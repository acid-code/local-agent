import { toast } from './toast';

export interface FileMeta { id: string; name: string; mime: string; size: number; source?: string; sessionId?: string | null; createdAt?: string; snippet?: string }

export type FileKind = 'image' | 'pdf' | 'markdown' | 'code' | 'text' | 'csv' | 'json' | 'docx' | 'pptx' | 'xlsx' | 'video' | 'audio' | 'zip' | 'binary';

const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'bash', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'cs', 'css', 'scss', 'sql', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'php', 'rb', 'swift', 'dart', 'lua', 'r', 'gradle', 'dockerfile', 'makefile', 'vue', 'svelte']);

export function extOf(name: string) {
  const base = name.split('/').pop() || name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}

export function kindOf(name: string, mime = ''): FileKind {
  const ext = extOf(name);
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'json' || ext === 'jsonl') return 'json';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'xlsx') return 'xlsx';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'].includes(ext)) return 'audio';
  if (['zip', 'apk', 'jar', 'aab'].includes(ext)) return 'zip';
  if (CODE.has(ext)) return 'code';
  if (['txt', 'log', 'env', 'conf', 'cfg', 'rst', 'text'].includes(ext) || mime.startsWith('text/')) return 'text';
  return 'binary';
}

export function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const rawUrl = (id: string, download = false) => `/api/files/${id}/raw${download ? '?download=1' : ''}`;
export const pathRawUrl = (root: string, path: string, download = false) => `/api/git/${encodeURIComponent(root)}/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;

interface AndroidBridge { download?: (url: string, name: string, mime: string) => void; share?: (url: string, name: string, mime: string) => void; openWith?: (url: string, name: string, mime: string) => void }
const android = () => (window as unknown as { LocalAgentAndroid?: AndroidBridge }).LocalAgentAndroid;
export const isAndroidApp = () => Boolean(android()?.download);
export const isElectron = () => Boolean((window as unknown as { localAgent?: unknown }).localAgent) || /Electron/.test(navigator.userAgent);
const absolute = (url: string) => new URL(url, window.location.href).toString();
/** iPhone and iPad (iPadOS reports itself as a Mac with touch). */
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// iOS drops the tap's permission to open the share sheet if fetching the file takes too long.
// The fetched file is kept so a second tap opens the sheet straight away.
const ready = new Map<string, File>();

/** iOS share sheet with the file itself, which offers Save to Files, Save Image, AirDrop and the rest. */
async function iosShareSheet(url: string, name: string, mime: string) {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  let file = ready.get(url);
  try {
    if (!file) {
      const blob = await (await fetch(url, { credentials: 'same-origin' })).blob();
      file = new File([blob], name, { type: mime || blob.type });
      ready.set(url, file);
    }
    if (!nav.canShare?.({ files: [file] })) throw new Error('no file share');
    await nav.share({ files: [file], title: name });
    ready.delete(url);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof DOMException && error.name === 'NotAllowedError') { toast(`${name} is ready. Tap Save again to open the share sheet.`, 'info'); return; }
    window.open(url, '_blank', 'noopener');
  }
}

/** Save a file the way the platform expects: Android DownloadManager, Electron's save dialog, or a browser download. */
export function saveFile(url: string, name: string, mime = 'application/octet-stream') {
  const bridge = android();
  if (bridge?.download) {
    bridge.download(absolute(url), name, mime);
    toast(`Saving ${name} to Downloads…`, 'info');
    return;
  }
  if (isIOS() && 'share' in navigator) { void iosShareSheet(url, name, mime); return; }
  const a = document.createElement('a');
  a.href = url.includes('download=1') ? url : `${url}${url.includes('?') ? '&' : '?'}download=1`;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Open in a new tab, or hand the file to another app on Android. */
export function openExternally(url: string, name: string, mime = 'application/octet-stream') {
  const bridge = android();
  if (bridge?.openWith) { bridge.openWith(absolute(url), name, mime); return; }
  window.open(url, '_blank', 'noopener');
}

/** Share sheet: Android intent, Web Share with a file where the browser supports it, else copy the link. */
export async function shareFile(url: string, name: string, mime = 'application/octet-stream') {
  const bridge = android();
  if (bridge?.share) { bridge.share(absolute(url), name, mime); return; }
  if (isIOS() && 'share' in navigator) { await iosShareSheet(url, name, mime); return; }
  try {
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    const blob = await (await fetch(url, { credentials: 'same-origin' })).blob();
    const file = new File([blob], name, { type: mime });
    if (nav.canShare?.({ files: [file] })) { await nav.share({ files: [file], title: name }); return; }
    if (nav.share) { await nav.share({ title: name, url: absolute(url) }); return; }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
  }
  await navigator.clipboard?.writeText(absolute(url)).catch(() => undefined);
  toast('Link copied. Sharing files is not available in this browser.', 'info');
}

export async function uploadFile(file: File, sessionId?: string | null): Promise<FileMeta> {
  if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} is over 50 MB.`);
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch('/api/files', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, contentBase64: btoa(binary), sessionId: sessionId || undefined }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data.file as FileMeta;
}

const metaCache = new Map<string, Promise<FileMeta | null>>();
export function fileMeta(id: string): Promise<FileMeta | null> {
  if (!metaCache.has(id)) metaCache.set(id, fetch(`/api/files/${id}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => d?.file ?? null).catch(() => null));
  return metaCache.get(id)!;
}

/** Citation tokens the agent and composer use. */
export const CITE_RE = /\[(msg|file):([A-Za-z0-9_]+)(?:#([^\]\s]+))?\]|\[@([A-Za-z]+:[A-Za-z0-9_-]+):([^\]#]*)(?:#L(\d+)(?:-(\d+))?)?\]/g;
export const CONTEXT_MARK = '\n\n<!--la:context-->\n';

export type Cite =
  | { kind: 'msg'; id: string }
  | { kind: 'file'; id: string; anchor?: string }
  | { kind: 'path'; root: string; path: string; start?: number; end?: number };

export function citeHref(cite: Cite) {
  if (cite.kind === 'msg') return `#cite:msg:${cite.id}`;
  if (cite.kind === 'file') return `#cite:file:${cite.id}${cite.anchor ? `:${cite.anchor}` : ''}`;
  return `#cite:path:${encodeURIComponent(cite.root)}:${encodeURIComponent(cite.path)}:${cite.start || ''}:${cite.end || ''}`;
}

export function parseCiteHref(href: string): Cite | null {
  if (!href.startsWith('#cite:')) return null;
  const parts = href.slice(6).split(':');
  if (parts[0] === 'msg' && parts[1]) return { kind: 'msg', id: parts[1] };
  if (parts[0] === 'file' && parts[1]) return { kind: 'file', id: parts[1], anchor: parts.slice(2).join(':') || undefined };
  if (parts[0] === 'path' && parts[1]) return { kind: 'path', root: decodeURIComponent(parts[1]), path: decodeURIComponent(parts[2] || ''), start: Number(parts[3]) || undefined, end: Number(parts[4]) || undefined };
  return null;
}

/** Rewrites citation tokens into markdown links the renderer turns into chips. Code spans and blocks are left alone. */
export function linkCitations(text: string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part.replace(CITE_RE, (_m, kind, id, anchor, root, path, start, end) => {
    if (kind === 'msg') return `[message](${citeHref({ kind: 'msg', id })})`;
    if (kind === 'file') return `[file${anchor ? ` · ${anchor.replace('=', ' ')}` : ''}](${citeHref({ kind: 'file', id, anchor })})`;
    const label = `@${path || '.'}${start ? `#L${start}${end ? `-${end}` : ''}` : ''}`;
    return `[${label.replace(/[[\]]/g, '')}](${citeHref({ kind: 'path', root, path, start: Number(start) || undefined, end: Number(end) || undefined })})`;
  })).join('');
}

export function citationsIn(text: string): Cite[] {
  const out: Cite[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    if (m[1] === 'file') out.push({ kind: 'file', id: m[2]!, anchor: m[3] });
    else if (m[1] === 'msg') out.push({ kind: 'msg', id: m[2]! });
    else out.push({ kind: 'path', root: m[4]!, path: m[5]!, start: Number(m[6]) || undefined, end: Number(m[7]) || undefined });
  }
  return out;
}

/** The quote block the composer prepends. The model reads it as a marked quote with a pointer to its source. */
export function quoteBlock(ref: string, text: string) {
  const lines = text.trim().split('\n').slice(0, 40).map((line) => `> ${line}`);
  return `> **Quote** [${ref}]\n${lines.join('\n')}`;
}
