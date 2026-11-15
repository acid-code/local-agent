import type { StepRow } from './db.js';
import { falseSuccess } from './monitor.js';

/**
 * Honesty after tool errors. Every failed tool result carries a recovery route for the model; a final reply that claims
 * success while a failure is unrecovered is sent back for one or two recovery rounds, and if it still claims success the
 * user sees a note naming what failed.
 */
export const MAX_RECOVERY_ROUNDS = 2;

export const HONESTY_RULE = '\n\nTool errors: if a tool returns an error, that step did not happen. Fix the cause and retry once, try another tool, or tell the user plainly what failed and what they can do. Never say a step succeeded unless a tool result shows it.';

/** A short, error-specific route the model can take next. Appended to the tool's error result. */
export function recoveryHint(tool: string, error: string): string {
  const e = error.toLowerCase();
  const routes: string[] = [];
  if (/enoent|no such file|not found|does not exist|404/.test(e)) routes.push(tool === 'shell' && /command not found|not found:/.test(e) ? 'the command is not installed: use another tool, or say what needs installing' : 'check the path or name (list the folder or search first), then retry with the right one');
  if (/eacces|eperm|permission|denied|read-only|forbidden|403|401|unauthori/.test(e)) routes.push('this location or account is not allowed: use a path inside the workspace, or ask the user for access; do not retry the same call');
  if (/timeout|timed out|etimedout|econnreset|econnrefused|503|502|429|rate limit|network|fetch failed/.test(e)) routes.push('likely temporary: retry once; if it fails again, report it or use another source');
  if (/invalid|schema|expected|required|parse|json|argument|unknown option|usage:/.test(e)) routes.push('the arguments were wrong: fix them per the error and retry once');
  if (/exit (code )?[1-9]|exited with|non-zero|command failed/.test(e)) routes.push('read the command output above, fix the cause, and retry once');
  if (/blocked by guardrails|read-only mode|denied by the owner|not allowed to call/.test(e)) return '\n[recovery] This was refused on purpose. Do not retry it; tell the user what you could not do, or find a safe alternative.';
  if (!routes.length) routes.push('retry once with a fix, try another tool, or report the failure');
  return `\n[recovery] ${tool} failed, so this step did not happen. Next: ${routes.join('; ')}. Do not tell the user it worked.`;
}

/** Checks a final reply. `retry` means send it back to the model with `note`; `footer` means append it to the reply. */
export function checkFinalReply(steps: StepRow[], reply: string, rounds: number, turnsLeft: number, hebrew = false): { action: 'ok' } | { action: 'retry'; note: string; reason: string } | { action: 'footer'; footer: string; reason: string } {
  const verdict = falseSuccess(steps, reply, 'completed');
  if (!verdict.flagged) return { action: 'ok' };
  const failed = steps.filter((step) => verdict.failedTools.includes(step.name) && (step.status === 'failed' || step.error));
  const detail = failed.slice(-3).map((step) => `${step.name}: ${String(step.error ?? step.output ?? 'failed').slice(0, 200)}`).join('\n');
  if (rounds < MAX_RECOVERY_ROUNDS && turnsLeft > 1) {
    return {
      action: 'retry', reason: verdict.reason,
      note: `\n\nCHECK BEFORE ANSWERING: your last draft said the task succeeded, but these tool calls failed and nothing fixed them:\n${detail}\nEither recover now (fix the cause and call the tool again, or use another tool), or answer honestly: say what failed, what did work, and what the user can do. Do not claim it worked.`,
    };
  }
  const names = verdict.failedTools.join(', ');
  return {
    action: 'footer', reason: verdict.reason,
    footer: hebrew ? `\n\n⚠️ שימו לב: ${names} נכשל ולא תוקן, כך שחלק מהמשימה כנראה לא בוצע. בדקו את התוצאה.` : `\n\n⚠️ Note: ${names} failed and was not fixed, so part of this may not have happened. Please check the result.`,
  };
}
