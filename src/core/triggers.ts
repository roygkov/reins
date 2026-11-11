// Triggers without a human: a schedule and an event open a task of a scenario. The harness has
// no process of its own: a timer of the system calls `tick`, a system that saw an event calls
// `fire`. A task that needs the model waits for a client that runs without a window.
// Specification: docs/spec/harness-manifest, page 2; harness-model, page 6.

import fs from 'node:fs';
import path from 'node:path';
import { nextRun, parseSchedule } from '../contracts/schedule.ts';
import { openScenario, type Runtime } from './runtime.ts';
import type { Inputs } from './task.ts';

export { nextRun, parseSchedule } from '../contracts/schedule.ts';

export type Triggered = { task: string; scenario: string; state: string };
export type TriggerResult = { opened: Triggered[]; skipped: Triggered[] };

const LOCK_STALE_MS = 60_000; // a lock that nobody released for this long: its holder is gone
const stateFile = (rt: Runtime, name: string): string => path.join(rt.stateDir, 'triggers', `${name}.json`);

function lastRun(rt: Runtime, name: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(rt, name), 'utf8')) as { last?: unknown };
    const at = typeof value.last === 'string' ? Date.parse(value.last) : NaN;
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

function note(rt: Runtime, name: string, now: number): void {
  fs.mkdirSync(path.dirname(stateFile(rt, name)), { recursive: true });
  const tmp = `${stateFile(rt, name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ last: new Date(now).toISOString() }));
  fs.renameSync(tmp, stateFile(rt, name));
}

function open(rt: Runtime, name: string, inputs: Inputs, out: TriggerResult): boolean {
  const r = openScenario(rt, name, inputs, {});
  if (!r.ok) return false;
  // A task that executes needs the model. Any other ended without it: no work, or the collect failed.
  (r.task.state === 'executing' ? out.opened : out.skipped).push({ task: r.task.id, scenario: name, state: r.task.state });
  return true;
}

// Runs the scenarios whose schedule came. The first look at a scenario only notes the time: a
// schedule does not run at the moment it is connected. A time that passed several times while
// nobody looked runs once.
export function tick(rt: Runtime, now: number = Date.now()): TriggerResult {
  const out: TriggerResult = { opened: [], skipped: [] };
  for (const s of rt.merged.scenarios) {
    const trigger = s.manifest.trigger;
    if (trigger.kind !== 'schedule' || s.manifest.state === 'disabled') continue;
    const form = parseSchedule(trigger.value ?? '');
    if (form === null) continue;
    // One look at a scenario at a time: two timers that fire together must not both run it.
    const lock = `${stateFile(rt, s.name)}.lock`;
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      try {
        // The age of a lock is read from the clock, not from the time that the caller looks at.
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // no lock
      }
      fs.closeSync(fs.openSync(lock, 'wx'));
    } catch {
      continue;
    }
    let due = false;
    try {
      const last = lastRun(rt, s.name);
      due = last !== null && nextRun(form, new Date(last)).getTime() <= now;
      // The time is noted before the task opens: a look after this one does not run it again.
      if (last === null || due) note(rt, s.name, now);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    if (due) open(rt, s.name, {}, out);
  }
  return out;
}

// An event of another system: every scenario that waits for an event of this name gets a task
// with the inputs of the event. Inputs that do not fit a scenario open nothing for it.
export function fire(rt: Runtime, event: string, inputs: Record<string, string | number>): TriggerResult & { refused: { scenario: string; error: string }[] } {
  const out: TriggerResult & { refused: { scenario: string; error: string }[] } = { opened: [], skipped: [], refused: [] };
  for (const s of rt.merged.scenarios) {
    const trigger = s.manifest.trigger;
    if (trigger.kind !== 'event' || trigger.value !== event || s.manifest.state === 'disabled') continue;
    // A value of the event is text; an input that the scenario types as a number is read as one.
    const typed: Inputs = {};
    const types = new Map((trigger.inputs ?? []).map((i) => [i.name, i.type]));
    for (const [key, value] of Object.entries(inputs)) typed[key] = types.get(key) === 'number' && typeof value === 'string' && /^-?[0-9]+(\.[0-9]+)?$/.test(value) ? Number(value) : value;
    const r = openScenario(rt, s.name, typed, {});
    if (!r.ok) out.refused.push({ scenario: s.name, error: r.error });
    else (r.task.state === 'executing' ? out.opened : out.skipped).push({ task: r.task.id, scenario: s.name, state: r.task.state });
  }
  return out;
}
