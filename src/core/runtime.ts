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
import { checkCitations, type Answer } from '../check/citations.ts';
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
  checkTimeoutMs?: number; // the deadline of a done check that the core runs
  configFile?: string; // the file that names the packs: an agent must not change it
  publishIdleMs?: number; // how long the envelope of a publication answers without any use
  gateConfig?: Record<string, unknown>; // the rule data of the gate; absent: the gate loads its own layers
  harnessDirs?: string[]; // the code of the harness and of the client adapter: the human decides each change
};

// Who sends an event. The agent can report and ask. Only the harness gives a check answer,
// and only the human approves: so the agent cannot close a task of a scenario.
export type Origin = 'agent' | 'human' | 'harness';
const ALLOWED: Record<Origin, readonly TaskEvent['type'][]> = {
  agent: ['report', 'ask', 'finish'],
  human: ['human', 'finish'],
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
  if (scenario.instructions !== undefined) made.task.instructions = scenario.instructions;
  commit(rt, { task: made.task, rows: made.rows });

  // The preparation can take long, and the human can stop the task meanwhile. So the end of the
  // preparation is written under the lock, to the task as it is on the disk, and only when that
  // task still prepares. A stopped task stays stopped.
  const id = made.task.id;
  const prepared = (event: TaskEvent, outputs?: Record<string, unknown>): Task => {
    // A busy lock is tried again: the end of a preparation must not be lost.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const done = withLock(rt, id, () => {
        const now = loadTask(rt, id);
        if (now === null || now.state !== 'preparing') return now;
        if (outputs !== undefined) writeAtomic(taskFile(rt, id, '.collect'), outputs);
        return commit(rt, step(now, event)).task;
      });
      if (done !== 'busy') return done ?? made.task;
    }
    return loadTask(rt, id) ?? made.task;
  };

  const collect = manifest.collect;
  if (collect === undefined) return { ok: true, task: prepared({ type: 'prepared', work: true, outputs: 0, bytes: 0 }), collected: null };
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
  if (!result.ok) return { ok: true, task: prepared({ type: 'collect_failed', reason: result.reason }), collected: null };
  // The run condition is the name of a flag. False: the task closes without the model.
  if (manifest.run_if !== undefined && result.flags[manifest.run_if] === false) {
    return { ok: true, task: prepared({ type: 'prepared', work: false, flag: manifest.run_if }), collected: null };
  }
  const task = prepared({ type: 'prepared', work: true, outputs: collect.outputs.length, bytes: result.bytes }, result.outputs);
  return { ok: true, task, collected: task.state === 'executing' ? result.outputs : null };
}

export function openFreeTask(rt: Runtime): Task {
  const made = newFreeTask(newId());
  commit(rt, { task: made.task, rows: made.rows });
  return made.task;
}

// The done checks that the core runs itself.
const coreChecks = (task: Task): boolean => task.manifest?.done.kind === 'citations';

export function applyEvent(rt: Runtime, id: string, event: TaskEvent, origin: Origin): Step | { error: 'unknown_task' | 'not_allowed' | 'busy' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  if (!ALLOWED[origin].includes(event.type)) return { error: 'not_allowed' };
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return null;
    // A check that the core runs itself takes the report as text and gives its own answer:
    // nobody else can move such a task into the check or out of it.
    if (coreChecks(task) && (event.type === 'report' || event.type === 'check')) return 'not_allowed' as const;
    return commit(rt, step(task, event));
  });
  if (r === 'busy') return { error: 'busy' };
  if (r === 'not_allowed') return { error: 'not_allowed' };
  return r ?? { error: 'unknown_task' };
}

// The tasks that are not closed, by their id. A broken task file is no task.
export function openTasks(rt: Runtime): Task[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(rt.stateDir, 'tasks')).sort();
  } catch {
    return [];
  }
  const out: Task[] = [];
  for (const name of names) {
    const id = /^(t[0-9a-f]{12})\.json$/.exec(name)?.[1];
    const task = id === undefined ? null : loadTask(rt, id);
    if (task !== null && task.state !== 'closed' && task.state !== 'skipped') out.push(task);
  }
  return out;
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

const REPORT_CAP = 1024 * 1024;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
const reportFile = (rt: Runtime, id: string): string => path.join(rt.stateDir, 'tasks', `${id}.report.txt`);

// The last accepted report of a task. Kept beside the task, never in the journal.
export function readReport(rt: Runtime, id: string): string | null {
  if (!TASK_ID.test(id)) return null;
  try {
    return fs.readFileSync(reportFile(rt, id), 'utf8');
  } catch {
    return null;
  }
}

// The list of the changed files as the collect step gave it: paths, or objects with a `path`.
function changedFiles(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const file = isObj(item) ? item.path : item;
    if (typeof file !== 'string' || file === '') return null;
    // `./a//b` and `a/b` name one file.
    out.push(path.posix.normalize(file).replace(/^\.\//, ''));
  }
  return out;
}

// The citation check of a task. The source is the directory that the collect step named; the agent
// gives only the text. Without a source there is no answer, and no answer is "not ready".
function citations(rt: Runtime, task: Task, text: string): Answer {
  const none: Answer = { result: 'none', reason: 'no_source', n: 0, faults: [] };
  const done = task.manifest?.done;
  if (done?.source === undefined) return none;
  const collected = readCollected(rt, task.id);
  const root = collected?.[done.source];
  if (typeof root !== 'string') return none;
  let changed: string[] | undefined;
  if (done.changed !== undefined) {
    const list = changedFiles(collected?.[done.changed]);
    if (list === null) return none;
    changed = list;
  }
  // The check runs under the lock of the task: it ends well before the lock can be taken as stale.
  const deadline = Date.now() + Math.min(rt.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, LOCK_STALE_MS / 2);
  return checkCitations(text, {
    root,
    ...(changed !== undefined ? { changed } : {}),
    ...(task.manifest?.output.max_items !== undefined ? { maxItems: task.manifest.output.max_items } : {}),
    ...(task.manifest?.output.fields !== undefined ? { fields: task.manifest.output.fields } : {}),
    expired: () => Date.now() > deadline,
  });
}

export type Submitted = { step: Step; answer?: Answer } | { error: 'unknown_task' | 'busy' | 'too_large' };
export type Checked = { step: Step; answer: Answer } | { error: 'unknown_task' | 'busy' | 'not_checking' };

// Runs the check of a task that waits for it, from the report that is kept on the disk, and applies
// the answer. The answer is computed and applied under one lock. A call that met a busy lock, or a
// process that died after the report, leaves the task in "checking": this call can be made again.
export function runCheck(rt: Runtime, id: string): Checked {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const r = withLock(rt, id, (): Checked => {
    const task = loadTask(rt, id);
    if (task === null) return { error: 'unknown_task' };
    if (task.state !== 'checking' || !coreChecks(task)) return { error: 'not_checking' };
    const text = readReport(rt, id);
    // A report that cannot be read is a fault of the harness: no answer.
    const answer: Answer = text === null ? { result: 'none', reason: 'no_source', n: 0, faults: [] } : citations(rt, task, text);
    const detail: Record<string, string | number> = answer.result === 'none' ? {} : { n: answer.n, faults: answer.faults.length };
    if (answer.reason !== undefined) detail.reason = answer.reason;
    return { step: commit(rt, step(task, { type: 'check', result: answer.result, detail })), answer };
  });
  return r === 'busy' ? { error: 'busy' } : r;
}

// The agent submits the text of its report. The core keeps the text and, for a check that the core
// runs itself (the citation check), runs it at once. The agent does not start the check and cannot
// give its answer. When the check could not run now, the step says "checking" and has no answer:
// `runCheck` finishes it.
export function submitReport(rt: Runtime, id: string, text: string): Submitted {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const size = Buffer.byteLength(text);
  if (size > REPORT_CAP) return { error: 'too_large' };
  const fp = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const submitted = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return null;
    const s = step(task, { type: 'report', size, fp });
    if (s.error !== undefined) return s;
    // The text is on the disk before the state says "checking": a check never reads an older report.
    const file = reportFile(rt, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return commit(rt, s);
  });
  if (submitted === 'busy') return { error: 'busy' };
  if (submitted === null) return { error: 'unknown_task' };
  if (submitted.error !== undefined || submitted.task.state !== 'checking' || !coreChecks(submitted.task)) return { step: submitted };
  const checked = runCheck(rt, id);
  return 'error' in checked ? { step: submitted } : checked;
}
