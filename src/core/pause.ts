// A pause of the barriers, on the word of the human: for some minutes a question passes without
// the question. A refusal and the protection of the harness itself hold during a pause.
// Specification: docs/spec/harness-core, page 3.

import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from './runtime.ts';

export const MAX_PAUSE_MINUTES = 480;
const fileOf = (rt: Runtime): string => path.join(rt.stateDir, 'pause.json');

// The time until which the barriers are paused, or null.
export function pausedUntil(rt: Runtime, now: number = Date.now()): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(fileOf(rt), 'utf8'));
    // The file is the work of `pause` only: one key, a time in the form that `pause` writes, and
    // not further away than the longest pause. Any other file is no pause: the barriers hold.
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return null;
    const until = (value as { until?: unknown }).until;
    if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)) return null;
    const left = Date.parse(until) - now;
    return left > 0 && left <= MAX_PAUSE_MINUTES * 60_000 ? until : null;
  } catch {
    return null;
  }
}

// Pauses for the minutes; zero ends a pause.
export function pause(rt: Runtime, minutes: number, now: number = Date.now()): string | null {
  if (minutes <= 0) {
    fs.rmSync(fileOf(rt), { force: true });
    return null;
  }
  const until = new Date(now + Math.min(minutes, MAX_PAUSE_MINUTES) * 60_000).toISOString();
  fs.mkdirSync(rt.stateDir, { recursive: true });
  fs.writeFileSync(fileOf(rt), JSON.stringify({ until }));
  rt.journal.write({ kind: 'harness.barriers_off', project: rt.project, data: { minutes: Math.min(minutes, MAX_PAUSE_MINUTES) } });
  return until;
}
