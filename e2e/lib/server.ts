/** Starts the built server (packages/server/dist) on a free port with its own data folder, like a real install. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  });
}

export interface RunningServer {
  url: string; port: number; dataDir: string; logs: string[];
  stop(): Promise<void>; kill(): Promise<void>; restart(extraEnv?: Record<string, string>): Promise<void>;
}

export async function startServer(opts: { ollamaUrl: string; dataDir?: string; env?: Record<string, string>; root?: string }): Promise<RunningServer> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'la-e2e-'));
  const port = await freePort();
  const logs: string[] = [];
  let child: ChildProcess | null = null;
  let extra: Record<string, string> = {};
  const launch = async () => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(opts.root ?? ROOT, 'packages/server/dist/index.js')], {
      cwd: opts.root ?? ROOT,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.tmpdir(), TMPDIR: os.tmpdir(),
        DATA_DIR: dataDir, LA_HOST: '127.0.0.1', LA_PORT: String(port), LA_DISABLE_SETUP: '1',
        OLLAMA_HOST: opts.ollamaUrl, DOCKER_HOST: 'tcp://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9',
        WHISPER_URL: 'http://127.0.0.1:9', KOKORO_URL: 'http://127.0.0.1:9', LA_COOKIE_SECRET: 'e2e-cookie-secret-not-real-0123456789',
        ...opts.env, ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk) => logs.push(String(chunk)));
    child.stderr!.on('data', (chunk) => logs.push(String(chunk)));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`); if (res.status < 500) return; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join('')}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${logs.join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const end = async (signal: NodeJS.Signals) => {
    const running = child;
    if (!running || running.exitCode !== null) return;
    await new Promise<void>((resolve) => { running.once('exit', () => resolve()); running.kill(signal); setTimeout(() => { running.kill('SIGKILL'); }, 5000); });
    child = null;
  };
  await launch();
  return {
    url: `http://127.0.0.1:${port}`, port, dataDir, logs,
    stop: () => end('SIGTERM'),
    kill: () => end('SIGKILL'),
    async restart(extraEnv = {}) { extra = extraEnv; await end('SIGTERM'); await launch(); },
  };
}
