import { createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { AtSign, Check, Copy, CornerUpLeft, FileText, Quote } from 'lucide-react';
import { fileMeta, linkCitations, parseCiteHref, type Cite } from '../lib/files';
import { t } from '../i18n';

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
    <button type="button" className={`cite-chip ${cite.kind}`} onClick={(event) => { event.preventDefault(); handlers?.open(cite); }} title={cite.kind === 'msg' ? t('Jump to the quoted message') : cite.kind === 'file' ? t('Open the file preview') : t('Open in the preview')}>
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
            pre: ({ children }) => <CodeBlock sourceId={streaming ? undefined : sourceId} onQuote={handlers?.quoteCode}>{children}</CodeBlock>,
          }}
        >
          {linkCitations(body) || (streaming ? '' : '…')}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function CodeBlock({ children, sourceId, onQuote }: { children: ReactNode; sourceId?: string; onQuote?: (code: string, sourceId: string) => void }) {
  const [copied, setCopied] = useState(false);
  const child = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string } } | undefined;
  const lang = /language-([\w+#-]+)/.exec(child?.props?.className || '')?.[1] || 'text';
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang}</span>
        <span className="spacer" />
        {onQuote && sourceId && <button type="button" className="code-btn" title={t('Quote this code in your reply')} onClick={() => onQuote(textOf(children), sourceId)}><Quote size={13} aria-hidden />{' '}{t('Quote')}</button>}
        <button type="button" className="code-btn" title={t('Copy code')} onClick={() => { void navigator.clipboard?.writeText(textOf(children)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />} {copied ? t('Copied') : t('Copy')}</button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
