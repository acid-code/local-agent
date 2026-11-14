/** Small helpers the web console uses to present tool output. Kept here so they are unit-tested. */

export interface Source { n: number; title: string; url: string | null; snippet: string }

/** Turns web_search and kb_search tool output into a numbered source list. Unknown tools return []. */
export function parseSources(toolName: string | null | undefined, content: string): Source[] {
  const text = String(content || '').trim();
  if (!text) return [];
  if (toolName === 'web_search') {
    return text.split(/\n\s*\n/).flatMap((block) => {
      const lines = block.split('\n');
      const head = lines[0]?.match(/^(\d+)\.\s+(.*)$/);
      const url = lines[1]?.trim() || '';
      if (!head || !/^https?:\/\//i.test(url)) return [];
      return [{ n: Number(head[1]), title: head[2]!.trim() || url, url, snippet: lines.slice(2).join(' ').trim() }];
    });
  }
  if (toolName === 'kb_search') {
    return text.split(/\n\s*\n/).flatMap((block) => {
      const head = block.match(/^\[(\d+)\]\s+(.*)(?:\n([\s\S]*))?$/);
      if (!head) return [];
      return [{ n: Number(head[1]), title: head[2]!.trim(), url: null, snippet: (head[3] || '').replace(/\s+/g, ' ').trim() }];
    });
  }
  return [];
}

/** First line of a tool result, cut to fit a one-line summary. */
export function toolSummary(content: string, max = 90): string {
  const first = String(content || '').split('\n').find((line) => line.trim())?.trim() || 'No output.';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
