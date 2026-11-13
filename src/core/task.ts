// The task loop: the states of a task and the moves between them. Pure: no files, no clock.
// The harness holds the state. The agent cannot move a task to "closed": only a check answer
// or a decision of the human does that. Every move drafts the journal rows that describe it.
// Specification: docs/spec/harness-core, pages 2, 5, 6 and 7; harness-manifest, page 2.

import { inputForm, labelOf, type Level, type Manifest, type ResultLabel } from '../contracts/manifest.ts';
import type { EventKind, TASK_KINDS } from '../contracts/journal.ts';
import { decide, grantKey, plainValue, type Action, type Decision, type Grant, type LayerDecision, type TaskUse } from '../contracts/policy.ts';
import type { Fault } from '../contracts/shape.ts';

export type TaskKind = (typeof TASK_KINDS)[number];
// publishing: the result is accepted, and the writes that the envelope names can still be made.
export const TASK_STATES = ['preparing', 'executing', 'checking', 'waiting_human', 'publishing', 'closed', 'skipped'] as const;
export type TaskState = (typeof TASK_STATES)[number];
// Why a task waits: the gate asked, the check failed past the limit, or the result needs an approval.
// contract: the task has a contract that the human has not approved yet.
// limit: the task spent more tokens than its limit. scope: a contract task needs a write that
// its contract does not name.
export type WaitReason = 'gate' | 'check' | 'approval' | 'contract' | 'limit' | 'scope';
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
  session?: string; // the session of the client that holds the task now
  raised?: boolean; // the level of the model was raised once
  inputs: Inputs;
  envelope: Grant[];
  use: TaskUse;
  returns: number;
  level?: Level;
  label?: ResultLabel;
  work?: string; // the fingerprint of the work that the accepted result holds for
  root?: string; // the directory of that work: the source of the manifest, else the directory where the report was given
  cost?: { tokens: number }; // what the model spent on the task, as the client reported it
  budget?: number; // the limit of tokens after the human gave more
  reads?: number; // the reads through connectors that the task made
  extraReads?: string[]; // the read connectors outside the manifest that the human let this task use
  changes?: number; // the changes that a free task made
  offered?: boolean; // the free task got its offer of a contract
  checked?: number; // the time of the accepted answer
  check?: string; // the fingerprint of the check that gave it
  soak?: number; // the first PASS came: the second answer is due at this time
  red?: boolean; // the last answer of the check was not PASS: the files of the check are protected
  probes?: number; // the runs of the done check before the report
  widened?: boolean; // the human let a contract task go on past its contract
  disputed?: string; // the time when the human said that the accepted result was wrong
};

export type TaskEvent =
  | { type: 'prepared'; work: boolean; flag?: string; outputs?: number; bytes?: number }
  | { type: 'collect_failed'; reason: string }
  // `changed`: a fact of the client about a free request: the work tree is not what it was at the request.
  // `root`: the directory of the work that the report is about.
  | { type: 'report'; size: number; fp: string; changed?: boolean; root?: string }
  // `detail`: counts and a reason code of the check for the journal, never text.
  // `work`: the fingerprint of the work that the check saw.
  // `at`: the time of the answer. `check`: the fingerprint of the check that answered.
  | { type: 'check'; result: 'PASS' | 'FAIL' | 'none'; detail?: Record<string, string | number>; work?: string; at?: number; check?: string }
  | { type: 'invalidate'; reason?: 'work_changed' | 'check_changed' | 'expired' }
  | { type: 'limit' } // the task went past its limit of tokens
  | { type: 'scope' } // a contract task needs a write that its contract does not name // the work changed after the check: the answer does not hold any more
  | { type: 'ask' }
  // `work`, `at`: an approval of a result: the fingerprint of the work that the human saw, and the time.
  | { type: 'human'; decision: 'answered' | 'accept' | 'return' | 'stop'; work?: string; at?: number }
  | { type: 'finish' } // the publication is over: nothing more will be written
  | { type: 'expire' };

// `fp`: the fingerprint of the state of the work that the row is about.
export type RowDraft = { kind: EventKind; data?: Record<string, string | number | boolean>; fp?: string };
export type Step = { task: Task; rows: RowDraft[]; error?: 'bad_event' };

export type InputErrorCode = 'missing' | 'unknown' | 'bad_type' | 'bad_form';
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
    // The form that the manifest names holds for every way a task opens, also by the name of the scenario.
    else if (d.pattern !== undefined && typeof value === 'string' && inputForm(d.pattern)?.test(value) !== true) errors.push({ code: 'bad_form', path: d.name });
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

// `reason`: why the task is a task of this scenario: the human named the scenario, or the input had the form of its manifest.
export function newScenarioTask(id: string, manifest: Manifest, inputs: Inputs, reason: 'scenario_name' | 'input_form' = 'scenario_name'): { task: Task; rows: RowDraft[] } | { errors: InputError[] } {
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
    ...(manifest.model.level !== undefined ? { level: manifest.model.level } : {}),
  };
  return { task, rows: [{ kind: 'task.opened' }, { kind: 'task.kind_decided', data: { kind: 'scenario', reason } }] };
}

// A task with a contract: a manifest for one task, proposed by the agent. Nothing runs before
// the human approves it (harness-core, page 5).
export function newContractTask(id: string, manifest: Manifest): { task: Task; rows: RowDraft[] } {
  const task: Task = {
    id, kind: 'contract', state: 'waiting_human', waiting: 'contract', scenario: manifest.name, version: manifest.version ?? 1,
    manifest, inputs: {}, envelope: grantsOf(manifest, {}), use: { confirmed: [], used: {} }, returns: 0, ...(manifest.model.level !== undefined ? { level: manifest.model.level } : {}),
  };
  return {
    task,
    rows: [
      { kind: 'task.opened' }, { kind: 'task.kind_decided', data: { kind: 'contract', reason: 'human_word' } },
      { kind: 'task.contract_proposed' }, { kind: 'task.waiting_human', data: { reason: 'contract' } },
    ],
  };
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
      if (done === undefined) {
        const closed = close(task, 'not_verified', [submitted]);
        // The journal keeps the fact: this result was a change of the work that nothing verified.
        if (event.changed === true && task.kind === 'free') for (const row of closed.rows) if (row.kind === 'task.closed') row.data = { ...row.data, changed: 1 };
        return closed;
      }
      if (event.root !== undefined) task = { ...task, root: event.root };
      if (done.kind === 'human') return { task: { ...task, state: 'waiting_human', waiting: 'approval' }, rows: [submitted, { kind: 'task.waiting_human', data: { reason: 'approval' } }] };
      return { task: { ...task, state: 'checking' }, rows: [submitted, { kind: 'check.started', data: { check_kind: done.kind } }] };
    }
    case 'check': {
      if (task.state !== 'checking' || done === undefined) return refuse(task);
      const detail = event.detail ?? {};
      if (event.result === 'PASS') {
        const { red: _, soak, checked: _c, check: _k, ...green } = task;
        const at = event.at ?? 0;
        const pass: RowDraft = { kind: 'check.answered', data: { ...detail, result: 'PASS', check_kind: done.kind }, ...(event.work !== undefined ? { fp: event.work } : {}) };
        // The soak: the first PASS is not the result. The check answers again after the term.
        if (done.soak_minutes !== undefined && soak === undefined) return { task: { ...green, soak: at + done.soak_minutes * 60_000, ...(event.check !== undefined ? { check: event.check } : {}), ...(event.work !== undefined ? { work: event.work } : {}) }, rows: [{ ...pass, data: { ...pass.data, soak: done.soak_minutes } }] };
        return accept({ ...green, checked: at, ...(event.check !== undefined ? { check: event.check } : {}), ...(event.work !== undefined ? { work: event.work } : {}) }, labelOf(done.kind, done.proves), [pass]);
      }
      // No answer means "not ready". The silence of a check is never a success.
      const answer: RowDraft = { ...(event.result === 'FAIL' ? { kind: 'check.answered' as const, data: { ...detail, result: 'FAIL', check_kind: done.kind } } : { kind: 'check.no_answer' as const, data: { ...detail, check_kind: done.kind } }), ...(event.work !== undefined ? { fp: event.work } : {}) };
      // A check that did not accept the work must not be made weaker instead of the work made better.
      const { soak: _s, check: _k, work: _w, ...rest } = task;
      if (task.returns < done.retries) return back({ ...rest, red: true }, [answer], 'check_fail', true);
      return {
        task: { ...rest, red: true, state: 'waiting_human', waiting: 'check' },
        rows: [answer, { kind: 'check.retries_exceeded', data: { n: task.returns } }, { kind: 'task.waiting_human', data: { reason: 'check' } }],
      };
    }
    case 'ask': {
      if (task.state !== 'executing') return refuse(task);
      return { task: { ...task, state: 'waiting_human', waiting: 'gate' }, rows: [{ kind: 'task.waiting_human', data: { reason: 'gate' } }] };
    }
    case 'limit':
    case 'scope': {
      // The task does no more work until the human decides: one more budget, or the end.
      if (task.state !== 'executing') return refuse(task);
      return { task: { ...task, state: 'waiting_human', waiting: event.type }, rows: [{ kind: 'task.waiting_human', data: { reason: event.type } }] };
    }
    case 'invalidate': {
      // An accepted result holds for the work that the check saw. The work is not that any more:
      // what would be published now was not checked.
      if (task.state !== 'publishing') return refuse(task);
      return close(task, 'not_verified', [{ kind: 'check.invalidated', data: { reason: event.reason ?? 'work_changed' } }], event.reason ?? 'work_changed');
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
      // The approval of a contract starts the preparation. Nothing else answers a proposal.
      if (task.waiting === 'contract') {
        if (event.decision !== 'accept') return refuse(task);
        const { waiting: _, ...rest } = task;
        return { task: { ...rest, state: 'preparing' }, rows: [decided, { kind: 'task.contract_approved' }] };
      }
      if (task.waiting === 'gate') {
        if (event.decision !== 'answered') return refuse(task);
        const { waiting: _, ...rest } = task;
        return { task: { ...rest, state: 'executing' }, rows: [decided] };
      }
      // A task that stopped at a limit or at the edge of its contract has no result to accept:
      // the human lets it go on, or stops it.
      if (task.waiting === 'limit' || task.waiting === 'scope') {
        if (event.decision !== 'return') return refuse(task);
        return back(task, [decided], 'human', false);
      }
      // The approval holds for the work as the human saw it: a change after it ends the publication.
      if (event.decision === 'accept') return accept(event.work === undefined ? task : { ...task, work: event.work, ...(event.at !== undefined ? { checked: event.at } : {}) }, 'approved_by_human', [decided]);
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
// `outward`: the action is one that another human sees. It is confirmed once also when the grant asks for no confirmation.
export function confirmGrant(task: Task, key: string, outward = false): Task {
  // Only an open task takes a confirmation: nothing is written for a task that is closed or not started.
  if (task.state !== 'executing' && task.state !== 'waiting_human' && task.state !== 'publishing') return task;
  const named = task.envelope.some((g) => grantKey(g.action, g.target, g.env) === key && (g.confirm === 'once' || outward));
  if (!named || task.use.confirmed.includes(key)) return task;
  return { ...task, use: { ...task.use, confirmed: [...task.use.confirmed, key] } };
}
