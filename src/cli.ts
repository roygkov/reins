#!/usr/bin/env node
// The command line of the harness: the way a client runs a scenario without hooks.
//   reins scenarios                      the scenarios of the connected packs
//   reins open <scenario> [name=value]   opens a task and prints the input for the model
//   reins input <task>                   prints the input of an open task again
//   reins report <task> <file|->         submits the report of the model, prints the answer
//   reins finish <task>                  ends the publication of an accepted result, closes the task
//   reins stop <task>                    the human stops a task in any open state
//   reins tasks                          the tasks that are not closed
// The output is one JSON object. Exit codes: 0 done, 2 the task is not closed as verified,
// 1 an error. The config names the packs: $REINS_CONFIG or ~/.config/reins/config.json.

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadRuntime } from './client/config.ts';
import { taskInput } from './client/input.ts';
import { applyEvent, loadTask, openScenario, openTasks, readCollected, runCheck, submitReport, type Runtime } from './core/runtime.ts';
import type { Inputs, Task } from './core/task.ts';

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

// A large collected result does not go into the context of the model: it is written to a file
// beside the task and the input names the file. The model reads what it needs from there.
function byReference(rt: Runtime, id: string, collected: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(collected)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    if (bytes <= INLINE_BYTES) {
      out[name] = value;
      continue;
    }
    const file = path.join(rt.stateDir, 'tasks', `${id}.collected`, `${name}.${typeof value === 'string' ? 'txt' : 'json'}`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    out[name] = { file, bytes };
  }
  return out;
}

function view(rt: Runtime, task: Task): Out {
  const out: Out = { ok: true, task: task.id, state: task.state };
  if (task.label !== undefined) out.label = task.label;
  if (task.waiting !== undefined) out.waiting = task.waiting;
  const input = taskInput(task, readCollected(rt, task.id));
  if (input !== null) {
    input.collected = byReference(rt, task.id, input.collected);
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
      return row;
    }),
    rejected: rt.merged.rejected,
  };
}

// The done checks that this client can bring to an end: the core runs the citation check, the human approves.
const RUNNABLE: readonly string[] = ['citations', 'human'];

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
  const opened = openScenario(rt, name, inputs);
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
  const r = loadTask(rt, id)?.state === 'checking' ? runCheck(rt, id) : submitReport(rt, id, text);
  if ('error' in r) throw new Stop(r.error === 'not_checking' ? 'check_not_supported' : r.error);
  if (r.step.error !== undefined) throw new Stop(r.step.error);
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
    const task = loadTask(rt, first);
    if (task === null) throw new Stop('unknown_task');
    return view(rt, task);
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
  if (command === 'finish' && first !== undefined && rest.length === 0) {
    const rt = runtime();
    const r = applyEvent(rt, first, { type: 'finish' }, 'agent');
    if (!('task' in r)) throw new Stop(r.error);
    if (r.error !== undefined) throw new Stop(r.error);
    return view(rt, r.task);
  }
  if (command === 'report' && first !== undefined && rest.length === 1 && rest[0] !== undefined) return report(runtime(), first, rest[0]);
  throw new Stop('usage', { commands: ['scenarios', 'tasks', 'open <scenario> [name=value]', 'input <task>', 'report <task> <file|->', 'finish <task>', 'stop <task>'] });
}

let out: Out;
let stopped = false;
try {
  out = main(process.argv.slice(2));
  // `stopped` is for the exit code only: a stop that worked is a success of the command.
  stopped = out.stopped === true;
  delete out.stopped;
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  out = e.out;
}
process.stdout.write(`${JSON.stringify(out)}\n`);
// Exit code 0: for `open` and `input` the task executes or had no work; for `report` the task is
// closed with a verified result. Exit code 2: the task did not close as verified.
const verified = (out.state === 'closed' || out.state === 'publishing') && out.label !== 'not_verified';
const reported = 'returns_left' in out;
const done = stopped || out.state === undefined || verified || (!reported && (out.state === 'executing' || out.state === 'skipped'));
process.exitCode = out.ok !== true ? 1 : done ? 0 : 2;
