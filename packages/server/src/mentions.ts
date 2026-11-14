import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '@local-agent/shared';
import type { Store } from './db.js';
import { fileText, getFile } from './files.js';
import { gitRoot, readExcerpt, treeListing } from './gitops.js';

/** Everything after this marker in a user message is context the composer attached. The UI hides it and shows chips. */
export const CONTEXT_MARK = '\n\n<!--la:context-->\n';
export const CONTEXT_BUDGET = 60_000;

export type Mention =
  | { kind: 'path'; root: string; path: string; start?: number; end?: number }
  | { kind: 'file'; id: string };

export function mentionLabel(mention: Mention, store: Store): string {
  if (mention.kind === 'file') return `[file:${mention.id}]`;
  const range = mention.start ? `#L${mention.start}${mention.end && mention.end !== mention.start ? `-${mention.end}` : ''}` : '';
  return `[@${mention.root}:${mention.path || '.'}${range}]`;
  void store;
}

/** Turns @-mentions into text the model can read: folder trees, file contents or excerpts, uploaded file text. Each block says when it was cut. */
export function expandMentions(store: Store, mentions: Mention[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const mention of mentions.slice(0, 12)) {
    let block = '';
    try {
      if (mention.kind === 'file') {
        const file = getFile(store, mention.id);
        if (!file) { blocks.push(`[file:${mention.id}] was not found.`); continue; }
        const text = fileText(store, file.id);
        const room = Math.max(2_000, Math.min(20_000, CONTEXT_BUDGET - used));
        block = text
          ? `### [file:${file.id}] ${file.name} (${file.mime}, ${file.size} bytes)\n\`\`\`\n${text.slice(0, room)}\n\`\`\`${text.length > room ? `\n(Truncated: showing ${room} of ${text.length} characters. Use find_context with id ${file.id} for more.)` : ''}`
          : `### [file:${file.id}] ${file.name} (${file.mime}, ${file.size} bytes)\nNo readable text (binary or media). The owner can open it in the preview.`;
      } else {
        const root = gitRoot(store, mention.root);
        const full = path.resolve(root.path, mention.path || '.');
        if (!isInside(root.path, full)) throw new Error('That path is outside the workspace.');
        const label = mentionLabel(mention, store);
        if (fs.statSync(full).isDirectory()) {
          const tree = treeListing(root.path, mention.path || '.', { depth: 3, max: 300 });
          block = `### ${label} folder in ${root.label}\n\`\`\`\n${tree.text || '(empty)'}\n\`\`\`${tree.truncated ? `\n(Truncated: ${tree.count} entries shown, 3 levels deep.)` : ''}`;
        } else {
          const ex = readExcerpt(root.path, mention.path, { start: mention.start, end: mention.end });
          if (ex.binary) block = `### ${label} in ${root.label}\nBinary file, ${ex.size} bytes. Not inlined.`;
          else {
            const room = Math.max(2_000, CONTEXT_BUDGET - used);
            const text = ex.text.length > room ? ex.text.slice(0, room) : ex.text;
            const cut = ex.truncated || text.length < ex.text.length;
            const lang = path.extname(mention.path).slice(1);
            block = `### ${label} in ${root.label} (lines ${ex.startLine}-${ex.endLine} of ${ex.lines})\n\`\`\`${lang}\n${text}\n\`\`\`${cut ? `\n(Truncated at ${text.length} characters. Ask for a line range to see more.)` : ''}`;
          }
        }
      }
    } catch (error) {
      block = `${mentionLabel(mention, store)} could not be read: ${error instanceof Error ? error.message : 'error'}`;
    }
    if (used + block.length > CONTEXT_BUDGET) {
      blocks.push(`${mentionLabel(mention, store)} skipped: the attached context is over ${CONTEXT_BUDGET} characters.`);
      continue;
    }
    used += block.length;
    blocks.push(block);
  }
  return blocks.length ? `Attached context from the owner:\n\n${blocks.join('\n\n')}` : '';
}
