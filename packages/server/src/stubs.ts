/**
 * Designed, not built. Knowledge, skills, and triggers now have a runtime.
 * Calling this throws so a route cannot pretend an eval runner exists.
 */

export interface EvalCase {
  id: string;
  task: string;
  expect: string;
  /** Rerun after a model or prompt change and diff the traces. */
}

export function notInThisVersion(feature: string): never {
  throw new Error(`${feature} is only a design note in this version. See ROADMAP.md.`);
}
