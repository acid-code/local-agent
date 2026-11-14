import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { hfUrl, imageFileName, imageModelBytes, type ImageModelSpec } from '@local-agent/shared';
import { defaultBinary, imageDir, modelInstalled, modelsDir } from './images.js';
import { DockerCtl } from './docker.js';

/** Download and install jobs for the image role. One at a time per target; progress is polled by the setup site. */
export interface ImageJob {
  id: string;
  kind: 'model' | 'runner';
  target: string;
  status: 'running' | 'done' | 'error';
  file?: string;
  received: number;
  total: number;
  error?: string;
  startedAt: string;
}

const jobs = new Map<string, ImageJob>();
export const listImageJobs = () => [...jobs.values()];

export function diskFree(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch { return null; }
}

/** Bytes still to fetch for a model (partial .part files count as already fetched). */
export function bytesNeeded(dataDir: string, spec: ImageModelSpec) {
  return spec.files.reduce((sum, file) => {
    const full = path.join(modelsDir(dataDir), imageFileName(file));
    if (fs.existsSync(full)) return sum;
    const part = `${full}.part`;
    return sum + Math.max(0, file.bytes - (fs.existsSync(part) ? fs.statSync(part).size : 0));
  }, 0);
}

export function modelState(dataDir: string, spec: ImageModelSpec) {
  return { ...spec, totalBytes: imageModelBytes(spec), neededBytes: bytesNeeded(dataDir, spec), installed: modelInstalled(dataDir, spec), gated: spec.files.some((file) => file.gated) };
}

/** Fetch every file of a model from Hugging Face into <dataDir>/image/models, resuming .part files. */
export function startModelDownload(dataDir: string, spec: ImageModelSpec, opts: { token?: string | null; fetchImpl?: typeof fetch }) {
  const key = `model:${spec.id}`;
  const existing = jobs.get(key);
  if (existing?.status === 'running') return existing;
  if (spec.files.some((file) => file.gated) && !opts.token) {
    const gated = spec.files.find((file) => file.gated)!;
    throw Object.assign(new Error(`${spec.name} needs a Hugging Face token: accept the licence at https://huggingface.co/${gated.repo}, then save the token as HF_TOKEN in the vault.`), { statusCode: 400 });
  }
  const free = diskFree(modelsDir(dataDir));
  const needed = bytesNeeded(dataDir, spec);
  if (free !== null && free < needed + 2 * 1024 ** 3) throw Object.assign(new Error(`Not enough disk: ${spec.name} needs ${gb(needed)} and leaves less than 2 GB free (${gb(free)} free).`), { statusCode: 400 });
  const job: ImageJob = { id: key, kind: 'model', target: spec.id, status: 'running', received: imageModelBytes(spec) - needed, total: imageModelBytes(spec), startedAt: new Date().toISOString() };
  jobs.set(key, job);
  const fetchImpl = opts.fetchImpl ?? fetch;
  void (async () => {
    try {
      fs.mkdirSync(modelsDir(dataDir), { recursive: true });
      for (const file of spec.files) {
        const full = path.join(modelsDir(dataDir), imageFileName(file));
        if (fs.existsSync(full)) continue;
        job.file = imageFileName(file);
        const part = `${full}.part`;
        const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        const headers: Record<string, string> = {};
        if (have) headers.range = `bytes=${have}-`;
        if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        const response = await fetchImpl(hfUrl(file), { headers, redirect: 'follow' });
        if (response.status === 401 || response.status === 403) throw new Error(`Hugging Face refused ${file.repo}. Accept its licence on huggingface.co and check the HF_TOKEN in the vault.`);
        if (!response.ok || !response.body) throw new Error(`Download of ${job.file} failed (${response.status}).`);
        const append = have > 0 && response.status === 206;
        if (!append) job.received -= have;
        const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          job.received += value.byteLength;
          if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
        await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
        fs.renameSync(part, full);
      }
      job.status = 'done';
      job.file = undefined;
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  })();
  return job;
}

const RELEASES = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=5';

/** Which prebuilt stable-diffusion.cpp asset fits this machine. Vulkan when a GPU device is present (iGPU), else CPU. */
export function pickRunnerAsset(names: string[], platform = process.platform, arch = process.arch, gpu = fs.existsSync('/dev/dri')): string | null {
  const ok = (pattern: RegExp) => names.find((name) => pattern.test(name)) ?? null;
  if (platform === 'linux' && arch === 'x64') return (gpu && ok(/bin-Linux-.*x86_64-vulkan\.zip$/)) || ok(/bin-Linux-[^-]+-[\d.]+-x86_64\.zip$/) || ok(/bin-Linux-.*x86_64\.zip$/);
  if (platform === 'win32') return (gpu && ok(/bin-win-vulkan-x64\.zip$/)) || ok(/bin-win-(cpu|avx2)-x64\.zip$/);
  if (platform === 'darwin' && arch === 'arm64') return ok(/bin-Darwin-.*arm64\.zip$/);
  return null;
}

/** Download the latest prebuilt sd-cli into <dataDir>/image/bin and check that it runs. */
export function startRunnerInstall(dataDir: string, fetchImpl: typeof fetch = fetch) {
  const key = 'runner';
  const existing = jobs.get(key);
  if (existing?.status === 'running') return existing;
  const job: ImageJob = { id: key, kind: 'runner', target: 'stable-diffusion.cpp', status: 'running', received: 0, total: 0, startedAt: new Date().toISOString() };
  jobs.set(key, job);
  void (async () => {
    const binDir = path.dirname(defaultBinary(dataDir));
    try {
      const releases = await (await fetchImpl(RELEASES, { headers: { accept: 'application/vnd.github+json' } })).json() as { assets: { name: string; browser_download_url: string; size: number }[] }[];
      const assets = releases.flatMap((release) => release.assets);
      const name = pickRunnerAsset(releases[0]?.assets.map((asset) => asset.name) ?? []) ?? pickRunnerAsset(assets.map((asset) => asset.name));
      const asset = assets.find((item) => item.name === name);
      if (!asset) throw new Error(`No prebuilt stable-diffusion.cpp for ${process.platform}/${process.arch}. Use an image server (backend "http") instead; see docs/images.md.`);
      job.file = asset.name; job.total = asset.size;
      const response = await fetchImpl(asset.browser_download_url);
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const zip = Buffer.from(await response.arrayBuffer());
      job.received = zip.length;
      fs.mkdirSync(imageDir(dataDir), { recursive: true });
      const zipPath = path.join(imageDir(dataDir), 'sd.zip');
      fs.writeFileSync(zipPath, zip);
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.mkdirSync(binDir, { recursive: true });
      await run(process.platform === 'win32' ? 'powershell' : 'unzip', process.platform === 'win32' ? ['-NoProfile', '-Command', `Expand-Archive -Force '${zipPath}' '${binDir}'`] : ['-oq', zipPath, '-d', binDir]);
      fs.rmSync(zipPath, { force: true });
      flatten(binDir);
      const binary = defaultBinary(dataDir);
      if (!fs.existsSync(binary)) throw new Error('The download did not contain sd-cli.');
      fs.chmodSync(binary, 0o755);
      try {
        await run(binary, ['--help'], { LD_LIBRARY_PATH: binDir });
      } catch (error) {
        fs.rmSync(binDir, { recursive: true, force: true });
        const text = String((error as Error).message);
        if (!/GLIBC/.test(text) || process.platform !== 'linux') throw new Error(`sd-cli did not start: ${text.slice(0, 200)}`);
        // The prebuilt binary targets a newer glibc. Build one for this exact system inside Docker and copy it out.
        job.file = 'building from source in Docker (5-15 min)';
        await buildInDocker(binDir, job);
      }
      job.status = 'done';
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  })();
  return job;
}

/** Same distro and glibc as this machine, so the static binary runs here. Needs Docker; no compiler on the host. */
function osImage() {
  try {
    const rel = Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split('\n').filter((line) => line.includes('=')).map((line) => { const [k, ...v] = line.split('='); return [k, v.join('=').replace(/^"|"$/g, '')]; }));
    if ((rel.ID === 'ubuntu' || rel.ID === 'debian') && rel.VERSION_ID) return rel.ID === 'debian' ? `debian:${rel.VERSION_CODENAME || rel.VERSION_ID}` : `ubuntu:${rel.VERSION_ID}`;
  } catch { /* fall through */ }
  return 'ubuntu:24.04';
}

export const BUILD_SCRIPT = [
  'set -e',
  'apt-get update -q >/dev/null',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y -q cmake g++ git ca-certificates >/dev/null',
  'git clone -q --depth 1 --recursive --shallow-submodules https://github.com/leejet/stable-diffusion.cpp /src',
  'cd /src',
  'cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON >/dev/null',
  'cmake --build build --config Release -j"$(nproc)" --target sd-cli',
].join(' && ');

async function buildInDocker(binDir: string, job: ImageJob) {
  const docker = new DockerCtl();
  if (!(await docker.ping())) throw new Error('The prebuilt stable-diffusion.cpp needs a newer Linux (glibc) than this machine, and Docker is not available to build one. See docs/images.md.');
  const result = await docker.runAndCopyOut({ Image: osImage(), Cmd: ['bash', '-c', BUILD_SCRIPT], Labels: { 'local-agent': 'image-build' } }, "/src/build/bin/sd-cli");
  if (!result.file) throw new Error(`Building stable-diffusion.cpp failed: ${result.output.split('\n').slice(-3).join(' ').slice(0, 300)}`);
  fs.mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'sd-cli');
  fs.writeFileSync(binary, result.file, { mode: 0o755 });
  job.received = result.file.length;
  await run(binary, ['--help']);
}

function flatten(dir: string) {
  // Some archives wrap everything in one folder.
  const entries = fs.readdirSync(dir);
  if (entries.length === 1 && fs.statSync(path.join(dir, entries[0]!)).isDirectory()) {
    const inner = path.join(dir, entries[0]!);
    for (const name of fs.readdirSync(inner)) fs.renameSync(path.join(inner, name), path.join(dir, name));
    fs.rmdirSync(inner);
  }
}

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => execFile(cmd, args, { timeout: 120_000, env: { ...process.env, ...env } }, (error, _stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve()));
}

export const gb = (bytes: number | null) => bytes == null ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
