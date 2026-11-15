/** `node packages/server/dist/bench-cli.js [model]`: the runtime bench without the server (prints JSON at the end). */
import { benchRuntime } from './runtime-bench.js';

const base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '').replace(/^(?!https?:)/, 'http://');
const report = await benchRuntime(fetch, base, { model: process.argv[2], log: (line) => process.stderr.write(line) });
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
