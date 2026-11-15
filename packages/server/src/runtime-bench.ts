import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A short runtime bench the server runs on the real machine: the same prompt through Ollama on the CPU (num_gpu 0) and
 * with GPU offload (Vulkan/ROCm, whatever Ollama loaded), plus llama.cpp's llama-bench when it is on PATH. It picks the
 * runtime with the best decode speed, and only calls the GPU better when it is clearly faster (>= 15%).
 */
export interface BenchRun { runtime: string; ok: boolean; promptTps?: number; decodeTps?: number; gpuShare?: number; seconds?: number; error?: string }
export interface BenchReport {
  at: string; model: string; machine: { cpu: string; ramGiB: number; gpu: string | null; vulkan: string | null; rocm: string | null };
  runs: BenchRun[]; pick: string; why: string; untested: string[];
}

const PROMPT = 'Write three short sentences about the sea, then count from one to ten in words.';
const run = (bin: string, args: string[], ms = 15_000) => new Promise<string | null>((resolve) => execFile(bin, args, { timeout: ms, maxBuffer: 4 << 20 }, (error, stdout) => resolve(error ? null : String(stdout))));

export async function machineInfo() {
  const cpu = os.cpus()[0]?.model.trim() || 'unknown CPU';
  const ramGiB = Math.round(os.totalmem() / 2 ** 30);
  const vulkanRaw = await run('vulkaninfo', ['--summary'], 8000);
  const vulkan = vulkanRaw ? ([...vulkanRaw.matchAll(/deviceName\s*=\s*(.+)/g)].map((match) => match[1]!.trim()).filter((name) => !/llvmpipe/i.test(name))[0] ?? null) : null;
  const rocmRaw = await run('rocminfo', [], 8000);
  const rocm = rocmRaw ? (rocmRaw.match(/gfx\d+[a-z]?/)?.[0] ?? null) : null;
  let gpu: string | null = vulkan;
  if (!gpu && fs.existsSync('/sys/class/drm')) {
    const card = fs.readdirSync('/sys/class/drm').find((name) => /^card\d+$/.test(name) && fs.existsSync(`/sys/class/drm/${name}/device/mem_info_gtt_total`));
    if (card) gpu = `DRM ${card}`;
  }
  return { cpu, ramGiB, gpu, vulkan, rocm };
}

async function ollamaRun(fetchImpl: typeof fetch, base: string, model: string, cpu: boolean): Promise<BenchRun> {
  const runtime = cpu ? 'ollama-cpu' : 'ollama-gpu';
  try {
    const started = Date.now();
    // Warm-up loads the model with the right placement, then the timed run.
    const body = (predict: number) => JSON.stringify({ model, prompt: PROMPT, stream: false, keep_alive: '2m', options: { num_predict: predict, temperature: 0, seed: 1, ...(cpu ? { num_gpu: 0 } : {}) } });
    const warm = await fetchImpl(`${base}/api/generate`, { method: 'POST', body: body(4), signal: AbortSignal.timeout(300_000) });
    if (!warm.ok) return { runtime, ok: false, error: `HTTP ${warm.status}: ${(await warm.text()).slice(0, 200)}` };
    await warm.json();
    const response = await fetchImpl(`${base}/api/generate`, { method: 'POST', body: body(96), signal: AbortSignal.timeout(300_000) });
    const json = await response.json() as { prompt_eval_count?: number; prompt_eval_duration?: number; eval_count?: number; eval_duration?: number; error?: string };
    if (!response.ok || json.error) return { runtime, ok: false, error: json.error || `HTTP ${response.status}` };
    const ps = await fetchImpl(`${base}/api/ps`).then((res) => res.json() as Promise<{ models?: { name: string; size?: number; size_vram?: number }[] }>).catch(() => ({ models: [] }));
    const row = ps.models?.find((item) => item.name === model || item.name.startsWith(`${model}:`));
    const gpuShare = cpu ? 0 : row?.size ? Math.round(((row.size_vram ?? 0) / row.size) * 100) / 100 : undefined;
    return {
      runtime, ok: true, gpuShare, seconds: Math.round((Date.now() - started) / 100) / 10,
      promptTps: json.prompt_eval_duration ? Math.round(((json.prompt_eval_count ?? 0) / (json.prompt_eval_duration / 1e9)) * 10) / 10 : undefined,
      decodeTps: json.eval_duration ? Math.round(((json.eval_count ?? 0) / (json.eval_duration / 1e9)) * 10) / 10 : undefined,
    };
  } catch (error) {
    return { runtime, ok: false, error: error instanceof Error ? error.message : 'failed' };
  }
}

/** llama.cpp's own bench (Vulkan or CPU build, whichever is installed) on a GGUF file, when both are present. */
async function llamaBench(gguf: string | undefined): Promise<BenchRun | null> {
  if (!gguf || !fs.existsSync(gguf)) return null;
  const out = await run('llama-bench', ['-m', gguf, '-p', '128', '-n', '64', '-ngl', '99', '-o', 'json'], 600_000);
  if (out === null) return { runtime: 'llamacpp', ok: false, error: 'llama-bench is not installed or failed.' };
  try {
    const rows = JSON.parse(out) as { n_prompt: number; n_gen: number; avg_ts: number; backends?: string }[];
    const backend = (rows[0]?.backends || 'llamacpp').toLowerCase();
    return { runtime: `llamacpp-${backend}`, ok: true, promptTps: Math.round((rows.find((row) => row.n_prompt > 0)?.avg_ts ?? 0) * 10) / 10, decodeTps: Math.round((rows.find((row) => row.n_gen > 0)?.avg_ts ?? 0) * 10) / 10 };
  } catch { return { runtime: 'llamacpp', ok: false, error: 'Could not read llama-bench output.' }; }
}

export function choose(runs: BenchRun[], machine: BenchReport['machine']): { pick: string; why: string } {
  const ok = runs.filter((row) => row.ok && row.decodeTps);
  const cpu = ok.find((row) => row.runtime === 'ollama-cpu');
  // Ollama can report size_vram on a GPU-less box, so a GPU run only counts when a GPU is actually visible.
  const gpu = machine.gpu || machine.vulkan || machine.rocm ? ok.find((row) => row.runtime === 'ollama-gpu' && (row.gpuShare ?? 0) > 0) : undefined;
  const llama = ok.filter((row) => row.runtime.startsWith('llamacpp')).sort((a, b) => b.decodeTps! - a.decodeTps!)[0];
  if (!cpu && !gpu) return { pick: 'none', why: 'No Ollama run finished; check that Ollama is running and the model is pulled.' };
  const best = [cpu, gpu, llama].filter(Boolean).sort((a, b) => b!.decodeTps! - a!.decodeTps!)[0]!;
  if (llama && best === llama && (!gpu || llama.decodeTps! > gpu.decodeTps! * 1.15) && (!cpu || llama.decodeTps! > cpu.decodeTps! * 1.15)) {
    return { pick: llama.runtime, why: `llama.cpp decodes at ${llama.decodeTps} t/s, over 15% faster than Ollama; point an OpenAI-compatible provider at llama-server.` };
  }
  if (gpu && (!cpu || gpu.decodeTps! >= cpu.decodeTps! * 1.15 || (gpu.promptTps ?? 0) >= (cpu.promptTps ?? 0) * 2)) {
    const kind = machine.rocm && !machine.vulkan ? 'ollama-rocm' : 'ollama-vulkan';
    return { pick: kind, why: `GPU offload (${Math.round((gpu.gpuShare ?? 0) * 100)}% on GPU): ${gpu.decodeTps} t/s decode, ${gpu.promptTps ?? '?'} t/s prompt vs CPU ${cpu?.decodeTps ?? '?'} / ${cpu?.promptTps ?? '?'}.` };
  }
  if (!gpu && !machine.gpu) return { pick: 'ollama-cpu', why: `No GPU visible to Ollama; CPU decodes at ${cpu!.decodeTps} t/s.` };
  return { pick: 'ollama-cpu', why: `The GPU was not clearly faster (${gpu?.decodeTps ?? 'no GPU run'} vs CPU ${cpu?.decodeTps} t/s); stay on the CPU and keep the iGPU free.` };
}

export async function benchRuntime(fetchImpl: typeof fetch, base: string, opts: { model?: string; gguf?: string; gpuBase?: string; log?: (line: string) => void } = {}): Promise<BenchReport> {
  const log = opts.log ?? (() => undefined);
  const machine = await machineInfo();
  log(`Machine: ${machine.cpu}, ${machine.ramGiB} GB RAM, GPU ${machine.gpu ?? 'none'}${machine.vulkan ? ` (Vulkan: ${machine.vulkan})` : ''}${machine.rocm ? ` (ROCm: ${machine.rocm})` : ''}\n`);
  let model = opts.model;
  if (!model) {
    const tags = await fetchImpl(`${base}/api/tags`).then((res) => res.json() as Promise<{ models?: { name: string; size?: number }[] }>).catch(() => ({ models: [] }));
    model = (tags.models ?? []).filter((row) => !/embed|nomic|vl|vision/i.test(row.name)).sort((a, b) => (a.size ?? 0) - (b.size ?? 0)).find((row) => (row.size ?? 0) > 400e6)?.name;
  }
  if (!model) throw new Error('Pull a chat model first (any 1-4B model works for the bench).');
  const runs: BenchRun[] = [];
  for (const cpu of [true, false]) {
    const target = !cpu && opts.gpuBase ? opts.gpuBase : base;
    log(`Ollama ${cpu ? 'CPU only' : 'with GPU offload'} on ${model}${target !== base ? ` (Vulkan server at ${target})` : ''}…\n`);
    const result = await ollamaRun(fetchImpl, target, model, cpu);
    runs.push(result);
    log(result.ok ? `  decode ${result.decodeTps} t/s, prompt ${result.promptTps} t/s${result.gpuShare !== undefined ? `, ${Math.round(result.gpuShare * 100)}% on GPU` : ''}\n` : `  failed: ${result.error}\n`);
  }
  const llama = await llamaBench(opts.gguf ?? process.env.LA_BENCH_GGUF);
  if (llama) { runs.push(llama); log(llama.ok ? `llama-bench (${llama.runtime}): decode ${llama.decodeTps} t/s, prompt ${llama.promptTps} t/s\n` : `llama-bench: ${llama.error}\n`); }
  const { pick, why } = choose(runs, machine);
  const untested = [
    ...(machine.vulkan ? [] : ['Vulkan: no Vulkan GPU visible on this machine, so the GPU path was not measured.']),
    ...(machine.rocm ? [] : ['ROCm: rocminfo not found.']),
    ...(llama ? [] : ['llama.cpp: set LA_BENCH_GGUF to a .gguf file and install llama-bench to include it.']),
  ];
  log(`Pick: ${pick}. ${why}\n`);
  return { at: new Date().toISOString(), model, machine, runs, pick, why, untested };
}

export function saveBench(dataDir: string, report: BenchReport) {
  fs.writeFileSync(path.join(dataDir, 'runtime-bench.json'), JSON.stringify(report, null, 1));
}
export function loadBench(dataDir: string): BenchReport | null {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-bench.json'), 'utf8')) as BenchReport; } catch { return null; }
}
