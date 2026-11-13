/**
 * Designed, not built. See ROADMAP.md. Calling one throws so a route cannot
 * pretend the feature exists.
 */

export interface KnowledgeSource {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  /** Chunk, embed, and retrieve beside the conversation index. Not wired. */
}

export interface SkillTemplate {
  id: string;
  name: string;
  prompt: string;
  tools: string[];
  /** Shared across personas. Distinct from the three built-in persona templates. */
}

export interface ExternalTrigger {
  id: string;
  kind: 'email' | 'github' | 'file' | 'url';
  /** Would start a run the way cron already does. */
}

export interface EvalCase {
  id: string;
  task: string;
  expect: string;
  /** Rerun after a model or prompt change and diff the traces. */
}

export function notInThisVersion(feature: string): never {
  throw new Error(`${feature} is only a design note in this version. See ROADMAP.md.`);
}
