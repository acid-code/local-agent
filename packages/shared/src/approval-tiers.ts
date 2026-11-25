import { hasShellRedirect, withoutHarmlessRedirects } from './guard.js';
/**
 * Risk-based approval tiers. Every tool call gets a tier; the approval mode decides which tiers ask first.
 *   safe   read-only (read, list, search, fetch): never asks
 *   low    reversible changes inside the workspace (file writes with a checkpoint, sandboxed non-destructive shell)
 *   medium destructive but contained (rm/mv in the sandbox, new containers, scripts, unknown connector actions)
 *   high   leaves the box or cannot be undone (push, publish, send, pay, delete containers, sudo, kill, saving skills)
 * Modes: cautious asks for low and up (and anything a tool flags), balanced asks for medium and up, autonomous only high.
 */
export type RiskTier = 'safe' | 'low' | 'medium' | 'high';
export type ApprovalMode = 'cautious' | 'balanced' | 'autonomous';
export const RISK_ORDER: RiskTier[] = ['safe', 'low', 'medium', 'high'];

const SAFE_TOOLS = new Set([
  'read_file', 'list_dir', 'grep', 'glob', 'find_tools', 'find_context', 'time_now',
  'kb_search', 'web_search', 'web_fetch', 'recall', 'search_chats', 'docker_ps', 'docker_inspect',
  'read_slides', 'load_skill', 'read_output', 'consult_agent', 'read_image_text', 'understand_image',
]);
const LOW_TOOLS = new Set(['write_file', 'make_slides', 'memory_file', 'remember', 'plan', 'send_message', 'handoff']);
const HIGH_SHELL = [/\bsudo\b/i, /\bgit\s+push\b/i, /\bnpm\s+publish\b/i, /\bdocker\b[^\n]*\b(rm|rmi|system|prune|kill)\b/i, /\b(kill|pkill|killall)\b/i, /\b(mount|umount)\b/i, /\bch(mod|own)\s+-R\b/i, /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\.|\$HOME)/i, /\b(ssh|scp|rsync)\b[^\n]*@/i, /\bcurl\b[^\n]*-X\s*(POST|PUT|DELETE|PATCH)/i];
const MEDIUM_SHELL = [/\brm\b/i, /\bmv\b/i, /\bchmod\b/i, /\bchown\b/i, /\btee\b/i, /\bgit\s+(reset|clean|checkout\s+--|rebase)\b/i];
const HIGH_ACTION = /(^|_)(send|post|publish|delete|remove|destroy|pay|purchase|buy|transfer|merge|deploy|share|invite|reply|comment|create_(issue|pull|pr|draft|event)|update_(issue|event)|push)(_|$)/i;

export function riskOf(tool: string, args: Record<string, unknown>, declared: string | null): { tier: RiskTier; why: string } {
  if (tool === 'shell') {
    const command = String(args.command ?? '');
    // 2>/dev/null and 2>&1 must not count as writes; same rule as assessCommand.
    const cleaned = withoutHarmlessRedirects(command);
    if (/\bapt(-get)?\s+install\b/i.test(command)) return { tier: 'high', why: `Installs system packages in the shared workbench (affects all personas): ${command.slice(0, 160)}` };
    if (HIGH_SHELL.some((pattern) => pattern.test(command))) return { tier: 'high', why: `Shell command with effects outside the workspace: ${command.slice(0, 160)}` };
    if (hasShellRedirect(command) || MEDIUM_SHELL.some((pattern) => pattern.test(cleaned))) return { tier: 'medium', why: `Shell command changes or deletes files: ${command.slice(0, 160)}` };
    return { tier: 'low', why: `Shell command: ${command.slice(0, 160)}` };
  }
  if (tool === 'docker_rm') return { tier: 'high', why: declared ?? 'Remove a container' };
  if (tool === 'browse') {
    const url = String(args.url ?? '');
    const actions = Array.isArray(args.actions) ? (args.actions as { type?: string; url?: string; selector?: string; text?: string }[]) : [];
    const payUrl = /\/(checkout|pay(ment)?|billing|cart|order|purchase|buy)\b/i;
    const payText = /\b(pay\s*now|buy\s*now|place\s*order|complete\s*(purchase|order|payment)|checkout|submit\s*payment|confirm\s*purchase|purchase)\b/i;
    const onPay = payUrl.test(url) || actions.some((a) => a.type === 'navigate' && payUrl.test(String(a.url ?? '')));
    const isPaySubmit = actions.some((a) => {
      const target = `${a.selector ?? ''} ${a.text ?? ''}`;
      if (a.type === 'submit') return onPay || payText.test(target);
      if (a.type === 'click') return payText.test(target) || (onPay && /\b(submit|confirm|continue|buy|pay|order)\b/i.test(target));
      return false;
    });
    if (isPaySubmit) return { tier: 'high', why: 'Submit or purchase action on a payment/checkout page' };
  }
  // Skills keep their last versions and can be deleted, so text-only skills are reversible: a new one is low, an update
  // medium. A skill that ships a script runs code for every persona, so it always asks.
  if (tool === 'propose_skill') {
    if (args.scriptName || args.scriptBody) return { tier: 'high', why: declared ?? 'Save a skill with a script' };
    return { tier: args.slug ? 'medium' : 'low', why: declared ?? 'Save a skill' };
  }
  if (tool === 'git' && ['status', 'diff', 'log', 'fetch', 'branches', 'show'].includes(String(args.action ?? ''))) return { tier: 'safe', why: 'git (read-only)' };
  if (tool === 'git' && /push|remote|open_pr/.test(String(args.action ?? ''))) return { tier: 'high', why: declared ?? `git ${String(args.action)}` };
  if (SAFE_TOOLS.has(tool)) return { tier: declared ? 'low' : 'safe', why: declared ?? `${tool} (read-only)` };
  if (LOW_TOOLS.has(tool)) return { tier: 'low', why: declared ?? `${tool} in the workspace` };
  if (HIGH_ACTION.test(tool) || HIGH_ACTION.test(String(args.action ?? ''))) return { tier: 'high', why: declared ?? `${tool} acts outside this box` };
  if (declared) return { tier: 'medium', why: declared };
  return { tier: /(^|_)(get|list|read|search|find|fetch|query|describe|show|view)(_|$)/i.test(tool) ? 'safe' : 'low', why: tool };
}

export function needsApproval(tier: RiskTier, declared: string | null, mode: ApprovalMode): boolean {
  if (tier === 'high') return true;
  if (mode === 'autonomous') return false;
  if (mode === 'balanced') return tier === 'medium';
  return tier !== 'safe' && (tier === 'medium' || Boolean(declared));
}
