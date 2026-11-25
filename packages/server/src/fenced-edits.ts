import type { ToolCall } from '@local-agent/shared';

export const FENCED_EDIT_HINT =
  'Large file edits: instead of JSON-escaping big files, you may output fenced blocks: ' +
  '```file:path/to/file.ts (or :append / :overwrite) for full or chunked writes, or ' +
  '```edit:path/to/file.ts with <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks.';

function parseFileSpec(rawSpec: string): { path: string; append: boolean; overwrite: boolean } | null {
  let targetPath = rawSpec.trim();
  let append = false;
  let overwrite = false;
  if (targetPath.endsWith(':append')) {
    append = true;
    targetPath = targetPath.slice(0, -':append'.length);
  } else if (targetPath.endsWith(':overwrite')) {
    overwrite = true;
    targetPath = targetPath.slice(0, -':overwrite'.length);
  }
  if (!targetPath || targetPath.startsWith('..') || /\s/.test(targetPath)) return null;
  return { path: targetPath, append, overwrite };
}

function parseSearchReplaceHunks(lines: string[]): { search: string; replace: string }[] {
  const hunks: { search: string; replace: string }[] = [];
  let state: 'idle' | 'search' | 'replace' = 'idle';
  let searchLines: string[] = [];
  let replaceLines: string[] = [];
  for (const line of lines) {
    if (state === 'idle') {
      if (/^<{7}\s*SEARCH\s*$/.test(line)) {
        state = 'search';
        searchLines = [];
        replaceLines = [];
      }
      continue;
    }
    if (state === 'search') {
      if (/^={7}\s*$/.test(line)) {
        state = 'replace';
      } else {
        searchLines.push(line);
      }
      continue;
    }
    if (/^>{7}\s*REPLACE\s*$/.test(line)) {
      const search = searchLines.join('\n');
      if (search.length > 0) {
        hunks.push({ search, replace: replaceLines.join('\n') });
      }
      state = 'idle';
      searchLines = [];
      replaceLines = [];
    } else {
      replaceLines.push(line);
    }
  }
  return hunks;
}

/**
 * Extract Aider-style fenced file writes (```file:path) and SEARCH/REPLACE edits (```edit:path).
 * Unclosed fences are preserved verbatim so truncated output is never half-applied.
 */
export function extractFencedEdits(raw: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  if (!raw || !/`{3,}(?:file|edit):/.test(raw)) return { text: raw, calls };
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const outLines: string[] = [];
  const stamp = Date.now().toString(36);
  const openRe = /^(`{3,})(file|edit):([^\s`]+)\s*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const open = openRe.exec(line);
    if (!open) {
      outLines.push(line);
      continue;
    }
    const fenceLen = open[1]!.length;
    const kind = open[2] as 'file' | 'edit';
    const spec = open[3]!;
    const closeRe = new RegExp(`^\\\`{${fenceLen},}\\s*$`);

    let closeIdx = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closeRe.test(lines[j]!)) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx < 0) {
      outLines.push(...lines.slice(i));
      break;
    }

    const bodyLines = lines.slice(i + 1, closeIdx);
    let parsedCall: ToolCall | null = null;

    if (kind === 'file') {
      const parsedSpec = parseFileSpec(spec);
      if (parsedSpec) {
        const content = bodyLines.length ? `${bodyLines.join('\n')}\n` : '';
        parsedCall = {
          id: `fenced_${stamp}_${calls.length}`,
          name: 'write_file',
          arguments: JSON.stringify({
            path: parsedSpec.path,
            content,
            ...(parsedSpec.append ? { append: true } : {}),
            ...(parsedSpec.overwrite ? { overwrite: true } : {}),
          }),
        };
      }
    } else {
      const targetPath = spec.trim();
      if (targetPath && !targetPath.startsWith('..') && !/\s/.test(targetPath)) {
        const hunks = parseSearchReplaceHunks(bodyLines);
        if (hunks.length === 1) {
          parsedCall = {
            id: `fenced_${stamp}_${calls.length}`,
            name: 'apply_patch',
            arguments: JSON.stringify({ path: targetPath, search: hunks[0]!.search, replace: hunks[0]!.replace }),
          };
        } else if (hunks.length > 1) {
          parsedCall = {
            id: `fenced_${stamp}_${calls.length}`,
            name: 'apply_patch',
            arguments: JSON.stringify({
              edits: hunks.map((h) => ({ path: targetPath, search: h.search, replace: h.replace })),
            }),
          };
        }
      }
    }

    if (parsedCall) {
      calls.push(parsedCall);
    } else {
      for (let k = i; k <= closeIdx; k += 1) outLines.push(lines[k]!);
    }
    i = closeIdx;
  }

  const text = calls.length ? outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() : raw;
  return { text, calls };
}
