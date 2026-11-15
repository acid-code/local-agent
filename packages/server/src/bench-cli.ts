/** `node packages/server/dist/bench-cli.js [model]`: the runtime bench without the server (prints JSON at the end). LA_BENCH_GPU_BASE points the GPU run at a second (Vulkan) Ollama. */
import { benchRuntime } from './runtime-bench.js';

const norm = (url: string) => url.replace(/\/$/, '').replace(/^(?!https?:)/, 'http://');
const base = norm(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
const gpuBase = process.env.LA_BENCH_GPU_BASE ? norm(process.env.LA_BENCH_GPU_BASE) : undefined;
const report = await benchRuntime(fetch, base, { model: process.argv[2], gpuBase, log: (line) => process.stderr.write(line) });
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
