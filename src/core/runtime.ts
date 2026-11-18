// The runtime: opens tasks from the merged packs, keeps their state on the disk, runs the collect
// script and writes the journal. One task is one file; the task belongs to the harness, not to a session.
// Specification: docs/spec/harness-spec.md, sections 3, 5 and П4.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Journal, RowInput } from '../journal/writer.ts';
import type { Merged } from '../packs/packs.ts';
import type { Action, Decision, LayerDecision } from '../contracts/policy.ts';
import { LEVELS, fixedStart, guardPattern, inputForm, validateManifest, type Level, type Manifest } from '../contracts/manifest.ts';
import { isObj, type Fault } from '../contracts/shape.ts';
import { closedContext } from '../packs/packs.ts';
import { patchSession, withSession, readSession } from './sessions.ts';
import { checkCitations, type Answer } from '../check/citations.ts';
import { runCollect, type Sandbox } from './collect.ts';
import { workState, workTop } from './work.ts';
import { notify } from './notify.ts';
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
  uptimeMs?: () => number; // the time since the start of the process of a hook: the cost of one decision
  notify?: string[]; // the command of the machine that shows a notice to the human; `{text}` is the notice
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
    if (r.fp !== undefined) row.fp = r.fp;
    // The basis of a decision that a pack gave names the level of that pack.
    const layer = r.kind === 'policy.basis' ? r.data?.layer : undefined;
    if (layer === 'organization' || layer === 'project' || layer === 'person') row.pack = layer;
    rt.journal.write(row);
  }
}

function commit(rt: Runtime, s: Step, sub?: { role: string; parent: string }): Step {
  if (s.error === undefined) {
    writeAtomic(taskFile(rt, s.task.id), s.task);
    record(rt, s.task, s.rows, sub);
    // A task that starts to wait for the human says so outside the client, by the command of the
    // config: the human may be away from the window. The words are of the harness: the id and the
    // reason. A wait for a decision of the gate has the notice of the queue.
    for (const r of s.rows) {
      const reason = r.kind === 'task.waiting_human' ? r.data?.reason : undefined;
      if (typeof reason === 'string' && reason !== 'gate') notify(rt, `reins: the task ${s.task.id} waits for you: ${reason}. \`reins tasks\` shows it.`);
    }
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
export function openScenario(rt: Runtime, name: string, inputs: Inputs, opts: { session?: string; byForm?: boolean } = {}): Opened {
  const scenario = rt.merged.scenarios.find((s) => s.name === name);
  if (scenario === undefined) return { ok: false, error: 'unknown_scenario' };
  if (scenario.manifest.state === 'disabled') return { ok: false, error: 'disabled' };
  // Nobody called the scenario for the term of the packs: the human brings it back with `reins enable`.
  if (scenarioOff(rt, name)) return { ok: false, error: 'idle' };
  // The task works with its own copy of the manifest from here on.
  const manifest = structuredClone(scenario.manifest);
  const made = newScenarioTask(newId(), manifest, { ...inputs }, opts.byForm === true ? 'input_form' : 'scenario_name');
  if ('errors' in made) return { ok: false, error: 'bad_inputs', details: made.errors };
  if (scenario.instructions !== undefined) made.task.instructions = scenario.instructions;
  made.task.level ??= defaultLevel(rt);
  hold(rt, made.task, opts.session);
  commit(rt, { task: made.task, rows: made.rows });
  freeze(rt, made.task.id);
  noteUse(rt, name);
  return { ok: true, ...prepareTask(rt, made.task) };
}

// A scenario by the form of the input (harness-core, page 8): a value that fits the form of one
// manifest opens that scenario without its name. The form is the pattern of the one input of a
// command scenario. A value that fits the forms of several manifests opens nothing: the human
// chooses by the name. A type alone is no form.
const MAX_FORM_VALUE = 500;
export type OpenedByForm = Opened | { ok: false; error: 'no_match' } | { ok: false; error: 'several'; scenarios: string[] };
export function openByForm(rt: Runtime, value: string, opts: { session?: string } = {}): OpenedByForm {
  const fits: { name: string; input: string }[] = [];
  // A value is a ticket, a link, a name: a longer text has no form, and a pattern of a pack is not run on it.
  if (value.length > MAX_FORM_VALUE || /[\r\n]/.test(value)) return { ok: false, error: 'no_match' };
  for (const s of rt.merged.scenarios) {
    const inputs = s.manifest.trigger.inputs ?? [];
    const [only] = inputs;
    // A scenario that does not act (disabled, or switched off for no calls) is no choice.
    if (s.manifest.trigger.kind !== 'command' || s.manifest.state === 'disabled' || scenarioOff(rt, s.name) || inputs.length !== 1 || only === undefined || only.pattern === undefined) continue;
    if (inputForm(only.pattern)?.test(value) === true) fits.push({ name: s.name, input: only.name });
  }
  const [one] = fits;
  if (one === undefined) return { ok: false, error: 'no_match' };
  if (fits.length > 1) return { ok: false, error: 'several', scenarios: fits.map((f) => f.name).sort() };
  return openScenario(rt, one.name, { [one.input]: value }, { ...opts, byForm: true });
}

// The session that holds a task. The task becomes the current scenario task of that session:
// the task that the session worked on before stays open, but is suspended.
function hold(rt: Runtime, task: Task, session: string | undefined): void {
  if (session === undefined) return;
  task.session = session;
  task.opener = session;
  // The tasks that the request of now opened: at a stop they say that a check of its change is under way.
  withSession(rt, session, (now) => ({ next: { ...now, scenario: task.id, opened: [...(now.opened ?? []), task.id].slice(-20) }, result: undefined }));
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
    // The state of the source that the collect step named, at this moment: the executor reads this
    // work. The check answers later, and the work can change meanwhile.
    const source = manifest.done.source === undefined ? undefined : outputs?.[manifest.done.source];
    const read = typeof source === 'string' && source !== '' ? workState(source) : null;
    // A busy lock is tried again: the end of a preparation must not be lost.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const done = withLock(rt, id, () => {
        const now = loadTask(rt, id);
        if (now === null || now.state !== 'preparing') return now;
        if (outputs !== undefined) writeAtomic(taskFile(rt, id, '.collect'), outputs);
        const next = step(now, event);
        if (next.error === undefined && read !== null) next.task.read = read;
        return commit(rt, next).task;
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
    const root = task.root ?? sourceRoot(rt, task) ?? rt.workDir;
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
  const root = task.root ?? sourceRoot(rt, task);
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
  const names = checkNames(task);
  if (names.length === 0) return null;
  // A check of several parts has one version: a change of any part is a change of the check.
  // A check of one name keeps its version as it always was, the fingerprint of the one file: a
  // task that was accepted before this code keeps its answer.
  const several = task.manifest?.done.checks !== undefined;
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    const file = rt.merged.scriptFiles[`check/${name}`];
    if (file === undefined) return null;
    try {
      if (several) hash.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
      else hash.update(fs.readFileSync(file));
    } catch {
      return null;
    }
  }
  return hash.digest('hex').slice(0, 32);
}

// The scripts of the check of a task: the parts that its manifest names, or the one name.
function checkNames(task: Task): string[] {
  const done = task.manifest?.done;
  return done?.checks ?? (done?.check !== undefined ? [done.check] : []);
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
// The human says that the result of a closed task was wrong: a fact of the journal, once for a
// task. The task stays closed with its label: the fact counts the results that a check or a human
// accepted and that were not right.
export function disputeResult(rt: Runtime, id: string): { task: Task; first: boolean } | { error: 'unknown_task' | 'busy' | 'not_closed' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return 'unknown_task' as const;
    if (task.state !== 'closed') return 'not_closed' as const;
    if (task.disputed !== undefined) return { task, first: false };
    const next: Task = { ...task, disputed: new Date().toISOString() };
    writeAtomic(taskFile(rt, id), next);
    return { task: next, first: true };
  });
  if (typeof r === 'string') return { error: r };
  if (r.first) record(rt, r.task, [{ kind: 'task.result_disputed', data: { label: r.task.label ?? 'not_verified' } }]);
  return r;
}

// The word of the human: the done check sent the work of this task back, and the work was right.
// The task must have a send-back; the journal has the word once for a task. The task itself does
// not change its state: the word is a measure of the check, not a way past it.
export function disputeFail(rt: Runtime, id: string): { task: Task; first: boolean } | { error: 'unknown_task' | 'busy' | 'no_fail' } {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const r = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return 'unknown_task' as const;
    if (task.returns < 1) return 'no_fail' as const;
    if (task.fail_disputed !== undefined) return { task, first: false };
    const next: Task = { ...task, fail_disputed: new Date().toISOString() };
    writeAtomic(taskFile(rt, id), next);
    return { task: next, first: true };
  });
  if (typeof r === 'string') return { error: r };
  if (r.first) record(rt, r.task, [{ kind: 'check.fail_disputed', data: { n: r.task.returns } }]);
  return r;
}

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
    // An approval of a result, also of one that the check did not accept: the human saw the work as it is now.
    if (event.type === 'human' && event.decision === 'accept' && (task.waiting === 'approval' || task.waiting === 'check') && task.root !== undefined) {
      const work = workState(task.root);
      if (work !== null) event = { ...event, work, at: Date.now() };
    }
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
    ...(done.recheck !== undefined ? { recheck: done.recheck } : {}),
    ...(changed !== undefined ? { changed } : {}),
    ...(task.manifest?.output.max_items !== undefined ? { maxItems: task.manifest.output.max_items } : {}),
    ...(task.manifest?.output.fields !== undefined ? { fields: task.manifest.output.fields } : {}),
    expired: () => Date.now() > deadline,
  });
}

const DEFAULT_CHECK_SCRIPT_MS = 5 * 60_000;

// A check of the kinds "command", "artifact" and "external state": a script of a pack decides.
// The script gets the task, its inputs, the paths of the report and of the collected results and
// its time limit, and prints one result: PASS or FAIL. A script that is missing or fails gives no answer.
function scriptCheck(rt: Runtime, task: Task, report: string = reportFile(rt, task.id)): Answer {
  const names = checkNames(task);
  if (names.length === 0) return { result: 'none', reason: 'no_check', n: 0, faults: [] };
  // Every part runs, also after a part that failed: a red answer names each part that did not pass.
  // The time limit is of one part: the parts run one after another.
  const results = names.map((name) => ({ name, ...partCheck(rt, task, name, report) }));
  const why = results.flatMap((p) => (p.why === undefined ? [] : [{ name: p.name, ...p.why }]));
  if (names.length === 1 && task.manifest?.done.checks === undefined) {
    const one = results[0];
    return one === undefined || one.result === 'none' ? { result: 'none', reason: one?.reason ?? 'no_check', n: 0, faults: [], ...(why.length > 0 ? { why } : {}) } : { result: one.result, n: 0, faults: [], ...(why.length > 0 ? { why } : {}) };
  }
  const bad = results.filter((p) => p.result !== 'PASS').map((p) => ({ name: p.name, result: p.result as 'FAIL' | 'none' }));
  // Every part without an answer has no script: the cause is the pack, not a run of a script.
  const silent = results.filter((p) => p.result === 'none');
  const reason = silent.length > 0 && silent.every((p) => p.reason === 'no_check') ? 'no_check' : 'check_failed';
  if (bad.length === 0) return { result: 'PASS', n: names.length, faults: [] };
  // One part that failed makes the answer red. Without one, a part that gave no answer leaves the whole check without an answer.
  return bad.some((p) => p.result === 'FAIL') ? { result: 'FAIL', n: names.length, faults: [], parts: bad, ...(why.length > 0 ? { why } : {}) } : { result: 'none', reason, n: names.length, faults: [], parts: bad, ...(why.length > 0 ? { why } : {}) };
}

type Why = { cause: string; exit?: number; stderr?: string; limit_s?: number };
function partCheck(rt: Runtime, task: Task, name: string, report: string): { result: 'PASS' | 'FAIL' | 'none'; reason?: 'no_check' | 'check_failed'; why?: Why } {
  const file = rt.merged.scriptFiles[`check/${name}`];
  if (file === undefined) return { result: 'none', reason: 'no_check' };
  const collected = taskFile(rt, task.id, '.collect');
  const timeoutMs = rt.checkScriptTimeoutMs ?? DEFAULT_CHECK_SCRIPT_MS;
  // `limit_s`: the time limit of this script, in seconds. A script that divides its time reads it here, not from the config.
  const r = runCollect(file, { inputs: task.inputs, task: task.id, report, collected: fs.existsSync(collected) ? collected : null, limit_s: timeoutMs / 1000 }, {
    outputs: ['result'], flags: [], timeoutMs, maxBytes: 64 * 1024,
    ...(task.manifest !== undefined ? { env: connectorEnv(rt, task.manifest) } : {}),
    // A check runs the tests of the work: it writes into the directory of the work that it checks,
    // and it reaches this machine (a local server of the tests, a container engine).
    ...scriptSandbox(rt, task.manifest, checkedWork(rt, task), true),
  });
  if (!r.ok) {
    if (r.reason === 'timeout') {
      stepTimeout(rt, task.id, 'check');
      return { result: 'none', reason: 'check_failed', why: { cause: 'timeout', limit_s: Math.round(timeoutMs / 1000) } };
    }
    // A script that ran and failed says why: its exit code and the end of its error text.
    return { result: 'none', reason: 'check_failed', why: { cause: r.reason, ...(r.reason === 'exit' && r.exit !== undefined ? { exit: r.exit } : {}), ...(r.reason === 'exit' && r.stderr !== undefined ? { stderr: r.stderr } : {}) } };
  }
  const result = r.outputs.result;
  // A script that answers FAIL says why on its error output: the end of that text goes to the agent.
  if (result === 'FAIL') return { result, ...(r.stderr !== undefined ? { why: { cause: 'fail', stderr: r.stderr } } : {}) };
  return result === 'PASS' ? { result } : { result: 'none', reason: 'check_failed', why: { cause: 'bad_result' } };
}

// `bad_form`: a text report without a section that the manifest names; `missing` lists them.
export type Submitted = { step: Step; answer?: Answer } | { error: 'unknown_task' | 'busy' | 'too_large'; max_bytes?: number } | { error: 'bad_form'; missing: string[] };
// A section of a text report: a line that holds only the name of the section, as a heading (`#`)
// or with a colon after it. The case of the letters does not matter.
function hasSection(text: string, name: string): boolean {
  const want = name.trim().toLowerCase();
  return text.split(/\r?\n/).some((line) => line.trim().replace(/^#{1,6}\s*/, '').replace(/[:：]\s*$/, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/[:：]\s*$/, '').trim().toLowerCase() === want);
}

// The done check before the report (harness-check, page 1): the agent asks for the answer of the
// check while it still works. The answer accepts nothing and returns nothing: the task executes
// on, no send-back is spent. Only the report closes a task. The packs give the count of such runs
// for one task (`limits.probes`); without the count there is no such run. A red answer protects
// the files of the check, as a red answer to a report does.
export type Probed = { task: Task; answer: Answer; left: number } | { error: 'unknown_task' | 'busy' | 'not_allowed' | 'limit' | 'no_report' };
export function probeCheck(rt: Runtime, id: string, text: string | null): Probed {
  if (!TASK_ID.test(id)) return { error: 'unknown_task' };
  const max = rt.merged.context.maxProbes;
  // The run is counted first, under the lock: two calls never share one place of the count.
  const counted = withLock(rt, id, () => {
    const task = loadTask(rt, id);
    if (task === null) return 'unknown_task' as const;
    if (max === undefined || task.state !== 'executing' || !coreChecks(task)) return 'not_allowed' as const;
    if ((task.probes ?? 0) >= max) return 'limit' as const;
    // A sweep of quotes reads the report itself; a script can check the work without one.
    if (task.manifest?.done.kind === 'citations' && text === null) return 'no_report' as const;
    const next: Task = { ...task, probes: (task.probes ?? 0) + 1 };
    writeAtomic(taskFile(rt, id), next);
    return next;
  });
  if (typeof counted === 'string') return { error: counted };
  const task = counted;
  const kind = task.manifest?.done.kind ?? 'command';
  record(rt, task, [{ kind: 'check.started', data: { check_kind: kind, probe: 1 } }]);
  // The text of this run lies beside the report of the task, never in its place.
  // One file for one run: two runs at one time never read the text of each other. A run without
  // a text gets an empty file, never the report of the task: `none` means no report for the script too.
  const file = taskFile(rt, id, `.probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(file, text ?? '');
  const version = checkVersion(rt, task);
  const unbound = task.manifest?.done.unbound === true;
  const root = unbound ? null : task.root ?? sourceRoot(rt, task) ?? (rt.workDir !== undefined && path.isAbsolute(rt.workDir) ? rt.workDir : null);
  const workBefore = root === null ? null : workState(root);
  const probeFrom = Date.now();
  let answer: Answer = kind === 'citations' ? citations(rt, task, text ?? '') : scriptCheck(rt, task, file);
  const probeMs = Date.now() - probeFrom;
  const work = root === null ? null : workState(root);
  if (workBefore !== null && work !== workBefore) answer = { result: 'none', reason: 'work_changed', n: 0, faults: [] };
  if (answer.result === 'PASS' && work === null && !unbound && kind !== 'citations') answer = { result: 'none', reason: 'no_work', n: 0, faults: [] };
  fs.rmSync(file, { force: true });
  const soaks = task.manifest?.done.soak_minutes !== undefined;
  const detail: Record<string, string | number> = { probe: 1, ms: probeMs, ...(soaks ? {} : { report: text === null ? 'none' : crypto.createHash('sha256').update(text).digest('hex').slice(0, 12), ...(version !== null ? { check: version.slice(0, 12) } : {}) }), ...(answer.reason !== undefined ? { reason: answer.reason } : {}) };
  const row: RowDraft = answer.result === 'none' ? { kind: 'check.no_answer', data: { ...detail, check_kind: kind } } : { kind: 'check.answered', data: { ...detail, result: answer.result, check_kind: kind }, ...(work !== null ? { fp: work } : {}) };
  // A red answer: the files of the check are protected from now on.
  const after = answer.result === 'PASS' ? task : mutateTask(rt, id, (now) => (now.red === true ? null : { ...now, red: true })) ?? loadTask(rt, id) ?? task;
  record(rt, after, [row]);
  return { task: after, answer, left: Math.max(0, (max ?? 0) - (after.probes ?? 0)) };
}

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
  const unbound = before.manifest?.done.unbound === true;
  const root = unbound ? null : before.root ?? sourceRoot(rt, before);
  const workBefore = root === null ? null : workState(root);
  const checkFrom = Date.now();
  let answer: Answer = text === null ? { result: 'none', reason: 'no_source', n: 0, faults: [] } : before.manifest?.done.kind === 'citations' ? citations(rt, before, text) : scriptCheck(rt, before);
  const checkMs = Date.now() - checkFrom;
  const work = root === null ? null : workState(root);
  // The work changed while the check ran: nothing says which work the answer is about.
  if (workBefore !== null && work !== workBefore) answer = { result: 'none', reason: 'work_changed', n: 0, faults: [] };
  // A green answer of a script holds for one state of a work. Without a fingerprint of the work
  // nothing says what the answer is about: that is no answer. A manifest whose result is no work
  // in a directory says so itself (`done.unbound`).
  if (answer.result === 'PASS' && work === null && !unbound && before.manifest !== undefined && before.manifest.done.kind !== 'citations') answer = { result: 'none', reason: 'no_work', n: 0, faults: [] };
  // The check changed while it ran: nothing says which check answered.
  if (checkVersion(rt, before) !== version) answer = { result: 'none', reason: 'check_failed', n: 0, faults: [] };
  // The second answer of a soak is about the work and the check of the first: a soak shows that one state held over the term.
  if (before.soak !== undefined && answer.result === 'PASS' && ((work ?? undefined) !== before.work || (version ?? undefined) !== before.check)) answer = { result: 'none', reason: 'work_changed', n: 0, faults: [] };
  const detail: Record<string, string | number> = answer.result === 'none' ? {} : { n: answer.n, faults: answer.faults.length };
  // How long the check ran: the wait of a task between its report and its answer.
  detail.ms = checkMs;
  // A check of several parts: how many parts ran and how many did not pass. The names stay in the answer for the agent.
  if (before.manifest?.done.checks !== undefined) {
    detail.parts = before.manifest.done.checks.length;
    // The count of the parts that did not pass is a fact only of an answer that the parts gave.
    if (answer.parts !== undefined || answer.result === 'PASS') detail.failed = answer.parts?.length ?? 0;
  }
  if (answer.reason !== undefined) detail.reason = answer.reason;
  // The report has no fault of its own: each fault is an item with a value of `done.reject`.
  const onlyRejected = answer.result === 'FAIL' && answer.reason === 'faults' && answer.faults.length > 0 && answer.faults.every((f) => f.fault === 'rejected');
  // The report that the check read: the same work and the same report must get the same answer.
  // The version of the check goes with it: a check that the owner changed is another check. A
  // task with a soak answers twice on one work by design: its rows name no report.
  if (text !== null && before.manifest?.done.soak_minutes === undefined) {
    detail.report = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
    if (version !== null) detail.check = version.slice(0, 12);
  }
  // The cause of one script without an answer is a code of the journal; its text is not. A script
  // that answered FAIL has a result in the journal, not a cause.
  if (answer.result === 'none' && answer.why?.length === 1 && answer.why[0] !== undefined) detail.cause = answer.why[0].cause;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = withLock(rt, id, (): Checked => {
      const task = loadTask(rt, id);
      if (task === null) return { error: 'unknown_task' };
      // The same wait: the same count of returns and the same report that the check read.
      if (task.state !== 'checking' || task.returns !== before.returns || task.soak !== before.soak || readReport(rt, id) !== text) return { error: 'not_checking' };
      return { step: commit(rt, step(task, { type: 'check', result: answer.result, detail, at: now, ...(version !== null ? { check: version } : {}), ...(work !== null && answer.reason !== 'work_changed' ? { work } : {}), ...(onlyRejected ? { rejected: true } : {}) })), answer };
    });
    if (r !== 'busy') {
      if (!('error' in r)) noteReview(rt, r.step.task, answer);
      return r;
    }
  }
  return { error: 'busy' };
}

// A review that the check accepted and that names findings to fix (`done.recheck`): the session
// of the task keeps it, one for a scenario in a repository. A change of the work after it needs
// the scenario again (AA31 - AA34). An accepted report of the same scenario in the same
// repository without such a finding ends that: the review ran again. A review whose work has no
// fingerprint or no repository is not kept: the stop could never compare it. A session that
// ended is not written.
// The session that a task counts for: its owner. The session that opens a task owns it. A session
// with a window that takes the task becomes its owner (`resumeTask`); a client without a window
// takes the task only for its run and the owner stays. The owner is a fact of the task, written
// at the take: it is never read from the files of the sessions.
export const ownerOf = (task: Task): string | undefined => task.opener ?? task.session;

const MAX_REVIEWS = 20;
function noteReview(rt: Runtime, task: Task, answer: Answer): void {
  // The review belongs to the owner of the task: the session of the author must see the answer
  // of a review that a client without a window reported.
  const session = ownerOf(task);
  if (answer.result !== 'PASS' || answer.recheck === undefined || session === undefined || task.scenario === undefined) return;
  if (task.work === undefined || task.root === undefined) return;
  const top = workTop(task.root);
  if (top === null) return;
  const { id, scenario } = task;
  const open = answer.recheck;
  // The review judged the work that it read at its preparation, not the work at the moment of the
  // check: the author can change the work while the reviewer reads.
  const work = task.read ?? task.work;
  const moved = work !== task.work;
  withSession(rt, session, (now) => {
    const others = (now.reviews ?? []).filter((r) => r.scenario !== scenario || r.top !== top);
    // A report with nothing to fix about an older state of the work ends no record: nobody read the work of now.
    if (open === 0 && (moved || others.length === (now.reviews ?? []).length)) return { next: null, result: undefined };
    const reviews = open > 0 ? [...others, { task: id, scenario, open, top, work }].slice(-MAX_REVIEWS) : others;
    const { reviews: _reviews, ...rest } = now;
    return { next: reviews.length > 0 ? { ...rest, reviews } : rest, result: undefined };
  }, 'known');
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
    // The form of the result (harness-manifest, part 7): a text report is not larger than the
    // manifest says, and it has every section that the manifest names. A report of another form
    // is not taken: nothing is written, the task goes on, no send-back is spent. A list of items
    // is data: the citation check reads its form.
    const output = task.manifest?.output;
    if (output !== undefined && task.manifest?.done.kind !== 'citations' && task.state === 'executing') {
      if (output.max_bytes !== undefined && size > output.max_bytes) return { refused: { error: 'too_large' as const, max_bytes: output.max_bytes } };
      // The sections are lines of a text: a report of another format has none.
      const missing = output.format !== 'text' ? [] : (output.sections ?? []).filter((name) => !hasSection(text, name));
      if (missing.length > 0) return { refused: { error: 'bad_form' as const, missing } };
    }
    // The work that the report is about: the source that the manifest names, else the directory
    // where the report is given. The answer of the check and an approval of the human hold for it.
    const root = task.manifest?.done.unbound === true ? null : sourceRoot(rt, task) ?? (rt.workDir !== undefined && path.isAbsolute(rt.workDir) ? rt.workDir : null);
    const s = step(task, { type: 'report', size, fp, ...(root !== null ? { root } : {}) });
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
  if ('refused' in submitted) return submitted.refused;
  if (submitted.error !== undefined || submitted.task.state !== 'checking' || !coreChecks(submitted.task)) return { step: submitted };
  const checked = runCheck(rt, id);
  return 'error' in checked ? { step: submitted } : checked;
}
