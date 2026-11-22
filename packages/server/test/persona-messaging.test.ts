import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Bus } from '../src/bus.js';
import { ensureFilesTable } from '../src/files.js';
import { GiB, MemoryBudget, type MemoryProbe } from '../src/memory.js';
import { dispatchPersonaMessage, listPersonaMessages, MAX_AUTO_STARTS_PER_WINDOW } from '../src/persona-messaging.js';
import { nid, now } from '../src/util.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-pmsg-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'test.db'));
  ensureFilesTable(store);
  const bus = new Bus();
  const researcher = store.createAgent({ name: 'Researcher', slug: 'researcher', systemPrompt: '', toolAllowlist: [], ownerId: 'owner', workspacePath: path.join(dir, 'ws-r') });
  const coder = store.createAgent({ name: 'Coder', slug: 'coder', systemPrompt: '', toolAllowlist: [], ownerId: 'owner', workspacePath: path.join(dir, 'ws-c') });
  const memberAgent = store.createAgent({ name: 'GuestBot', slug: 'guestbot', systemPrompt: '', toolAllowlist: [], ownerId: 'mem_1', workspacePath: path.join(dir, 'ws-m') });
  const rSession = store.createSession({ agentId: researcher.id, title: 'Research chat', ownerId: 'owner' });
  return { store, bus, researcher, coder, memberAgent, rSession };
}

describe('persona messaging and handoff', () => {
  it('delivers send_message, bumps unread, records in persona_messages, and auto-starts target run', async () => {
    const { store, bus, researcher, coder, rSession } = makeEnv();
    const started: any[] = [];
    const res = await dispatchPersonaMessage({
      store,
      bus,
      startTurn: async (input) => {
        started.push(input);
        return store.createRun({ sessionId: input.sessionId, agentId: input.agentId, configVersion: 1, cursor: { phase: 'route', turn: 0, ...input.cursorExtras } });
      },
      isRunActive: () => true,
      fromAgent: researcher,
      fromSessionId: rSession.id,
      fromRunId: 'run_1',
      currentHop: 0,
      kind: 'message',
      to: 'Coder',
      text: 'Found the root cause in auth.ts.',
    });

    expect(res.status).toBe('running');
    expect(started).toHaveLength(1);
    expect(started[0].background).toBe(true);
    expect(started[0].cursorExtras.hop).toBe(1);

    const updatedCoder = store.getAgent(coder.id)!;
    expect(updatedCoder.unread).toBe(1);

    const msgs = store.listMessages(res.toSessionId);
    expect(msgs.some((m) => m.content.includes('[persona-message|') && m.content.includes('Found the root cause'))).toBe(true);

    const rows = listPersonaMessages(store, { ownerId: 'owner' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromAgentId).toBe(researcher.id);
    expect(rows[0]!.toAgentId).toBe(coder.id);
    expect(rows[0]!.hop).toBe(1);
    store.close();
  });

  it('refuses messages when hop > 3 and logs refused status', async () => {
    const { store, bus, researcher, rSession } = makeEnv();
    await expect(dispatchPersonaMessage({
      store,
      bus,
      startTurn: async () => { throw new Error('should not start'); },
      isRunActive: () => true,
      fromAgent: researcher,
      fromSessionId: rSession.id,
      fromRunId: 'run_1',
      currentHop: 3,
      kind: 'handoff',
      to: 'Coder',
      text: 'One hop too far',
    })).rejects.toThrow(/hop limit \(3\) exceeded/i);

    const rows = listPersonaMessages(store, { ownerId: 'owner' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('refused');
    expect(rows[0]!.hop).toBe(4);
    store.close();
  });

  it('enforces max 3 auto-started runs per target persona per 10 minutes', async () => {
    const { store, bus, researcher, rSession } = makeEnv();
    const startTurn = async (input: any) => store.createRun({ sessionId: input.sessionId, agentId: input.agentId, configVersion: 1, cursor: { phase: 'route', turn: 0 } });

    for (let i = 0; i < MAX_AUTO_STARTS_PER_WINDOW; i += 1) {
      await dispatchPersonaMessage({
        store, bus, startTurn, isRunActive: () => true,
        fromAgent: researcher, fromSessionId: rSession.id, fromRunId: `run_${i}`,
        currentHop: 0, kind: 'message', to: 'Coder', text: `Ping ${i}`,
      });
    }

    // 4th handoff is refused due to rate limit.
    await expect(dispatchPersonaMessage({
      store, bus, startTurn, isRunActive: () => true,
      fromAgent: researcher, fromSessionId: rSession.id, fromRunId: 'run_4',
      currentHop: 0, kind: 'handoff', to: 'Coder', text: 'Too many',
    })).rejects.toThrow(/rate limit reached/i);

    // 4th send_message delivers the note without starting a run.
    const msg4 = await dispatchPersonaMessage({
      store, bus, startTurn, isRunActive: () => true,
      fromAgent: researcher, fromSessionId: rSession.id, fromRunId: 'run_5',
      currentHop: 0, kind: 'message', to: 'Coder', text: 'Note only',
    });
    expect(msg4.toRunId).toBeNull();
    expect(msg4.status).toBe('sent');
    store.close();
  });

  it('returns handoff result directly while sender is running, and posts back to sender chat if sender finished', async () => {
    const { store, bus, researcher, rSession } = makeEnv();
    // Case 1: sender is still running -> direct tool result.
    const res1 = await dispatchPersonaMessage({
      store,
      bus,
      startTurn: async (input) => {
        const run = store.createRun({ sessionId: input.sessionId, agentId: input.agentId, configVersion: 1, cursor: { phase: 'route', turn: 0 } });
        store.insertMessage({ sessionId: input.sessionId, role: 'assistant', content: 'Fixed the bug and tests pass.', toolCalls: null, agentId: input.agentId, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: null });
        const done = store.updateRun(run.id, { status: 'completed', endedAt: now() })!;
        setTimeout(() => input.onDone?.(done), 10);
        return run;
      },
      isRunActive: () => true,
      fromAgent: researcher,
      fromSessionId: rSession.id,
      fromRunId: 'run_sender_1',
      currentHop: 0,
      kind: 'handoff',
      to: 'Coder',
      text: 'Fix the auth bug',
    });
    expect(res1.status).toBe('completed');
    expect(res1.result).toBe('Fixed the bug and tests pass.');

    // Case 2: sender wait times out and sender finishes before target finishes -> result posted to sender chat.
    let triggerDone: (() => void) | null = null;
    const res2 = await dispatchPersonaMessage({
      store,
      bus,
      startTurn: async (input) => {
        const run = store.createRun({ sessionId: input.sessionId, agentId: input.agentId, configVersion: 1, cursor: { phase: 'route', turn: 0 } });
        triggerDone = () => {
          store.insertMessage({ sessionId: input.sessionId, role: 'assistant', content: 'Async result ready.', toolCalls: null, agentId: input.agentId, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: null });
          const done = store.updateRun(run.id, { status: 'completed', endedAt: now() })!;
          input.onDone?.(done);
        };
        return run;
      },
      isRunActive: () => false, // sender already ended
      fromAgent: researcher,
      fromSessionId: rSession.id,
      fromRunId: 'run_sender_2',
      currentHop: 0,
      kind: 'handoff',
      to: 'Coder',
      text: 'Long background refactor',
      handoffWaitMs: 15,
    });
    expect(res2.status).toBe('running');
    triggerDone!();
    const senderMsgs = store.listMessages(rSession.id);
    expect(senderMsgs.some((m) => m.content.includes('Async result ready.'))).toBe(true);
    expect(store.getAgent(researcher.id)!.unread).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it('enforces member isolation: members cannot message owner personas and vice versa', async () => {
    const { store, bus, researcher, memberAgent, rSession } = makeEnv();
    const startTurn = async () => { throw new Error('should not start'); };
    await expect(dispatchPersonaMessage({
      store, bus, startTurn, isRunActive: () => true,
      fromAgent: researcher, fromSessionId: rSession.id, fromRunId: 'r1',
      currentHop: 0, kind: 'message', to: 'GuestBot', text: 'Hello member',
    })).rejects.toThrow(/another account/i);

    await expect(dispatchPersonaMessage({
      store, bus, startTurn, isRunActive: () => true,
      fromAgent: memberAgent, fromSessionId: null, fromRunId: 'r2',
      currentHop: 0, kind: 'message', to: 'Coder', text: 'Hello owner',
    })).rejects.toThrow(/another account/i);
    store.close();
  });

  it('respects personaAutoStart setting toggle and queues auto-started background runs under memory pressure', async () => {
    const { store, bus, researcher, rSession } = makeEnv();
    const cur = store.getSettings();
    store.saveSettings({ ...cur, personaAutoStart: false }, 'disable auto start', {});

    const delivered = await dispatchPersonaMessage({
      store, bus,
      startTurn: async () => { throw new Error('should not auto-start'); },
      isRunActive: () => true,
      fromAgent: researcher, fromSessionId: rSession.id, fromRunId: 'r1',
      currentHop: 0, kind: 'message', to: 'Coder', text: 'FYI only',
    });
    expect(delivered.toRunId).toBeNull();
    expect(delivered.status).toBe('sent');

    // Re-enable and verify background admission queues under MemoryBudget pressure.
    store.saveSettings({ ...cur, personaAutoStart: true }, 'enable auto start', {});
    const probe: MemoryProbe = {
      serverRss: () => 0.5 * GiB,
      systemAvailable: () => 20 * GiB,
      loaded: async () => [],
      show: async () => null,
      unload: async () => undefined,
    };
    const budget = new MemoryBudget(probe, () => ({ budgetBytes: 12 * GiB, systemReserveBytes: 2 * GiB, parallelSlots: 1 }));
    const holder = await budget.admit({ kind: 'chat', label: 'user-chat', model: 'm1', bytes: 10 * GiB });

    let waited = false;
    let admitted = false;
    await dispatchPersonaMessage({
      store, bus,
      startTurn: async (input) => {
        expect(input.background).toBe(true);
        const run = store.createRun({ sessionId: input.sessionId, agentId: input.agentId, configVersion: 1, cursor: { phase: 'route', turn: 0, background: true } });
        void budget.admit({
          kind: 'background', label: 'auto-run', model: 'm2', bytes: 10 * GiB, runId: run.id,
          onWait: () => { waited = true; },
        }).then((lease) => { admitted = true; lease.release(); });
        return run;
      },
      isRunActive: () => true,
      fromAgent: researcher, fromSessionId: rSession.id, fromRunId: nid('run'),
      currentHop: 0, kind: 'message', to: 'Coder', text: 'Queued under pressure',
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(waited).toBe(true);
    expect(admitted).toBe(false);
    holder.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(admitted).toBe(true);
    store.close();
  });
});
