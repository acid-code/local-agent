import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from './db.js';
import { nid, now, slugify } from './util.js';
import { tokenize } from './kb.js';

export interface SkillRecord {
  slug: string;
  name: string;
  description: string;
  body: string;
  version: number;
  updatedAt: string;
  enabled?: boolean;
}

export interface SkillFile {
  path: string;
  content: string;
}

export function parseSkillMd(raw: string): { name: string; description: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md needs frontmatter with name and a when-to-use description.');
  const front = match[1];
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  const description = (front.match(/^(?:description|when):\s*(.+)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  if (!name || !description) throw new Error('Frontmatter needs name and description.');
  return { name, description, body: match[2].trim() };
}

export function renderSkillMd(skill: { name: string; description: string; body: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body.trim()}\n`;
}

const FIT_STOP = new Set(['when', 'user', 'asks', 'with', 'this', 'that', 'from', 'your', 'have', 'will', 'into', 'about', 'they', 'them', 'then', 'than', 'what', 'which', 'where', 'after', 'before', 'using']);

export function skillFit(description: string, text: string): number {
  const words = tokenize(description).filter((word) => word.length > 3 && !FIT_STOP.has(word));
  if (!words.length) return 0;
  const hay = [...new Set(tokenize(text))];
  const hits = words.filter((word) => hay.some((item) => item === word || (word.length >= 5 && item.length >= 5 && (item.startsWith(word.slice(0, 5)) || word.startsWith(item.slice(0, 5)))))).length;
  return hits / words.length;
}

function rowToSkill(row: Record<string, unknown>): SkillRecord {
  return {
    slug: String(row.slug), name: String(row.name), description: String(row.description),
    body: String(row.body), version: Number(row.version), updatedAt: String(row.updated_at),
  };
}

export function listSkills(store: Store, agentId?: string | null): SkillRecord[] {
  const rows = store.db.prepare('SELECT * FROM skills ORDER BY name').all() as Record<string, unknown>[];
  return rows.map((row) => ({ ...rowToSkill(row), enabled: agentId ? skillEnabled(store, agentId, String(row.slug)) : true }));
}

export function skillEnabled(store: Store, agentId: string, slug: string): boolean {
  const row = store.db.prepare('SELECT enabled FROM agent_skills WHERE agent_id = ? AND slug = ?').get(agentId, slug) as { enabled: number } | undefined;
  return row ? Boolean(row.enabled) : true;
}

export function setSkillEnabled(store: Store, agentId: string, slug: string, enabled: boolean) {
  store.db.prepare('INSERT INTO agent_skills (agent_id, slug, enabled) VALUES (?, ?, ?) ON CONFLICT(agent_id, slug) DO UPDATE SET enabled = excluded.enabled').run(
    agentId, slug, enabled ? 1 : 0,
  );
}

export async function saveSkill(store: Store, dataDir: string, raw: string, slugInput?: string): Promise<SkillRecord> {
  const parsed = parseSkillMd(raw);
  const slug = slugify(slugInput || parsed.name);
  const current = store.db.prepare('SELECT version FROM skills WHERE slug = ?').get(slug) as { version: number } | undefined;
  const version = (current?.version ?? 0) + 1;
  const ts = now();
  if (current) {
    store.db.prepare('UPDATE skills SET name = ?, description = ?, body = ?, version = ?, updated_at = ? WHERE slug = ?').run(
      parsed.name, parsed.description, parsed.body, version, ts, slug,
    );
  } else {
    store.db.prepare('INSERT INTO skills (slug, name, description, body, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      slug, parsed.name, parsed.description, parsed.body, version, ts,
    );
  }
  store.db.prepare('INSERT INTO skill_versions (id, slug, version, name, description, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    nid('skv'), slug, version, parsed.name, parsed.description, parsed.body, ts,
  );
  await writeSkillFile(dataDir, slug, renderSkillMd(parsed));
  return { slug, ...parsed, version, updatedAt: ts };
}

export function skillVersions(store: Store, slug: string) {
  return (store.db.prepare('SELECT version, name, description, body, created_at FROM skill_versions WHERE slug = ? ORDER BY version DESC').all(slug) as Record<string, unknown>[])
    .map((row) => ({ version: Number(row.version), name: String(row.name), description: String(row.description), body: String(row.body), createdAt: String(row.created_at) }));
}

export async function writeSkillFile(dataDir: string, slug: string, markdown: string) {
  const dir = path.join(dataDir, 'skills', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), markdown, 'utf8');
}

export function safeSkillPath(relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.split('/').some((part) => part === '..' || part === '')) throw new Error('Skill file path is not allowed.');
  if (cleaned !== 'SKILL.md' && !cleaned.startsWith('scripts/') && !cleaned.startsWith('assets/')) {
    throw new Error('Skill files belong in SKILL.md, scripts/, or assets/.');
  }
  return cleaned;
}

export async function importSkill(store: Store, dataDir: string, bundle: { slug?: string; skillMd: string; files?: SkillFile[] }): Promise<SkillRecord> {
  const skill = await saveSkill(store, dataDir, bundle.skillMd, bundle.slug);
  for (const file of bundle.files ?? []) {
    const relative = safeSkillPath(file.path);
    if (relative === 'SKILL.md') continue;
    const full = path.join(dataDir, 'skills', skill.slug, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content, 'utf8');
  }
  return skill;
}

export async function exportSkill(store: Store, dataDir: string, slug: string): Promise<{ slug: string; skillMd: string; files: SkillFile[] }> {
  const row = store.db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Skill not found.');
  const skill = rowToSkill(row);
  const skillMd = renderSkillMd(skill);
  const root = path.join(dataDir, 'skills', slug);
  const files: SkillFile[] = [];
  for (const folder of ['scripts', 'assets']) {
    const dir = path.join(root, folder);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { names = []; }
    for (const name of names) {
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      files.push({ path: `${folder}/${name}`, content });
    }
  }
  return { slug, skillMd, files };
}

export function skillCatalog(store: Store, agentId: string, userText: string): string {
  const skills = listSkills(store, agentId).filter((skill) => skill.enabled);
  if (!skills.length) return '';
  const ranked = skills
    .map((skill) => ({ skill, score: skillFit(skill.description, userText) }))
    .sort((a, b) => b.score - a.score);
  // Names and one-line descriptions only; a body loads with load_skill when a task fits.
  const lines = ranked.slice(0, 40).map(({ skill }) => `- ${skill.slug}: ${skill.description.length > 200 ? `${skill.description.slice(0, 197)}…` : skill.description}`);
  const best = ranked[0];
  const hint = best && best.score >= 0.5 ? `\nThe skill ${best.skill.slug} fits this message. Call load_skill before you answer.` : '';
  return `\n\nSkills you can load with load_skill when one fits:\n${lines.join('\n')}${hint}`;
}

export function runSkillScript(file: string, timeoutMs = 8000): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  const limit = Math.min(30_000, Math.max(200, timeoutMs));
  return new Promise((resolve) => {
    const child = spawn(file, [], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, limit);
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, output: output.slice(0, 8000), timedOut });
    });
  });
}

export async function loadSkill(store: Store, dataDir: string, agentId: string, slug: string): Promise<string> {
  const row = store.db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`No skill named ${slug}.`);
  if (!skillEnabled(store, agentId, slug)) throw new Error(`Skill ${slug} is turned off for this persona.`);
  const skill = rowToSkill(row);
  const extras = await exportSkill(store, dataDir, slug);
  const attached = extras.files.map((file) => `\n\n--- ${file.path} ---\n${file.content.slice(0, 8000)}`);
  return `# ${skill.name} (v${skill.version})\nWhen to use: ${skill.description}\n\n${skill.body}${attached.join('')}`;
}
