import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, type StrategyName } from '@local-agent/shared';
import { z } from 'zod';

export type AutoRole = 'fast' | 'main' | 'coder' | 'thinking' | 'cloud';

export interface PersonaContract {
  version: number;
  slug: string;
  name: string;
  purpose: string;
  guidelines: string;
  modelRole: AutoRole;
  contextBudgetTokens: number;
  tools: string[];
  approvals: string[];
  inputs: string[];
  outputs: string[];
  strategy: StrategyName;
}

const SLUGS = ['general', 'coder', 'planner', 'researcher', 'voice', 'router', 'trigger'] as const;

const planSchema = z.object({ items: z.array(z.string().min(1)).min(1).max(20) });
const replySchema = z.object({ content: z.string().min(1) });
const patchSchema = replySchema.extend({ diff: z.string().min(1) });
const handoffSchema = z.object({ to: z.string().min(1), message: z.string().min(1) });
const activitySchema = z.object({ label: z.string().min(1), body: z.string().min(1) });
const notificationSchema = z.object({ text: z.string().min(1) });
const routeSchema = z.object({ role: z.enum(['fast', 'main', 'coder', 'thinking', 'cloud']), reason: z.string().min(1) });
const triggerSchema = z.object({ kind: z.string().min(1), event: z.record(z.unknown()) });
const transcriptSchema = z.object({ transcript: z.string().min(1) });
const chatSchema = z.object({ content: z.string().min(1) });

export const outputSchemas = { plan: planSchema, reply: replySchema, patch: patchSchema, handoff: handoffSchema, activity: activitySchema, notification: notificationSchema, route: routeSchema };
export const inputSchemas = { chat: chatSchema, plan: planSchema, handoff: handoffSchema, trigger: triggerSchema, transcript: transcriptSchema };

const toolSchemas: Record<string, z.ZodTypeAny> = {
  // One object (not a union) so the model sees every field. No arguments reads the current plan.
  plan: z.object({
    items: z.array(z.string().min(1)).min(1).max(20).optional().describe('The full list of steps. Replaces the current plan.'),
    itemId: z.string().min(1).optional().describe('Id of one plan item to update instead of replacing the plan.'),
    status: z.string().optional().describe('New status for itemId: pending, doing, done, or blocked.'),
    text: z.string().optional().describe('New text for itemId.'),
    checks: z.array(z.string().min(1)).max(10).optional().describe('Acceptance checks that prove the work is done, e.g. "`npm test` passes" or "README lists the new flag". Commands in backticks are run-verified before the run may finish.'),
  }),
  git: z.object({
    action: z.enum(['status', 'diff', 'log', 'fetch', 'branch', 'checkout', 'commit', 'pull', 'push', 'force-push', 'revert', 'open_pr']),
    project: z.string().optional().describe('Project label when the chat has more than one project, or "workspace".'),
    name: z.string().optional().describe('Branch name for branch or checkout.'),
    message: z.string().optional().describe('Commit message.'),
    title: z.string().optional().describe('Pull request title (open_pr).'),
    body: z.string().optional().describe('Pull request body (open_pr).'),
    base: z.string().optional().describe('Base branch for open_pr. Defaults to main.'),
  }),
  consult_agent: z.object({ agent: z.string().min(1).describe('Teammate persona name.'), question: z.string().min(1) }),
  apply_patch: z.object({
    path: z.string().optional().describe('File to edit (single edit).'),
    search: z.string().optional().describe('Exact text to find. Empty creates the file.'),
    replace: z.string().optional().describe('Replacement text.'),
    edits: z.array(z.object({ path: z.string(), search: z.string(), replace: z.string() })).optional().describe('Several edits applied as one batch.'),
  }),
  repo_sync: z.object({ label: z.string().optional(), url: z.string().optional() }),
  shell: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe('Project label to run in, when this chat has more than one project.'),
  }),
  write_file: z.object({ path: z.string().min(1), content: z.string() }),
  create_file: z.object({ path: z.string().min(1), content: z.string() }),
  read_file: z.object({
    path: z.string().min(1),
    startLine: z.coerce.number().int().min(1).optional().describe('Optional 1-based first line, to read a slice of a large file.'),
    endLine: z.coerce.number().int().min(1).optional().describe('Optional 1-based last line (inclusive).'),
  }),
  web_search: z.object({ query: z.string().min(1) }),
  web_fetch: z.object({ url: z.string().min(1) }),
  request_secret: z.object({ name: z.string().min(1), reason: z.string().min(1), scope: z.string().optional() }),
};

export function personasDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../personas');
}

export function loadContract(slug: string): PersonaContract {
  const file = path.join(personasDir(), slug, 'contract.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PersonaContract;
  if (parsed.slug !== slug || parsed.version !== 1) throw new Error(`Contract ${slug} is not version 1.`);
  return parsed;
}

export function allContracts(): PersonaContract[] {
  return SLUGS.map((slug) => loadContract(slug));
}

export function contractForAgent(name: string): PersonaContract | null {
  const text = name.toLowerCase();
  if (text.includes('coder')) return loadContract('coder');
  if (text.includes('research')) return loadContract('researcher');
  if (text.includes('plan')) return loadContract('planner');
  if (text.includes('voice')) return loadContract('voice');
  if (text.includes('operator') || text.includes('general') || text.includes('house')) return loadContract('general');
  return null;
}

export function personaTemplate(slug: string) {
  const contract = loadContract(slug);
  return { id: slug, name: contract.name, description: contract.purpose, systemPrompt: contract.guidelines, tools: contract.tools, strategy: contract.strategy };
}

/**
 * Validation schema for a tool call. Objects pass unknown keys through: the contract checks the fields it knows,
 * and a field it does not list (a newer tool option) must still reach the tool instead of being silently dropped.
 */
export function toolArgumentsSchema(name: string): z.ZodTypeAny {
  const schema = toolSchemas[name];
  if (!schema) return z.record(z.unknown());
  return schema instanceof z.ZodObject ? schema.passthrough() : schema;
}

/** JSON schema derived from the contract alone (no tool-level descriptions). Prefer mergeToolParameters. */
export function toolParameters(name: string): Record<string, unknown> {
  const schema = toolSchemas[name];
  if (!schema) return { type: 'object', additionalProperties: true };
  return zodParameters(schema);
}

/**
 * The schema the model sees: the tool's own JSON schema, with the contract's fields, types, enums, and required list
 * layered on top. Descriptions from either side are kept, and no field either side knows about is lost.
 */
export function mergeToolParameters(name: string, own: Record<string, unknown> | undefined): Record<string, unknown> {
  const schema = toolSchemas[name];
  if (!schema) return own ?? { type: 'object', properties: {} };
  const contract = zodParameters(schema) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const ownProps = (own?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const properties: Record<string, Record<string, unknown>> = {};
  for (const key of new Set([...Object.keys(contract.properties ?? {}), ...Object.keys(ownProps)])) {
    const fromContract = contract.properties?.[key] ?? {};
    const fromTool = ownProps[key] ?? {};
    const merged: Record<string, unknown> = { ...fromTool, ...fromContract };
    const description = (fromTool.description as string | undefined) || (fromContract.description as string | undefined);
    if (description) merged.description = description;
    properties[key] = merged;
  }
  const result: Record<string, unknown> = { type: 'object', properties };
  const required = contract.required?.length ? contract.required : (own?.required as string[] | undefined);
  if (required?.length) result.required = required;
  if (own?.description) result.description = own.description;
  return result;
}

export function promptFits(contract: PersonaContract): { ok: boolean; tokens: number } {
  const tokens = estimateTokens(contract.guidelines, 'approx');
  return { ok: tokens <= contract.contextBudgetTokens * 0.5, tokens };
}

export function contractWarnings(localModelNames: string[]): string[] {
  const warnings: string[] = [];
  for (const name of localModelNames) {
    if (/embed|nomic-embed/i.test(name)) warnings.push(`${name} is an embedding model. It cannot take tool calls or structured JSON chat.`);
  }
  for (const contract of allContracts()) {
    const fit = promptFits(contract);
    if (!fit.ok) warnings.push(`${contract.name} guidelines are ${fit.tokens} tokens, over half of the ${contract.contextBudgetTokens} token budget.`);
  }
  return warnings;
}

/** Router contract: start on main, step up only for a stated reason. */
export function pickAutoRole(text: string, opts?: { failures?: number; tooLong?: boolean }): { role: AutoRole; reason: string } {
  const failures = opts?.failures ?? 0;
  if (/^\/smart\b/i.test(text) || /use the smart model/i.test(text)) return { role: 'cloud', reason: 'You asked for the smart model.' };
  if (opts?.tooLong) return { role: 'thinking', reason: 'The context is past the current model budget.' };
  if (failures >= 2) return { role: 'thinking', reason: 'Two attempts failed, so the turn steps up.' };
  if (/think harder/i.test(text)) return { role: 'thinking', reason: 'You asked to think harder.' };
  if (/\b(typo|fix|implement|refactor|bug|edit|commit|patch)\b/i.test(text)) return { role: 'coder', reason: 'This turn changes code.' };
  if (/\b(plan|design)\b/i.test(text)) return { role: 'thinking', reason: 'This turn is a plan.' };
  if (/\b(summarize|summary|one line|classify)\b/i.test(text) || text.trim().length < 24) return { role: 'fast', reason: 'A short reply stays on the fast model.' };
  return { role: 'main', reason: 'Ordinary turns stay on the main model.' };
}

export async function checkOrRepair<T>(schema: z.ZodType<T>, value: unknown, repair: (error: string) => Promise<unknown>): Promise<{ ok: true; value: T; repaired: boolean } | { ok: false; error: string }> {
  const first = schema.safeParse(value);
  if (first.success) return { ok: true, value: first.data, repaired: false };
  const message = first.error.issues.map((issue) => issue.message).join('; ') || 'does not match the contract';
  try {
    const next = await repair(message);
    const second = schema.safeParse(next);
    if (second.success) return { ok: true, value: second.data, repaired: true };
    const again = second.error.issues.map((issue) => issue.message).join('; ');
    return { ok: false, error: `Contract mismatch after one repair: ${again}` };
  } catch (error) {
    return { ok: false, error: `Contract mismatch. Repair failed: ${error instanceof Error ? error.message : 'invalid JSON'}. ${message}` };
  }
}

export function coderAllowsPushWithoutApproval(contract = loadContract('coder')): boolean {
  return !contract.approvals.includes('git:push');
}

function zodParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodEffects) return zodParameters(schema.innerType());
  if (schema instanceof z.ZodUnion) {
    // Merge every branch into one object of optional fields, so the model still sees each field.
    const properties: Record<string, unknown> = {};
    for (const option of schema.options as z.ZodTypeAny[]) {
      Object.assign(properties, (zodParameters(option).properties ?? {}) as Record<string, unknown>);
    }
    return { type: 'object', properties, description: 'One of the contract shapes for this tool.' };
  }
  if (!(schema instanceof z.ZodObject)) return { type: 'object' };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(shape)) {
    const optional = value instanceof z.ZodOptional || value instanceof z.ZodDefault;
    properties[key] = jsonType(value);
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
}

function jsonType(schema: z.ZodTypeAny): Record<string, unknown> {
  const description = schema.description;
  const withDescription = (value: Record<string, unknown>) => (description && !value.description ? { ...value, description } : value);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) return withDescription(jsonType(schema._def.innerType as z.ZodTypeAny));
  if (schema instanceof z.ZodEffects) return withDescription(jsonType(schema.innerType()));
  if (schema instanceof z.ZodString) return withDescription({ type: 'string' });
  if (schema instanceof z.ZodNumber) return withDescription({ type: (schema._def.checks ?? []).some((check: { kind: string }) => check.kind === 'int') ? 'integer' : 'number' });
  if (schema instanceof z.ZodBoolean) return withDescription({ type: 'boolean' });
  if (schema instanceof z.ZodEnum) return withDescription({ type: 'string', enum: schema.options });
  if (schema instanceof z.ZodArray) return withDescription({ type: 'array', items: jsonType(schema.element as z.ZodTypeAny) });
  if (schema instanceof z.ZodObject) return withDescription(zodParameters(schema));
  return withDescription({ type: 'object' });
}
