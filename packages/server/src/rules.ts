import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.js';

/**
 * Project rule files from the chat's workspaces, the way coding agents read them:
 * AGENTS.md, CLAUDE.md (root and nested), .cursorrules, .cursor/rules/*.mdc (alwaysApply / globs / description),
 * .github/copilot-instructions.md, GEMINI.md, .windsurfrules, .clinerules (file or folder), CONVENTIONS.md (aider).
 * Each chat can switch single files off. Sizes are capped so rules never crowd out the conversation.
 */
export const ROOT_RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', 'GEMINI.md', '.windsurfrules', '.clinerules', 'CONVENTIONS.md'];
export const RULE_FILE_CAP = 4000;
export const RULE_TOTAL_CAP = 12_000;
const NESTED_NAMES = new Set(['CLAUDE.md', 'AGENTS.md']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', 'target', '.venv', 'venv', '__pycache__', 'coverage']);

export type RuleKind = 'always' | 'glob' | 'manual' | 'nested';
export interface RuleFile {
  key: string; root: string; label: string; file: string; kind: RuleKind;
  globs: string[]; description: string; chars: number; enabled: boolean; text: string;
}

function readText(file: string): string | null {
  try { const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 512_000) return null; return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

/** Cursor .mdc: YAML-ish front matter with description, globs (string or list) and alwaysApply. */
export function parseMdc(raw: string): { description: string; globs: string[]; alwaysApply: boolean; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { description: '', globs: [], alwaysApply: false, body: raw.trim() };
  const head = match[1]!;
  const field = (name: string) => head.match(new RegExp(`^${name}[ \\t]*:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  let globsRaw = field('globs');
  if (!globsRaw) {
    const list = head.match(/^globs[ \t]*:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)/m)?.[1];
    if (list) globsRaw = list.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean).join(',');
  }
  const globs = globsRaw.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return { description: field('description').replace(/^["']|["']$/g, ''), globs, alwaysApply: /^true$/i.test(field('alwaysApply')), body: match[2]!.trim() };
}

function walk(dir: string, depth: number, visit: (full: string, name: string, isDir: boolean) => void) {
  if (depth < 0) return;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      visit(full, entry.name, true);
      walk(full, depth - 1, visit);
    } else if (entry.isFile()) visit(full, entry.name, false);
  }
}

export function discoverRules(roots: { label: string; path: string }[], disabled: Set<string> = new Set()): RuleFile[] {
  const out: RuleFile[] = [];
  const add = (root: { label: string; path: string }, full: string, kind: RuleKind, text: string, extra: Partial<RuleFile> = {}) => {
    const file = path.relative(root.path, full).split(path.sep).join('/');
    const key = `${root.path}::${file}`;
    if (!text || out.some((row) => row.key === key)) return;
    out.push({ key, root: root.path, label: root.label, file, kind, globs: [], description: '', chars: text.length, enabled: !disabled.has(key), text, ...extra });
  };
  for (const root of roots) {
    for (const name of ROOT_RULE_FILES) {
      const full = path.join(root.path, name);
      let isDir = false;
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
      if (isDir) {
        // .clinerules can be a folder of Markdown files.
        for (const child of fs.readdirSync(full).filter((item) => /\.(md|txt)$/i.test(item)).sort()) add(root, path.join(full, child), 'always', readText(path.join(full, child)) ?? '');
        continue;
      }
      add(root, full, 'always', readText(full) ?? '');
    }
    // .cursor/rules anywhere in the tree (nested rule folders apply to their part of the repo).
    walk(root.path, 4, (full, name, isDir) => {
      if (isDir || !name.endsWith('.mdc') || !full.split(path.sep).join('/').includes('/.cursor/rules/')) return;
      const raw = readText(full);
      if (!raw) return;
      const parsed = parseMdc(raw);
      const kind: RuleKind = parsed.alwaysApply ? 'always' : parsed.globs.length ? 'glob' : 'manual';
      add(root, full, kind, parsed.body, { globs: parsed.globs, description: parsed.description });
    });
    // Nested CLAUDE.md / AGENTS.md apply to their own folder.
    walk(root.path, 3, (full, name, isDir) => {
      if (isDir || !NESTED_NAMES.has(name) || path.dirname(full) === path.resolve(root.path)) return;
      add(root, full, 'nested', readText(full) ?? '');
    });
  }
  return out;
}

function clip(text: string, room: number, file: string) {
  return text.length > room ? `${text.slice(0, room)}\n… (${text.length - room} more characters; read ${file} for the rest)` : text;
}

/** The system-prompt block. Always rules in full, glob and folder rules scoped, description-only rules as a menu. */
export function rulesBrief(rules: RuleFile[]): string {
  const on = rules.filter((rule) => rule.enabled);
  if (!on.length) return '';
  const order: RuleKind[] = ['always', 'glob', 'nested', 'manual'];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    for (const rule of on.filter((row) => row.kind === kind)) {
      const room = Math.min(RULE_FILE_CAP, RULE_TOTAL_CAP - total);
      const name = `${rule.label}/${rule.file}`;
      if (kind === 'manual') {
        const line = `- ${name}: ${rule.description || 'project rule'} (read it with read_file when the task fits)`;
        if (total + line.length > RULE_TOTAL_CAP) break;
        parts.push(line); total += line.length; continue;
      }
      if (room <= 200) { parts.push(`- ${name} (not loaded: rules budget used; read it with read_file)`); continue; }
      const scope = kind === 'glob' ? ` — applies when working on files matching ${rule.globs.join(', ')}` : kind === 'nested' ? ` — applies inside ${rule.label}/${path.posix.dirname(rule.file)}/` : '';
      const body = clip(rule.text, room, name);
      parts.push(`### ${name}${scope}\n${body}`);
      total += body.length;
    }
  }
  return `\n\nProject rules from the attached workspaces. Follow them; they override your defaults (the user's direct instructions still win):\n${parts.join('\n\n')}`;
}

// ── Per-chat switches ────────────────────────────────────────────────────────

function ensure(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS session_rules_off (session_id TEXT NOT NULL, rule_key TEXT NOT NULL, PRIMARY KEY (session_id, rule_key))');
}
export function disabledRules(store: Store, sessionId: string): Set<string> {
  ensure(store);
  return new Set((store.db.prepare('SELECT rule_key AS k FROM session_rules_off WHERE session_id = ?').all(sessionId) as { k: string }[]).map((row) => row.k));
}
export function setRuleEnabled(store: Store, sessionId: string, key: string, enabled: boolean) {
  ensure(store);
  if (enabled) store.db.prepare('DELETE FROM session_rules_off WHERE session_id = ? AND rule_key = ?').run(sessionId, key);
  else store.db.prepare('INSERT OR IGNORE INTO session_rules_off (session_id, rule_key) VALUES (?, ?)').run(sessionId, key);
}
