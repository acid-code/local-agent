import fs from 'node:fs';
import path from 'node:path';

export const AVATAR_MAX_BYTES = 512 * 1024;

const TYPES = ['png', 'jpeg', 'webp', 'gif'] as const;
export type AvatarType = (typeof TYPES)[number];

export const FACES: { id: string; label: string }[] = [
  { id: 'nova', label: 'Nova' },
  { id: 'oak', label: 'Oak' },
  { id: 'iris', label: 'Iris' },
  { id: 'moss', label: 'Moss' },
  { id: 'ember', label: 'Ember' },
  { id: 'tide', label: 'Tide' },
  { id: 'flint', label: 'Flint' },
  { id: 'luma', label: 'Luma' },
];

export function sniffImage(bytes: Buffer): AvatarType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'gif';
  return null;
}

export function saveAvatar(dataDir: string, agentId: string, bytes: Buffer): { file: string; type: AvatarType } {
  if (bytes.length === 0) throw new Error('The image is empty.');
  if (bytes.length > AVATAR_MAX_BYTES) throw new Error('Avatars must be 512 KB or smaller.');
  const type = sniffImage(bytes);
  if (!type) throw new Error('Use a PNG, JPEG, WebP, or GIF.');
  const dir = path.join(dataDir, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  for (const ext of ['png', 'jpg', 'webp', 'gif']) fs.rmSync(path.join(dir, `${agentId}.${ext}`), { force: true });
  const ext = type === 'jpeg' ? 'jpg' : type;
  const file = `${agentId}.${ext}`;
  fs.writeFileSync(path.join(dir, file), bytes);
  return { file, type };
}

export function avatarPath(dataDir: string, file: string): string | null {
  if (!/^agt_[a-z0-9]+\.(png|jpg|webp|gif)$/.test(file)) return null;
  const full = path.join(dataDir, 'avatars', file);
  return fs.existsSync(full) ? full : null;
}

export const ACCENT_DEFAULT = '#e4b56a';

export function accentOk(value: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
