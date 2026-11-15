import { hebrewVariants, stripNiqqud } from '@local-agent/shared';
import { discoverRules, rulesBrief } from './rules.js';
import { OWNER_ID } from './accounts.js';
import type { Store } from './db.js';
import { listSkills, renderSkillMd, saveSkill } from './skills.js';
import type { Tool } from './tools.js';
import { now } from './util.js';
import { revertBatches } from './coding.js';

/**
 * Ideas borrowed from Hermes Agent: capped memory files, a skill learning loop, full-text search of past chats,
 * project rule files loaded from workspaces, and rollback of a reply's edits.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ── Capped memory files ──────────────────────────────────────────────────────

export const MEMORY_CAPS = { user: 1500, notes: 3000 } as const;
export type MemoryKind = keyof typeof MEMORY_CAPS;
const MEMORY_TITLES: Record<MemoryKind, string> = { user: 'USER', notes: 'NOTES' };

function ensureMemory(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_files (agent_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, kind))');
}

export function readMemoryFile(store: Store, agentId: string, kind: MemoryKind): string {
  ensureMemory(store);
  return (store.db.prepare('SELECT content FROM memory_files WHERE agent_id = ? AND kind = ?').get(agentId, kind) as { content: string } | undefined)?.content ?? '';
}

export function writeMemoryFile(store: Store, agentId: string, kind: MemoryKind, content: string) {
  ensureMemory(store);
  const text = content.replace(/\r\n/g, '\n').trim();
  if (text.length > MEMORY_CAPS[kind]) throw Object.assign(new Error(`${MEMORY_TITLES[kind]} holds at most ${MEMORY_CAPS[kind]} characters (got ${text.length}). Shorten it first.`), { statusCode: 400 });
  store.db.prepare('INSERT INTO memory_files (agent_id, kind, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at').run(agentId, kind, text, now());
  return text;
}

export function memoryFiles(store: Store, agentId: string) {
  return (Object.keys(MEMORY_CAPS) as MemoryKind[]).map((kind) => ({ kind, title: MEMORY_TITLES[kind], cap: MEMORY_CAPS[kind], content: readMemoryFile(store, agentId, kind) }));
}

/** Always in the system prompt (they are small by design). */
export function memoryBrief(store: Store, agentId: string): string {
  const parts = memoryFiles(store, agentId).filter((file) => file.content);
  if (!parts.length) return '\n\nYour memory files are empty. Use memory_file to keep durable facts: USER for the person (preferences, context), NOTES for your own working knowledge.';
  return `\n\nYour memory files (keep them short; consolidate when near the cap):\n${parts.map((file) => `## ${file.title} (${file.content.length}/${file.cap})\n${file.content}`).join('\n')}`;
}

export function memoryFileTool(): Tool {
  return {
    name: 'memory_file',
    description: `Your two capped memory files. USER (${MEMORY_CAPS.user} chars): durable facts about the person. NOTES (${MEMORY_CAPS.notes} chars): your own working knowledge. action: read | append (text) | replace (text, to consolidate). An append that would pass the cap is refused: read, then replace with a shorter merged version.`,
    parameters: obj({ file: { type: 'string', enum: ['user', 'notes'] }, action: { type: 'string', enum: ['read', 'append', 'replace'] }, text: { type: 'string' } }, ['file', 'action']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const kind = (args.file === 'user' ? 'user' : 'notes') as MemoryKind;
      const current = readMemoryFile(ctx.store, ctx.agent.id, kind);
      if (args.action === 'read') return current ? `${MEMORY_TITLES[kind]} (${current.length}/${MEMORY_CAPS[kind]}):\n${current}` : `${MEMORY_TITLES[kind]} is empty.`;
      const text = String(args.text || '').trim();
      if (!text) throw new Error('Pass text.');
      const next = args.action === 'replace' ? text : (current ? `${current}\n${text}` : text);
      if (next.length > MEMORY_CAPS[kind]) {
        return `Refused: ${MEMORY_TITLES[kind]} would be ${next.length}/${MEMORY_CAPS[kind]} characters. Consolidate: merge duplicates, drop stale lines, then call replace with the shorter whole file.\nCurrent ${MEMORY_TITLES[kind]}:\n${current}`;
      }
      writeMemoryFile(ctx.store, ctx.agent.id, kind, next);
      return `${MEMORY_TITLES[kind]} saved (${next.length}/${MEMORY_CAPS[kind]}).`;
    },
  };
}

// ── Skill learning loop ──────────────────────────────────────────────────────

export function proposeSkillTool(): Tool {
  return {
    name: 'propose_skill',
    description: 'After a hard or repeated task, offer to save how you did it as a skill (or update an existing one) so next time is quicker. The user approves it first. name, description (when to use it, one line), body (Markdown steps, commands, pitfalls), slug to update an existing skill.',
    parameters: obj({ name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, slug: { type: 'string' } }, ['name', 'description', 'body']),
    mutates: () => true,
    approval: (args, ctx) => {
      const existing = args.slug && ctx ? listSkills(ctx.store).find((skill) => skill.slug === String(args.slug)) : null;
      const head = existing ? `Update skill “${existing.name}” to v${existing.version + 1}` : `Save new skill “${String(args.name || '').slice(0, 60)}”`;
      return `${head}: ${String(args.description || '').slice(0, 160)}`;
    },
    async execute(args, ctx) {
      const name = String(args.name || '').trim().slice(0, 80);
      const description = String(args.description || '').trim().replace(/\s+/g, ' ').slice(0, 300);
      const body = String(args.body || '').trim().slice(0, 20_000);
      if (!name || !description || !body) throw new Error('name, description and body are all needed.');
      const skill = await saveSkill(ctx.store, ctx.libraryDir || '', renderSkillMd({ name, description, body }), args.slug ? String(args.slug) : undefined);
      return `Saved skill ${skill.slug} v${skill.version}. It is in the catalog for every persona; its body loads only when a task fits.`;
    },
  };
}

/** Nudge after a task that took many steps; the agent decides whether it is worth a skill. */
export function skillNudge(turn: number, toolNames: string[]): string {
  if (turn < 4 || !toolNames.includes('propose_skill')) return '';
  return '\n\nThis task has taken several steps. Before your final answer, if you found a reusable way to do it, call propose_skill once (or update the skill you used). Skip it for one-off work.';
}

// ── Search past chats ────────────────────────────────────────────────────────

const ftsReady = new WeakSet<Store>();
/**
 * Past-chat search index. Trigram tokens match inside words, which Hebrew needs (prefixes are glued on: הבית holds בית)
 * and English does not mind. The older unicode61 table is dropped once.
 */
function syncFts(store: Store) {
  if (!ftsReady.has(store)) {
    store.db.exec('DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS messages_fts_state');
    store.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_tri USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, tokenize = 'trigram remove_diacritics 1')`);
    store.db.exec('CREATE TABLE IF NOT EXISTS messages_tri_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_rowid INTEGER NOT NULL)');
    ftsReady.add(store);
  }
  const last = (store.db.prepare('SELECT last_rowid AS r FROM messages_tri_state WHERE id = 1').get() as { r: number } | undefined)?.r ?? 0;
  const rows = store.db.prepare(`SELECT rowid AS r, id, session_id, content FROM messages WHERE rowid > ? AND role IN ('user', 'assistant') ORDER BY rowid LIMIT 5000`).all(last) as { r: number; id: string; session_id: string; content: string }[];
  if (!rows.length) return;
  const insert = store.db.prepare('INSERT INTO messages_tri (content, message_id, session_id) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(stripNiqqud(row.content.slice(0, 20_000)), row.id, row.session_id);
  store.db.prepare('INSERT INTO messages_tri_state (id, last_rowid) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_rowid = excluded.last_rowid').run(rows[rows.length - 1]!.r);
  if (rows.length === 5000) syncFts(store);
}

/** Trigram MATCH terms: words of 3+ letters, Hebrew ones also without their prefixes. Shorter words cannot match a trigram index. */
export function ftsQuery(text: string) {
  const words = stripNiqqud(text.toLowerCase()).match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  const terms = new Set<string>();
  for (const word of words.slice(0, 8)) {
    for (const form of /[\u05D0-\u05EA]/.test(word) ? hebrewVariants(word) : [word]) if (form.length >= 3) terms.add(form);
  }
  return [...terms].map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** A short window around the first match, whole words, with matches wrapped in «». Works for Hebrew prefixes too. */
export function snippetOf(body: string, terms: string[], width = 90) {
  const lower = body.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  let start = Math.max(0, at - width / 2);
  let end = Math.min(body.length, at + width);
  while (start > 0 && /\S/.test(body[start - 1]!)) start -= 1;
  while (end < body.length && /\S/.test(body[end]!)) end += 1;
  let text = body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (terms.length) {
    const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
    text = text.replace(pattern, '«$1»');
  }
  return `${start > 0 ? '… ' : ''}${text}${end < body.length ? ' …' : ''}`;
}

export function searchChats(store: Store, opts: { query: string; ownerId: string; exclude?: string | null; limit?: number }) {
  syncFts(store);
  const match = ftsQuery(opts.query);
  if (!match) return [];
  const hits = store.db.prepare(`SELECT f.session_id AS sid, f.message_id AS mid, f.content AS body, bm25(messages_tri) AS score
    FROM messages_tri f JOIN chat_sessions s ON s.id = f.session_id
    WHERE messages_tri MATCH ? AND s.owner_id = ? AND s.archived = 0 AND (? IS NULL OR f.session_id <> ?)
    ORDER BY score LIMIT 60`).all(match, opts.ownerId, opts.exclude ?? null, opts.exclude ?? null) as { sid: string; mid: string; body: string; score: number }[];
  const terms = [...new Set((match.match(/"((?:[^"]|"")+)"/g) ?? []).map((term) => term.slice(1, -1).replace(/""/g, '"')))].sort((a, b) => b.length - a.length);
  const grouped = new Map<string, { sid: string; hits: { mid: string; snip: string }[]; score: number }>();
  for (const hit of hits) {
    const group = grouped.get(hit.sid) ?? { sid: hit.sid, hits: [], score: hit.score };
    if (group.hits.length < 3) group.hits.push({ mid: hit.mid, snip: snippetOf(hit.body, terms) });
    grouped.set(hit.sid, group);
  }
  return [...grouped.values()].slice(0, Math.min(10, opts.limit ?? 5)).map((group) => {
    const session = store.getSession(group.sid)!;
    const summaries = store.listSummaries(group.sid);
    const summary = summaries.at(-1)?.content || session.summary || '';
    return { sessionId: group.sid, title: session.title, updatedAt: session.updatedAt, summary: summary.slice(0, 600), hits: group.hits };
  });
}

export function searchChatsTool(): Tool {
  return {
    name: 'search_chats',
    description: 'Full-text search across your past chats with this person. Returns matching chats with their summary and the best snippets. Cite as [msg:<id>]; read a whole message with find_context id.',
    parameters: obj({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const results = searchChats(ctx.store, { query: String(args.query || ''), ownerId: ctx.agent.ownerId || OWNER_ID, exclude: ctx.sessionId, limit: Number(args.limit) || 5 });
      if (!results.length) return 'No past chat matches.';
      return results.map((row) => `• “${row.title}” (${row.updatedAt.slice(0, 10)})${row.summary ? `\n  Summary: ${row.summary}` : ''}\n${row.hits.map((hit) => `  [msg:${hit.mid}] ${hit.snip}`).join('\n')}`).join('\n');
    },
  };
}

// ── Project rule files ───────────────────────────────────────────────────────

/** Kept for callers that only have roots: every rule file on. See rules.ts for discovery and per-chat switches. */
export function projectRules(roots: { label: string; path: string }[], disabled?: Set<string>): string {
  return rulesBrief(discoverRules(roots, disabled));
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/** Undo every edit checkpoint a reply made, newest first. */
export async function rollbackRun(store: Store, runId: string) {
  const rows = store.db.prepare('SELECT id FROM edit_batches WHERE run_id = ? AND reverted_at IS NULL ORDER BY created_at DESC, rowid DESC').all(runId) as { id: string }[];
  return rows.length ? revertBatches(store, rows.map((row) => row.id)) : 0;
}
