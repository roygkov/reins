// Journal row: one event per row, rows are only added. The list of kinds is closed:
// a row of an unknown kind is not written. A row holds lists, numbers and fingerprints,
// never the text of a prompt, a command, a report or an error.
// Specification: docs/spec/harness-journal, pages 1, 2 and 4.

import { inList, isInt, isObj, type Fault } from './shape.ts';
import { DONE_KINDS, LEVELS, RESULT_LABELS } from './manifest.ts';
import { ACTION_KINDS, LAYERS, OUTCOMES } from './policy.ts';

export const JOURNAL_VERSION = 1;

export const SOURCES = ['task', 'policy', 'check', 'executor', 'memory', 'craft', 'harness'] as const;
export type Source = (typeof SOURCES)[number];

export const EVENT_KINDS = [
  // the loop
  'task.opened', 'task.kind_decided', 'task.contract_proposed', 'task.contract_approved', 'task.prepared', 'task.skipped',
  'task.started', 'task.report_submitted', 'task.returned', 'task.waiting_human', 'task.human_decision', 'task.closed',
  // the policy
  'policy.decision', 'policy.basis', 'policy.envelope_opened', 'policy.envelope_closed', 'policy.action_deferred',
  'policy.deferred_resolved', 'policy.protected_attempt',
  // the check
  'check.started', 'check.answered', 'check.no_answer', 'check.invalidated', 'check.retries_exceeded',
  // executors and cost
  'executor.started', 'executor.report_received', 'executor.report_judged', 'executor.level_raised', 'executor.cost', 'executor.tool_failed',
  // memory
  'memory.read', 'memory.record_used', 'memory.record_changed',
  // craft
  'craft.pattern_found', 'craft.proposal_created', 'craft.proposal_resolved', 'craft.effect_measured',
  // the harness itself
  'harness.failure', 'harness.step_timeout', 'harness.client_shape_changed', 'harness.client_level_detected',
  'harness.barriers_off', 'harness.packs_merged', 'harness.pack_changed', 'harness.manifest_rejected',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const TASK_KINDS = ['scenario', 'contract', 'free'] as const;
// The kind of a task follows the scenario name, the form of the input or the facts. Never the words of the prompt.
// human_word: the human asked for a task with a contract.
export const TASK_KIND_REASONS = ['scenario_name', 'input_form', 'facts', 'human_word'] as const;
export const EXECUTORS = ['main', 'sub'] as const;
export const CHECK_RESULTS = ['PASS', 'FAIL'] as const;

export type JournalRow = {
  ts: string;
  v: 1;
  kind: EventKind;
  project: string;
  task?: string;
  parent?: string;
  session?: string;
  scenario?: string;
  scenario_v?: number;
  executor?: (typeof EXECUTORS)[number];
  role?: string;
  level?: (typeof LEVELS)[number];
  client?: string;
  fp?: string;
  pack?: (typeof LAYERS)[number];
  data?: Record<string, number | boolean | string>;
};

export type JournalErrorCode =
  | 'not_object' | 'missing' | 'unknown_field' | 'unknown_kind' | 'version_unsupported' | 'bad_time'
  | 'bad_token' | 'bad_fingerprint' | 'not_integer' | 'not_number' | 'not_in_list' | 'bad_value' | 'free_text';

export type JournalError = Fault<JournalErrorCode>;

const FIELDS = ['ts', 'v', 'kind', 'project', 'task', 'parent', 'session', 'scenario', 'scenario_v', 'executor', 'role', 'level', 'client', 'fp', 'pack', 'data'] as const;
const TOKENS = ['project', 'task', 'parent', 'session', 'scenario', 'role', 'client'] as const;
// A token is an identifier or a code: no spaces, bounded length. A sentence is not a token.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
// The name of a rule in the data of a row: the same form as a token, so no text of a command and no long path.
export const RULE_NAME = TOKEN;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const FINGERPRINT = /^[0-9a-f]{8,64}$/;
// The name of a data field is an identifier: free text cannot hide in a key.
const DATA_KEY = /^[a-z][a-z0-9_]{0,39}$/;
// Events of these sources always belong to a task.
const NEEDS_TASK: readonly Source[] = ['task', 'policy', 'check', 'executor'];

type FieldSpec = readonly string[] | 'number' | 'token';

// Data fields that a kind requires. Other data fields are free, within the "no free text" rule.
const DATA: Partial<Record<EventKind, Record<string, FieldSpec>>> = {
  'task.kind_decided': { kind: TASK_KINDS, reason: TASK_KIND_REASONS },
  'task.closed': { label: RESULT_LABELS },
  'policy.decision': { outcome: OUTCOMES, action_kind: ACTION_KINDS, env: 'token' },
  'policy.basis': { layer: LAYERS, rule: 'token' },
  'task.prepared': { outputs: 'number', bytes: 'number' },
  'task.report_submitted': { size: 'number' },
  'task.returned': { n: 'number', reason: ['check_fail', 'human'] },
  'task.waiting_human': { reason: ['gate', 'check', 'approval', 'contract', 'limit', 'scope'] },
  'executor.report_judged': { result: CHECK_RESULTS },
  // answered: the human said "yes" to a question about one action. confirm: the one approval of a task.
  // `refused`: a question about an action that no run of the tool answered: the human said "no".
  'task.human_decision': { decision: ['answered', 'accept', 'return', 'stop', 'confirm', 'refused'] },
  'policy.envelope_opened': { grants: 'number' },
  'policy.protected_attempt': { rule: 'token', outcome: ['ask', 'deny'] },
  'check.started': { check_kind: DONE_KINDS },
  'check.no_answer': { check_kind: DONE_KINDS },
  'check.retries_exceeded': { n: 'number' },
  'executor.tool_failed': { tool: 'token' },
  'memory.read': { n: 'number' },
  'memory.record_used': { record: 'token' },
  'memory.record_changed': { record: 'token', state: ['pending', 'active', 'stale', 'replaced', 'vetoed', 'closed'] },
  'craft.pattern_found': { pattern: 'token', n: 'number' },
  'craft.proposal_created': { proposal: 'token', pattern: 'token' },
  'craft.proposal_resolved': { proposal: 'token', state: ['accepted', 'rejected'] },
  'craft.effect_measured': { proposal: 'token', effect: ['better', 'same', 'worse'] },
  'harness.client_shape_changed': { client: 'token', event: 'token' },
  'harness.client_level_detected': { client: 'token', level: 'token' },
  'harness.barriers_off': { minutes: 'number' },
  'policy.action_deferred': { queued: 'token', rule: 'token' },
  'policy.deferred_resolved': { queued: 'token', state: ['approved', 'rejected'] },
  'check.answered': { result: CHECK_RESULTS, check_kind: DONE_KINDS },
  'executor.cost': { tokens: 'number', ms: 'number', calls: 'number' },
  'harness.failure': { where: 'token' },
};

export function sourceOf(kind: EventKind): Source {
  return kind.slice(0, kind.indexOf('.')) as Source;
}

function dataField(errors: JournalError[], path: string, value: unknown, spec: FieldSpec | undefined): void {
  if (spec === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push({ code: 'not_number', path });
    return;
  }
  if (spec !== undefined && spec !== 'token') {
    if (typeof value !== 'string') errors.push({ code: 'bad_value', path });
    else if (!spec.includes(value)) errors.push({ code: 'not_in_list', path });
    return;
  }
  if (typeof value === 'boolean') {
    if (spec === 'token') errors.push({ code: 'bad_value', path });
    return;
  }
  if (typeof value === 'number') {
    if (spec === 'token' || !Number.isFinite(value)) errors.push({ code: 'bad_value', path });
    return;
  }
  if (typeof value !== 'string') errors.push({ code: 'bad_value', path });
  else if (!TOKEN.test(value)) errors.push({ code: 'free_text', path });
}

// The check that runs before a row is written. An empty list means the row can be written.
// A reader is more tolerant: it skips fields that it does not know.
export function validateRow(row: unknown): JournalError[] {
  const errors: JournalError[] = [];
  const add = (code: JournalErrorCode, path: string): void => void errors.push({ code, path });
  if (!isObj(row)) {
    add('not_object', '$');
    return errors;
  }
  for (const key of Object.keys(row)) if (!(FIELDS as readonly string[]).includes(key)) add('unknown_field', key);

  if (row.ts === undefined) add('missing', 'ts');
  else if (typeof row.ts !== 'string' || !TIME.test(row.ts) || Number.isNaN(Date.parse(row.ts))) add('bad_time', 'ts');

  if (row.v === undefined) add('missing', 'v');
  else if (row.v !== JOURNAL_VERSION) add('version_unsupported', 'v');

  let kind: EventKind | null = null;
  if (row.kind === undefined) add('missing', 'kind');
  else if (!inList(EVENT_KINDS, row.kind)) add('unknown_kind', 'kind');
  else kind = row.kind;

  if (row.project === undefined) add('missing', 'project');
  for (const key of TOKENS) {
    const value = row[key];
    if (value !== undefined && (typeof value !== 'string' || !TOKEN.test(value))) add('bad_token', key);
  }
  if (kind !== null && NEEDS_TASK.includes(sourceOf(kind)) && row.task === undefined) add('missing', 'task');

  if (row.executor !== undefined && !inList(EXECUTORS, row.executor)) add('not_in_list', 'executor');
  // A row of a subordinate executor carries the parent task: its cost and its actions stay attributable.
  if (row.executor === 'sub' && row.parent === undefined) add('missing', 'parent');
  if (row.level !== undefined && !inList(LEVELS, row.level)) add('not_in_list', 'level');
  if (row.pack !== undefined && !inList(LAYERS, row.pack)) add('not_in_list', 'pack');
  if (row.fp !== undefined && (typeof row.fp !== 'string' || !FINGERPRINT.test(row.fp))) add('bad_fingerprint', 'fp');
  if (row.scenario !== undefined && row.scenario_v === undefined) add('missing', 'scenario_v');
  if (row.scenario_v !== undefined && (!isInt(row.scenario_v) || row.scenario_v < 1)) add('not_integer', 'scenario_v');

  const spec: Record<string, FieldSpec> = kind === null ? {} : (DATA[kind] ?? {});
  if (row.data !== undefined && !isObj(row.data)) {
    add('not_object', 'data');
    return errors;
  }
  const data = row.data ?? {};
  for (const key of Object.keys(spec)) if (!Object.hasOwn(data, key)) add('missing', `data.${key}`);
  for (const [key, value] of Object.entries(data)) {
    if (!DATA_KEY.test(key)) add('free_text', `data.${key}`);
    else dataField(errors, `data.${key}`, value, Object.hasOwn(spec, key) ? spec[key] : undefined);
  }
  return errors;
}
