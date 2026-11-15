import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '@local-agent/shared';

/**
 * isInside, plus links: the target's real location (through any symlink, even for a file not created yet) must also
 * be inside the root's real location. A link in a workspace that points at /etc or the data folder is refused.
 */
export function safeInside(root: string, target: string): boolean {
  if (!isInside(root, target)) return false;
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return true; } // no root on disk yet: nothing to follow
  // The deepest part of the path that exists (a dangling link counts as existing and is refused below).
  let probe = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try { fs.lstatSync(probe); break; } catch { /* not there yet */ }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real: string;
  try { real = fs.realpathSync(probe); } catch { return false; }
  const full = path.join(real, ...tail);
  return full === realRoot || full.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
}
