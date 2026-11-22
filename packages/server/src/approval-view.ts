import type { Approval, Store } from './db.js';
import { redactValue } from './debug.js';

export type ApprovalRisk = 'safe' | 'low' | 'medium' | 'high';

/** The engine prefixes the reason with "[<tier> risk]" when the approval mode asks. Anything unknown counts as high, so a phone never one-taps it. */
export function riskFromReason(reason: string): ApprovalRisk {
  const match = /^\[(safe|low|medium|high) risk\]/i.exec(reason.trim());
  return (match?.[1]?.toLowerCase() as ApprovalRisk | undefined) ?? 'high';
}

/** One short line saying what will actually run, with secrets redacted. */
export function approvalSummary(toolName: string, args: unknown): string {
  const clean = redactValue(args) as Record<string, unknown> | null;
  if (!clean || typeof clean !== 'object') return toolName;
  const pick = ['command', 'path', 'action', 'url', 'name', 'to', 'query'].map((key) => clean[key]).find((value) => typeof value === 'string' && value.trim());
  const text = typeof pick === 'string' ? pick : JSON.stringify(clean);
  return text.length > 280 ? `${text.slice(0, 277)}…` : text;
}

/** What the approvals screens (web, phone, notifications) need to show a pending approval and jump to its chat. */
export function approvalView(store: Store, approval: Approval) {
  const run = store.getRun(approval.runId);
  const session = run ? store.getSession(run.sessionId) : null;
  const agent = run?.agentId ? store.getAgent(run.agentId) : null;
  return {
    id: approval.id,
    runId: approval.runId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    reason: approval.reason,
    status: approval.status,
    createdAt: approval.createdAt,
    risk: riskFromReason(approval.reason),
    summary: approvalSummary(approval.toolName, approval.args),
    sessionId: run?.sessionId ?? null,
    sessionTitle: session?.title ?? null,
    agentId: run?.agentId ?? null,
    agentName: agent?.name ?? null,
  };
}
