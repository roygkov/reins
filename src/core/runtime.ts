// The runtime: opens tasks from the merged packs, keeps their state on the disk, runs the collect
// script and writes the journal. One task is one file; the task belongs to the harness, not to a session.
// Specification: docs/spec/harness-core, pages 2 and 7; harness-manifest, page 2.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Journal, RowInput } from '../journal/writer.ts';
import type { Merged } from '../packs/packs.ts';
import type { Action, Decision, LayerDecision } from '../contracts/policy.ts';
import { isObj } from '../contracts/shape.ts';
import { runCollect } from './collect.ts';
import { TASK_STATES, confirmGrant, decideFor, newFreeTask, newScenarioTask, step, type InputError, type Inputs, type RowDraft, type Step, type Task, type TaskEvent } from './task.ts';

export type Runtime = {
  merged: Merged;
  // The directory of the task files and the journal. It must lie outside the work tree and inside
  // the protected paths: an agent that can write here can forge a state or a confirmation.
  stateDir: string;
  journal: Journal;
  project: string;
  session?: string;
  collectTimeoutMs?: number; // for a manifest that sets no time limit
  lockWaitMs?: number; // how long a call waits for the lock of a task
};

// Who sends an event. The agent can report and ask. Only the harness gives a check answer,
// and only the human approves: so the agent cannot close a task of a scenario.
export type Origin = 'agent' | 'human' | 'harness';
const ALLOWED: Record<Origin, readonly TaskEvent['type'][]> = {
  agent: ['report', 'ask'],
  human: ['human'],
  harness: ['prepared', 'collect_failed', 'check', 'expire'],
};

export type Opened =
  | { ok: true; task: Task; collected: Record<string, unknown> | null }
  | { ok: false; error: 'unknown_scenario' | 'disabled' }
  | { ok: false; error: 'bad_inputs'; details: InputError[] };

const TASK_ID = /^[a-z0-9]{6,32}$/;
const DEFAULT_COLLECT_TIMEOUT_MS = 60_000;
const DEFAULT_COLLECT_BYTES = 1024 * 1024;

const newId = (): string => `t${crypto.randomBytes(6).toString('hex')}`;
const taskFile = (rt: Runtime, id: string, suffix = ''): string => path.join(rt.stateDir, 'tasks', `${id}${suffix}.json`);

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

// A task file is read with a check of its shape: a broken file is no task.
function asTask(value: Record<string, unknown> | null, id: string): Task | null {
  if (value === null || value.id !== id) return null;
  if (typeof value.state !== 'string' || !(TASK_STATES as readonly string[]).includes(value.state)) return null;
  if (!Array.isArray(value.envelope) || !isObj(value.inputs) || !Number.isInteger(value.returns)) return null;
  const use = value.use;
  if (!isObj(use) || !Array.isArray(use.confirmed) || !isObj(use.used)) return null;
  return value as Task;
}

export function loadTask(rt: Runtime, id: string): Task | null {
  if (!TASK_ID.test(id)) return null;
  return asTask(readObject(taskFile(rt, id)), id);
}

const LOCK_STALE_MS = 10_000;
const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One writer per task: load, decide and save run under a lock file. Hooks are separate processes,
// and two of them must not both count the last use of a grant.
function withLock<T>(rt: Runtime, id: string, fn: () => T): T | 'busy' {
  const lock = path.join(rt.stateDir, 'tasks', `${id}.lock`);
  const deadline = Date.now() + (rt.lockWaitMs ?? 2000);
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch {
      try {
        // A lock that nobody released: its holder is gone.
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // the lock went away between the two calls: try again
      }
      if (Date.now() >= deadline) return 'busy';
      pause(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// What the collect script gave for the model. Kept beside the task, never in the journal.
export function readCollected(rt: Runtime, id: string): Record<string, unknown> | null {
  if (!TASK_ID.test(id)) return null;
  return readObject(taskFile(rt, id, '.collect'));
}

function record(rt: Runtime, task: Task, rows: RowDraft[]): void {
  for (const r of rows) {
    const row: RowInput = { kind: r.kind, project: rt.project, task: task.id };
    if (rt.session !== undefined) row.session = rt.session;
    if (task.scenario !== undefined) {
      row.scenario = task.scenario;
      row.scenario_v = task.version ?? 1;
    }
    if (r.data !== undefined && Object.keys(r.data).length > 0) row.data = r.data;
    rt.journal.write(row);
  }
}

function commit(rt: Runtime, s: Step): Step {
  if (s.error === undefined) {
    writeAtomic(taskFile(rt, s.task.id), s.task);
    record(rt, s.task, s.rows);
  }
  return s;
}

// Opens a task of a scenario by its name. The trigger is refused before any task exists when
// the scenario is unknown or disabled or the inputs do not fit.
export function openScenario(rt: Runtime, name: string, inputs: Inputs): Opened {
  const scenario = rt.merged.scenarios.find((s) => s.name === name);
  if (scenario === undefined) return { ok: false, error: 'unknown_scenario' };
  if (scenario.manifest.state === 'disabled') return { ok: false, error: 'disabled' };
  // The task works with its own copy of the manifest from here on.
  const manifest = structuredClone(scenario.manifest);
  const made = newScenarioTask(newId(), manifest, { ...inputs });
  if ('errors' in made) return { ok: false, error: 'bad_inputs', details: made.errors };
  commit(rt, { task: made.task, rows: made.rows });

  const collect = manifest.collect;
  if (collect === undefined) {
    const s = commit(rt, step(made.task, { type: 'prepared', work: true, outputs: 0, bytes: 0 }));
    return { ok: true, task: s.task, collected: null };
  }
  const file = rt.merged.scriptFiles[collect.script];
  const result =
    file === undefined
      ? ({ ok: false, reason: 'exit' } as const)
      : runCollect(file, { inputs: made.task.inputs }, {
          outputs: collect.outputs,
          flags: collect.flags ?? [],
          timeoutMs: collect.timeout_s !== undefined ? collect.timeout_s * 1000 : (rt.collectTimeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS),
          maxBytes: collect.max_bytes ?? DEFAULT_COLLECT_BYTES,
        });
  if (!result.ok) {
    const s = commit(rt, step(made.task, { type: 'collect_failed', reason: result.reason }));
    return { ok: true, task: s.task, collected: null };
  }
  // The run condition is the name of a flag. False: the task closes without the model.
  if (manifest.run_if !== undefined && result.flags[manifest.run_if] === false) {
    const s = commit(rt, step(made.task, { type: 'prepared', work: false, flag: manifest.run_if }));
    return { ok: true, task: s.task, collected: null };
  }
  writeAtomic(taskFile(rt, made.task.id, '.collect'), result.outputs);
  const s = commit(rt, step(made.task, { type: 'prepared', work: true, outputs: collect.outputs.length, bytes: result.bytes }));
  return { ok: true, task: s.task, collected: result.outputs };
}

export function openFreeTask(rt: Runtime): Task {
  const made = newFreeTask(newId());
  commit(rt, { task: made.task, rows: made.rows });
  return made.task;
}

export function applyEvent(rt: Runtime, id: string, event: TaskEvent, origin: Origin): Step | { error: 'unknown_task' | 'not_allowed' | 'busy' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  if (!ALLOWED[origin].includes(event.type)) return { error: 'not_allowed' };
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    return task === null ? null : commit(rt, step(task, event));
  });
  if (r === 'busy') return { error: 'busy' };
  return r ?? { error: 'unknown_task' };
}

// The policy decision for one action of a task; null when the task is unknown or its lock is busy.
// A caller that gets null has no envelope: it decides the action as an action outside a task.
export function decideAction(rt: Runtime, id: string, action: Action, layers: LayerDecision[]): Decision | null {
  if (!TASK_ID.test(id)) return null;
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return null;
    const d = decideFor(task, action, layers);
    commit(rt, { task: d.task, rows: d.rows });
    return d.decision;
  });
  return r === 'busy' ? null : r;
}

// The one confirmation of a grant of the envelope by the human.
export function confirm(rt: Runtime, id: string, key: string): boolean {
  if (!TASK_ID.test(id)) return false;
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return false;
    const next = confirmGrant(task, key);
    if (next === task) return false;
    commit(rt, { task: next, rows: [{ kind: 'task.human_decision', data: { decision: 'confirm' } }] });
    return true;
  });
  return r === true;
}
