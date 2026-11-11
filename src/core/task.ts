// The task loop: the states of a task and the moves between them. Pure: no files, no clock.
// The harness holds the state. The agent cannot move a task to "closed": only a check answer
// or a decision of the human does that. Every move drafts the journal rows that describe it.
// Specification: docs/spec/harness-core, pages 2, 5, 6 and 7; harness-manifest, page 2.

import { labelOf, type Level, type Manifest, type ResultLabel } from '../contracts/manifest.ts';
import type { EventKind, TASK_KINDS } from '../contracts/journal.ts';
import { decide, grantKey, plainValue, type Action, type Decision, type Grant, type LayerDecision, type TaskUse } from '../contracts/policy.ts';
import type { Fault } from '../contracts/shape.ts';

export type TaskKind = (typeof TASK_KINDS)[number];
// publishing: the result is accepted, and the writes that the envelope names can still be made.
export const TASK_STATES = ['preparing', 'executing', 'checking', 'waiting_human', 'publishing', 'closed', 'skipped'] as const;
export type TaskState = (typeof TASK_STATES)[number];
// Why a task waits: the gate asked, the check failed past the limit, or the result needs an approval.
export type WaitReason = 'gate' | 'check' | 'approval';
export type Inputs = Record<string, string | number>;

export type Task = {
  id: string;
  kind: TaskKind;
  state: TaskState;
  waiting?: WaitReason;
  scenario?: string;
  version?: number;
  manifest?: Manifest; // the copy the task started with; a later change of the file does not reach it
  instructions?: string; // the text for the model, also a copy
  inputs: Inputs;
  envelope: Grant[];
  use: TaskUse;
  returns: number;
  level?: Level;
  label?: ResultLabel;
};

export type TaskEvent =
  | { type: 'prepared'; work: boolean; flag?: string; outputs?: number; bytes?: number }
  | { type: 'collect_failed'; reason: string }
  | { type: 'report'; size: number; fp: string }
  // `detail`: counts and a reason code of the check for the journal, never text.
  | { type: 'check'; result: 'PASS' | 'FAIL' | 'none'; detail?: Record<string, string | number> }
  | { type: 'ask' }
  | { type: 'human'; decision: 'answered' | 'accept' | 'return' | 'stop' }
  | { type: 'finish' } // the publication is over: nothing more will be written
  | { type: 'expire' };

export type RowDraft = { kind: EventKind; data?: Record<string, string | number | boolean> };
export type Step = { task: Task; rows: RowDraft[]; error?: 'bad_event' };

export type InputErrorCode = 'missing' | 'unknown' | 'bad_type';
export type InputError = Fault<InputErrorCode>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;

function inputFits(type: string, value: string | number): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) return false;
  if (type === 'id') return ID.test(value);
  if (type === 'url') {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }
  return true;
}

export function checkInputs(manifest: Manifest, inputs: Inputs): InputError[] {
  const errors: InputError[] = [];
  const declared = manifest.trigger.inputs ?? [];
  for (const d of declared) {
    const value = Object.hasOwn(inputs, d.name) ? inputs[d.name] : undefined;
    if (value === undefined) errors.push({ code: 'missing', path: d.name });
    else if (!inputFits(d.type, value)) errors.push({ code: 'bad_type', path: d.name });
  }
  for (const name of Object.keys(inputs)) if (!declared.some((d) => d.name === name)) errors.push({ code: 'unknown', path: name });
  return errors;
}

// The envelope of a task: the write grants of the manifest with the inputs filled into the targets.
export function grantsOf(manifest: Manifest, inputs: Inputs): Grant[] {
  return (manifest.permissions.write ?? []).map((w) => ({
    action: w.action,
    target: w.target.replace(/\{([^{}]*)\}/g, (_, name: string) => plainValue(String(inputs[name] ?? ''))),
    env: w.env,
    limit: w.limit,
    confirm: w.confirm,
  }));
}

export function newScenarioTask(id: string, manifest: Manifest, inputs: Inputs): { task: Task; rows: RowDraft[] } | { errors: InputError[] } {
  const errors = checkInputs(manifest, inputs);
  if (errors.length > 0) return { errors };
  const task: Task = {
    id,
    kind: 'scenario',
    state: 'preparing',
    scenario: manifest.name,
    version: manifest.version ?? 1,
    manifest,
    inputs,
    envelope: grantsOf(manifest, inputs),
    use: { confirmed: [], used: {} },
    returns: 0,
    level: manifest.model.level,
  };
  return { task, rows: [{ kind: 'task.opened' }, { kind: 'task.kind_decided', data: { kind: 'scenario', reason: 'scenario_name' } }] };
}

// A free task has no manifest: no collect, no envelope, no check. Its result is "not verified".
export function newFreeTask(id: string): { task: Task; rows: RowDraft[] } {
  const task: Task = { id, kind: 'free', state: 'executing', inputs: {}, envelope: [], use: { confirmed: [], used: {} }, returns: 0 };
  return { task, rows: [{ kind: 'task.opened' }, { kind: 'task.kind_decided', data: { kind: 'free', reason: 'facts' } }] };
}

const refuse = (task: Task): Step => ({ task, rows: [], error: 'bad_event' });

function close(task: Task, label: ResultLabel, before: RowDraft[], reason?: string): Step {
  const rows = [...before];
  // The envelope lives no longer than the task. It was opened only if the task started.
  if (task.envelope.length > 0 && task.state !== 'preparing') rows.push({ kind: 'policy.envelope_closed' });
  rows.push({ kind: 'task.closed', data: reason === undefined ? { label } : { label, reason } });
  const { waiting: _, ...rest } = task;
  return { task: { ...rest, state: 'closed', label }, rows };
}

// The result of a task is accepted: by the check or by the human. A task whose envelope names
// writes stays open for the publication of the result; the label is already known. A task
// without writes closes at once.
function accept(task: Task, label: ResultLabel, before: RowDraft[]): Step {
  if (task.envelope.length === 0) return close(task, label, before);
  const { waiting: _, ...rest } = task;
  return { task: { ...rest, state: 'publishing', label }, rows: before };
}

function back(task: Task, before: RowDraft[], reason: 'check_fail' | 'human', count: boolean): Step {
  const returns = task.returns + (count ? 1 : 0);
  const { waiting: _, ...rest } = task;
  return { task: { ...rest, state: 'executing', returns }, rows: [...before, { kind: 'task.returned', data: { n: returns, reason } }] };
}

export function step(task: Task, event: TaskEvent): Step {
  const done = task.manifest?.done;
  switch (event.type) {
    case 'prepared': {
      if (task.state !== 'preparing') return refuse(task);
      if (!event.work) return { task: { ...task, state: 'skipped' }, rows: [{ kind: 'task.skipped', data: event.flag === undefined ? {} : { flag: event.flag } }] };
      const rows: RowDraft[] = [
        { kind: 'task.prepared', data: { outputs: event.outputs ?? 0, bytes: event.bytes ?? 0 } },
        { kind: 'task.started', data: task.level === undefined ? {} : { level: task.level } },
      ];
      if (task.envelope.length > 0) rows.push({ kind: 'policy.envelope_opened', data: { grants: task.envelope.length } });
      return { task: { ...task, state: 'executing' }, rows };
    }
    case 'collect_failed': {
      if (task.state !== 'preparing') return refuse(task);
      // A failure of the harness itself is written down; the task ends without a verified result.
      return close(task, 'not_verified', [{ kind: 'harness.failure', data: { where: 'collect', reason: event.reason } }], 'collect_failed');
    }
    case 'report': {
      if (task.state !== 'executing') return refuse(task);
      const submitted: RowDraft = { kind: 'task.report_submitted', data: { size: event.size, fp: event.fp } };
      // The report of the agent is a claim. Without a manifest nothing checks it: the check step is
      // skipped and the result is marked "not verified" (harness-core page 2, rule 4). This is the one
      // place where a report ends a task, and the label says that nothing was verified.
      if (done === undefined) return close(task, 'not_verified', [submitted]);
      if (done.kind === 'human') return { task: { ...task, state: 'waiting_human', waiting: 'approval' }, rows: [submitted, { kind: 'task.waiting_human', data: { reason: 'approval' } }] };
      return { task: { ...task, state: 'checking' }, rows: [submitted, { kind: 'check.started', data: { check_kind: done.kind } }] };
    }
    case 'check': {
      if (task.state !== 'checking' || done === undefined) return refuse(task);
      const detail = event.detail ?? {};
      if (event.result === 'PASS') return accept(task, labelOf(done.kind), [{ kind: 'check.answered', data: { ...detail, result: 'PASS', check_kind: done.kind } }]);
      // No answer means "not ready". The silence of a check is never a success.
      const answer: RowDraft = event.result === 'FAIL' ? { kind: 'check.answered', data: { ...detail, result: 'FAIL', check_kind: done.kind } } : { kind: 'check.no_answer', data: { ...detail, check_kind: done.kind } };
      if (task.returns < done.retries) return back(task, [answer], 'check_fail', true);
      return {
        task: { ...task, state: 'waiting_human', waiting: 'check' },
        rows: [answer, { kind: 'check.retries_exceeded', data: { n: task.returns } }, { kind: 'task.waiting_human', data: { reason: 'check' } }],
      };
    }
    case 'ask': {
      if (task.state !== 'executing') return refuse(task);
      return { task: { ...task, state: 'waiting_human', waiting: 'gate' }, rows: [{ kind: 'task.waiting_human', data: { reason: 'gate' } }] };
    }
    case 'finish': {
      if (task.state !== 'publishing') return refuse(task);
      return close(task, task.label ?? 'not_verified', []);
    }
    case 'human': {
      const decided: RowDraft = { kind: 'task.human_decision', data: { decision: event.decision } };
      // The human can stop a task in any open state. A result that was accepted before keeps its
      // label; any other task ends without a verified result.
      if (event.decision === 'stop') {
        if (task.state === 'closed' || task.state === 'skipped') return refuse(task);
        return close(task, task.state === 'publishing' ? (task.label ?? 'not_verified') : 'not_verified', [decided], 'stopped');
      }
      if (task.state !== 'waiting_human') return refuse(task);
      if (task.waiting === 'gate') {
        if (event.decision !== 'answered') return refuse(task);
        const { waiting: _, ...rest } = task;
        return { task: { ...rest, state: 'executing' }, rows: [decided] };
      }
      if (event.decision === 'accept') return accept(task, 'approved_by_human', [decided]);
      // One more try: after a human check it counts as a send-back, after the limit it does not.
      if (event.decision === 'return') return back(task, [decided], 'human', task.waiting === 'approval');
      return refuse(task);
    }
    case 'expire': {
      if (task.state === 'closed' || task.state === 'skipped') return refuse(task);
      // A publication past its term: the result was accepted before, its label stays.
      return close(task, task.state === 'publishing' ? (task.label ?? 'not_verified') : 'not_verified', [], 'expired');
    }
  }
}

// The policy decision for one action of a task. The envelope acts while the task executes and
// while its result is published.
// A use of a grant is counted in the task.
export function decideFor(task: Task, action: Action, layers: LayerDecision[]): { task: Task; decision: Decision; rows: RowDraft[] } {
  const open = (task.state === 'executing' || task.state === 'publishing') && task.envelope.length > 0;
  const decision = decide(open ? { action, layers, envelope: task.envelope, task: task.use } : { action, layers });
  const rows: RowDraft[] = [
    { kind: 'policy.decision', data: { outcome: decision.outcome, action_kind: action.kind, env: action.env.name } },
    { kind: 'policy.basis', data: { layer: decision.basis.layer, rule: decision.basis.rule } },
  ];
  if (decision.envelope !== 'applied') return { task, decision, rows };
  const key = grantKey(action.name, action.target, action.env.name);
  const used = { ...task.use.used, [key]: (task.use.used[key] ?? 0) + 1 };
  return { task: { ...task, use: { ...task.use, used } }, decision, rows };
}

// The one confirmation of a grant by the human. A grant that the manifest does not name cannot be confirmed.
export function confirmGrant(task: Task, key: string): Task {
  // Only an open task takes a confirmation: nothing is written for a task that is closed or not started.
  if (task.state !== 'executing' && task.state !== 'waiting_human' && task.state !== 'publishing') return task;
  const named = task.envelope.some((g) => grantKey(g.action, g.target, g.env) === key && g.confirm === 'once');
  if (!named || task.use.confirmed.includes(key)) return task;
  return { ...task, use: { ...task.use, confirmed: [...task.use.confirmed, key] } };
}
