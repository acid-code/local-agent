import { createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { AtSign, CornerUpLeft, FileText, Quote } from 'lucide-react';
import { fileMeta, linkCitations, parseCiteHref, type Cite } from '../lib/files';

/** How citation chips and code-block quotes reach the chat. */
export interface CiteHandlers { open: (cite: Cite) => void; quoteCode?: (code: string, sourceId: string) => void }
export const CiteContext = createContext<CiteHandlers | null>(null);

function FileName({ id, fallback }: { id: string; fallback: string }) {
  const [name, setName] = useState(fallback);
  useEffect(() => { void fileMeta(id).then((meta) => { if (meta) setName(meta.name); }); }, [id]);
  return <>{name}</>;
}

export function CiteChip({ cite, children }: { cite: Cite; children?: ReactNode }) {
  const handlers = useContext(CiteContext);
  const icon = cite.kind === 'msg' ? <CornerUpLeft size={12} /> : cite.kind === 'file' ? <FileText size={12} /> : <AtSign size={12} />;
  const label = cite.kind === 'file'
    ? <><FileName id={cite.id} fallback="file" />{cite.anchor ? ` · ${cite.anchor.replace('=', ' ')}` : ''}</>
    : children;
  return (
    <button type="button" className={`cite-chip ${cite.kind}`} onClick={(event) => { event.preventDefault(); handlers?.open(cite); }} title={cite.kind === 'msg' ? 'Jump to the quoted message' : cite.kind === 'file' ? 'Open the file preview' : 'Open in the preview'}>
      {icon}<span className="ellipsis">{label}</span>
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

export function Markdown({ text, streaming = false, sourceId }: { text: string; streaming?: boolean; sourceId?: string }) {
  const handlers = useContext(CiteContext);
  const think = text.match(/^<think>([\s\S]*?)(<\/think>)?/);
  const body = think ? text.slice(think[0].length) : text;
  return (
    <div className={streaming ? 'caret' : undefined}>
      {think && <div className="think">{think[1]}</div>}
      <div className="prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          urlTransform={(url) => (url.startsWith('#cite:') ? url : defaultUrlTransform(url))}
          components={{
            a: ({ href, children }) => {
              const cite = href ? parseCiteHref(href) : null;
              if (cite) return <CiteChip cite={cite}>{children}</CiteChip>;
              return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
            },
            pre: ({ children }) => (
              <div className="code-block">
                <pre>{children}</pre>
                {handlers?.quoteCode && sourceId && !streaming && (
                  <button type="button" className="code-quote" title="Quote this code" aria-label="Quote this code" onClick={() => handlers.quoteCode?.(textOf(children), sourceId)}><Quote size={13} /> Quote</button>
                )}
              </div>
            ),
          }}
        >
          {linkCitations(body) || (streaming ? '' : '…')}
        </ReactMarkdown>
      </div>
    </div>
  );
}
