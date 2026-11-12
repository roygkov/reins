#!/usr/bin/env node
// The command line of the harness: the way a client runs a scenario without hooks.
//   reins scenarios                      the scenarios of the connected packs
//   reins open <scenario> [name=value]   opens a task and prints the input for the model
//   reins input <task>                   prints the input of an open task again
//   reins report <task> <file|->         submits the report of the model, prints the answer
//   reins finish <task>                  ends the publication of an accepted result, closes the task
//   reins stop <task>                    the human stops a task in any open state
//   reins tasks                          the tasks that are not closed
//   reins tick                           opens the tasks of the scenarios whose schedule came
//   reins tick run                       the same, and starts the client of the machine for each task
//   reins timer [minutes]                the text of a timer of the system that runs `tick run`
//   reins run <scenario> [name=value]    opens a task and starts the client of the machine for it
//   reins fire <event> [name=value]      opens the tasks of the scenarios that wait for this event
//   reins fire run <event> [name=value]  the same, and starts the client of the machine for every task
//   reins queue [approve|reject <id>]    the actions that a rule deferred; the human answers
// The output is one JSON object. Exit codes: 0 done, 2 the task is not closed as verified,
// 1 an error. The config names the packs: $REINS_CONFIG or ~/.config/reins/config.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadRuntime } from './client/config.ts';
import { runTask } from './client/run.ts';
import { resumeTask } from './client/session.ts';
import { sessionOfDirectory } from './core/sessions.ts';
import { isObj } from './contracts/shape.ts';
import { findRoot } from './gate/index.ts';
import { taskInput } from './client/input.ts';
import { applyEvent, approveContract, collectedDir, loadTask, verifyWork, openScenario, openTasks, proposeContract, raiseLevel, readCollected, runCheck, submitReport, type Runtime, readReport } from './core/runtime.ts';
import type { Inputs, Task } from './core/task.ts';
import { MAX_PAUSE_MINUTES, pause } from './core/pause.ts';
import { listQueue, resolveQueued } from './core/queue.ts';
import { sweep } from './core/sweep.ts';
import { timerText } from './client/timer.ts';
import { writeWeek } from './craft/weekly.ts';
import { enableScenario, scenarioOff } from './core/idle.ts';
import { fire, tick } from './core/triggers.ts';
import { listProposals, measure, propose, resolveProposal } from './craft/craft.ts';
import { eight, summarize } from './journal/metrics.ts';
import { readJournal, readJournalSince } from './journal/writer.ts';
import { addRecord, brokenRecords, closeCase, countUses, importRecords, listRecords, recordsForInput, restoreRecord, searchRecords, shareRecord, stepCase, vetoRecord, wrongRecord } from './memory/store.ts';

type Out = Record<string, unknown>;
class Stop extends Error {
  out: Out;
  constructor(error: string, more: Out = {}) {
    super(error);
    this.out = { ok: false, error, ...more };
  }
}

function runtime(): Runtime {
  try {
    return loadRuntime();
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
  const input = taskInput(task, readCollected(rt, task.id), 'reins', rt.merged.models);
  if (input !== null) {
    input.collected = byReference(rt, task.id, input.collected);
    // The notes of the packs: rules of work that hold for every task (language, tone).
    if (rt.merged.notes.length > 0) input.pack_notes = rt.merged.notes;
    // The memory about the places of this work: the changed files when the scenario names them.
    const changed = task.manifest?.done.changed === undefined ? undefined : readCollected(rt, task.id)?.[task.manifest.done.changed];
    const places = Array.isArray(changed) ? changed.map((f) => (typeof f === 'string' ? f : isObj(f) && typeof f.path === 'string' ? f.path : '')).filter((p) => p !== '') : [];
    const records = recordsForInput(rt, { paths: places, maxBytes: MEMORY_INPUT_BYTES });
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
  const opened = list.map((t) => {
    const ran = runTask(rt, t.task);
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
  const session = sessionOfDirectory(rt, process.cwd());
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
  if ('error' in r) throw new Stop(r.error === 'not_checking' ? 'check_not_supported' : r.error);
  if (r.step.error !== undefined) throw new Stop(r.step.error);
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
  if (command === 'open' && first !== undefined) return open(runtime(), first, rest);
  if (command === 'input' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    if (loadTask(rt, first) === null) throw new Stop('unknown_task');
    // Reading the input takes the task for the session of this directory: a suspended task comes
    // back, a task of an ended session continues here.
    resumeTask(rt, first, sessionOfDirectory(rt, process.cwd()));
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
    const session = sessionOfDirectory(rt, process.cwd());
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
      if (accepted.error !== undefined) throw new Stop(accepted.error, { state: accepted.task.state });
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
    if (r.error !== undefined) throw new Stop(r.error, { state: r.task.state });
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
  if (command === 'sweep' && first === undefined) return { ok: true, closed: sweep(runtime()) };
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
  if (command === 'tick' && first === undefined) return { ok: true, ...tick(runtime()) };
  // The schedule with a client: every task that it opens and that needs the model gets a run of
  // the client of the machine, one after another.
  if (command === 'tick' && first === 'run' && rest.length === 0) {
    // A client without a window starts no client: nothing is opened, the time of the schedule stays.
    if (process.env.REINS_HEADLESS === '1') throw new Stop('nested_run');
    const rt = runtime();
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
      try {
        process.kill(Number(fs.readFileSync(lock, 'utf8')), 0);
      } catch (e) {
        // No such process, or a lock that cannot be read: the holder is gone. A process of another user counts as alive.
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive) return { ok: true, busy: true, opened: [], skipped: [] };
      fs.rmSync(lock, { force: true });
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
    const days = first !== undefined && /^[1-9][0-9]{0,2}$/.test(first) ? Number(first) : 7;
    return {
      ok: true,
      days,
      metrics: summarize(readJournalSince(rt.stateDir, Date.now() - days * 24 * 60 * 60 * 1000), Date.now() - days * 24 * 60 * 60 * 1000),
      // The eight numbers of the week and of the week before it.
      eight: eight(readJournalSince(rt.stateDir, Date.now() - 14 * 24 * 60 * 60 * 1000)),
      open_tasks: openTasks(rt).length,
      packs: rt.merged.packs.map((p) => ({ level: p.level, name: p.name, connected: p.connected, errors: p.errors })),
      rejected: rt.merged.rejected,
    };
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
        })),
        more: found.more,
      };
    }
    if (first === 'show' && rest.length === 1) {
      const record = listRecords(rt).find((r) => r.id === rest[0]);
      if (record === undefined) throw new Stop('unknown_record');
      // The human reads a record in any state. The journal counts only a record in use: a record
      // that is out of use was not given to the agent for the work.
      if (record.state === 'active') rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: 1 } });
      return { ok: true, record };
    }
    if (first === 'veto' && rest.length === 1 && rest[0] !== undefined) {
      if (!vetoRecord(rt, rest[0])) throw new Stop('unknown_record');
      return { ok: true, record: rest[0], state: 'vetoed' };
    }
    // Words of the human: a record for every project, and "this was wrong".
    if (first === 'share' && rest.length === 1 && rest[0] !== undefined) {
      if (!shareRecord(rt, rest[0])) throw new Stop('unknown_record');
      return { ok: true, record: rest[0], scope: 'common' };
    }
    if (first === 'wrong' && rest.length === 1 && rest[0] !== undefined) {
      if (!wrongRecord(rt, rest[0])) throw new Stop('unknown_record');
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
      if (!r.ok) throw new Stop(r.error);
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
      if (!r.ok) throw new Stop(r.error);
      return { ok: true, record: id, next: r.record.next, ...(r.record.status !== undefined ? { status: r.record.status } : {}), ...(r.record.state === 'closed' ? { state: 'closed' } : {}) };
    }
    // `add <type> <text> [task=<id>] [path=<p>]...` is the agent; `decide <text> because=<reason> ...` is the human.
    if ((first === 'add' && rest.length >= 2) || (first === 'decide' && rest.length >= 1)) {
      const [type, text, ...more] = first === 'add' ? rest : ['decision', ...rest];
      const value = (name: string): string | undefined => more.find((m) => m.startsWith(`${name}=`))?.slice(name.length + 1);
      const input: Parameters<typeof addRecord>[1] = { type: type ?? '', text: text ?? '', paths: more.filter((m) => m.startsWith('path=')).map((m) => m.slice(5)), by: first === 'add' ? 'agent' : 'human' };
      for (const key of ['task', 'because', 'rejected', 'revisit', 'supersedes', 'next', 'status', 'unverified'] as const) {
        const v = value(key);
        if (v !== undefined) input[key] = v;
      }
      // The places of a record are relative to the repository where the client works.
      const root = findRoot(process.cwd());
      if (root.isRepo) input.root = root.root;
      const r = addRecord(rt, input);
      if (!r.ok) throw new Stop(r.error);
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
    if (r.error !== undefined) throw new Stop(r.error);
    return view(rt, r.task);
  }
  if (command === 'report' && first !== undefined && rest.length === 1 && rest[0] !== undefined) return report(runtime(), first, rest[0]);
  throw new Stop('usage', { commands: ['scenarios', 'status [days]', 'week', 'pause <minutes>', 'sweep', 'enable <scenario>', 'tick', 'tick run', 'timer [minutes]', 'run <scenario> [name=value]', 'fire <event> [name=value]', 'fire run <event> [name=value]', 'craft', 'craft accept|reject <id>', 'tasks', 'result <task>', 'queue', 'queue approve|reject <id>', 'open <scenario> [name=value]', 'input <task>', 'propose <contract.json>', 'approve <task>', 'retry <task>', 'raise <task>', 'report <task> <file|->', 'finish <task>', 'stop <task>', 'memory', 'memory find <word>...', 'memory show <id>', 'memory next <case> <step> task=<id> [status=<s>]', 'memory close <case> task=<id>', 'memory step <case> <step> [status=<s>]', 'memory end <case>', 'memory add <type> <text> task=<id> [path=<p>]', 'memory decide <text> because=<reason>', 'memory veto <id>', 'memory restore <id>', 'memory share <id>', 'memory wrong <id>', 'memory import <file>'] });
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
const reported = 'returns_left' in out;
// After a run of a client the task must be closed as verified, or had no work.
const ranClient = out.ran === true;
// A client that did not start, or a run of the schedule where a task did not end as verified,
// is not a success either.
const notRun = out.ran === false || out.failed === true;
const done = !notRun && (stopped || onlyReads || taskState === undefined || verified || (!reported && !ranClient && (taskState === 'executing' || taskState === 'skipped')) || (ranClient && taskState === 'skipped'));
process.exitCode = out.ok !== true ? 1 : done ? 0 : 2;
