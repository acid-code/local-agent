import path from 'node:path';

const BLOCKED: RegExp[] = [
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b[^\n]*\bif=/i,
  />\s*\/dev\/(sd|nvme|vd)/i,
  /:\(\)\s*\{/,
  /\b(shutdown|reboot|poweroff)\b/i,
  /\bcurl\b[^\n]*\|\s*(sh|bash)\b/i,
  /\bwget\b[^\n]*\|\s*(sh|bash)\b/i,
];

const MUTATING: RegExp[] = [
  /\brm\b/i,
  /\bmv\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsudo\b/i,
  /\b(mount|umount)\b/i,
  /\b(kill|pkill)\b/i,
  /\bdocker\b[^\n]*\b(rm|rmi|system|prune|kill)\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\btee\b/i,
  /\bfind\b[^\n|;&]*\s-delete\b/i,
];

/**
 * Redirects that only throw output away or merge streams (2>/dev/null, &>/dev/null, 2>&1). Read-only commands
 * like `git log --oneline -5 2>/dev/null` were flagged as destructive because of the bare ">" rule, which made the
 * agent sit on an approval prompt for an `ls`.
 */
const HARMLESS_REDIRECTS = /(?:\d|&)?>{1,2}\s*\/dev\/null\b|\b\d>&\d\b/g;

export type CommandAssessment = 'ok' | 'mutating' | 'blocked';

/** Replace complete single- and double-quoted literals with "" so inline code (e.g. `<script>`, `x > 0`) is not read as shell operators. */
export function stripQuotedStrings(command: string): string {
  let out = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < command.length) {
        const cur = command[j]!;
        if (ch === '"' && cur === '\\') { j += 2; continue; }
        if (cur === ch) break;
        j += 1;
      }
      if (j < command.length) {
        out += '""';
        i = j;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Drop 2>/dev/null, >/dev/null, &>/dev/null and 2>&1 so they are not treated as file writes. */
export function withoutHarmlessRedirects(command: string): string {
  return command.replace(HARMLESS_REDIRECTS, ' ');
}

/** True only when an unquoted shell output redirect (> or >>) outside harmless /dev/null & stream merges exists. */
export function hasShellRedirect(command: string): boolean {
  return /(^|[^&=])>{1,2}/.test(stripQuotedStrings(withoutHarmlessRedirects(command)));
}

export function assessCommand(command: string): CommandAssessment {
  if (BLOCKED.some((pattern) => pattern.test(command))) return 'blocked';
  const cleaned = withoutHarmlessRedirects(command);
  if (hasShellRedirect(command) || MUTATING.some((pattern) => pattern.test(cleaned))) return 'mutating';
  return 'ok';
}

export function isInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function resolveInside(root: string, relative: string): string | null {
  const target = path.resolve(root, relative || '.');
  return isInside(root, target) ? target : null;
}

export function isBlockedUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https URLs are fetched.';
  const host = url.hostname.toLowerCase();
  if (host === 'metadata.google.internal' || host === '169.254.169.254') return 'Cloud metadata addresses are blocked.';
  if (host.endsWith('.metadata.google.internal')) return 'Cloud metadata addresses are blocked.';
  return null;
}

export function assertSafeName(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_.:/-]{1,128}$/.test(value)) {
    throw new Error(`${label} may only contain letters, numbers, and . _ : / -`);
  }
  return value;
}

export function redact(text: string): string {
  return text
    .replace(/\b(sk|rk|token|api[_-]?key)[-_=: ]+[A-Za-z0-9_\-]{8,}\b/gi, '$1=[redacted]')
    .replace(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, '[redacted]')
    .replace(/\bla_[A-Za-z0-9_\-]{12,}\b/g, 'la_[redacted]');
}
