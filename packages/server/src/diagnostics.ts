import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workbench } from './workbench.js';

export interface PostEditDiagnosticsOptions {
  workspace: string;
  root?: string;
  roots?: string[];
  workbench?: Workbench | null;
  enabled?: boolean;
  timeoutMs?: number;
}

const MAX_LINES = 15;
const MAX_CHARS = 2000;

function isInsideRoot(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}${path.sep}`);
}

function stopRootFor(file: string, workspace: string, root?: string, roots?: string[]): string {
  const candidates = [...(roots ?? []), ...(root ? [root] : []), workspace].map((p) => path.resolve(p));
  const resolved = path.resolve(file);
  const hit = candidates
    .filter((candidate) => isInsideRoot(resolved, candidate))
    .sort((a, b) => b.length - a.length)[0];
  return hit ?? path.resolve(root || workspace);
}

async function fileExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

async function findNearestUp(startDir: string, stopRoot: string, relParts: string[]): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopRoot);
  if (!isInsideRoot(dir, stop)) return null;
  while (true) {
    const candidate = path.join(dir, ...relParts);
    if (await fileExists(candidate)) return candidate;
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir || !isInsideRoot(parent, stop)) break;
    dir = parent;
  }
  return null;
}

function execCheck(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    const finish = (result: { code: number | null; stdout: string; stderr: string; missing: boolean }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, stdout, stderr, missing: true });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 32_000) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 32_000) stderr += String(chunk);
    });
    child.on('error', () => finish({ code: null, stdout, stderr, missing: true }));
    child.on('close', (code) => finish({ code, stdout, stderr, missing: false }));
  });
}

function nonEmptyLines(raw: string): string[] {
  return raw.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
}

function formatLines(lines: string[]): string {
  if (!lines.length) return '';
  const body = lines.slice(0, MAX_LINES).join('\n');
  const clipped = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS - 3)}...` : body;
  return `\n\n[Diagnostics] Issues detected after edit (fix before finishing):\n${clipped}`;
}

/**
 * Run fast automatic post-edit syntax/type checks on written files.
 * Returns an empty string when clean, disabled, or when no checker is present.
 */
export async function runPostEditDiagnostics(files: string[], opts: PostEditDiagnosticsOptions): Promise<string> {
  if (opts.enabled === false || process.env.LA_POST_EDIT_DIAGNOSTICS === '0' || !files.length) return '';
  const unique = [...new Set(files.map((file) => path.resolve(file)))];
  const issues: string[] = [];
  const tsGroups = new Map<string, { tsconfigPath: string; stopRoot: string; files: string[] }>();
  const quickTimeout = Math.min(opts.timeoutMs ?? 4000, 4000);
  const tscTimeout = opts.timeoutMs ?? 8000;

  for (const file of unique) {
    if (issues.length >= MAX_LINES) break;
    const stopRoot = stopRootFor(file, opts.workspace, opts.root, opts.roots);
    const rel = path.relative(stopRoot, file) || path.basename(file);
    const ext = path.extname(file).toLowerCase();

    if (ext === '.json') {
      try {
        const raw = await fs.readFile(file, 'utf8');
        try {
          JSON.parse(raw);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push(`${rel}: JSON syntax error — ${msg}`);
        }
      } catch { /* unreadable or missing file */ }
      continue;
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      try {
        const res = await execCheck(process.execPath, ['--check', file], path.dirname(file), quickTimeout);
        if (!res.missing && res.code !== 0) {
          const errLines = nonEmptyLines(res.stderr || res.stdout).slice(0, 6);
          if (errLines.length) issues.push(...errLines);
          else issues.push(`${rel}: JavaScript syntax check failed (exit ${res.code})`);
        }
      } catch { /* ignore checker failure */ }
      continue;
    }

    if (ext === '.py') {
      try {
        const res = await execCheck('python3', ['-m', 'py_compile', file], path.dirname(file), quickTimeout);
        if (!res.missing && res.code !== 0) {
          const errLines = nonEmptyLines(res.stderr || res.stdout).slice(0, 6);
          if (errLines.length) issues.push(...errLines);
          else issues.push(`${rel}: Python syntax check failed (exit ${res.code})`);
        }
      } catch { /* ignore missing python3 */ }
      continue;
    }

    if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
      try {
        const tsconfigPath = await findNearestUp(path.dirname(file), stopRoot, ['tsconfig.json']);
        if (!tsconfigPath) continue;
        const tsconfigDir = path.dirname(tsconfigPath);
        const existing = tsGroups.get(tsconfigDir);
        if (existing) {
          existing.files.push(file);
        } else {
          tsGroups.set(tsconfigDir, { tsconfigPath, stopRoot, files: [file] });
        }
      } catch { /* ignore */ }
    }
  }

  for (const [tsconfigDir, group] of tsGroups) {
    if (issues.length >= MAX_LINES) break;
    try {
      const tscBin = await findNearestUp(tsconfigDir, group.stopRoot, ['node_modules', '.bin', 'tsc']);
      if (!tscBin) continue;
      const res = await execCheck(tscBin, ['--noEmit', '--pretty', 'false', '-p', group.tsconfigPath], tsconfigDir, tscTimeout);
      if (!res.missing && res.code !== 0) {
        const allLines = nonEmptyLines(`${res.stdout}\n${res.stderr}`);
        const needles = group.files.flatMap((file) => {
          const relFromTsconfig = path.relative(tsconfigDir, file).replace(/\\/g, '/');
          const relFromStop = path.relative(group.stopRoot, file).replace(/\\/g, '/');
          const base = path.basename(file);
          return [relFromTsconfig, relFromStop, `${base}(`, `${base}:`].filter(Boolean);
        });
        const matching = allLines.filter((line) => {
          const normalized = line.replace(/\\/g, '/');
          return needles.some((needle) => normalized.includes(needle));
        });
        const picked = (matching.length ? matching : allLines).slice(0, 10);
        issues.push(...picked);
      }
    } catch { /* ignore tsc errors */ }
  }

  return formatLines(issues);
}
