import type { StepRow } from './db.js';
import { falseSuccess } from './monitor.js';

/**
 * Honesty after tool errors. Every failed tool result carries a recovery route for the model; a final reply that claims
 * success while a failure is unrecovered is sent back for one or two recovery rounds, and if it still claims success the
 * user sees a note naming what failed.
 */
export const MAX_RECOVERY_ROUNDS = 2;

export const HONESTY_RULE = '\n\nTool errors & self-check: if a tool returns an error, that step did not happen — fix the cause and retry, try another tool, or report plainly what failed. Never claim you cannot do something when you have a tool for it (such as make_slides for .pptx, read_image_text for OCR, generate_image for images, web_search for web lookup, or propose_skill/run_skill_script for reusable skills & tools). Before finalizing any non-trivial answer, double-check your own work, verify outputs, and loop to fix any gaps.';

const CAPABILITY_CHECKS: { tool: string; label: string; deny: RegExp }[] = [
  { tool: 'make_slides', label: 'make_slides (creates real .pptx files with optional generated images)', deny: /(?:can(?:'t|not)|unable to|❌[^.\n]*)\s*(?:directly\s+)?(?:create|generate|make|build|export|produce)\s+(?:a\s+)?(?:\.pptx|pptx|powerpoint|slide\s*deck)/i },
  { tool: 'read_image_text', label: 'read_image_text (runs OCR on images)', deny: /(?:can(?:'t|not)|unable to|❌[^.\n]*)\s*(?:run\s+ocr|read\s+text\s+from\s+images|extract\s+text\s+from\s+images|perform\s+ocr)/i },
  { tool: 'understand_image', label: 'understand_image (analyzes scenes, colors/shades/hexes, charts/numbers, and visual details in images)', deny: /(?:can(?:'t|not)|unable to|❌[^.\n]*)\s*(?:see|view|inspect|analyze|describe|understand)\s+(?:the\s+)?(?:images?|photos?|pictures?|screenshots?)/i },
  { tool: 'generate_image', label: 'generate_image (generates images locally)', deny: /(?:can(?:'t|not)|unable to|❌[^.\n]*)\s*(?:directly\s+)?(?:create|generate|make|render)\s+(?:an?\s+)?images?\b/i },
  { tool: 'web_search', label: 'web_search (searches the web via SearXNG)', deny: /(?:can(?:'t|not)|unable to|do not have access to|❌[^.\n]*)\s*(?:browse|search)\s+the\s+(?:web|internet)/i },
];

/** Catches drafts where the model falsely claims it lacks a built-in tool that is actively attached right now. */
export function falseInability(reply: string, availableTools: string[]): { tool: string; label: string } | null {
  if (!availableTools.length || !reply.trim()) return null;
  const set = new Set(availableTools);
  for (const check of CAPABILITY_CHECKS) {
    if (set.has(check.tool) && check.deny.test(reply)) return { tool: check.tool, label: check.label };
  }
  return null;
}

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
export function checkFinalReply(steps: StepRow[], reply: string, rounds: number, turnsLeft: number, hebrew = false, availableTools: string[] = []): { action: 'ok' } | { action: 'retry'; note: string; reason: string } | { action: 'footer'; footer: string; reason: string } {
  const missed = falseInability(reply, availableTools);
  if (missed && rounds < MAX_RECOVERY_ROUNDS && turnsLeft > 1) {
    return {
      action: 'retry',
      reason: `Claimed inability despite having ${missed.tool}`,
      note: `\n\nCAPABILITY SELF-CHECK: Your last draft claimed you cannot do this, but you DO have the tool ${missed.label} available right now! Call ${missed.tool} immediately and deliver the real result instead of refusing.`,
    };
  }
  const verdict = falseSuccess(steps, reply, 'completed');
  if (!verdict.flagged) return doneCheck(steps, reply, rounds, turnsLeft, availableTools);
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

// ── Done check ────────────────────────────────────────────────────────────────────────────────────────────────
const ACTION_VERBS = 'check|run|create|fix|update|implement|continue|start|proceed|look|read|write|search|install|build|test|deploy|add|open|edit|apply|make|do|try|verify|go ahead|begin|investigate|patch|refactor|commit|push';
const PROMISE_EN = new RegExp(`^(?:ok(?:ay)?[,!.]?\\s*|great[,!.]?\\s*|now,?\\s*|next,?\\s*|first,?\\s*)*(?:i'?ll|i will|let me|i'?m going to|i am going to|i'?m now going to)\\s+(?:now\\s+|first\\s+|quickly\\s+)?(?:${ACTION_VERBS})\\b`, 'i');
const PROMISE_HE = /^(?:עכשיו |כעת |קודם |בסדר[,.]? )*(?:אני )?(?:אבדוק|אריץ|אתקן|אצור|אמשיך|אעדכן|אתחיל|אכתוב|אחפש|אתקין|אבנה|אפתח|אנסה|אוסיף)/;
const CODE_FILE = /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)\b/gi;
const EDIT_TOOLS = new Set(['create_file', 'write_file', 'apply_patch', 'edit_file']);

/** The reply only announces what it is about to do ("I'll now run the tests.") instead of doing it or answering. */
export function promiseOnly(reply: string): boolean {
  const text = reply.trim();
  if (!text || text.length > 1500 || /\?\s*$/.test(text)) return false;
  const sentences = text.split(/(?<=[.!:…])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const last = sentences.at(-1) ?? '';
  if (/let me know/i.test(last)) return false;
  return PROMISE_EN.test(last) || PROMISE_HE.test(last);
}

/** Code files edited after the last shell command: nothing ran tests, a build or the code since. */
export function unverifiedEdits(steps: Pick<StepRow, 'kind' | 'name' | 'status' | 'input' | 'index'>[]): string[] {
  const done = steps.filter((step) => step.kind === 'tool' && step.status === 'completed');
  const lastShell = Math.max(-1, ...done.filter((step) => step.name === 'shell' || step.name === 'run_tests').map((step) => step.index));
  const files = new Set<string>();
  for (const step of done) {
    if (!EDIT_TOOLS.has(step.name) || step.index < lastShell) continue;
    for (const match of JSON.stringify(step.input ?? '').slice(0, 20_000).match(CODE_FILE) ?? []) files.add(match.replace(/^[ab]\//, ''));
  }
  return [...files].slice(0, 8);
}

function alreadyAsked(steps: Pick<StepRow, 'kind' | 'name' | 'output'>[], marker: string) {
  return steps.some((step) => step.kind === 'contract' && step.name === 'verify' && String(step.output ?? '').includes(marker));
}

/** After the honesty checks: no promise-only endings, and code edits get verified before the run ends (once each). */
export function doneCheck(steps: StepRow[], reply: string, rounds: number, turnsLeft: number, availableTools: string[] = []): { action: 'ok' } | { action: 'retry'; note: string; reason: string } {
  if (turnsLeft <= 1 || rounds >= MAX_RECOVERY_ROUNDS) return { action: 'ok' };
  if (promiseOnly(reply) && !alreadyAsked(steps, 'Promised')) {
    return {
      action: 'retry', reason: 'Promised a next step instead of doing it',
      note: '\n\nKEEP GOING: your last message only said what you were about to do. Do it now with the tools (call them in this step), then answer with the result. If you are truly finished, give the final answer instead.',
    };
  }
  const edited = availableTools.includes('shell') ? unverifiedEdits(steps) : [];
  if (edited.length && !alreadyAsked(steps, 'Unverified code edits')) {
    return {
      action: 'retry', reason: `Unverified code edits (${edited.join(', ')})`,
      note: `\n\nVERIFY BEFORE ANSWERING: you changed ${edited.join(', ')} but ran nothing since. Run the project's tests, typecheck or build (or execute the changed code) with shell, fix what fails, then answer with what you ran and its result. If nothing can be run here, say so plainly in your answer.`,
    };
  }
  return { action: 'ok' };
}
