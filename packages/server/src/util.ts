import { randomBytes, randomUUID } from 'node:crypto';

export function nid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'agent';
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated]`;
}

export class CrashError extends Error {
  constructor(message = 'Process interrupted while a step was running.') {
    super(message);
    this.name = 'CrashError';
  }
}

export class StopError extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'StopError';
  }
}

export class InterruptedToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterruptedToolError';
  }
}
