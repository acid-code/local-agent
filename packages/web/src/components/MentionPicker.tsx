import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, ChevronLeft, File, FileUp, Folder, Paperclip, X } from 'lucide-react';
import { api } from '../lib/api';
import { humanSize, uploadFile, type FileMeta } from '../lib/files';
import { errorText, toast } from '../lib/toast';
import { t } from '../i18n';

export interface GitRootInfo { id: string; label: string; path: string; kind: 'workspace' | 'project'; workshops: string[] }
export type MentionPick =
  | { kind: 'path'; root: string; path: string; dir: boolean; start?: number; end?: number; label: string }
  | { kind: 'file'; id: string; label: string };
interface Entry { name: string; path: string; dir: boolean; size: number }

/** Splits "src/a.ts#L10-20" into a path and a line range. */
export function splitRange(value: string): { path: string; start?: number; end?: number } {
  const m = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(value.trim());
  return { path: (m?.[1] || '').replace(/^\.?\/+/, ''), start: m?.[2] ? Number(m[2]) : undefined, end: m?.[3] ? Number(m[3]) : m?.[2] ? Number(m[2]) : undefined };
}

/** A pasted absolute path becomes a path inside the root that holds it. */
export function mapPastedPath(value: string, roots: { id: string; path: string }[], fallbackRoot: string): { root: string; path: string } {
  const clean = value.trim();
  for (const root of [...roots].sort((a, b) => b.path.length - a.path.length)) {
    const base = root.path.replace(/\/+$/, '');
    if (clean === base) return { root: root.id, path: '' };
    if (clean.startsWith(`${base}/`)) return { root: root.id, path: clean.slice(base.length + 1) };
  }
  return { root: fallbackRoot, path: clean.replace(/^\.?\/+/, '') };
}

export function MentionPicker({ query, setQuery, defaultRoot, sessionId, onPick, onClose }: {
  query: string; setQuery: (value: string) => void; defaultRoot: string | null; sessionId: string | null;
  onPick: (pick: MentionPick) => void; onClose: () => void;
}) {
  const [roots, setRoots] = useState<GitRootInfo[]>([]);
  const [root, setRoot] = useState<string>(defaultRoot || '');
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const upload = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    api<{ roots: GitRootInfo[] }>('/api/git/roots').then((data) => {
      setRoots(data.roots);
      setRoot((value) => value && data.roots.some((r) => r.id === value) ? value : data.roots[0]?.id || '');
    }).catch(() => undefined);
  }, []);
  const range = splitRange(query);
  const typedDir = range.path.includes('/') ? range.path.slice(0, range.path.lastIndexOf('/')) : '';
  const filter = range.path.includes('/') ? range.path.slice(range.path.lastIndexOf('/') + 1) : range.path;
  const pasted = query.startsWith('/');
  const browseDir = pasted ? '' : typedDir || dir;
  useEffect(() => {
    if (!root || pasted) { setEntries([]); return; }
    api<{ entries: Entry[] }>(`/api/git/${encodeURIComponent(root)}/tree?path=${encodeURIComponent(browseDir || '.')}`).then((data) => setEntries(data.entries)).catch(() => setEntries([]));
  }, [root, browseDir, pasted]);
  useEffect(() => {
    const id = setTimeout(() => {
      api<{ files: FileMeta[] }>(`/api/files?limit=8${filter ? `&q=${encodeURIComponent(filter)}` : ''}`).then((data) => setFiles(data.files)).catch(() => setFiles([]));
    }, 150);
    return () => clearTimeout(id);
  }, [filter]);

  const shown = useMemo(() => entries.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 40), [entries, filter]);
  const rootInfo = roots.find((r) => r.id === root);
  type Item = { key: string; run: () => void };
  const items: Item[] = [
    ...(pasted ? [{ key: 'paste', run: () => { const mapped = mapPastedPath(range.path.startsWith('/') ? `/${range.path}` : query, roots, root); onPick({ kind: 'path', root: mapped.root, path: mapped.path, dir: false, start: range.start, end: range.end, label: mapped.path || '.' }); } }] : []),
    ...shown.map((entry) => ({ key: entry.path, run: () => entry.dir && !range.start ? (setDir(entry.path), setQuery(entry.path + '/')) : onPick({ kind: 'path', root, path: entry.path, dir: entry.dir, start: range.start, end: range.end, label: entry.path }) })),
    ...files.map((file) => ({ key: file.id, run: () => onPick({ kind: 'file', id: file.id, label: file.name }) })),
  ];
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    if (event.key === 'Enter') { event.preventDefault(); items[active]?.run(); }
    if (event.key === 'Backspace' && !query && dir) { event.preventDefault(); setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''); }
  };
  let index = -1;
  const cls = () => { index += 1; return index === active ? 'pick-item active' : 'pick-item'; };

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const saved = await uploadFile(file, sessionId);
        onPick({ kind: 'file', id: saved.id, label: saved.name });
      }
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="mention-picker" role="dialog" aria-label={t('Reference a file or folder')} onKeyDown={onKey}>
      <div className="pick-head">
        <AtSign size={16} />
        <input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder={t('file, folder/, path#L10-20, or paste a full path')} aria-label={t('Search files')} />
        <button className="icon-btn" aria-label={t('Close')} onClick={onClose}><X size={16} /></button>
      </div>
      <div className="pick-body">
        <button className="pick-item upload" onClick={() => upload.current?.click()} disabled={busy}><FileUp size={16} /> {busy ? t('Uploading…') : t('Upload from this device')}<span className="faint">{t('laptop or phone, up to 50 MB')}</span></button>
        <input ref={upload} type="file" multiple hidden onChange={(event) => { void onFiles(event.target.files); event.target.value = ''; }} />
        {pasted && <button className={cls()} onClick={items[0]!.run}><File size={16} />{' '}{t('Use path')}{' '}<span className="mono ellipsis">{query}</span></button>}
        {!pasted && (
          <>
            <div className="pick-section">
              <select aria-label={t('Folder')} value={root} onChange={(event) => { setRoot(event.target.value); setDir(''); }}>
                {roots.map((r) => <option key={r.id} value={r.id}>{r.label}{r.workshops.length ? ` (${r.workshops.join(', ')})` : ''}</option>)}
              </select>
              {(browseDir || dir) && <button className="btn ghost small" onClick={() => { const up = browseDir.includes('/') ? browseDir.slice(0, browseDir.lastIndexOf('/')) : ''; setDir(up); setQuery(up ? `${up}/` : ''); }}><ChevronLeft size={14} />{' '}{t('Up')}</button>}
              <button className="btn ghost small" onClick={() => onPick({ kind: 'path', root, path: browseDir, dir: true, label: browseDir || rootInfo?.label || '.' })}><Folder size={14} />{' '}{t('@ this folder')}</button>
            </div>
            <p className="faint pick-path mono ellipsis">{rootInfo?.path}{browseDir ? `/${browseDir}` : ''}</p>
            {shown.map((entry) => (
              <button key={entry.path} className={cls()} onClick={() => entry.dir && !range.start ? (setDir(entry.path), setQuery(`${entry.path}/`)) : onPick({ kind: 'path', root, path: entry.path, dir: entry.dir, start: range.start, end: range.end, label: entry.path })}>
                {entry.dir ? <Folder size={16} /> : <File size={16} />}<span className="ellipsis">{entry.name}{entry.dir ? '/' : ''}</span>{!entry.dir && <span className="faint">{humanSize(entry.size)}{range.start ? t(' · L{0}-{1}', [range.start, range.end]) : ''}</span>}
              </button>
            ))}
            {shown.length === 0 && <p className="faint pick-empty">{entries.length ? t('No match in this folder.') : t('This folder is empty.')}</p>}
          </>
        )}
        {files.length > 0 && <p className="pick-label faint"><Paperclip size={12} />{' '}{t('Uploaded and shared files')}</p>}
        {files.map((file) => (
          <button key={file.id} className={cls()} onClick={() => onPick({ kind: 'file', id: file.id, label: file.name })}>
            <Paperclip size={16} /><span className="ellipsis">{file.name}</span><span className="faint">{humanSize(file.size)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
