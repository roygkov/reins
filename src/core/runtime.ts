// The runtime: opens tasks from the merged packs, keeps their state on the disk, runs the collect
// script and writes the journal. One task is one file; the task belongs to the harness, not to a session.
// Specification: docs/spec/harness-core, pages 2 and 7; harness-manifest, page 2.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Journal, RowInput } from '../journal/writer.ts';
import type { Merged } from '../packs/packs.ts';
import type { Action, Decision, LayerDecision } from '../contracts/policy.ts';
import { LEVELS, fixedStart, guardPattern, validateManifest, type Level, type Manifest } from '../contracts/manifest.ts';
import { isObj, type Fault } from '../contracts/shape.ts';
import { closedContext } from '../packs/packs.ts';
import { patchSession } from './sessions.ts';
import { checkCitations, type Answer } from '../check/citations.ts';
import { runCollect, type Sandbox } from './collect.ts';
import { workState } from './work.ts';
import { noteUse, scenarioOff } from './idle.ts';
import { TASK_STATES, confirmGrant, decideFor, newContractTask, newFreeTask, newScenarioTask, step, type InputError, type Inputs, type RowDraft, type Step, type Task, type TaskEvent } from './task.ts';

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
  checkScriptTimeoutMs?: number; // the time limit of a check script of a pack
  publishIdleMs?: number; // how long the envelope of a publication answers without any use
  gateConfig?: Record<string, unknown>; // the rule data of the gate; absent: the gate loads its own layers
  projectPackDir?: string; // `.reins` of the repository of the client, also when it does not exist yet
  memoryDir?: string; // the directory of the memory records; absent: inside the state directory
  clientPaths?: string[]; // patterns of the paths of the client settings that register the harness
  runner?: string[]; // the command of the machine that starts a client for one task, with its arguments
  memoryCommit?: boolean; // the harness commits the directory of the memory records after a change
  runnerTimeoutMs?: number; // how long one run of the client can take
  runnerParallel?: number; // how many clients the schedule or an event runs at one time
  scriptSandbox?: boolean; // the scripts of the packs run in the sandbox of the system
  workDir?: string; // the directory where the client works: a script of a pack must not change it
  harnessDirs?: string[]; // the code of the harness and of the client adapter: the human decides each change
};

// Who sends an event. The agent can report and ask. Only the harness gives a check answer,
// and only the human approves: so the agent cannot close a task of a scenario.
export type Origin = 'agent' | 'human' | 'harness';
const ALLOWED: Record<Origin, readonly TaskEvent['type'][]> = {
  agent: ['report', 'ask', 'finish'],
  human: ['human', 'finish'],
  harness: ['prepared', 'collect_failed', 'check', 'expire', 'invalidate', 'limit', 'scope'],
};

export type Opened =
  | { ok: true; task: Task; collected: Record<string, unknown> | null }
  | { ok: false; error: 'unknown_scenario' | 'disabled' | 'idle' }
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

// Where the copies of large collected results lie for the model to read. Outside the state on
// purpose: the state is closed for the agent, and a copy is only for its reading. The check of a
// task reads the collected results from the state, never from a copy.
export const collectedDir = (rt: Runtime): string => path.join(path.dirname(rt.stateDir), `collected-${path.basename(rt.stateDir)}`);

// What the collect script gave for the model. Kept beside the task, never in the journal.
export function readCollected(rt: Runtime, id: string): Record<string, unknown> | null {
  if (!TASK_ID.test(id)) return null;
  return readObject(taskFile(rt, id, '.collect'));
}

// `sub`: the rows are about an action of a subordinate executor: its role and its parent task.
function record(rt: Runtime, task: Task, rows: RowDraft[], sub?: { role: string; parent: string }): void {
  for (const r of rows) {
    const row: RowInput = { kind: r.kind, project: rt.project, task: task.id, ...(sub !== undefined ? { executor: 'sub' as const, role: sub.role, parent: sub.parent } : {}) };
    const session = task.session ?? rt.session;
    if (session !== undefined) row.session = session;
    if (task.scenario !== undefined) {
      row.scenario = task.scenario;
      row.scenario_v = task.version ?? 1;
    }
    if (r.data !== undefined && Object.keys(r.data).length > 0) row.data = r.data;
    rt.journal.write(row);
  }
}

function commit(rt: Runtime, s: Step, sub?: { role: string; parent: string }): Step {
  if (s.error === undefined) {
    writeAtomic(taskFile(rt, s.task.id), s.task);
    record(rt, s.task, s.rows, sub);
  }
  return s;
}

// The level of the model for a manifest that names none: the level that the lowest pack gives,
// never above the limit of the packs. No pack names one: the middle level.
function defaultLevel(rt: Runtime): Level {
  const level = rt.merged.defaultLevel ?? 'medium';
  const max = rt.merged.context.maxLevel;
  return max !== undefined && LEVELS.indexOf(level) > LEVELS.indexOf(max) ? max : level;
}

// A change of a pack during a task does not reach the task (harness-packs, page 4): the task works
// with the merge that it started with. What the policy reads of the merge is kept beside the task:
// the table of the tools, the rules, the data of the gate, and the context with the environments
// and the limits. One thing does reach the task at once: a barrier that became stricter. A rule of
// a pack only asks, defers or refuses, and the data of the gate only adds dangerous places, so the
// task sees the kept ones and the new ones together. The directories of the packs and the scripts
// are read as they are now: the protection of the packs and the version of a check look at the disk.
const FROZEN = ['tools', 'rules', 'gate', 'context'] as const;
function freeze(rt: Runtime, id: string): void {
  writeAtomic(taskFile(rt, id, '.packs'), Object.fromEntries(FROZEN.map((key) => [key, rt.merged[key]])));
}
const both = <T>(kept: readonly T[], now: readonly T[]): T[] => {
  const seen = new Set(kept.map((x) => JSON.stringify(x)));
  return [...kept, ...now.filter((x) => !seen.has(JSON.stringify(x)))];
};
// The runtime as an open task of a scenario sees it. Any other task, and a task without the kept
// merge, sees the packs as they are now.
export function frozenRuntime(rt: Runtime, id: string | undefined): Runtime {
  if (id === undefined || !TASK_ID.test(id)) return rt;
  const task = loadTask(rt, id);
  if (task === null || task.state === 'closed' || task.state === 'skipped') return rt;
  const kept = readObject(taskFile(rt, id, '.packs'));
  if (kept === null || !isObj(kept.tools) || !Array.isArray(kept.rules) || !isObj(kept.gate) || !isObj(kept.context)) return rt;
  const gate: Record<string, unknown> = { ...rt.merged.gate };
  for (const [key, list] of Object.entries(kept.gate)) {
    const now = (rt.merged.gate as Record<string, unknown>)[key];
    gate[key] = Array.isArray(list) ? both(list, Array.isArray(now) ? now : []) : list;
  }
  return {
    ...rt,
    merged: {
      ...rt.merged,
      tools: kept.tools as Runtime['merged']['tools'],
      context: kept.context as Runtime['merged']['context'],
      rules: both(kept.rules as Runtime['merged']['rules'], rt.merged.rules),
      gate: gate as Runtime['merged']['gate'],
    },
  };
}

// Opens a task of a scenario by its name. The trigger is refused before any task exists when
// the scenario is unknown or disabled or the inputs do not fit.
export function openScenario(rt: Runtime, name: string, inputs: Inputs, opts: { session?: string } = {}): Opened {
  const scenario = rt.merged.scenarios.find((s) => s.name === name);
  if (scenario === undefined) return { ok: false, error: 'unknown_scenario' };
  if (scenario.manifest.state === 'disabled') return { ok: false, error: 'disabled' };
  // Nobody called the scenario for the term of the packs: the human brings it back with `reins enable`.
  if (scenarioOff(rt, name)) return { ok: false, error: 'idle' };
  // The task works with its own copy of the manifest from here on.
  const manifest = structuredClone(scenario.manifest);
  const made = newScenarioTask(newId(), manifest, { ...inputs });
  if ('errors' in made) return { ok: false, error: 'bad_inputs', details: made.errors };
  if (scenario.instructions !== undefined) made.task.instructions = scenario.instructions;
  made.task.level ??= defaultLevel(rt);
  hold(rt, made.task, opts.session);
  commit(rt, { task: made.task, rows: made.rows });
  freeze(rt, made.task.id);
  noteUse(rt, name);
  return { ok: true, ...prepareTask(rt, made.task) };
}

// The session that holds a task. The task becomes the current scenario task of that session:
// the task that the session worked on before stays open, but is suspended.
function hold(rt: Runtime, task: Task, session: string | undefined): void {
  if (session === undefined) return;
  task.session = session;
  patchSession(rt, session, { scenario: task.id });
}

// A step of the harness ran past its time: a fact of the journal, with the step and the task.
export function stepTimeout(rt: Runtime, task: string, where: 'collect' | 'check' | 'run'): void {
  rt.journal.write({ kind: 'harness.step_timeout', project: rt.project, task, data: { where } });
}

// The preparation of a task that has a manifest: the collect script and the run condition.
function prepareTask(rt: Runtime, start: Task): { task: Task; collected: Record<string, unknown> | null } {
  const manifest = start.manifest;
  if (manifest === undefined) return { task: start, collected: null };
  // The preparation can take long, and the human can stop the task meanwhile. So the end of the
  // preparation is written under the lock, to the task as it is on the disk, and only when that
  // task still prepares. A stopped task stays stopped.
  const id = start.id;
  const prepared = (event: TaskEvent, outputs?: Record<string, unknown>): Task => {
    // A busy lock is tried again: the end of a preparation must not be lost.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const done = withLock(rt, id, () => {
        const now = loadTask(rt, id);
        if (now === null || now.state !== 'preparing') return now;
        if (outputs !== undefined) writeAtomic(taskFile(rt, id, '.collect'), outputs);
        return commit(rt, step(now, event)).task;
      });
      if (done !== 'busy') return done ?? start;
    }
    return loadTask(rt, id) ?? start;
  };

  const collect = manifest.collect;
  if (collect === undefined) return { task: prepared({ type: 'prepared', work: true, outputs: 0, bytes: 0 }), collected: null };
  const file = rt.merged.scriptFiles[collect.script];
  // A collect script only reads. A change of the work of the client is a fact that it did not.
  const workBefore = rt.workDir === undefined ? null : workState(rt.workDir);
  const result =
    file === undefined
      ? ({ ok: false, reason: 'exit' } as const)
      : runCollect(file, { inputs: start.inputs }, {
          outputs: collect.outputs,
          flags: collect.flags ?? [],
          timeoutMs: collect.timeout_s !== undefined ? collect.timeout_s * 1000 : (rt.collectTimeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS),
          maxBytes: collect.max_bytes ?? DEFAULT_COLLECT_BYTES,
          env: connectorEnv(rt, manifest),
          // A collect script only reads: it writes into the temporary directories and nowhere else.
          ...scriptSandbox(rt, manifest, []),
        });
  if (workBefore !== null && rt.workDir !== undefined) {
    if (workState(rt.workDir) !== workBefore) return { task: prepared({ type: 'collect_failed', reason: 'changed_work' }), collected: null };
  }
  if (!result.ok) {
    if (result.reason === 'timeout') stepTimeout(rt, id, 'collect');
    return { task: prepared({ type: 'collect_failed', reason: result.reason }), collected: null };
  }
  // The run condition is the name of a flag. False: the task closes without the model.
  if (manifest.run_if !== undefined && result.flags[manifest.run_if] === false) {
    return { task: prepared({ type: 'prepared', work: false, flag: manifest.run_if }), collected: null };
  }
  const task = prepared({ type: 'prepared', work: true, outputs: collect.outputs.length, bytes: result.bytes }, result.outputs);
  return { task, collected: task.state === 'executing' ? result.outputs : null };
}

// The variables of the read connectors that a manifest names: a script of the task gets these
// and no variable of another connector.
function connectorEnv(rt: Runtime, manifest: Manifest): string[] {
  return (manifest.permissions.read ?? []).flatMap((name) => rt.merged.connectorEnv[name] ?? []);
}

// The sandbox of a script of the task, when the config asks for one. The network: only when the
// manifest names a read connector that needs it. The files of the connectors that the manifest
// does not name cannot be read. `writable`: where this script may write besides the temporary
// directories.
function scriptSandbox(rt: Runtime, manifest: Manifest | undefined, writable: string[], local = false): { sandbox: Sandbox } | Record<string, never> {
  if (rt.scriptSandbox !== true) return {};
  const reads = manifest?.permissions.read ?? [];
  const home = os.homedir();
  const denyRead = Object.entries(rt.merged.connectorFiles).filter(([name]) => !reads.includes(name)).flatMap(([, files]) => files.map((f) => path.join(home, f.slice(2))));
  return { sandbox: { network: reads.some((name) => rt.merged.connectorNetwork.includes(name)), denyRead, writable, ...(local ? { local: true } : {}) } };
}

// Where a check script may write: the work that it checks. The path comes from a collect script,
// so it is taken only when it is a work: the directory of the client, or the top of a repository.
// The root of the system, the home directory and a directory above it are never a work.
function checkedWork(rt: Runtime, task: Task): string[] {
  const root = sourceRoot(rt, task);
  if (root === null || !path.isAbsolute(root)) return [];
  let dir: string;
  let home: string;
  try {
    dir = fs.realpathSync(root);
    home = fs.realpathSync(os.homedir());
    if (!fs.statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  if (dir === '/' || home === dir || home.startsWith(`${dir}/`)) return [];
  // The code of the harness itself is never a place where a script of a pack writes.
  for (const own of rt.harnessDirs ?? []) {
    let real = own;
    try {
      real = fs.realpathSync(own);
    } catch {
      // the path as the config names it
    }
    if (dir === real || dir.startsWith(`${real}/`) || real.startsWith(`${dir}/`)) return [];
  }
  const own = rt.workDir !== undefined && path.resolve(rt.workDir) === root;
  return own || fs.existsSync(path.join(dir, '.git')) ? [dir] : [];
}

// The directory of the work that a result of the task is about: the collect result that the
// manifest names as the source.
function sourceRoot(rt: Runtime, task: Task): string | null {
  const name = task.manifest?.done.source;
  const root = name === undefined ? undefined : readCollected(rt, task.id)?.[name];
  return typeof root === 'string' && root !== '' ? root : null;
}

// The files of the checks that gave a red answer: the work of each such task and the patterns of
// its manifest. Until a green answer a change of these files is a decision of the human.
export function redGuards(rt: Runtime): { root: string; patterns: RegExp[]; dirs: string[] }[] {
  const out: { root: string; patterns: RegExp[]; dirs: string[] }[] = [];
  for (const task of openTasks(rt)) {
    const guards = task.manifest?.done.guards;
    if (task.red !== true || guards === undefined || guards.length === 0) continue;
    const root = sourceRoot(rt, task) ?? rt.workDir;
    if (root === undefined || !path.isAbsolute(root)) continue;
    let dir = root;
    try {
      dir = fs.realpathSync(root);
    } catch {
      // the path as the collect step named it
    }
    // The part of a pattern before its first `*` is a fixed path: a directory above it holds the files too.
    const dirs = guards.map(fixedStart);
    out.push({ root: dir, patterns: guards.map(guardPattern), dirs });
  }
  return out;
}

// An accepted result holds for the work that the check saw. False: the work changed after the
// check, and the publication of the task ended without a verified result.
export function verifyWork(rt: Runtime, id: string, now: number = Date.now()): boolean {
  const task = loadTask(rt, id);
  if (task === null || task.state !== 'publishing') return true;
  const root = sourceRoot(rt, task);
  const term = task.manifest?.done.valid_minutes;
  // The work had a fingerprint at the check. No fingerprint now is not "the same work".
  const reason =
    task.work !== undefined && (root === null ? null : workState(root)) !== task.work ? 'work_changed'
    // The check itself is a part of the answer: a weaker check would have given another one.
    : task.check !== undefined && checkVersion(rt, task) !== task.check ? 'check_changed'
    : term !== undefined && task.checked !== undefined && now - task.checked > term * 60_000 ? 'expired'
    : null;
  if (reason === null) return true;
  applyEvent(rt, id, { type: 'invalidate', reason }, 'harness');
  return false;
}

// The version of the check of a task: the fingerprint of the script of the pack that decides.
// The citation check is code of the core: it has no version of its own.
function checkVersion(rt: Runtime, task: Task): string | null {
  const name = task.manifest?.done.check;
  const file = name === undefined ? undefined : rt.merged.scriptFiles[`check/${name}`];
  if (file === undefined) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

export type Proposed = { ok: true; task: Task } | { ok: false; error: 'bad_contract'; details: Fault<string>[] };

// A contract: a manifest for one task, proposed by the agent. It is checked by the same code as
// a manifest of a pack, against the same packs, so it cannot ask for more than they allow. The
// limits are mandatory. Nothing runs before the human approves it.
export function proposeContract(rt: Runtime, value: unknown, opts: { session?: string } = {}): Proposed {
  const details: Fault<string>[] = validateManifest(value, closedContext(rt.merged));
  if (details.length === 0 && isObj(value)) {
    const m = value as unknown as Manifest;
    if (m.package !== 'person') details.push({ code: 'not_allowed', path: 'package' });
    if (m.trigger.kind !== 'command') details.push({ code: 'not_allowed', path: 'trigger.kind' });
    if (m.model.token_limit === undefined) details.push({ code: 'missing', path: 'model.token_limit' });
    // A contract has no inputs: its targets are written out in full.
    if ((m.trigger.inputs ?? []).length > 0) details.push({ code: 'not_allowed', path: 'trigger.inputs' });
    if (rt.merged.scenarios.some((s) => s.name === m.name)) details.push({ code: 'duplicate', path: 'name' });
  }
  if (details.length > 0) return { ok: false, error: 'bad_contract', details };
  const made = newContractTask(newId(), structuredClone(value) as Manifest);
  // The proposal knows its session, but it is not the current task of the session yet: a
  // proposal that the human refuses must not suspend the task before it.
  if (opts.session !== undefined) made.task.session = opts.session;
  // A contract without a level takes the level of the packs, as a scenario does.
  made.task.level ??= defaultLevel(rt);
  commit(rt, { task: made.task, rows: made.rows });
  return { ok: true, task: made.task };
}

// The approval of a contract by the human: the task starts as a scenario task would.
export function approveContract(rt: Runtime, id: string): { task: Task; collected: Record<string, unknown> | null } | { error: 'unknown_task' | 'busy' | 'not_a_proposal' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const approved = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return 'unknown_task' as const;
    if (task.kind !== 'contract' || task.state !== 'waiting_human' || task.waiting !== 'contract') return 'not_a_proposal' as const;
    return commit(rt, step(task, { type: 'human', decision: 'accept' })).task;
  });
  if (typeof approved === 'string') return { error: approved };
  if (approved.session !== undefined) patchSession(rt, approved.session, { scenario: approved.id });
  freeze(rt, approved.id);
  return prepareTask(rt, approved);
}

// The agent asks for the higher level of the model that the manifest allows. Once for a task.
export function raiseLevel(rt: Runtime, id: string): { task: Task } | { error: 'unknown_task' | 'busy' | 'not_allowed' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return 'unknown_task' as const;
    const to = task.manifest?.model.raise_to;
    // A raise goes up: a level that is not above the level of the task is no raise.
    if (task.state !== 'executing' || to === undefined || task.raised === true || LEVELS.indexOf(to) <= LEVELS.indexOf(task.level ?? 'medium')) return 'not_allowed' as const;
    const next: Task = { ...task, level: to, raised: true };
    writeAtomic(taskFile(rt, id), next);
    const row: RowInput = { kind: 'executor.level_raised', project: rt.project, task: id, level: to };
    if (next.session !== undefined) row.session = next.session;
    if (next.scenario !== undefined) {
      row.scenario = next.scenario;
      row.scenario_v = next.version ?? 1;
    }
    rt.journal.write(row);
    return next;
  });
  return typeof r === 'string' ? { error: r } : { task: r };
}

// Changes a task under its lock, outside the task loop: what the harness notes about the task
// (who holds it, which executors run). null: the task is unknown or the change gave nothing.
export function mutateTask(rt: Runtime, id: string, change: (task: Task) => Task | null): Task | null {
  if (!TASK_ID.test(id)) return null;
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    const next = task === null ? null : change(task);
    if (next !== null) writeAtomic(taskFile(rt, id), next);
    return next;
  });
  return r === 'busy' ? null : r;
}

export function openFreeTask(rt: Runtime): Task {
  const made = newFreeTask(newId());
  commit(rt, { task: made.task, rows: made.rows });
  return made.task;
}

// The done checks that the core runs itself.
const coreChecks = (task: Task): boolean => task.manifest !== undefined && task.manifest.done.kind !== 'human';

export function applyEvent(rt: Runtime, id: string, event: TaskEvent, origin: Origin): Step | { error: 'unknown_task' | 'not_allowed' | 'busy' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  if (!ALLOWED[origin].includes(event.type)) return { error: 'not_allowed' };
  // Every end of a publication first compares the work with the work that the check saw: a
  // publication that expires or that the human stops keeps the label of the check only then.
  if (event.type === 'expire' || event.type === 'finish' || (event.type === 'human' && event.decision === 'stop')) verifyWork(rt, id);
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return null;
    // A check that the core runs itself takes the report as text and gives its own answer:
    // nobody else can move such a task into the check or out of it.
    if (coreChecks(task) && (event.type === 'report' || event.type === 'check')) return 'not_allowed' as const;
    // The approval of a contract starts a preparation: only `approveContract` does both.
    if (task.waiting === 'contract' && event.type === 'human' && event.decision === 'accept') return 'not_allowed' as const;
    const s = step(task, event);
    if (s.error === undefined && event.type === 'human' && event.decision === 'return') {
      // The human lets a stopped task go on: one more budget of the size of its limit, or the
      // work past the contract.
      const limit = task.manifest?.model.token_limit ?? frozenRuntime(rt, id).merged.context.maxTokens;
      if (task.waiting === 'limit' && limit !== undefined) s.task.budget = Math.max(task.budget ?? limit, task.cost?.tokens ?? 0) + limit; // on top of what the task spent while it waited
      if (task.waiting === 'scope') s.task.widened = true;
    }
    return commit(rt, s);
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
// `unshown`: the client shows no question to the human in its mode now. The row of a question says
// so: a question that no human saw is not counted among the questions to the human.
export function decideAction(rt: Runtime, id: string, action: Action, layers: LayerDecision[], sub?: { role: string; parent: string }, unshown = false): Decision | null {
  if (!TASK_ID.test(id)) return null;
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return null;
    const d = decideFor(task, action, layers);
    if (unshown) for (const row of d.rows) if (row.kind === 'policy.decision' && row.data?.outcome === 'ask') row.data = { ...row.data, unshown: 1 };
    commit(rt, { task: d.task, rows: d.rows }, sub);
    return d.decision;
  });
  return r === 'busy' ? null : r;
}

// The one confirmation of a grant of the envelope by the human.
export function confirm(rt: Runtime, id: string, key: string, outward = false): boolean {
  if (!TASK_ID.test(id)) return false;
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return false;
    const next = confirmGrant(task, key, outward);
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
  // The deadline of the check is short: a citation check reads a few files.
  const deadline = Date.now() + Math.min(rt.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, LOCK_STALE_MS / 2);
  // The named texts: an output of the collect step as its text. An output that is not one text
  // (a list of comments) is the lines of all its texts.
  let texts: Record<string, string> | undefined;
  if (done.texts !== undefined) {
    texts = {};
    const lines = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(lines) : isObj(value) ? Object.values(value).flatMap(lines) : []);
    for (const name of done.texts) if (collected?.[name] !== undefined) texts[name] = lines(collected[name]).join('\n');
  }
  return checkCitations(text, {
    root,
    ...(texts !== undefined ? { texts } : {}),
    ...(done.reject !== undefined ? { reject: done.reject } : {}),
    ...(done.unquoted !== undefined ? { unquoted: done.unquoted } : {}),
    ...(changed !== undefined ? { changed } : {}),
    ...(task.manifest?.output.max_items !== undefined ? { maxItems: task.manifest.output.max_items } : {}),
    ...(task.manifest?.output.fields !== undefined ? { fields: task.manifest.output.fields } : {}),
    expired: () => Date.now() > deadline,
  });
}

const DEFAULT_CHECK_SCRIPT_MS = 5 * 60_000;

// A check of the kinds "command", "artifact" and "external state": a script of a pack decides.
// The script gets the task, its inputs and the paths of the report and of the collected results,
// and prints one result: PASS or FAIL. A script that is missing or fails gives no answer.
function scriptCheck(rt: Runtime, task: Task): Answer {
  const none = (reason: 'no_check' | 'check_failed'): Answer => ({ result: 'none', reason, n: 0, faults: [] });
  const name = task.manifest?.done.check;
  const file = name === undefined ? undefined : rt.merged.scriptFiles[`check/${name}`];
  if (file === undefined) return none('no_check');
  const collected = taskFile(rt, task.id, '.collect');
  const r = runCollect(file, { inputs: task.inputs, task: task.id, report: reportFile(rt, task.id), collected: fs.existsSync(collected) ? collected : null }, {
    outputs: ['result'], flags: [], timeoutMs: rt.checkScriptTimeoutMs ?? DEFAULT_CHECK_SCRIPT_MS, maxBytes: 64 * 1024,
    ...(task.manifest !== undefined ? { env: connectorEnv(rt, task.manifest) } : {}),
    // A check runs the tests of the work: it writes into the directory of the work that it checks,
    // and it reaches this machine (a local server of the tests, a container engine).
    ...scriptSandbox(rt, task.manifest, checkedWork(rt, task), true),
  });
  if (!r.ok) {
    if (r.reason === 'timeout') stepTimeout(rt, task.id, 'check');
    return none('check_failed');
  }
  const result = r.outputs.result;
  return result === 'PASS' || result === 'FAIL' ? { result, n: 0, faults: [] } : none('check_failed');
}

export type Submitted = { step: Step; answer?: Answer } | { error: 'unknown_task' | 'busy' | 'too_large' };
export type Checked = { step: Step; answer: Answer } | { error: 'unknown_task' | 'busy' | 'not_checking' | 'soaking' };

// Runs the check of a task that waits for it, from the report that is kept on the disk, and applies
// the answer. The answer is computed without the lock and applied under it. A call that met a busy lock, or a
// process that died after the report, leaves the task in "checking": this call can be made again.
export function runCheck(rt: Runtime, id: string, now: number = Date.now()): Checked {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  // The check runs without the lock: a script of a pack can run for minutes, and a lock that old
  // counts as abandoned. The answer is applied under the lock, to the task as it is then, and
  // only when that task still waits for this check. A task that was stopped meanwhile stays stopped.
  const before = loadTask(rt, id);
  if (before === null) return { error: 'unknown_task' };
  if (before.state !== 'checking' || !coreChecks(before)) return { error: 'not_checking' };
  // The soak: the second answer is not due yet.
  if (before.soak !== undefined && now < before.soak) return { error: 'soaking' };
  const version = checkVersion(rt, before);
  const text = readReport(rt, id);
  // A report that cannot be read is a fault of the harness: no answer.
  // The answer holds for one state of the work: the work is read before the check and after it.
  const root = sourceRoot(rt, before);
  const workBefore = root === null ? null : workState(root);
  let answer: Answer = text === null ? { result: 'none', reason: 'no_source', n: 0, faults: [] } : before.manifest?.done.kind === 'citations' ? citations(rt, before, text) : scriptCheck(rt, before);
  const work = root === null ? null : workState(root);
  // The work changed while the check ran: nothing says which work the answer is about.
  if (workBefore !== null && work !== workBefore) answer = { result: 'none', reason: 'work_changed', n: 0, faults: [] };
  // The check changed while it ran: nothing says which check answered.
  if (checkVersion(rt, before) !== version) answer = { result: 'none', reason: 'check_failed', n: 0, faults: [] };
  // The second answer of a soak is about the work and the check of the first: a soak shows that one state held over the term.
  if (before.soak !== undefined && answer.result === 'PASS' && ((work ?? undefined) !== before.work || (version ?? undefined) !== before.check)) answer = { result: 'none', reason: 'work_changed', n: 0, faults: [] };
  const detail: Record<string, string | number> = answer.result === 'none' ? {} : { n: answer.n, faults: answer.faults.length };
  if (answer.reason !== undefined) detail.reason = answer.reason;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = withLock(rt, id, (): Checked => {
      const task = loadTask(rt, id);
      if (task === null) return { error: 'unknown_task' };
      // The same wait: the same count of returns and the same report that the check read.
      if (task.state !== 'checking' || task.returns !== before.returns || task.soak !== before.soak || readReport(rt, id) !== text) return { error: 'not_checking' };
      return { step: commit(rt, step(task, { type: 'check', result: answer.result, detail, at: now, ...(version !== null ? { check: version } : {}), ...(work !== null ? { work } : {}) })), answer };
    });
    if (r !== 'busy') return r;
  }
  return { error: 'busy' };
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
