import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GiB, MemoryBudget, readGtt, type LoadedInfo, type MemoryProbe } from '../src/memory.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function machine(init: { loaded?: LoadedInfo[]; gtt?: { usedBytes: number; totalBytes: number } | null; external?: number }) {
  const state = { loaded: [...(init.loaded ?? [])], gtt: init.gtt ?? null, unloaded: [] as string[] };
  const probe: MemoryProbe = {
    loaded: async () => state.loaded.map((model) => ({ ...model })),
    shape: async () => null,
    unload: async (name) => { state.unloaded.push(name); state.loaded = state.loaded.filter((item) => item.name !== name); },
    serverRss: () => 0.5 * GiB,
    pidRss: () => 0,
    systemAvailable: () => 100 * GiB,
    gtt: () => state.gtt,
    externalResident: () => init.external ?? 0,
  };
  return { state, budget: new MemoryBudget(probe, () => ({ budgetBytes: 60 * GiB, systemReserveBytes: 0 }), undefined, 10) };
}
const model = (name: string, gib: number): LoadedInfo => ({ name, sizeBytes: gib * GiB, contextLength: 8192 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

describe('GTT admission', () => {
  it('reads mem_info_gtt_used/total across cards', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'la-drm-')); dirs.push(root);
    fs.mkdirSync(path.join(root, 'card0', 'device'), { recursive: true });
    fs.writeFileSync(path.join(root, 'card0', 'device', 'mem_info_gtt_total'), String(40 * GiB));
    fs.writeFileSync(path.join(root, 'card0', 'device', 'mem_info_gtt_used'), String(25 * GiB));
    fs.mkdirSync(path.join(root, 'card1-HDMI-A-1'));
    expect(readGtt(root)).toEqual({ usedBytes: 25 * GiB, totalBytes: 40 * GiB });
    expect(readGtt(path.join(root, 'missing'))).toBeNull();
  });

  it('queues a load that does not fit free GTT minus headroom, and starts it when GTT frees', async () => {
    const { state, budget } = machine({ gtt: { usedBytes: 30 * GiB, totalBytes: 40 * GiB } });
    expect(await budget.fitsNow({ kind: 'chat', label: 'big', model: 'big', bytes: 9 * GiB })).toBe(false);
    let started = false;
    const pending = budget.admit({ kind: 'chat', label: 'big', model: 'big', bytes: 9 * GiB }).then((lease) => { started = true; return lease; });
    await tick();
    expect(started).toBe(false);
    state.gtt = { usedBytes: 20 * GiB, totalBytes: 40 * GiB };
    (await pending).release();
    expect(started).toBe(true);
  });

  it('never loads a third resident model: unloads an idle one first, else waits', async () => {
    const { state, budget } = machine({ loaded: [model('a', 4)], external: 1 });
    const lease = await budget.admit({ kind: 'chat', label: 'b', model: 'b', bytes: 4 * GiB });
    expect(state.unloaded).toEqual(['a']);
    // 'b' is now busy and llama-server holds the other slot: a third model waits.
    state.loaded = [model('b', 4)];
    expect(await budget.fitsNow({ kind: 'chat', label: 'c', model: 'c', bytes: 1 * GiB })).toBe(false);
    let started = false;
    const pending = budget.admit({ kind: 'chat', label: 'c', model: 'c', bytes: 1 * GiB }).then((next) => { started = true; return next; });
    await tick();
    expect(started).toBe(false);
    // A chat on a model that is already resident still starts.
    (await budget.admit({ kind: 'chat', label: 'b again', model: 'b', bytes: 4 * GiB })).release();
    lease.release();
    (await pending).release();
    expect(started).toBe(true);
  });

  it('keeps 4 GiB default GTT headroom and enforces 4 GiB OS reserve on unified-memory GPUs', async () => {
    // 30 GiB used + 4 GiB headroom leaves 6 GiB allocatable, so 7 GiB waits until GTT drops.
    const { state, budget } = machine({ gtt: { usedBytes: 30 * GiB, totalBytes: 40 * GiB } });
    expect(await budget.fitsNow({ kind: 'chat', label: 'mid', model: 'mid', bytes: 7 * GiB })).toBe(false);
    state.gtt = { usedBytes: 28 * GiB, totalBytes: 40 * GiB };
    expect(await budget.fitsNow({ kind: 'chat', label: 'mid', model: 'mid', bytes: 7 * GiB })).toBe(true);

    // Even when systemReserveBytes is configured lower (e.g. 1.5 GiB), GPU-backed machines enforce >= 4 GiB OS reserve.
    const lowRamProbe: MemoryProbe = {
      loaded: async () => [],
      shape: async () => null,
      unload: async () => {},
      serverRss: () => 0.5 * GiB,
      pidRss: () => 0,
      systemAvailable: () => 6 * GiB,
      gtt: () => ({ usedBytes: 20 * GiB, totalBytes: 40 * GiB }),
      externalResident: () => 1,
    };
    const strict = new MemoryBudget(lowRamProbe, () => ({ budgetBytes: 40 * GiB, systemReserveBytes: 1.5 * GiB }), undefined, 10);
    expect(await strict.fitsNow({ kind: 'chat', label: 'small', model: 'small', bytes: 3 * GiB })).toBe(false);
  });

  it('non-model jobs (the workbench) only need RAM', async () => {
    const { budget } = machine({ gtt: { usedBytes: 39 * GiB, totalBytes: 40 * GiB }, external: 2 });
    const lease = await budget.admit({ kind: 'background', label: 'workbench', bytes: 6 * GiB });
    expect(budget.snapshotActive()).toEqual([{ kind: 'background', label: 'workbench', model: undefined, bytes: 6 * GiB }]);
    lease.release();
  });
});
