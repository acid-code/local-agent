import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, ExternalLink, FileArchive, FileQuestion, Quote, Share2, X } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { Markdown } from './Markdown';
import { extOf, fileMeta, humanSize, kindOf, openExternally, pathRawUrl, rawUrl, saveFile, shareFile, type FileKind } from '../lib/files';
import { toast } from '../lib/toast';

export type ViewerSource = { kind: 'file'; id: string; name?: string } | { kind: 'path'; root: string; path: string };
export interface QuotePick { ref: string; text: string; label: string }

/** The reference written into a quote for a spot in this source. */
function refFor(source: ViewerSource, anchor?: string) {
  if (source.kind === 'file') return `file:${source.id}${anchor ? `#${anchor}` : ''}`;
  const lines = anchor?.startsWith('L') ? `#${anchor}` : '';
  return `@${source.root}:${source.path}${lines}`;
}

export function FileViewer({ source, anchor, onClose, onQuote }: { source: ViewerSource; anchor?: string; onClose: () => void; onQuote?: (pick: QuotePick) => void }) {
  const [name, setName] = useState(source.kind === 'file' ? source.name || 'file' : source.path.split('/').pop() || source.path);
  const [mime, setMime] = useState('');
  const [size, setSize] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const url = source.kind === 'file' ? rawUrl(source.id) : pathRawUrl(source.root, source.path);

  useEffect(() => {
    if (source.kind !== 'file') return;
    void fileMeta(source.id).then((meta) => {
      if (!meta) { setMissing(true); return; }
      setName(meta.name); setMime(meta.mime); setSize(meta.size);
    });
  }, [source]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const kind = kindOf(name, mime);
  const label = name;
  const quote = (text: string, at?: string) => {
    if (!onQuote) return;
    const clean = text.trim();
    if (!clean) { toast('Select some text in the preview first.', 'info'); return; }
    onQuote({ ref: refFor(source, at), text: clean.slice(0, 2000), label: `${label}${at ? ` · ${at.replace('=', ' ')}` : ''}` });
    toast('Quote added to the message box.', 'ok');
  };
  const quoteSelection = () => {
    const sel = window.getSelection();
    const text = sel && body.current && sel.rangeCount && body.current.contains(sel.anchorNode) ? sel.toString() : '';
    quote(text, anchor);
  };

  return (
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${name}`} onClick={onClose}>
      <div className="viewer" onClick={(event) => event.stopPropagation()}>
        <header className="viewer-head">
          <div className="viewer-title">
            <strong className="ellipsis" dir="auto" title={name}>{name}</strong>
            <span className="faint">{kindLabel(kind, name)}{size !== null ? ` · ${humanSize(size)}` : ''}</span>
          </div>
          <div className="viewer-actions">
            {onQuote && <button className="btn ghost small" onClick={quoteSelection} title="Quote the selected text"><Quote size={15} /> <span>Quote</span></button>}
            <button className="icon-btn" aria-label="Download" title="Download / save" onClick={() => saveFile(url, name, mime)}><Download size={18} /></button>
            <button className="icon-btn" aria-label="Open in new tab" title="Open in new tab / another app" onClick={() => openExternally(url, name, mime)}><ExternalLink size={18} /></button>
            <button className="icon-btn" aria-label="Share" title="Share" onClick={() => void shareFile(url, name, mime)}><Share2 size={18} /></button>
            <button className="icon-btn" aria-label="Close preview" onClick={onClose}><X size={20} /></button>
          </div>
        </header>
        <div className="viewer-body" ref={body}>
          {missing ? <Info icon={<FileQuestion size={28} />} title="This file is gone." detail="It was deleted, or the id is wrong." /> : <Body kind={kind} url={url} name={name} anchor={anchor} quote={onQuote ? quote : undefined} />}
        </div>
      </div>
    </div>
  );
}

function kindLabel(kind: FileKind, name: string) {
  const ext = extOf(name).toUpperCase();
  return ({ image: 'Image', pdf: 'PDF', markdown: 'Markdown', code: `${ext} source`, text: 'Text', csv: 'Table', json: 'JSON', docx: 'Word document', pptx: 'PowerPoint', xlsx: 'Spreadsheet', video: 'Video', audio: 'Audio', zip: ext === 'APK' ? 'Android app' : 'Archive', binary: ext ? `${ext} file` : 'File' } as Record<FileKind, string>)[kind];
}

function Info({ icon, title, detail, children }: { icon: ReactNode; title: string; detail?: string; children?: ReactNode }) {
  return <div className="viewer-info">{icon}<strong>{title}</strong>{detail && <p className="muted">{detail}</p>}{children}</div>;
}

function useFetched<T>(url: string, as: 'text' | 'buffer', deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    setState({});
    fetch(url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not load (${res.status}).`);
        return (as === 'text' ? res.text() : res.arrayBuffer()) as Promise<T>;
      })
      .then((data) => { if (live) setState({ data }); })
      .catch((error: Error) => { if (live) setState({ error: error.message }); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  return state;
}

type QuoteFn = (text: string, at?: string) => void;

function Body({ kind, url, name, anchor, quote }: { kind: FileKind; url: string; name: string; anchor?: string; quote?: QuoteFn }) {
  if (kind === 'image') return <div className="viewer-center"><img src={url} alt={name} className="viewer-img" /></div>;
  if (kind === 'video') return <div className="viewer-center"><video src={url} controls playsInline preload="metadata" className="viewer-media" /></div>;
  if (kind === 'audio') return <div className="viewer-center"><audio src={url} controls preload="metadata" /></div>;
  if (kind === 'pdf') return <PdfView url={url} anchor={anchor} quote={quote} />;
  if (kind === 'docx') return <DocxView url={url} quote={quote} />;
  if (kind === 'pptx') return <PptxView url={url} anchor={anchor} quote={quote} />;
  if (kind === 'xlsx') return <XlsxView url={url} />;
  if (kind === 'zip') return <ZipView url={url} name={name} />;
  if (kind === 'binary') return <Info icon={<FileQuestion size={28} />} title="No preview for this type." detail="Download it, or open it with another app." />;
  return <TextView url={url} kind={kind} name={name} anchor={anchor} quote={quote} />;
}

function TextView({ url, kind, name, anchor, quote }: { url: string; kind: FileKind; name: string; anchor?: string; quote?: QuoteFn }) {
  const { data, error } = useFetched<string>(url, 'text');
  const range = /^L(\d+)(?:-(\d+))?$/.exec(anchor || '');
  const first = range ? Number(range[1]) : 0;
  const last = range ? Number(range[2] || range[1]) : 0;
  useEffect(() => { if (data && first) document.getElementById(`ln-${first}`)?.scrollIntoView({ block: 'center' }); }, [data, first]);
  if (error) return <Info icon={<FileQuestion size={28} />} title="Could not load the file." detail={error} />;
  if (data === undefined) return <p className="faint viewer-pad">Loading…</p>;
  const cut = data.length > 1_000_000;
  const text = cut ? data.slice(0, 1_000_000) : data;
  if (kind === 'markdown') return <div className="viewer-pad prose-wrap" dir="auto"><Markdown text={text} /></div>;
  if (kind === 'csv') return <CsvTable text={text} tab={extOf(name) === 'tsv'} />;
  if (kind === 'json') return <JsonView text={text} />;
  return <CodeLines text={text} lang={extOf(name)} first={first} last={last} quote={quote} cut={cut} />;
}

function CodeLines({ text, lang, first, last, quote, cut }: { text: string; lang: string; first: number; last: number; quote?: QuoteFn; cut: boolean }) {
  const html = useMemo(() => {
    try {
      const out = hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : text.length < 200_000 ? hljs.highlightAuto(text).value : escapeHtml(text);
      return out.split('\n');
    } catch { return escapeHtml(text).split('\n'); }
  }, [text, lang]);
  const lines = text.split('\n');
  return (
    <div className="code-view">
      {first > 0 && quote && <div className="viewer-bar"><span className="faint">Lines {first}–{last}</span><button className="btn ghost small" onClick={() => quote(lines.slice(first - 1, last).join('\n'), `L${first}-${last}`)}><Quote size={14} /> Quote these lines</button></div>}
      <pre className="hljs"><code>{html.map((line, i) => (
        <div key={i} id={`ln-${i + 1}`} className={i + 1 >= first && i + 1 <= last ? 'ln hl' : 'ln'}><span className="ln-no">{i + 1}</span><span dangerouslySetInnerHTML={{ __html: line || ' ' }} /></div>
      ))}</code></pre>
      {cut && <p className="faint viewer-pad">Showing the first 1 MB. Download for the rest.</p>}
    </div>
  );
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > 5000) break;
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Table({ rows, header = true }: { rows: (string | number | null)[][]; header?: boolean }) {
  if (!rows.length) return <p className="faint viewer-pad">Empty.</p>;
  const shown = rows.slice(0, 1000);
  const head = header ? shown[0]! : null;
  const rest = header ? shown.slice(1) : shown;
  return (
    <div className="table-wrap">
      <table className="data-table">
        {head && <thead><tr><th className="rn">#</th>{head.map((cell, i) => <th key={i} dir="auto">{String(cell ?? '')}</th>)}</tr></thead>}
        <tbody>{rest.map((row, r) => <tr key={r}><td className="rn">{r + 1}</td>{row.map((cell, i) => <td key={i} dir="auto">{String(cell ?? '')}</td>)}</tr>)}</tbody>
      </table>
      {rows.length > 1000 && <p className="faint viewer-pad">Showing 1,000 of {rows.length} rows.</p>}
    </div>
  );
}

function CsvTable({ text, tab }: { text: string; tab: boolean }) {
  const rows = useMemo(() => parseCsv(text, tab ? '\t' : ','), [text, tab]);
  return <Table rows={rows} />;
}

function JsonView({ text }: { text: string }) {
  const parsed = useMemo(() => { try { return { value: JSON.parse(text) as unknown }; } catch (error) { return { error: (error as Error).message }; } }, [text]);
  if ('error' in parsed) return <div><p className="badge warn viewer-pad">Not valid JSON: {parsed.error}</p><CodeLines text={text} lang="json" first={0} last={0} cut={false} /></div>;
  const value = parsed.value;
  if (Array.isArray(value) && value.length && value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    const cols = [...new Set(value.slice(0, 200).flatMap((row) => Object.keys(row as object)))].slice(0, 30);
    const rows = [cols, ...value.map((row) => cols.map((col) => { const v = (row as Record<string, unknown>)[col]; return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }))];
    return <Table rows={rows} />;
  }
  return <CodeLines text={JSON.stringify(value, null, 2)} lang="json" first={0} last={0} cut={false} />;
}

function PdfView({ url, anchor, quote }: { url: string; anchor?: string; quote?: QuoteFn }) {
  const { data, error } = useFetched<ArrayBuffer>(url, 'buffer');
  const host = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(0);
  const [status, setStatus] = useState('Loading…');
  const texts = useRef<Map<number, string>>(new Map());
  const target = Number(/page=(\d+)/.exec(anchor || '')?.[1] || 0);
  useEffect(() => {
    if (!data || !host.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
        if (cancelled) return;
        setPages(doc.numPages);
        setStatus('');
        const width = Math.min(host.current!.clientWidth - 24, 1000);
        const count = Math.min(doc.numPages, 60);
        for (let n = 1; n <= count; n += 1) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
          const canvas = document.getElementById(`pdf-c-${n}`) as HTMLCanvasElement | null;
          if (!canvas) continue;
          canvas.width = viewport.width; canvas.height = viewport.height;
          canvas.style.width = `${base.width * scale}px`; canvas.style.height = `${base.height * scale}px`;
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          const content = await page.getTextContent();
          texts.current.set(n, content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim());
          if (n === target) document.getElementById(`pdf-p-${n}`)?.scrollIntoView({ block: 'start' });
        }
      } catch (err) {
        if (!cancelled) setStatus(`Could not render this PDF: ${(err as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [data, target]);
  if (error) return <Info icon={<FileQuestion size={28} />} title="Could not load the PDF." detail={error} />;
  return (
    <div className="pdf-view" ref={host}>
      {status && <p className="faint viewer-pad">{status}</p>}
      {Array.from({ length: Math.min(pages, 60) }, (_, i) => i + 1).map((n) => (
        <section key={n} id={`pdf-p-${n}`} className={n === target ? 'pdf-page target' : 'pdf-page'}>
          <div className="viewer-bar"><span className="faint">Page {n} of {pages}</span>{quote && <button className="btn ghost small" onClick={() => quote(texts.current.get(n) || '', `page=${n}`)}><Quote size={14} /> Quote page</button>}</div>
          <canvas id={`pdf-c-${n}`} />
        </section>
      ))}
      {pages > 60 && <p className="faint viewer-pad">Showing 60 of {pages} pages. Download for the rest.</p>}
    </div>
  );
}

function DocxView({ url, quote }: { url: string; quote?: QuoteFn }) {
  const { data, error } = useFetched<ArrayBuffer>(url, 'buffer');
  const [html, setHtml] = useState<string | null>(null);
  const [fail, setFail] = useState('');
  useEffect(() => {
    if (!data) return;
    void import('mammoth/mammoth.browser').then((mammoth) => mammoth.convertToHtml({ arrayBuffer: data }))
      .then((result: { value: string }) => setHtml(result.value.replace(/<(script|iframe|object|embed)[\s\S]*?<\/\1>/gi, '').replace(/\son\w+="[^"]*"/gi, '')))
      .catch((err: Error) => setFail(err.message));
  }, [data]);
  if (error || fail) return <Info icon={<FileQuestion size={28} />} title="Could not open this document." detail={error || fail} />;
  if (html === null) return <p className="faint viewer-pad">Converting…</p>;
  return (
    <div className="doc-view" dir="auto">
      {quote && <p className="faint viewer-pad small-note">Select a passage and press Quote to cite it.</p>}
      <article className="doc-page prose" dangerouslySetInnerHTML={{ __html: html || '<p>(empty document)</p>' }} />
    </div>
  );
}

interface Slide { n: number; title: string; body: string[]; image?: string }
function PptxView({ url, anchor, quote }: { url: string; anchor?: string; quote?: QuoteFn }) {
  const { data, error } = useFetched<ArrayBuffer>(url, 'buffer');
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [fail, setFail] = useState('');
  const target = Number(/slide=(\d+)/.exec(anchor || '')?.[1] || 0);
  useEffect(() => {
    if (!data) return;
    let urls: string[] = [];
    void (async () => {
      try {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(data);
        const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
        const out: Slide[] = [];
        for (const name of names) {
          const n = Number(name.match(/(\d+)\.xml$/)![1]);
          const xml = await zip.file(name)!.async('string');
          const paras = xml.split(/<\/a:p>/).map((part) => [...part.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]!)).join('')).filter((t) => t.trim());
          const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`)?.async('string');
          const media = rels ? /Target="\.\.\/media\/([^"]+\.(?:png|jpe?g|gif))"/i.exec(rels)?.[1] : undefined;
          let image: string | undefined;
          if (media && zip.file(`ppt/media/${media}`)) { image = URL.createObjectURL(await zip.file(`ppt/media/${media}`)!.async('blob')); urls.push(image); }
          out.push({ n, title: paras[0] || `Slide ${n}`, body: paras.slice(1), image });
        }
        setSlides(out);
      } catch (err) { setFail((err as Error).message); }
    })();
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
  }, [data]);
  useEffect(() => { if (slides && target) document.getElementById(`slide-${target}`)?.scrollIntoView({ block: 'start' }); }, [slides, target]);
  if (error || fail) return <Info icon={<FileQuestion size={28} />} title="Could not open this presentation." detail={error || fail} />;
  if (!slides) return <p className="faint viewer-pad">Reading slides…</p>;
  if (!slides.length) return <Info icon={<FileQuestion size={28} />} title="No slides found." />;
  return (
    <div className="slides">
      {slides.map((slide) => (
        <section key={slide.n} id={`slide-${slide.n}`} className={slide.n === target ? 'slide target' : 'slide'}>
          <div className="viewer-bar"><span className="faint">Slide {slide.n}</span>{quote && <button className="btn ghost small" onClick={() => quote([slide.title, ...slide.body].join('\n'), `slide=${slide.n}`)}><Quote size={14} /> Quote slide</button>}</div>
          <div className="slide-card">
            <h3 dir="auto">{slide.title}</h3>
            {slide.body.length > 0 && <ul>{slide.body.map((line, i) => <li key={i} dir="auto">{line}</li>)}</ul>}
            {slide.image && <img src={slide.image} alt="" />}
          </div>
        </section>
      ))}
    </div>
  );
}

function decodeXml(value: string) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function XlsxView({ url }: { url: string }) {
  const { data, error } = useFetched<ArrayBuffer>(url, 'buffer');
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [active, setActive] = useState(0);
  const [fail, setFail] = useState('');
  useEffect(() => {
    if (!data) return;
    void (async () => {
      try {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(data);
        const shared = [...((await zip.file('xl/sharedStrings.xml')?.async('string')) || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join(''));
        const workbook = (await zip.file('xl/workbook.xml')?.async('string')) || '';
        const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) || '';
        const out: { name: string; rows: string[][] }[] = [];
        for (const m of workbook.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
          const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] || new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels)?.[1];
          const file = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : '';
          const xml = (file && (await zip.file(file)?.async('string'))) || '';
          const rows: string[][] = [];
          for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells: string[] = [];
            for (const c of row[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
              const ref = /r="([A-Z]+\d+)"/.exec(c[1]!)?.[1] || '';
              const type = /t="(\w+)"/.exec(c[1]!)?.[1];
              const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] || '')?.[1] ?? '';
              const value = type === 's' ? shared[Number(v)] ?? '' : decodeXml(v);
              const idx = ref ? colIndex(ref) : cells.length;
              while (cells.length < idx) cells.push('');
              cells[idx] = value;
            }
            rows.push(cells);
            if (rows.length > 2000) break;
          }
          out.push({ name: decodeXml(m[1]!), rows });
        }
        setSheets(out);
      } catch (err) { setFail((err as Error).message); }
    })();
  }, [data]);
  if (error || fail) return <Info icon={<FileQuestion size={28} />} title="Could not open this spreadsheet." detail={error || fail} />;
  if (!sheets) return <p className="faint viewer-pad">Reading sheets…</p>;
  return (
    <div>
      {sheets.length > 1 && <div className="sheet-tabs">{sheets.map((sheet, i) => <button key={sheet.name} className={i === active ? 'on' : ''} onClick={() => setActive(i)}>{sheet.name}</button>)}</div>}
      <Table rows={sheets[active]?.rows || []} />
    </div>
  );
}

function ZipView({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched<ArrayBuffer>(url, 'buffer');
  const [entries, setEntries] = useState<{ name: string; size: number }[] | null>(null);
  useEffect(() => {
    if (!data) return;
    void import('jszip').then(async ({ default: JSZip }) => {
      const zip = await JSZip.loadAsync(data);
      setEntries(Object.values(zip.files).filter((f) => !f.dir).map((f) => ({ name: f.name, size: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 })));
    }).catch(() => setEntries([]));
  }, [data]);
  const apk = extOf(name) === 'apk';
  return (
    <div className="viewer-pad">
      <Info icon={<FileArchive size={28} />} title={apk ? 'Android app package' : 'Archive'} detail={apk ? 'On the phone, use Open with to install it. Android asks before installing apps from outside the Play Store.' : 'Download it to extract the files.'} />
      {error && <p className="badge warn">{error}</p>}
      {entries && entries.length > 0 && (
        <details className="zip-list">
          <summary>{entries.length} entries</summary>
          <ul>{entries.slice(0, 500).map((entry) => <li key={entry.name} className="mono"><span className="ellipsis">{entry.name}</span><span className="faint">{entry.size ? humanSize(entry.size) : ''}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}
