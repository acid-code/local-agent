import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../src/providers.js';
import { buildApp } from '../src/app.js';
import {
  allContracts,
  personasDir,
  checkOrRepair,
  coderAllowsPushWithoutApproval,
  contractForAgent,
  loadContract,
  outputSchemas,
  pickAutoRole,
  promptFits,
  toolArgumentsSchema,
  toolParameters,
} from '../src/contracts.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const golden = JSON.parse(fs.readFileSync(path.join(personasDir(), 'golden.json'), 'utf8')) as {
  cases: { persona: string; input: { text?: string }; expectRole?: string; mockOutput?: unknown; expectOutput?: string; forbid?: string }[];
};

describe('persona contracts', () => {
  it('loads a versioned contract for every shipped persona', () => {
    const slugs = allContracts().map((contract) => contract.slug);
    expect(slugs).toEqual(['general', 'coder', 'planner', 'researcher', 'voice', 'router', 'trigger']);
    for (const contract of allContracts()) {
      expect(contract.version).toBe(1);
      expect(contract.guidelines.length).toBeGreaterThan(40);
      expect(promptFits(contract).ok).toBe(true);
    }
    expect(coderAllowsPushWithoutApproval()).toBe(false);
    expect(loadContract('coder').approvals).toContain('git:push');
    expect(loadContract('coder').approvals).toContain('git:force-push');
  });

  it('routes the golden samples and parses mock outputs', () => {
    for (const sample of golden.cases) {
      if (sample.expectRole) {
        expect(pickAutoRole(sample.input.text || '').role).toBe(sample.expectRole);
      }
      if (sample.expectOutput && sample.mockOutput) {
        const parsed = outputSchemas[sample.expectOutput as keyof typeof outputSchemas].safeParse(sample.mockOutput);
        expect(parsed.success, sample.persona).toBe(true);
      }
    }
    expect(pickAutoRole('hello').role).toBe('fast');
    expect(pickAutoRole('what should I cook tonight?').role).toBe('main');
  });

  it('repairs a tool call once, then fails in the timeline instead of running it', async () => {
    const bad = await checkOrRepair(toolArgumentsSchema('plan'), { items: [] }, async () => ({ items: ['Read the readme'] }));
    expect(bad.ok && bad.repaired).toBe(true);
    const worse = await checkOrRepair(toolArgumentsSchema('plan'), { items: [] }, async () => { throw new Error('not json'); });
    expect(worse.ok).toBe(false);
    expect(toolParameters('consult_agent').required).toEqual(['agent', 'question']);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-contract-'));
    dirs.push(dir);
    const script = new ScriptedProvider([
      { toolCalls: [{ id: 'p', name: 'plan', arguments: '{"items":[]}' }] },
    ]);
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => script });
    const agent = store.createAgent({ name: 'Planner', systemPrompt: 'plan', toolAllowlist: ['plan'], workspacePath: dir, modelId: 'model_rehearsal' });
    const session = store.createSession({ agentId: agent.id });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'plan the readme', wait: true });
    expect(run.status === 'completed' || run.status === 'failed').toBe(true);
    const steps = store.listSteps(run.id);
    expect(steps.some((step) => step.kind === 'contract' && step.status === 'failed')).toBe(true);
    const text = store.listMessages(session.id).map((message) => message.content).join('\n');
    expect(text).toMatch(/Contract mismatch/);
    expect(contractForAgent('Planner')?.slug).toBe('planner');
    await app.close();
  });
});
