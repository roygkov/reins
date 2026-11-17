#!/usr/bin/env node
// The command line of the harness: the way a client runs a scenario without hooks.
//   reins scenarios                      the scenarios of the connected packs
//   reins open <scenario> [name=value]   opens a task and prints the input for the model
//   reins input <task>                   prints the input of an open task again
//   reins report <task> <file|->         submits the report of the model, prints the answer
//   reins check <task> [file|-]          runs the done check before the report, when the packs give a count
//   reins finish <task>                  ends the publication of an accepted result, closes the task
//   reins stop <task>                    the human stops a task in any open state
//   reins dispute <task>                 the human says that the result of a closed task was wrong
//   reins probes                         asks the barrier about the commands with a known answer of the packs
//   reins tasks                          the tasks that are not closed
//   reins tick                           opens the tasks of the scenarios whose schedule came
//   reins tick run                       the same, and starts the client of the machine for each task
//   reins timer [minutes]                the text of a timer of the system that runs `tick run`
//   reins run <scenario> [name=value]    opens a task and starts the client of the machine for it
//   reins fire <event> [name=value]      opens the tasks of the scenarios that wait for this event
//   reins fire run <event> [name=value]  the same, and starts the client of the machine for every task
//   reins queue [approve|reject <id>]    the actions that a rule deferred; the human answers
//   reins metrics [days=N] [step=day|week] [project=here|<project>]
//                                        the eight numbers by day or by week, for a dashboard
// The output is one JSON object. Exit codes: 0 done, 2 the task is not closed as verified,
// 1 an error. The config names the packs: $REINS_CONFIG or ~/.config/reins/config.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadRuntime } from './client/config.ts';
import { runProbes } from './client/probes.ts';
import { runTask, runTasks } from './client/run.ts';
import { resumeTask } from './client/session.ts';
import { sessionOfCommand } from './core/sessions.ts';
import { isObj } from './contracts/shape.ts';
import { findRoot } from './gate/index.ts';
import { taskInput } from './client/input.ts';
import { applyEvent, approveContract, collectedDir, disputeFail, disputeResult, loadTask, probeCheck, verifyWork, openByForm, openScenario, openTasks, proposeContract, raiseLevel, readCollected, runCheck, submitReport, type Runtime, readReport } from './core/runtime.ts';
import type { Inputs, Task } from './core/task.ts';
import { MAX_PAUSE_MINUTES, pause } from './core/pause.ts';
import { listQueue, resolveQueued } from './core/queue.ts';
import { dueChecks, sweep } from './core/sweep.ts';
import { mergeView } from './core/merged.ts';
import { timerText } from './client/timer.ts';
import { writeWeek } from './craft/weekly.ts';
import { enableScenario, scenarioOff } from './core/idle.ts';
import { fire, tick } from './core/triggers.ts';
import { applyDue, listProposals, measure, propose, resolveProposal } from './craft/craft.ts';
import { BY, EIGHT, MEASURES, eight, ofProject, overTargets, series, summarize } from './journal/metrics.ts';
import { readJournal, readJournalSince } from './journal/writer.ts';
import { addRecord, brokenRecords, census, noteShown, closeCase, countUses, importRecords, isShared, listRecords, recordsForInput, restoreRecord, searchRecords, shareRecord, stepCase, vetoRecord, wrongRecord } from './memory/store.ts';

type Out = Record<string, unknown>;
// What a refusal of the memory says besides its code: the field of a text, the cause, the limit.
function faultOf(r: { field?: string; cause?: string; max?: number; length?: number }): Out {
  return { ...(r.field !== undefined ? { field: r.field } : {}), ...(r.cause !== undefined ? { cause: r.cause } : {}), ...(r.max !== undefined ? { max: r.max } : {}), ...(r.length !== undefined ? { length: r.length } : {}) };
}

// What a task that refused a command is, and the command that its state takes. A closed task
// takes nothing: the answer has its state and its label only.
function refusedBy(task: { id: string; state: string; label?: string; waiting?: string }): Out {
  const out: Out = { state: task.state, ...(task.label !== undefined ? { label: task.label } : {}), ...(task.waiting !== undefined ? { waiting: task.waiting } : {}) };
  const id = task.id;
  const next = task.state === 'executing' ? `the task takes a report: reins report ${id} <file>`
    : task.state === 'checking' ? `the check of the report did not answer: reins report ${id} - runs it again`
    : task.state === 'publishing' ? `the result is accepted: reins finish ${id} ends the publication`
    : task.state !== 'waiting_human' ? undefined
    : task.waiting === 'limit' || task.waiting === 'scope' ? `the task waits for the human: reins retry ${id} lets it go on, reins stop ${id} ends the task`
    : task.waiting === 'contract' ? `the task waits for the human: reins approve ${id} accepts the contract, reins stop ${id} ends the task`
    : task.waiting === 'gate' ? 'the task waits for the answer of the human to a question of the barrier'
    : `the task waits for the human: reins approve ${id} accepts the result, reins retry ${id} sends it back, reins stop ${id} ends the task`;
  return next === undefined ? out : { ...out, next };
}

class Stop extends Error {
  out: Out;
  constructor(error: string, more: Out = {}) {
    super(error);
    this.out = { ok: false, error, ...more };
  }
}

// The code of the harness: the command line lies in its `src`. A script of a pack never writes there.
const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The variables of the environment where the clients give a command the number of its session.
// Each client names its variable in the file `client.json` of its directory: the core names no client.
const SESSION_ENV: readonly string[] = ((): string[] => {
  const names: string[] = [];
  try {
    const root = path.join(HARNESS_ROOT, 'clients');
    for (const client of fs.readdirSync(root).sort()) {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(path.join(root, client, 'client.json'), 'utf8'));
        const name = value !== null && typeof value === 'object' ? (value as { session_env?: unknown }).session_env : undefined;
        if (typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name)) names.push(name);
      } catch {
        // this client names no variable
      }
    }
  } catch {
    // no clients beside the core
  }
  return names;
})();

function runtime(): Runtime {
  try {
    return { ...loadRuntime(), harnessDirs: [HARNESS_ROOT] };
  } catch (e) {
    if (e instanceof ConfigError) throw new Stop(e.code, { file: e.file });
    throw e;
  }
}

const INLINE_BYTES = 2000;
const MEMORY_INPUT_BYTES = 4000;

const isLink = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};
// Makes a directory and says that it is a real directory, not a link to another place.
function plainDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// A large collected result does not go into the context of the model: it is written to a file
// outside the state and the input names the file. The model reads what it needs from there.
function byReference(rt: Runtime, id: string, collected: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(collected)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    if (bytes <= INLINE_BYTES) {
      out[name] = value;
      continue;
    }
    const file = path.join(collectedDir(rt), id, `${name}.${typeof value === 'string' ? 'txt' : 'json'}`);
    // The copy lies where the agent can write. So it is written again whenever it differs from
    // what the state holds, and a place that is a link is not used: the result then stays in the input.
    if (!plainDir(collectedDir(rt)) || !plainDir(path.dirname(file)) || isLink(file)) {
      out[name] = value;
      continue;
    }
    let same = false;
    try {
      same = fs.readFileSync(file, 'utf8') === text;
    } catch {
      // no copy yet
    }
    if (!same) fs.writeFileSync(file, text);
    out[name] = { file, bytes };
  }
  return out;
}

function view(rt: Runtime, task: Task): Out {
  const out: Out = { ok: true, task: task.id, state: task.state };
  if (task.label !== undefined) out.label = task.label;
  if (task.waiting !== undefined) out.waiting = task.waiting;
  // A contract that waits for the human: the human reads what it asks for.
  if (task.waiting === 'contract') out.contract = task.manifest;
  const input = taskInput(task, readCollected(rt, task.id), 'reins', rt.merged.models, rt.merged.context.maxProbes);
  if (input !== null) {
    input.collected = byReference(rt, task.id, input.collected);
    // The notes of the packs: rules of work that hold for every task (language, tone).
    if (rt.merged.notes.length > 0) input.pack_notes = rt.merged.notes;
    // The memory about the places of this work: the changed files when the scenario names them.
    const changed = task.manifest?.done.changed === undefined ? undefined : readCollected(rt, task.id)?.[task.manifest.done.changed];
    const places = Array.isArray(changed) ? changed.map((f) => (typeof f === 'string' ? f : isObj(f) && typeof f.path === 'string' ? f.path : '')).filter((p) => p !== '') : [];
    // The terms of the task: the values of its inputs (a ticket, a change, a name). A link gives its parts.
    // A path of this machine is not a term: its parts (the name of the project, of the user) are in too many records.
    const terms = Object.values(task.inputs).flatMap((v) => (typeof v === 'number' ? [String(v)] : typeof v === 'string' && !/^[/~]/.test(v) ? v.split(/[\s/:?&=#@,;]+/) : [])).filter((w) => !/^(https?|www|com|org|net)$/i.test(w));
    const records = recordsForInput(rt, { paths: places, maxBytes: MEMORY_INPUT_BYTES, terms, ...(task.scenario !== undefined ? { scenario: task.scenario } : {}) });
    if (records.length > 0) {
      input.memory = records;
      input.protocol.push('`memory` holds records about this work. When a record helped, cite its id in the report: the harness counts that as a use of the record.');
    }
    out.input = input;
  }
  // The publication: the writes that the task names can be made now, then `finish` closes the task.
  if (task.state === 'publishing') out.writes = task.envelope;
  return out;
}

function scenarios(rt: Runtime): Out {
  return {
    ok: true,
    scenarios: rt.merged.scenarios.map((s) => {
      const row: Out = { name: s.name, title: s.manifest.title, level: s.level };
      if (s.manifest.description !== undefined) row.description = s.manifest.description;
      row.inputs = s.manifest.trigger.inputs ?? [];
      // What starts the scenario: a command, a schedule or an event.
      row.trigger = { kind: s.manifest.trigger.kind, ...(s.manifest.trigger.value !== undefined ? { value: s.manifest.trigger.value } : {}) };
      // Nobody called it for the term of the packs: `reins enable <name>` brings it back.
      if (scenarioOff(rt, s.name)) row.off = 'idle';
      return row;
    }),
    rejected: rt.merged.rejected,
    // A pack with a mistake is not connected: its rules and its scenarios do not act. The human must see it.
    ...(broken(rt).length > 0 ? { not_connected: broken(rt) } : {}),
  };
}

const broken = (rt: Runtime): { level: string; errors: unknown[] }[] =>
  rt.merged.packs.filter((p) => !p.connected && p.errors.length > 0).map((p) => ({ level: p.level, errors: p.errors.slice(0, 10) }));

// The done checks that this client can bring to an end: the core runs the citation check, the human approves.
const RUNNABLE: readonly string[] = ['citations', 'human', 'command', 'artifact', 'external'];

// The tasks that a trigger opened, each with a run of the client of the machine, one after
// another. A system that started the command reads the exit code: a task that did not end as
// verified is not a success.
function runOpened<T extends { task: string; state: string }>(rt: Runtime, list: T[]): { opened: unknown[]; failed?: true } {
  // Several clients at one time when the config says so: each in a work tree of its own.
  const replies = runTasks(rt, list.map((t) => t.task));
  const opened = list.map((t, i) => {
    const ran = replies[i] ?? { ran: false };
    const task = loadTask(rt, t.task);
    return { ...t, ...ran, state: task?.state ?? t.state, ...(task?.label !== undefined ? { label: task.label } : {}), ...(task?.waiting !== undefined ? { waiting: task.waiting } : {}) };
  });
  const failed = opened.some((t) => t.ran !== true || !((t.state === 'closed' || t.state === 'publishing') && t.label !== 'not_verified'));
  return { opened, ...(failed ? { failed: true as const } : {}) };
}

function open(rt: Runtime, name: string, pairs: string[]): Out {
  const types = new Map((rt.merged.scenarios.find((s) => s.name === name)?.manifest.trigger.inputs ?? []).map((i) => [i.name, i.type]));
  const inputs: Inputs = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Stop('usage');
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    inputs[key] = types.get(key) === 'number' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
  }
  // A scenario whose done check the core cannot run would stay in "checking" for ever: it is not opened.
  const kind = rt.merged.scenarios.find((s) => s.name === name)?.manifest.done.kind;
  if (kind !== undefined && !RUNNABLE.includes(kind)) throw new Stop('check_not_supported', { check: kind });
  // The task belongs to the session that last spoke in this directory.
  const session = sessionOfCommand(rt, process.cwd(), SESSION_ENV);
  const opened = openScenario(rt, name, inputs, session === undefined ? {} : { session });
  if (!opened.ok) throw new Stop(opened.error, 'details' in opened ? { details: opened.details } : {});
  return view(rt, opened.task);
}

function report(rt: Runtime, id: string, source: string): Out {
  let text: string;
  try {
    text = fs.readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch {
    throw new Stop('no_report');
  }
  // A task that waits for its check answer (a busy lock, a process that died): the check runs
  // again from the report that is kept. The new text is not read.
  const waits = loadTask(rt, id)?.state === 'checking';
  const r = waits ? runCheck(rt, id) : submitReport(rt, id, text);
  if ('error' in r) throw new Stop(r.error === 'not_checking' ? 'check_not_supported' : r.error, 'missing' in r ? { missing: r.missing } : 'max_bytes' in r && r.max_bytes !== undefined ? { max_bytes: r.max_bytes } : {});
  if (r.step.error !== undefined) throw new Stop(r.step.error, refusedBy(r.step.task));
  // A record of the memory that an accepted report cites by its id was used. A report that came
  // back, and a text that the harness did not read, count nothing.
  if (!waits && (r.answer === undefined || r.answer.result === 'PASS')) countUses(rt, text);
  const task = r.step.task;
  const out: Out = { ok: true, task: task.id, state: task.state };
  if (task.label !== undefined) out.label = task.label;
  if (task.waiting !== undefined) out.waiting = task.waiting;
  out.returns_left = Math.max(0, (task.manifest?.done.retries ?? 0) - task.returns);
  if (r.answer !== undefined) out.answer = r.answer;
  if (task.state === 'publishing') out.writes = task.envelope;
  return out;
}

function main(args: string[]): Out {
  const [command, first, ...rest] = args;
  if (command === 'scenarios' && first === undefined) return scenarios(runtime());
  // The merge of the packs: which pack is connected, which manifest was refused, which level gave each value.
  if (command === 'packs' && first === undefined) return { ok: true, ...mergeView(runtime()) };
  if (command === 'open' && first !== undefined) return open(runtime(), first, rest);
  // A scenario by the form of the input: the value fits the form of one manifest, and the code
  // opens that scenario. Several manifests: the human chooses by the name.
  if (command === 'match' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    const session = sessionOfCommand(rt, process.cwd(), SESSION_ENV);
    const opened = openByForm(rt, first, session === undefined ? {} : { session });
    if (!opened.ok) throw new Stop(opened.error, 'details' in opened ? { details: opened.details } : 'scenarios' in opened ? { scenarios: opened.scenarios } : {});
    return { ...view(rt, opened.task), scenario: opened.task.scenario ?? '' };
  }
  if (command === 'input' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    if (loadTask(rt, first) === null) throw new Stop('unknown_task');
    // Reading the input takes the task for the session of this directory: a suspended task comes
    // back, a task of an ended session continues here.
    resumeTask(rt, first, sessionOfCommand(rt, process.cwd(), SESSION_ENV));
    const task = loadTask(rt, first);
    if (task === null) throw new Stop('unknown_task');
    return view(rt, task);
  }
  // The agent proposes a contract for one task. It waits for the human.
  if (command === 'propose' && first !== undefined && rest.length === 0) {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(first, 'utf8'));
    } catch {
      throw new Stop('no_file');
    }
    const rt = runtime();
    const session = sessionOfCommand(rt, process.cwd(), SESSION_ENV);
    const r = proposeContract(rt, value, session === undefined ? {} : { session });
    if (!r.ok) throw new Stop(r.error, { details: r.details });
    return view(rt, r.task);
  }
  // The word of the human: the contract is approved and the work starts.
  if (command === 'approve' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    // The approval of the human: of a contract, or of a result that waits for it.
    const waits = loadTask(rt, first);
    if (waits !== null && waits.kind !== 'contract' || waits?.waiting === 'approval' || waits?.waiting === 'check') {
      const accepted = applyEvent(rt, first, { type: 'human', decision: 'accept' }, 'human');
      if (!('task' in accepted)) throw new Stop(accepted.error);
      if (accepted.error !== undefined) throw new Stop(accepted.error, refusedBy(accepted.task));
      return view(rt, accepted.task);
    }
    const r = approveContract(rt, first);
    if ('error' in r) throw new Stop(r.error);
    return view(rt, r.task);
  }
  // The human gives a task that waits one more try: after a report, a limit, or the edge of a contract.
  if (command === 'retry' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    const r = applyEvent(rt, first, { type: 'human', decision: 'return' }, 'human');
    if (!('task' in r)) throw new Stop(r.error);
    if (r.error !== undefined) throw new Stop(r.error, refusedBy(r.task));
    return view(rt, r.task);
  }
  if (command === 'raise' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    const r = raiseLevel(rt, first);
    if ('error' in r) throw new Stop(r.error);
    return view(rt, r.task);
  }
  // The word of the human: the barriers ask nothing for these minutes. Zero ends the pause.
  if (command === 'pause') {
    if (first === undefined || !/^[0-9]{1,3}$/.test(first) || Number(first) > MAX_PAUSE_MINUTES || rest.length > 0) throw new Stop('usage');
    return { ok: true, until: pause(runtime(), Number(first)) };
  }
  if (command === 'sweep' && first === undefined) {
    const rt = runtime();
    const checked = dueChecks(rt);
    return { ok: true, closed: sweep(rt), ...(checked.length > 0 ? { checked } : {}) };
  }
  // The word of the human: a scenario that the harness switched off for want of use acts again.
  if (command === 'enable' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    if (!rt.merged.scenarios.some((s) => s.name === first)) throw new Stop('unknown_scenario');
    const enabled = enableScenario(rt, first);
    if (enabled !== 'on') throw new Stop(enabled);
    return { ok: true, scenario: first };
  }
  // The text of a timer of the system for `tick run`. Nothing is written and nothing starts.
  if (command === 'timer' && rest.length === 0) {
    if (first !== undefined && !(/^[1-9][0-9]{0,3}$/.test(first) && Number(first) <= 1440)) throw new Stop('usage');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (process.env.REINS_CONFIG !== undefined) env.REINS_CONFIG = path.resolve(process.env.REINS_CONFIG);
    return { ok: true, ...timerText(first === undefined ? 5 : Number(first), fileURLToPath(import.meta.url), process.cwd(), env) };
  }
  // Triggers without a human. A timer of the system runs `tick`; a system that saw an event runs `fire`.
  if (command === 'tick' && first === undefined) {
    const rt = runtime();
    dueChecks(rt);
    return { ok: true, ...tick(rt) };
  }
  // The schedule with a client: every task that it opens and that needs the model gets a run of
  // the client of the machine, one after another.
  if (command === 'tick' && first === 'run' && rest.length === 0) {
    // A client without a window starts no client: nothing is opened, the time of the schedule stays.
    if (process.env.REINS_HEADLESS === '1') throw new Stop('nested_run');
    const rt = runtime();
    dueChecks(rt);
    // One run of the schedule at a time: a timer that fires while a run still works (cron does)
    // must not start a second client beside the first. The lock holds the number of its process:
    // a lock of a process that is gone is taken over.
    const lock = path.join(rt.stateDir, 'tick-run.lock');
    fs.mkdirSync(rt.stateDir, { recursive: true });
    const take = (): boolean => {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    };
    if (!take()) {
      let alive = true;
      let held = '';
      try {
        held = fs.readFileSync(lock, 'utf8');
        process.kill(Number(held), 0);
      } catch (e) {
        // No such process, or a lock that cannot be read: the holder is gone. A process of another user counts as alive.
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive) return { ok: true, busy: true, opened: [], skipped: [] };
      // Another timer can take the place of the dead holder at this same time: the lock is removed only while it still names the dead process.
      let same = false;
      try {
        same = fs.readFileSync(lock, 'utf8') === held;
      } catch {
        // the lock went away
      }
      if (same) fs.rmSync(lock, { force: true });
      if (!take()) return { ok: true, busy: true, opened: [], skipped: [] };
    }
    try {
      const r = tick(rt);
      return { ok: true, ...runOpened(rt, r.opened), skipped: r.skipped };
    } finally {
      try {
        if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock, { force: true });
      } catch {
        // the lock is gone already
      }
    }
  }
  // One scenario without a window: the task opens, and the client of the machine works on it.
  if (command === 'run' && first !== undefined) {
    if (process.env.REINS_HEADLESS === '1') throw new Stop('nested_run');
    const rt = runtime();
    const opened = open(rt, first, rest);
    delete opened.input;
    if (opened.state !== 'executing' || typeof opened.task !== 'string') return opened;
    const ran = runTask(rt, opened.task);
    const task = loadTask(rt, opened.task);
    return { ...opened, ...(task !== null ? { state: task.state, ...(task.label !== undefined ? { label: task.label } : {}), ...(task.waiting !== undefined ? { waiting: task.waiting } : {}) } : {}), ...ran };
  }
  if (command === 'fire' && first !== undefined) {
    // An event with a client: `fire run <event> [name=value]`. Every task that the event opens
    // gets a run of the client of the machine, one after another. `fire run` with no event after
    // it is the event with the name "run".
    const withClient = first === 'run' && rest[0] !== undefined && !rest[0].includes('=');
    const event = withClient ? (rest[0] as string) : first;
    const pairs = withClient ? rest.slice(1) : rest;
    if (withClient && process.env.REINS_HEADLESS === '1') throw new Stop('nested_run');
    const inputs: Record<string, string> = {};
    for (const pair of pairs) {
      const at = pair.indexOf('=');
      if (at < 1) throw new Stop('usage');
      inputs[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const rt = runtime();
    const r = fire(rt, event, inputs);
    if (!withClient) return { ok: true, ...r };
    // A scenario that waits for the event and did not take its inputs is not a success either.
    const ran = runOpened(rt, r.opened);
    return { ok: true, ...ran, skipped: r.skipped, refused: r.refused, ...(r.refused.length > 0 ? { failed: true } : {}) };
  }
  if (command === 'craft') {
    const rt = runtime();
    if (first === undefined) {
      propose(rt);
      applyDue(rt);
      measure(rt);
      return { ok: true, proposals: listProposals(rt) };
    }
    if ((first === 'accept' || first === 'reject') && rest.length === 1 && rest[0] !== undefined) {
      if (!resolveProposal(rt, rest[0], first === 'accept' ? 'accepted' : 'rejected')) throw new Stop('unknown_proposal');
      const applied = listProposals(rt).find((p) => p.id === rest[0])?.applied;
      return { ok: true, proposal: rest[0], state: first === 'accept' ? 'accepted' : 'rejected', ...(applied !== undefined ? { applied } : {}) };
    }
    throw new Stop('usage');
  }
  // The summary of the week, written now: the file and its text.
  if (command === 'week' && first === undefined) {
    const rt = runtime();
    const file = writeWeek(rt, Date.now(), true);
    if (file === null) throw new Stop('no_file');
    return { ok: true, file, text: fs.readFileSync(file, 'utf8') };
  }
  if (command === 'status') {
    const rt = runtime();
    // `status [days] [project=here|<project>]`. The journal is one for the machine: without a
    // project the counts are of all the projects.
    const words = [first, ...rest].filter((w): w is string => w !== undefined);
    const dayWords = words.filter((w) => /^[1-9][0-9]{0,2}$/.test(w));
    const projectWords = words.filter((w) => w.startsWith('project='));
    if (dayWords.length > 1 || projectWords.length > 1 || dayWords.length + projectWords.length !== words.length) throw new Stop('usage');
    const days = dayWords[0] !== undefined ? Number(dayWords[0]) : 7;
    const named = projectWords[0]?.slice(8);
    if (named !== undefined && named !== 'here' && !/^p[0-9a-f]{8}$/.test(named)) throw new Stop('usage');
    const project = named === 'here' ? rt.project : named;
    const rows = (since: number): ReturnType<typeof readJournalSince> => {
      const all = readJournalSince(rt.stateDir, since);
      return project === undefined ? all : ofProject(all, project);
    };
    return {
      ok: true,
      days,
      project: project ?? 'all',
      metrics: summarize(rows(Date.now() - days * 24 * 60 * 60 * 1000), Date.now() - days * 24 * 60 * 60 * 1000),
      // The barrier against the commands with a known answer that the packs hold: counts only.
      barrier: (({ n, bad, misses, noise }) => ({ n, bad, misses: misses.length, noise: noise.length }))(runProbes(rt, process.cwd())),
      // The measures of each day of the period against the targets of the packs.
      targets: ((): unknown => {
        const day = 24 * 60 * 60 * 1000;
        const end = Math.floor(Date.now() / day) * day + day;
        const from = end - days * day;
        return overTargets(series(rows(from), from, end, day), rt.merged.targets ?? {});
      })(),
      // The eight numbers of the week and of the week before it.
      eight: eight(rows(Date.now() - 14 * 24 * 60 * 60 * 1000)),
      // The open tasks are of the machine: a task does not name its project.
      open_tasks: openTasks(rt).length,
      packs: rt.merged.packs.map((p) => ({ level: p.level, name: p.name, connected: p.connected, errors: p.errors })),
      rejected: rt.merged.rejected,
    };
  }
  // The series of the eight numbers: the interface of the metrics for a program outside the
  // harness. The form has a version (the field `metrics`); a change of the form raises it. The
  // buckets are hours, days or weeks of UTC; the last one ends at the end of the day of today.
  if (command === 'metrics') {
    const rt = runtime();
    const words = [first, ...rest].filter((w): w is string => w !== undefined);
    const value = (key: string): string | undefined => words.find((w) => w.startsWith(`${key}=`))?.slice(key.length + 1);
    if (words.some((w) => !/^(days|step|project)=/.test(w)) || new Set(words.map((w) => w.split('=')[0])).size !== words.length) throw new Stop('usage');
    const daysWord = value('days') ?? '14';
    if (!/^[1-9][0-9]{0,2}$/.test(daysWord) || Number(daysWord) > 366) throw new Stop('usage');
    const step = value('step') ?? 'day';
    // An hour is for the use of the harness inside a day: a short window only.
    if (step !== 'day' && step !== 'week' && step !== 'hour') throw new Stop('usage');
    if (step === 'hour' && Number(daysWord) > 7) throw new Stop('usage');
    const named = value('project');
    if (named !== undefined && named !== 'here' && !/^p[0-9a-f]{8}$/.test(named)) throw new Stop('usage');
    const project = named === 'here' ? rt.project : named;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const stepMs = step === 'day' ? DAY_MS : step === 'hour' ? DAY_MS / 24 : 7 * DAY_MS;
    // The last bucket ends at the end of the day of today; with hours, at the end of this hour.
    const edge = step === 'hour' ? stepMs : DAY_MS;
    const to = Math.floor(Date.now() / edge) * edge + edge;
    const from = to - Math.ceil((Number(daysWord) * DAY_MS) / stepMs) * stepMs;
    const all = readJournalSince(rt.stateDir, from);
    const points = series(project === undefined ? all : ofProject(all, project), from, to, stepMs);
    // The projects of the window, the busiest first: a program outside asks for the series of each one.
    const seen = new Map<string, number>();
    if (project === undefined) for (const row of all) if (/^p[0-9a-f]{8}$/.test(row.project)) seen.set(row.project, (seen.get(row.project) ?? 0) + 1);
    const projects = [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
    // The form 2: each point carries `measures` besides the eight numbers; `measures` names them.
    // The form 3: each point carries `by`, the numbers with a name of their own; `by` names them.
    // The form 4: `measures` and `by` carry what the models spent, by model and by kind.
    // The form 5: the measure `fails_disputed`. The form 6: the measures of the memory.
    // The form 7: the measure `cache_rewrites` and the targets of the packs.
    // The form 8: the measures of the use (`actions`, `tasks_opened`) and the step of an hour.
    // The form 9: `projects`, the projects of the window, when the series is of the machine.
    // The form 10: the context of the sessions (the smallest, the largest and the middle one, by
    // session too) and the share of the text of the harness in it.
    return { ok: true, metrics: 10, ...(project === undefined ? { projects } : {}), targets: rt.merged.targets ?? {}, step, project: project ?? 'all', from: new Date(from).toISOString(), to: new Date(to).toISOString(), names: [...EIGHT], measures: [...MEASURES], by: [...BY], points };
  }
  if (command === 'memory') {
    const rt = runtime();
    if (first === undefined) {
      const broken = brokenRecords(rt);
      return broken.length > 0 ? { ok: true, records: listRecords(rt), broken } : { ok: true, records: listRecords(rt) };
    }
    // The records with these words, in every project: the agent reads the memory through the harness.
    // A row for a record: what it is and where the whole of it is. `show <id>` gives the record whole.
    if (first === 'find' && rest.length >= 1) {
      const found = searchRecords(rt, rest);
      const short = (text: string): string => (text.length > FIND_TEXT ? `${text.slice(0, FIND_TEXT)}…` : text);
      return {
        ok: true,
        records: found.records.map((r) => ({
          id: r.id, type: r.type, project: r.project, text: short(r.text),
          ...(r.paths.length > 0 ? { paths: r.paths } : {}), ...(r.next !== undefined ? { next: short(r.next) } : {}), ...(r.status !== undefined ? { status: r.status } : {}),
          // A record for every project, and a record that the human marked as wrong, look different.
          ...(r.scope !== undefined ? { scope: r.scope } : {}), ...(r.wrong !== undefined ? { wrong: r.wrong } : {}),
          // No record holds all the words: the row names the words that this record holds.
          ...(found.matched?.[r.id] !== undefined ? { matched: found.matched[r.id] } : {}),
        })),
        more: found.more,
        ...(found.partial ? { partial: true } : {}),
        // Records out of use with these words: the subject was in the memory before. `by` is the decision that took the place.
        ...(found.old !== undefined ? { old: found.old.map((o) => ({ id: o.record.id, type: o.record.type, state: o.record.state, text: short(o.record.text), ...(o.by !== undefined ? { by: o.by } : {}) })) } : {}),
      };
    }
    // The count of the memory now, written to the journal: the series of the metrics shows it by day.
    // `worst` names the records that were given many times and that no report cited.
    if (first === 'census' && rest.length === 0) {
      const c = census(rt);
      rt.journal.write({ kind: 'memory.counted', project: rt.project, data: { active: c.active, cited: c.cited, dead: c.dead, unseen: c.unseen } });
      return { ok: true, ...c };
    }
    if (first === 'show' && rest.length === 1) {
      const record = listRecords(rt).find((r) => r.id === rest[0]);
      if (record === undefined) throw new Stop('unknown_record');
      // The human reads a record in any state. The journal counts only a record in use: a record
      // that is out of use was not given to the agent for the work.
      if (record.state === 'active') noteShown(rt, record.id);
      return { ok: true, record };
    }
    if (first === 'veto' && rest.length === 1 && rest[0] !== undefined) {
      if (!vetoRecord(rt, rest[0])) throw new Stop('unknown_record');
      return { ok: true, record: rest[0], state: 'vetoed' };
    }
    // Words of the human: a record for every project, and "this was wrong".
    if (first === 'share' && rest.length === 1 && rest[0] !== undefined) {
      // A record that is shared already is no unknown record: the answer says that nothing changed.
      if (isShared(rt, rest[0])) return { ok: true, record: rest[0], scope: 'common', already: true };
      if (!shareRecord(rt, rest[0])) throw new Stop('unknown_record');
      return { ok: true, record: rest[0], scope: 'common' };
    }
    if (first === 'wrong' && rest.length === 1 && rest[0] !== undefined) {
      if (!wrongRecord(rt, rest[0])) {
        // A record that is there and takes no mark is not "unknown": a decision is replaced by a
        // decision, and a record that is not in use has nothing to lose.
        const found = listRecords(rt).find((r) => r.id === rest[0]);
        if (found === undefined) throw new Stop('unknown_record');
        throw new Stop('no_mark', { reason: found.type === 'decision' ? 'decision' : 'not_active' });
      }
      return { ok: true, record: rest[0], state: listRecords(rt).find((r) => r.id === rest[0])?.state };
    }
    if (first === 'restore' && rest.length === 1 && rest[0] !== undefined) {
      if (!restoreRecord(rt, rest[0])) throw new Stop('unknown_record');
      return { ok: true, record: rest[0], state: 'active' };
    }
    if (first === 'import' && rest.length === 1 && rest[0] !== undefined) {
      try {
        return { ok: true, ...importRecords(rt, rest[0]) };
      } catch {
        throw new Stop('no_file');
      }
    }
    // A case: `next <id> <step> task=<id> [status=<s>]` gives it a step, `close <id> task=<id>` ends it.
    // These are commands of the agent: the task says that its manifest lets the agent write cases.
    // Without `task=` they change nothing: the words of the human are `step` and `end`.
    // The same two changes on the word of the human: `step <id> <step> [status=<s>]` and `end <id>`.
    // They name no task. The agent can type them, so a client with the hook asks the human first.
    if ((first === 'step' && rest.length >= 2) || (first === 'end' && rest.length === 1)) {
      const id = rest[0] ?? '';
      if (first === 'end') {
        const r = closeCase(rt, id, { by: 'human' });
        if (!r.ok) throw new Stop(r.error);
        return { ok: true, record: id, state: 'closed' };
      }
      // A step without quotes would lose its words after the first: that is a mistake, not a step.
      if (rest.slice(2).some((m) => !m.startsWith('status='))) throw new Stop('usage');
      const status = rest.slice(2).find((m) => m.startsWith('status='))?.slice(7);
      const r = stepCase(rt, id, { by: 'human', next: rest[1] ?? '', ...(status !== undefined ? { status } : {}) });
      if (!r.ok) throw new Stop(r.error, faultOf(r));
      return { ok: true, record: id, next: r.record.next, ...(r.record.status !== undefined ? { status: r.record.status } : {}), ...(r.record.state === 'closed' ? { state: 'closed' } : {}) };
    }
    if ((first === 'next' && rest.length >= 2) || (first === 'close' && rest.length >= 1)) {
      const id = rest[0] ?? '';
      const more = rest.slice(first === 'next' ? 2 : 1);
      // A step without quotes would lose its words after the first: that is a mistake, not a step.
      if (more.some((m) => !m.startsWith('task=') && !m.startsWith('status='))) throw new Stop('usage');
      const value = (name: string): string | undefined => more.find((m) => m.startsWith(`${name}=`))?.slice(name.length + 1);
      const task = value('task');
      const who = { by: 'agent' as const, ...(task !== undefined ? { task } : {}) };
      if (first === 'close') {
        const r = closeCase(rt, id, who);
        if (!r.ok) throw new Stop(r.error);
        return { ok: true, record: id, state: 'closed' };
      }
      const status = value('status');
      const r = stepCase(rt, id, { ...who, next: rest[1] ?? '', ...(status !== undefined ? { status } : {}) });
      if (!r.ok) throw new Stop(r.error, faultOf(r));
      return { ok: true, record: id, next: r.record.next, ...(r.record.status !== undefined ? { status: r.record.status } : {}), ...(r.record.state === 'closed' ? { state: 'closed' } : {}) };
    }
    // `add <type> <text> [task=<id>] [path=<p>]...` is the agent; `decide <text> because=<reason> ...` is the human.
    if ((first === 'add' && rest.length >= 2) || (first === 'decide' && rest.length >= 1)) {
      const [type, text, ...more] = first === 'add' ? rest : ['decision', ...rest];
      const value = (name: string): string | undefined => more.find((m) => m.startsWith(`${name}=`))?.slice(name.length + 1);
      const input: Parameters<typeof addRecord>[1] = { type: type ?? '', text: text ?? '', paths: more.filter((m) => m.startsWith('path=')).map((m) => m.slice(5)), by: first === 'add' ? 'agent' : 'human' };
      for (const key of ['task', 'because', 'rejected', 'revisit', 'supersedes', 'repeats', 'next', 'status', 'unverified'] as const) {
        const v = value(key);
        if (v !== undefined) input[key] = v;
      }
      // The places of a record are relative to the repository where the client works.
      const root = findRoot(process.cwd());
      if (root.isRepo) input.root = root.root;
      const r = addRecord(rt, input);
      if (!r.ok) throw new Stop(r.error, faultOf(r));
      return { ok: true, record: r.record };
    }
    throw new Stop('usage');
  }
  // The result of a task: its state, its label and its report. The agent reads it here, not from
  // the files of the state: a client without a window leaves the report of its task there.
  if (command === 'result' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    const task = loadTask(rt, first);
    if (task === null) throw new Stop('unknown_task');
    const out: Out = { ok: true, task: task.id, ...(task.scenario !== undefined ? { scenario: task.scenario } : {}), state: task.state, only_reads: true };
    if (task.label !== undefined) out.label = task.label;
    if (task.waiting !== undefined) out.waiting = task.waiting;
    const text = readReport(rt, task.id);
    if (text !== null) {
      // A report that is data is given as data, whole: a part of it has no structure. A text stays
      // a text, cut at a size that a model can read.
      let report: unknown;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object') report = parsed;
      } catch {
        // a text report
      }
      if (report === undefined) report = text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)} … (+${text.length - RESULT_MAX} characters cut)` : text;
      out.report = report;
    }
    return out;
  }
  if (command === 'tasks' && first === undefined) {
    return {
      ok: true,
      tasks: openTasks(runtime()).map((t) => {
        const row: Out = { task: t.id, kind: t.kind, state: t.state };
        if (t.scenario !== undefined) row.scenario = t.scenario;
        if (Object.keys(t.inputs).length > 0) row.inputs = t.inputs;
        return row;
      }),
    };
  }
  // The word of the human: a task ends here, whatever its state. A client with the hook asks
  // the human before it runs this command.
  // The barrier against the commands with a known answer that the packs hold: each command whose
  // answer is not the expected one, by the pack and the place in its file.
  // A run of the probes writes its counts to the journal: the series of the metrics shows the barrier by day.
  if (command === 'probes' && first === undefined) {
    const rt = runtime();
    const result = runProbes(rt, process.cwd());
    // A run that asked nothing says nothing about the barrier.
    if (result.n > 0) rt.journal.write({ kind: 'harness.barrier_probed', project: rt.project, data: { n: result.n, misses: result.misses.length, noise: result.noise.length } });
    return { ok: true, ...result };
  }
  // The word of the human: the result of a closed task was wrong. The journal has it once for a task.
  if (command === 'dispute' && first !== undefined && rest.length === 0) {
    const r = disputeResult(runtime(), first);
    if ('error' in r) throw new Stop(r.error);
    return { ok: true, task: r.task.id, state: r.task.state, disputed: r.task.disputed, ...(r.task.label !== undefined ? { label: r.task.label } : {}), ...(r.first ? {} : { already: true }) };
  }
  // The word of the human: a FAIL of the done check of this task was wrong. The journal has it once for a task.
  if (command === 'dispute' && first !== undefined && rest.length === 1 && rest[0] === 'fail') {
    const r = disputeFail(runtime(), first);
    if ('error' in r) throw new Stop(r.error);
    return { ok: true, task: r.task.id, state: r.task.state, fail_disputed: r.task.fail_disputed, returns: r.task.returns, ...(r.first ? {} : { already: true }) };
  }
  if (command === 'stop' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    const r = applyEvent(rt, first, { type: 'human', decision: 'stop' }, 'human');
    if (!('task' in r)) throw new Stop(r.error);
    // A task that is closed already cannot be stopped: the answer says what it is.
    if (r.error !== undefined) throw new Stop(r.error, { state: r.task.state, ...(r.task.label !== undefined ? { label: r.task.label } : {}) });
    const out: Out = { ok: true, task: r.task.id, state: r.task.state, stopped: true };
    if (r.task.label !== undefined) out.label = r.task.label;
    return out;
  }
  // The queue of deferred actions. The answers are words of the human: a client with the hook
  // asks the human before it runs them.
  if (command === 'queue' && first === undefined) {
    return { ok: true, queue: listQueue(runtime()).map((q) => ({ id: q.id, state: q.state, at: q.at, tool: q.tool, rule: q.rule, what: q.what, task: q.task, project: q.project })) };
  }
  if (command === 'queue' && (first === 'approve' || first === 'reject') && rest.length === 1 && rest[0] !== undefined) {
    const state = first === 'approve' ? 'approved' : 'rejected';
    if (!resolveQueued(runtime(), rest[0], state)) throw new Stop('unknown_queued');
    return { ok: true, queued: rest[0], state };
  }
  if (command === 'finish' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    // The work changed after the check: the publication ended without a verified result.
    if (!verifyWork(rt, first)) {
      const ended = loadTask(rt, first);
      if (ended === null) throw new Stop('unknown_task');
      return view(rt, ended);
    }
    const r = applyEvent(rt, first, { type: 'finish' }, 'agent');
    if (!('task' in r)) throw new Stop(r.error);
    if (r.error !== undefined) throw new Stop(r.error, refusedBy(r.task));
    return view(rt, r.task);
  }
  // The done check before the report: its answer accepts nothing and spends no send-back.
  if (command === 'check' && first !== undefined && rest.length <= 1) {
    const rt = runtime();
    let text: string | null = null;
    if (rest[0] !== undefined) {
      try {
        text = fs.readFileSync(rest[0] === '-' ? 0 : rest[0], 'utf8');
      } catch {
        throw new Stop('no_report');
      }
    }
    const r = probeCheck(rt, first, text);
    if ('error' in r) throw new Stop(r.error);
    return { ok: true, task: r.task.id, state: r.task.state, probe: true, answer: r.answer, checks_left: r.left, returns_left: Math.max(0, (r.task.manifest?.done.retries ?? 0) - r.task.returns) };
  }
  if (command === 'report' && first !== undefined && rest.length === 1 && rest[0] !== undefined) return report(runtime(), first, rest[0]);
  throw new Stop('usage', { commands: ['scenarios', 'packs', 'check <task> [file|-]', 'status [days] [project=here|<project>]', 'metrics [days=N] [step=hour|day|week] [project=here|<project>]', 'week', 'pause <minutes>', 'dispute <task>', 'dispute <task> fail', 'probes', 'sweep', 'enable <scenario>', 'tick', 'tick run', 'timer [minutes]', 'run <scenario> [name=value]', 'fire <event> [name=value]', 'fire run <event> [name=value]', 'craft', 'craft accept|reject <id>', 'tasks', 'result <task>', 'queue', 'queue approve|reject <id>', 'open <scenario> [name=value]', 'match <value>', 'input <task>', 'propose <contract.json>', 'approve <task>', 'retry <task>', 'raise <task>', 'report <task> <file|->', 'finish <task>', 'stop <task>', 'memory', 'memory find <word>...', 'memory census', 'memory show <id>', 'memory next <case> <step> task=<id> [status=<s>]', 'memory close <case> task=<id>', 'memory step <case> <step> [status=<s>]', 'memory end <case>', 'memory add <type> <text> task=<id> [path=<p>]', 'memory decide <text> because=<reason>', 'memory veto <id>', 'memory restore <id>', 'memory share <id>', 'memory wrong <id>', 'memory import <file>'] });
}

const FIND_TEXT = 300; // characters of the text of a record in a row of a search
const RESULT_MAX = 200_000; // characters of a text report that `result` gives
let out: Out;
let stopped = false;
let onlyReads = false;
try {
  out = main(process.argv.slice(2));
  // `stopped` is for the exit code only: a stop that worked is a success of the command.
  stopped = out.stopped === true;
  // A command that only reads a task succeeds whatever the state of the task is.
  onlyReads = out.only_reads === true;
  delete out.only_reads;
  delete out.stopped;
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  out = e.out;
}
process.stdout.write(`${JSON.stringify(out)}\n`);
// Exit code 0: for `open` and `input` the task executes or had no work; for `report` the task is
// closed with a verified result. Exit code 2: the task did not close as verified.
// Only the answer about a task has a state of a task: `state` of a proposal, of a memory record
// or of a queued action says nothing about the exit code.
const taskState = typeof out.task === 'string' ? out.state : undefined;
const verified = (taskState === 'closed' || taskState === 'publishing') && out.label !== 'not_verified';
// A check before the report is no report: its red answer is "not ready", its green one changes nothing.
const probe = out.probe === true;
const reported = !probe && 'returns_left' in out;
// After a run of a client the task must be closed as verified, or had no work.
const ranClient = out.ran === true;
// A client that did not start, or a run of the schedule where a task did not end as verified,
// is not a success either.
const notRun = out.ran === false || out.failed === true;
const probeRed = probe && isObj(out.answer) && out.answer.result !== 'PASS';
const done = !notRun && !probeRed && (stopped || onlyReads || taskState === undefined || verified || (!reported && !ranClient && (taskState === 'executing' || taskState === 'skipped')) || (ranClient && taskState === 'skipped'));
process.exitCode = out.ok !== true ? 1 : done ? 0 : 2;
