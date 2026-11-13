import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const think = text.match(/^<think>([\s\S]*?)(<\/think>)?/);
  const body = think ? text.slice(think[0].length) : text;
  return (
    <div className={streaming ? 'caret' : undefined}>
      {think && <div className="think">{think[1]}</div>}
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}>
          {body || (streaming ? '' : '…')}
        </ReactMarkdown>
      </div>
    </div>
  );
}
