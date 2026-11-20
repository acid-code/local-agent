import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DockerCtl } from './docker.js';

export interface SemgrepFinding {
  checkId: string;
  path: string;
  line: number;
  severity: string;
  message: string;
}

export interface SemgrepResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  findings: SemgrepFinding[];
  summary: string;
}

const DEFAULT_IMAGE = process.env.LA_SEMGREP_IMAGE || 'semgrep/semgrep';
const FALLBACK_IMAGES = ['semgrep/semgrep:latest', 'returntocorp/semgrep:latest'];

function bundledRulesPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../assets/semgrep-rules.yaml'),
    path.resolve(here, '../../assets/semgrep-rules.yaml'),
    path.resolve(process.cwd(), 'packages/server/assets/semgrep-rules.yaml'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

/** Map a container-local path (e.g. /data/workspaces/...) back to its host bind path when running inside Docker. */
export function resolveHostMountPath(localPath: string): string {
  const abs = path.resolve(localPath);
  const dataDir = process.env.DATA_DIR;
  const hostDataDir = process.env.LA_HOST_DATA_DIR;
  if (dataDir && hostDataDir) {
    const normData = path.resolve(dataDir);
    if (abs === normData || abs.startsWith(normData + path.sep)) {
      return path.join(hostDataDir, abs.slice(normData.length));
    }
  }
  return abs;
}

/**
 * Built-in offline Semgrep security scan executed before every git commit (for all models).
 * Uses offline rules, --metrics=off, NetworkMode='none', the semgrep/semgrep image, and the project path.
 */
export async function runPreCommitSemgrep(
  docker: DockerCtl | undefined,
  projectPath: string,
  opts: { dataDir?: string } = {},
): Promise<SemgrepResult> {
  if (process.env.LA_SKIP_SEMGREP === '1' || process.env.NODE_ENV === 'test') {
    return { ok: true, skipped: true, reason: 'Semgrep disabled in test mode.', findings: [], summary: 'Semgrep skipped.' };
  }
  if (!docker || !docker.available()) {
    return { ok: true, skipped: true, reason: 'Docker socket unavailable; Semgrep scan skipped.', findings: [], summary: 'Semgrep skipped (Docker unavailable).' };
  }
  const rulesSrc = bundledRulesPath();
  if (!fs.existsSync(rulesSrc)) {
    return { ok: true, skipped: true, reason: 'Offline Semgrep rules file not found.', findings: [], summary: 'Semgrep skipped (rules missing).' };
  }
  let image = DEFAULT_IMAGE;
  if (!(await docker.hasImage(image))) {
    const found = await Promise.all(FALLBACK_IMAGES.map(async (img) => ((await docker.hasImage(img)) ? img : null)));
    const match = found.find(Boolean);
    if (!match) {
      return {
        ok: true,
        skipped: true,
        reason: `Semgrep image (${DEFAULT_IMAGE}) is not pulled yet. Run: docker pull semgrep/semgrep`,
        findings: [],
        summary: 'Semgrep skipped (image not pulled).',
      };
    }
    image = match;
  }

  // Copy offline rules into dataDir/cache so the host Docker daemon can always bind-mount it even when the app runs in Docker.
  let rulesMountPath = rulesSrc;
  if (opts.dataDir) {
    try {
      const cacheDir = path.join(opts.dataDir, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const copied = path.join(cacheDir, 'semgrep-rules.yaml');
      fs.copyFileSync(rulesSrc, copied);
      rulesMountPath = resolveHostMountPath(copied);
    } catch { /* fall back to rulesSrc */ }
  } else {
    rulesMountPath = resolveHostMountPath(rulesSrc);
  }
  const srcMountPath = resolveHostMountPath(projectPath);

  const res = await docker.runCollect({
    Image: image,
    Cmd: [
      'semgrep',
      'scan',
      '--config', '/rules/semgrep-rules.yaml',
      '--metrics=off',
      '--no-git-ignore',
      '--json',
      '--quiet',
      '/src',
    ],
    WorkingDir: '/src',
    Labels: { 'local-agent.role': 'sandbox', 'local-agent.task': 'semgrep' },
    HostConfig: {
      NetworkMode: 'none',
      Memory: 1536 * 1024 * 1024,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Binds: [
        `${srcMountPath}:/src:ro`,
        `${rulesMountPath}:/rules/semgrep-rules.yaml:ro`,
      ],
    },
  }, 60_000);

  const findings = parseSemgrepJson(res.output);
  const blocking = findings.filter((f) => f.severity === 'ERROR' || f.severity === 'WARNING');
  if (blocking.length > 0) {
    const lines = blocking.slice(0, 12).map((f) => `- [${f.severity}] ${f.path}:${f.line} (${f.checkId}): ${f.message}`);
    const more = blocking.length > 12 ? `\n...and ${blocking.length - 12} more finding(s).` : '';
    return {
      ok: false,
      skipped: false,
      findings: blocking,
      summary: `Pre-commit Semgrep security scan blocked commit (${blocking.length} finding${blocking.length === 1 ? '' : 's'}):\n${lines.join('\n')}${more}\nFix these issues before committing.`,
    };
  }
  return {
    ok: true,
    skipped: false,
    findings: [],
    summary: 'Semgrep security scan passed (0 issues).',
  };
}

export function parseSemgrepJson(raw: string): SemgrepFinding[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      results?: {
        check_id?: string;
        path?: string;
        start?: { line?: number };
        extra?: { severity?: string; message?: string };
      }[];
    };
    return (parsed.results ?? []).map((item) => ({
      checkId: String(item.check_id || 'semgrep'),
      path: String(item.path || '').replace(/^\/src\/?/, ''),
      line: Number(item.start?.line || 1),
      severity: String(item.extra?.severity || 'WARNING').toUpperCase(),
      message: String(item.extra?.message || 'Security issue detected.'),
    }));
  } catch {
    return [];
  }
}
