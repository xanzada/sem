import { randomUUID } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function uuid(): string {
  return randomUUID();
}

export function jittered(ms: number): number {
  return Math.max(50, Math.round(ms * (0.85 + Math.random() * 0.3)));
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}
