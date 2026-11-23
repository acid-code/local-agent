import type { Tool } from './tools.js';

/**
 * Lean tool menus with discovery. A persona starts with a small core (its declared tools plus essentials) and
 * calls find_tools to pull more from the full catalog (built-ins plus MCP connectors). Found tools join the
 * offered list for the rest of the run, appended at the end so the prompt prefix (and llama-server's cache) holds.
 */

/** Essentials every persona keeps on its menu when they are allowed at all. */
export const CORE_TOOLS = [
  'read_file', 'write_file', 'create_file', 'list_dir', 'grep', 'glob', 'shell', 'web_search', 'web_fetch',
  'request_secret', 'read_output', 'kb_search', 'load_skill', 'tasks', 'think', 'time_now', 'memory_file',
  'spawn_agent', 'helpers', 'share_file', 'find_tools',
];

/** Below this many allowed tools the whole list is offered and find_tools is not needed. */
export const LEAN_MIN_TOOLS = 18;
/** Tools pre-loaded from the request text at the start of a run, so obvious needs skip a find_tools round trip. */
export const SEED_TOOLS = 4;

export function leanMenuEnabled(): boolean {
  return (process.env.LA_TOOL_MENU || 'lean').toLowerCase() !== 'full';
}

/** Words that mean the same thing in requests and tool descriptions (English and Hebrew). */
const SYNONYMS: Record<string, string[]> = {
  email: ['gmail', 'mail', 'inbox', 'מייל', 'אימייל'],
  calendar: ['event', 'meeting', 'schedule', 'יומן', 'פגישה'],
  image: ['picture', 'photo', 'png', 'jpg', 'תמונה'],
  slides: ['presentation', 'deck', 'pptx', 'מצגת'],
  github: ['repo', 'repository', 'pull', 'pr', 'issue', 'commit'],
  deploy: ['vercel', 'deployment', 'hosting', 'domain'],
  remind: ['reminder', 'timer', 'alarm', 'תזכורת'],
  trigger: ['when', 'watch', 'webhook'],
  browse: ['browser', 'website', 'page', 'click', 'login'],
  task: ['todo', 'clickup', 'ticket', 'משימה'],
  shell: ['command', 'terminal', 'bash', 'run', 'npm', 'test'],
  edit: ['patch', 'change', 'modify', 'fix', 'replace'],
  git: ['branch', 'commit', 'push', 'diff'],
  memory: ['remember', 'recall', 'note'],
  text: ['ocr', 'scan', 'receipt'],
  tweet: ['twitter', 'x', 'post'],
};

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'my', 'me', 'i', 'it', 'is', 'with', 'tool', 'tools', 'please', 'can', 'you', 'that', 'this', 'be', 'from', 'at', 'by', 'do', 'what', 'how']);

export function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOP.has(word));
}

function expand(query: string): Set<string> {
  const out = new Set<string>();
  for (const word of words(query)) {
    out.add(word);
    if (word.endsWith('s') && word.length > 3) out.add(word.slice(0, -1));
    for (const [key, alts] of Object.entries(SYNONYMS)) {
      if (key === word || alts.includes(word)) { out.add(key); for (const alt of alts) out.add(alt); }
    }
  }
  return out;
}

/** Score tools against a keyword or intent query; name hits weigh more than description hits. */
export function rankTools(catalog: Tool[], query: string, servers: Map<string, string> = new Map()): { tool: Tool; score: number }[] {
  const terms = expand(query);
  if (!terms.size) return [];
  const exact = query.trim().toLowerCase();
  return catalog.map((tool) => {
    const nameWords = new Set(words(tool.name.replace(/[_.:-]/g, ' ')));
    const server = servers.get(tool.name)?.toLowerCase();
    const descWords = new Set(words(tool.description.slice(0, 600)));
    let score = tool.name.toLowerCase() === exact ? 10 : 0;
    for (const term of terms) {
      if (nameWords.has(term)) score += 3;
      else if (term.length > 3 && tool.name.toLowerCase().includes(term)) score += 2;
      if (server && (server === term || server.includes(term))) score += 2;
      if (descWords.has(term)) score += 1;
    }
    return { tool, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
}

/** A short schema the model can read before calling: parameters with type, required mark and a clipped description. */
export function compactSchema(tool: Tool): string {
  const params = tool.parameters as { properties?: Record<string, { type?: unknown; description?: string; enum?: unknown[] }>; required?: string[] };
  const required = new Set(params.required ?? []);
  const fields = Object.entries(params.properties ?? {}).slice(0, 12).map(([key, spec]) => {
    const type = spec.enum ? spec.enum.slice(0, 6).map(String).join('|') : String(spec.type ?? 'any');
    return `${key}${required.has(key) ? '' : '?'}: ${type}${spec.description ? ` (${spec.description.slice(0, 80)})` : ''}`;
  });
  return `- ${tool.name}: ${tool.description.replace(/\s+/g, ' ').slice(0, 220)}\n  args: ${fields.length ? fields.join('; ') : 'none'}`;
}

/** One line naming what find_tools can reach: built-in tool names and connector servers with their tool counts. */
export function catalogHint(discoverable: Tool[], servers: Map<string, string>, max = 900): string {
  const builtins = discoverable.filter((tool) => !servers.has(tool.name)).map((tool) => tool.name);
  const counts = new Map<string, number>();
  for (const tool of discoverable) { const server = servers.get(tool.name); if (server) counts.set(server, (counts.get(server) ?? 0) + 1); }
  const parts = [
    builtins.length ? `built-in: ${builtins.join(', ')}` : '',
    counts.size ? `connectors: ${[...counts].map(([server, n]) => `${server} (${n})`).join(', ')}` : '',
  ].filter(Boolean).join('. ');
  return parts.length > max ? `${parts.slice(0, max)}…` : parts;
}

export interface SkillHit { slug: string; name: string; description: string }

/** Score skills the same way as tools: name words weigh more than when-to-use words. */
export function rankSkills(skills: SkillHit[], query: string): { skill: SkillHit; score: number }[] {
  const terms = expand(query);
  if (!terms.size) return [];
  const exact = query.trim().toLowerCase();
  return skills.map((skill) => {
    const nameWords = new Set([...words(skill.name), ...words(skill.slug.replace(/-/g, ' '))]);
    const descWords = new Set(words(skill.description.slice(0, 400)));
    let score = skill.slug === exact ? 10 : 0;
    for (const term of terms) {
      if (nameWords.has(term)) score += 3;
      if (descWords.has(term)) score += 1;
    }
    return { skill, score };
  }).filter((row) => row.score >= 2).sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug));
}

export function findToolsTool(input: {
  /** Allowed tools that are not on the menu yet (stable for the run, so the description never changes). */
  discoverable: Tool[];
  servers: Map<string, string>;
  /** Names already offered (core plus earlier finds). */
  offered: () => Set<string>;
  /** Adds names to the run's menu from the next step on. */
  add: (names: string[]) => void;
  /** Saved skills this persona may load (enabled ones); hits point at load_skill. */
  skills?: () => SkillHit[];
}): Tool {
  const hint = catalogHint(input.discoverable, input.servers);
  return {
    name: 'find_tools',
    description: `Find more tools and saved skills when none on your list fits the job (email, calendar, GitHub, deploys, images, slides, reminders, browser, connectors…). Search by keyword or intent; matching tools are added to your list from the next step on and their arguments are shown, and matching skills are named for load_skill. Call it before saying you can't do something.${hint ? ` Reachable: ${hint}.` : ''}`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or intent, e.g. "send email", "github pull request", "make an image". An exact tool name also works.' },
        limit: { type: 'integer', description: 'How many tools to add (default 5, max 10).' },
      },
      required: ['query'],
    },
    mutates: () => false,
    approval: () => null,
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('Pass query: keywords or the intent, e.g. "send email".');
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
      const offered = input.offered();
      const names = query.split(/[\s,]+/).filter((name) => input.discoverable.some((tool) => tool.name === name));
      const ranked = rankTools(input.discoverable, query, input.servers);
      const picked: Tool[] = [];
      for (const name of names) { const tool = input.discoverable.find((item) => item.name === name); if (tool) picked.push(tool); }
      for (const row of ranked) if (picked.length < limit && !picked.includes(row.tool)) picked.push(row.tool);
      const skillHits = input.skills ? rankSkills(input.skills(), query).slice(0, 3) : [];
      const skillNote = skillHits.length
        ? `Saved skills that fit (call load_skill with the slug before you start):\n${skillHits.map(({ skill }) => `- load_skill ${skill.slug}: ${skill.description.slice(0, 160)}`).join('\n')}`
        : '';
      if (!picked.length && skillNote) return skillNote;
      if (!picked.length) {
        return `No tool matches "${query}". Try other words (what the tool acts on, e.g. "email", "calendar", "repo").${hint ? ` Reachable: ${hint}.` : ' Nothing else is available to this persona.'}`;
      }
      const fresh = picked.filter((tool) => !offered.has(tool.name)).map((tool) => tool.name);
      if (fresh.length) input.add(fresh);
      const already = picked.filter((tool) => offered.has(tool.name)).map((tool) => tool.name);
      return [
        fresh.length ? `Added to your tools (callable from your next step): ${fresh.join(', ')}.` : 'These are already on your list.',
        already.length && fresh.length ? `Already on your list: ${already.join(', ')}.` : '',
        picked.map(compactSchema).join('\n'),
        skillNote,
      ].filter(Boolean).join('\n');
    },
  };
}
