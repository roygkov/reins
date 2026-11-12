// Scenario manifest: a header and eight fields. The manifest is data only: no conditions,
// no branches, no code. A manifest that fails this validator is never connected.
// Specification: docs/spec/harness-manifest, pages 1, 3, 4 and 7.

import { parseSchedule } from './schedule.ts';
import { at, inList, isInt, isObj, oneLine, type Fault, type Obj } from './shape.ts';

export const MANIFEST_VERSION = 1;
export const PACKAGES = ['organization', 'project', 'person'] as const;
export const STATES = ['active', 'disabled'] as const;
export const TRIGGER_KINDS = ['command', 'schedule', 'event'] as const;
export const INPUT_TYPES = ['string', 'number', 'id', 'url'] as const;
export const LEVELS = ['weak', 'medium', 'strong'] as const;
export const CONFIRMS = ['none', 'once'] as const;
export const DONE_KINDS = ['command', 'artifact', 'external', 'citations', 'human'] as const;
export const OUTPUT_FORMATS = ['list', 'table', 'text', 'file'] as const;
export const OUTPUT_RECEIVERS = ['human', 'system'] as const;
export const RECORD_TYPES = ['decision', 'pitfall', 'case', 'state'] as const;
export const MEMORY_CLASSES = ['auto', 'veto'] as const;
export const RESULT_LABELS = ['verified_result', 'verified_form', 'approved_by_human', 'not_verified'] as const;
export const MAX_RETRIES = 5;

export type Package = (typeof PACKAGES)[number];
export type Level = (typeof LEVELS)[number];
export type Confirm = (typeof CONFIRMS)[number];
export type DoneKind = (typeof DONE_KINDS)[number];
export type RecordType = (typeof RECORD_TYPES)[number];
export type ResultLabel = (typeof RESULT_LABELS)[number];

export type WriteGrant = { action: string; target: string; env: string; limit: number; confirm: Confirm };

export type Manifest = {
  manifest: 1;
  version?: number; // the version of the scenario, 1 when absent
  name: string;
  title: string;
  package: Package;
  state?: (typeof STATES)[number];
  description?: string;
  trigger: { kind: (typeof TRIGGER_KINDS)[number]; value?: string; inputs?: { name: string; type: (typeof INPUT_TYPES)[number] }[] };
  collect?: { script: string; outputs: string[]; flags?: string[]; max_bytes?: number; timeout_s?: number };
  run_if?: string;
  model: { level?: Level; raise_to?: Level; executors?: { role: string; count: number; rights?: (typeof EXECUTOR_RIGHTS)[number]; area?: string[] }[]; token_limit?: number };
  permissions: { read: string[]; write?: WriteGrant[] };
  // `source` and `changed` belong to the citation check: the names of the collect results that hold
  // the directory of the source and the list of the changed files.
  done: { kind: DoneKind; check?: string; retries: number; source?: string; changed?: string; guards?: string[]; valid_minutes?: number; soak_minutes?: number; texts?: string[]; reject?: Record<string, string[]>; unquoted?: Record<string, string[]> };
  output: { format: (typeof OUTPUT_FORMATS)[number]; sections?: string[]; fields?: Record<string, string[]>; max_items?: number; max_bytes?: number; to?: (typeof OUTPUT_RECEIVERS)[number] };
  memory?: { write: RecordType[]; class?: (typeof MEMORY_CLASSES)[number] };
};

// What the packs allow. A manifest can ask for less than the packs allow, never for more.
// A field that is absent is not checked.
export type PackContext = {
  readConnectors?: string[];
  writeActions?: string[];
  scripts?: string[];
  checks?: string[];
  envs?: string[];
  productionEnvs?: string[];
  roles?: string[];
  memoryTypes?: string[];
  maxLevel?: Level;
  maxTokens?: number;
  maxReads?: number; // the reads of one task through connectors
  maxWriteLimit?: number;
  maxExecutors?: number;
};

export type ManifestErrorCode =
  | 'bad_form' | 'not_object' | 'not_array' | 'not_string' | 'not_integer' | 'not_positive' | 'not_in_range'
  | 'not_one_line' | 'not_in_list' | 'not_allowed' | 'missing' | 'missing_limit' | 'empty' | 'duplicate'
  | 'unknown_field' | 'version_unsupported' | 'bad_name' | 'bad_ref' | 'bad_target'
  | 'run_if_without_collect' | 'unknown_flag' | 'raise_below_level'
  | 'target_unbounded' | 'unknown_input' | 'unknown_output'
  | 'not_in_pack' | 'above_pack' | 'envelope_production';

export type ManifestError = Fault<ManifestErrorCode>;

const NAME = /^[a-z][a-z0-9-]{0,62}$/; // scenario, connector, action, role, check, environment
const IDENT = /^[a-z][a-z0-9_]{0,62}$/; // input, output, flag
const REF = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/; // an object of the pack, relative, no ".."
// The fields of an item of a result that the core reads. A manifest cannot give them another meaning.
export const ITEM_CORE_FIELDS: readonly string[] = ['file', 'line', 'end', 'quote', 'text', 'source'];
const PLACEHOLDER = /\{([^{}]*)\}/g;

// What a subordinate executor may do. read: it changes nothing. write: it changes the work, inside its area when it has one.
export const EXECUTOR_RIGHTS = ['read', 'write'] as const;
const TOP = ['manifest', 'version', 'name', 'title', 'package', 'state', 'description', 'trigger', 'collect', 'run_if', 'model', 'permissions', 'done', 'output', 'memory'] as const;
const TOP_REQUIRED = ['manifest', 'name', 'title', 'package', 'trigger', 'model', 'permissions', 'done', 'output'] as const;

// The label of the result that the human sees follows the kind of the check, not the manifest text.
export function labelOf(kind: DoneKind): ResultLabel {
  switch (kind) {
    case 'command':
    case 'artifact':
    case 'external':
      return 'verified_result';
    case 'citations':
      return 'verified_form';
    case 'human':
      return 'approved_by_human';
  }
}

class Report {
  readonly errors: ManifestError[] = [];
  add(code: ManifestErrorCode, path: string): void {
    this.errors.push({ code, path });
  }
}

// Reports unknown and missing keys. Returns the object, or null when the value is not an object.
function fields(r: Report, value: unknown, path: string, allowed: readonly string[], required: readonly string[]): Obj | null {
  if (!isObj(value)) {
    r.add('not_object', path === '' ? '$' : path);
    return null;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) r.add('unknown_field', at(path, key));
  for (const key of required) if (value[key] === undefined) r.add('missing', at(path, key));
  return value;
}

function text(r: Report, value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    r.add('not_string', path);
    return null;
  }
  if (!oneLine(value)) {
    r.add('not_one_line', path);
    return null;
  }
  return value;
}

function named(r: Report, value: unknown, path: string, pattern: RegExp, code: ManifestErrorCode = 'bad_name'): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    r.add('not_string', path);
    return null;
  }
  if (!pattern.test(value)) {
    r.add(code, path);
    return null;
  }
  return value;
}

function choice<T extends string>(r: Report, value: unknown, path: string, list: readonly T[]): T | null {
  if (value === undefined) return null;
  if (!inList(list, value)) {
    r.add('not_in_list', path);
    return null;
  }
  return value;
}

function positive(r: Report, value: unknown, path: string): number | null {
  if (value === undefined) return null;
  if (!isInt(value)) {
    r.add('not_integer', path);
    return null;
  }
  if (value <= 0) {
    r.add('not_positive', path);
    return null;
  }
  return value;
}

function list(r: Report, value: unknown, path: string): unknown[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    r.add('not_array', path);
    return null;
  }
  return value;
}

function inPack(r: Report, allowed: string[] | undefined, value: string | null, path: string): void {
  if (allowed !== undefined && value !== null && !allowed.includes(value)) r.add('not_in_pack', path);
}

function trigger(r: Report, value: unknown): Set<string> {
  const inputs = new Set<string>();
  const t = fields(r, value, 'trigger', ['kind', 'value', 'inputs'], ['kind']);
  if (t === null) return inputs;
  const kind = choice(r, t.kind, 'trigger.kind', TRIGGER_KINDS);
  text(r, t.value, 'trigger.value');
  if (kind !== null && kind !== 'command' && t.value === undefined) r.add('missing', 'trigger.value');
  // A schedule has one of the known forms. An event has a name.
  if (kind === 'schedule' && typeof t.value === 'string' && parseSchedule(t.value) === null) r.add('bad_form', 'trigger.value');
  if (kind === 'event' && typeof t.value === 'string' && !NAME.test(t.value)) r.add('bad_form', 'trigger.value');
  const items = list(r, t.inputs, 'trigger.inputs') ?? [];
  // Nobody gives inputs to a schedule.
  if (kind === 'schedule' && items.length > 0) r.add('not_allowed', 'trigger.inputs');
  items.forEach((item, i) => {
    const path = `trigger.inputs[${i}]`;
    const input = fields(r, item, path, ['name', 'type'], ['name', 'type']);
    if (input === null) return;
    const name = named(r, input.name, `${path}.name`, IDENT);
    choice(r, input.type, `${path}.type`, INPUT_TYPES);
    if (name === null) return;
    if (inputs.has(name)) r.add('duplicate', `${path}.name`);
    inputs.add(name);
  });
  return inputs;
}

function collect(r: Report, value: unknown, pack: PackContext): Set<string> | null {
  if (value === undefined) return null;
  const flags = new Set<string>();
  const c = fields(r, value, 'collect', ['script', 'outputs', 'flags', 'max_bytes', 'timeout_s'], ['script', 'outputs']);
  if (c === null) return flags;
  inPack(r, pack.scripts, named(r, c.script, 'collect.script', REF, 'bad_ref'), 'collect.script');
  const outputs = list(r, c.outputs, 'collect.outputs');
  if (outputs !== null && outputs.length === 0) r.add('empty', 'collect.outputs');
  (outputs ?? []).forEach((o, i) => named(r, o, `collect.outputs[${i}]`, IDENT));
  (list(r, c.flags, 'collect.flags') ?? []).forEach((f, i) => {
    const flag = named(r, f, `collect.flags[${i}]`, IDENT);
    if (flag !== null) flags.add(flag);
  });
  positive(r, c.max_bytes, 'collect.max_bytes');
  positive(r, c.timeout_s, 'collect.timeout_s');
  return flags;
}

function model(r: Report, value: unknown, pack: PackContext): void {
  // A manifest without a level takes the level that the packs give.
  const m = fields(r, value, 'model', ['level', 'raise_to', 'executors', 'token_limit'], []);
  if (m === null) return;
  const rank = (l: Level): number => LEVELS.indexOf(l);
  const level = choice(r, m.level, 'model.level', LEVELS);
  const raise = choice(r, m.raise_to, 'model.raise_to', LEVELS);
  if (level !== null && raise !== null && rank(raise) < rank(level)) r.add('raise_below_level', 'model.raise_to');
  if (pack.maxLevel !== undefined) {
    if (level !== null && rank(level) > rank(pack.maxLevel)) r.add('above_pack', 'model.level');
    if (raise !== null && rank(raise) > rank(pack.maxLevel)) r.add('above_pack', 'model.raise_to');
  }
  let total = 0;
  const areas: string[][] = [];
  (list(r, m.executors, 'model.executors') ?? []).forEach((item, i) => {
    const path = `model.executors[${i}]`;
    const e = fields(r, item, path, ['role', 'count', 'rights', 'area'], ['role', 'count']);
    if (e === null) return;
    inPack(r, pack.roles, named(r, e.role, `${path}.role`, NAME), `${path}.role`);
    const count = positive(r, e.count, `${path}.count`) ?? 0;
    total += count;
    const rights = choice(r, e.rights, `${path}.rights`, EXECUTOR_RIGHTS);
    if (e.area === undefined) return;
    // An area is a part of the work that one executor changes: only a writer has one.
    if (rights !== 'write') return r.add('not_allowed', `${path}.area`);
    const area = list(r, e.area, `${path}.area`);
    if (area === null) return;
    if (area.length === 0) return r.add('empty', `${path}.area`);
    let good = true;
    area.forEach((g, j) => { if (!isGuard(g)) { good = false; r.add('bad_name', `${path}.area[${j}]`); } });
    if (!good) return;
    // Two executors of one role would share the area.
    if (count > 1) return r.add('not_allowed', `${path}.count`);
    const starts = (area as string[]).map(fixedStart);
    if (areas.some((other) => other.some((a) => starts.some((b) => a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))))) r.add('duplicate', `${path}.area`);
    areas.push(starts);
  });
  if (pack.maxExecutors !== undefined && total > pack.maxExecutors) r.add('above_pack', 'model.executors');
  const tokens = positive(r, m.token_limit, 'model.token_limit');
  if (pack.maxTokens !== undefined && tokens !== null && tokens > pack.maxTokens) r.add('above_pack', 'model.token_limit');
}

// A write target is a template: fixed text plus placeholders that name trigger inputs.
// "Everything" is not a target: no wildcards, and at least one fixed letter or digit.
function target(r: Report, value: unknown, path: string, inputs: Set<string>): string | null {
  const t = text(r, value, path);
  if (t === null) return null;
  const fixed = t.replace(PLACEHOLDER, '');
  if (/[*?]/.test(t) || !/[A-Za-z0-9]/.test(fixed)) {
    r.add('target_unbounded', path);
    return null;
  }
  if (/[{}]/.test(fixed)) {
    r.add('bad_target', path);
    return null;
  }
  for (const m of t.matchAll(PLACEHOLDER)) {
    if (!inputs.has(m[1] ?? '')) {
      r.add('unknown_input', path);
      return null;
    }
  }
  return t;
}

function permissions(r: Report, value: unknown, pack: PackContext, inputs: Set<string>): void {
  const p = fields(r, value, 'permissions', ['read', 'write'], ['read']);
  if (p === null) return;
  (list(r, p.read, 'permissions.read') ?? []).forEach((c, i) => {
    const path = `permissions.read[${i}]`;
    inPack(r, pack.readConnectors, named(r, c, path, NAME), path);
  });
  const seen = new Set<string>();
  (list(r, p.write, 'permissions.write') ?? []).forEach((item, i) => {
    const path = `permissions.write[${i}]`;
    const w = fields(r, item, path, ['action', 'target', 'env', 'limit', 'confirm'], ['action', 'target', 'env', 'limit', 'confirm']);
    if (w === null) return;
    const action = named(r, w.action, `${path}.action`, NAME);
    inPack(r, pack.writeActions, action, `${path}.action`);
    const to = target(r, w.target, `${path}.target`, inputs);
    const env = named(r, w.env, `${path}.env`, NAME);
    // The envelope never covers a production environment. An environment that the packs
    // do not list counts as production: with a pack, the check fails closed.
    if (env !== null && pack !== STRUCTURE_ONLY) {
      const production = (pack.productionEnvs ?? []).includes(env) || !(pack.envs ?? []).includes(env);
      if (production) r.add('envelope_production', `${path}.env`);
    }
    const limit = positive(r, w.limit, `${path}.limit`);
    if (pack.maxWriteLimit !== undefined && limit !== null && limit > pack.maxWriteLimit) r.add('above_pack', `${path}.limit`);
    choice(r, w.confirm, `${path}.confirm`, CONFIRMS);
    if (action !== null && to !== null && env !== null) {
      const key = `${action} ${to} ${env}`;
      if (seen.has(key)) r.add('duplicate', path);
      seen.add(key);
    }
  });
}

const MAX_GUARDS = 20;
// A pattern of the files of a check: a path inside the work, with `/` between its parts. `*` is
// any text inside one part, `**` is any text. It never leaves the work.
function isGuard(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 200 || /[\\\0\n]/.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
// The part of a pattern before its first `*`: a fixed path.
export function fixedStart(guard: string): string {
  const parts = guard.split('/');
  const at = parts.findIndex((p) => p.includes('*'));
  return (at === -1 ? parts : parts.slice(0, at)).join('/');
}
export function guardPattern(guard: string): RegExp {
  const source = guard.split('**').map((piece) => piece.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${source}$`, 's');
}

function done(r: Report, value: unknown, pack: PackContext, outputs: readonly unknown[], itemFields: Record<string, unknown>): void {
  const d = fields(r, value, 'done', ['kind', 'check', 'retries', 'source', 'changed', 'guards', 'valid_minutes', 'soak_minutes', 'texts', 'reject', 'unquoted'], ['kind', 'retries']);
  if (d === null) return;
  const kind = choice(r, d.kind, 'done.kind', DONE_KINDS);
  const needsCheck = kind === 'command' || kind === 'artifact' || kind === 'external';
  if (kind !== null && needsCheck && d.check === undefined) r.add('missing', 'done.check');
  if (kind !== null && !needsCheck && d.check !== undefined) r.add('not_allowed', 'done.check');
  else inPack(r, pack.checks, named(r, d.check, 'done.check', NAME), 'done.check');
  // The citation check reads the source that the collect step prepared, never a path of the agent.
  for (const key of ['source', 'changed'] as const) {
    if (d[key] === undefined) continue;
    // The source also names the work that an answer of a check script holds for.
    if (kind !== null && kind !== 'citations' && (key === 'changed' || !needsCheck)) r.add('not_allowed', `done.${key}`);
    else {
      const name = named(r, d[key], `done.${key}`, IDENT);
      if (name !== null && !outputs.includes(name)) r.add('unknown_output', `done.${key}`);
    }
  }
  // Without a source the check can never answer: such a manifest is refused when it is connected.
  if (kind === 'citations' && d.source === undefined) r.add('missing', 'done.source');
  // The files that the check script runs or reads as its rules: the tests and their settings.
  if (d.guards !== undefined) {
    if (kind !== null && !needsCheck) r.add('not_allowed', 'done.guards');
    else {
      const guards = list(r, d.guards, 'done.guards') ?? [];
      if (guards.length > MAX_GUARDS) r.add('not_in_range', 'done.guards');
      else guards.forEach((g, i) => { if (!isGuard(g)) r.add('bad_name', `done.guards[${i}]`); });
    }
  }
  // The citation check can read the texts that the collect step gave (a ticket, a log, the output
  // of a command), and a value of a field of an item can decide: fail the item, or free it from its quote.
  if (d.texts !== undefined) {
    if (kind !== null && kind !== 'citations') r.add('not_allowed', 'done.texts');
    else (list(r, d.texts, 'done.texts') ?? []).forEach((t, i) => {
      const name = named(r, t, `done.texts[${i}]`, IDENT);
      if (name !== null && !outputs.includes(name)) r.add('unknown_output', `done.texts[${i}]`);
    });
  }
  const decided = new Set<string>();
  for (const key of ['reject', 'unquoted'] as const) {
    const lists = d[key];
    if (lists === undefined) continue;
    if (kind !== null && kind !== 'citations') { r.add('not_allowed', `done.${key}`); continue; }
    if (!isObj(lists)) { r.add('not_object', `done.${key}`); continue; }
    for (const [field, values] of Object.entries(lists)) {
      const at = `done.${key}.${field}`;
      const allowed = itemFields[field];
      if (!Array.isArray(allowed)) { r.add('unknown_field', at); continue; }
      (list(r, values, at) ?? []).forEach((v, i) => {
        if (typeof v !== 'string' || !allowed.includes(v)) r.add('not_in_list', `${at}[${i}]`);
        else if (decided.has(`${field} ${v}`)) r.add('duplicate', `${at}[${i}]`);
        else decided.add(`${field} ${v}`);
      });
    }
  }
  // The term of an answer: after it a green answer holds no more. The soak: an outer state changes
  // with time, so the first PASS waits for a second answer after the term.
  for (const [key, max, allowed] of [['valid_minutes', 7 * 24 * 60, kind !== 'human'], ['soak_minutes', 24 * 60, kind === 'external']] as const) {
    const n = d[key];
    if (n === undefined) continue;
    if (kind !== null && !allowed) r.add('not_allowed', `done.${key}`);
    else if (!isInt(n)) r.add('not_integer', `done.${key}`);
    else if (n < 1 || n > max) r.add('not_in_range', `done.${key}`);
  }
  if (d.retries !== undefined) {
    if (!isInt(d.retries)) r.add('not_integer', 'done.retries');
    else if (d.retries < 0 || d.retries > MAX_RETRIES) r.add('not_in_range', 'done.retries');
  }
}

function output(r: Report, value: unknown): void {
  const o = fields(r, value, 'output', ['format', 'sections', 'fields', 'max_items', 'max_bytes', 'to'], ['format']);
  if (o === null) return;
  choice(r, o.format, 'output.format', OUTPUT_FORMATS);
  (list(r, o.sections, 'output.sections') ?? []).forEach((s, i) => text(r, s, `output.sections[${i}]`));
  // The fields of one item of the result and the values that each can take. The words of a
  // format (a severity, a confidence) live here, in a pack, not in the core.
  if (o.fields !== undefined) {
    if (!isObj(o.fields)) r.add('not_object', 'output.fields');
    else {
      for (const [name, values] of Object.entries(o.fields)) {
        const at = `output.fields.${name}`;
        if (ITEM_CORE_FIELDS.includes(name)) r.add('not_allowed', at);
        else if (!IDENT.test(name)) r.add('bad_name', at);
        const items = list(r, values, at);
        if (items === null) continue;
        if (items.length === 0) r.add('empty', at);
        const seen = new Set<unknown>();
        items.forEach((v, i) => {
          if (typeof v !== 'string') r.add('not_string', `${at}[${i}]`);
          else if (!oneLine(v)) r.add('not_one_line', `${at}[${i}]`);
          else if (seen.has(v)) r.add('duplicate', `${at}[${i}]`);
          seen.add(v);
        });
      }
    }
  }
  positive(r, o.max_items, 'output.max_items');
  positive(r, o.max_bytes, 'output.max_bytes');
  if (o.max_items === undefined && o.max_bytes === undefined) r.add('missing_limit', 'output');
  choice(r, o.to, 'output.to', OUTPUT_RECEIVERS);
}

function memory(r: Report, value: unknown, pack: PackContext): void {
  if (value === undefined) return;
  const m = fields(r, value, 'memory', ['write', 'class'], ['write']);
  if (m === null) return;
  const types = list(r, m.write, 'memory.write') ?? [];
  types.forEach((t, i) => inPack(r, pack.memoryTypes, choice(r, t, `memory.write[${i}]`, RECORD_TYPES), `memory.write[${i}]`));
  if (types.length > 0 && m.class === undefined) r.add('missing', 'memory.class');
  choice(r, m.class, 'memory.class', MEMORY_CLASSES);
}

// Without a pack only the structure is checked: that is for an editor or a draft, and such
// a manifest is not connected. Connecting a manifest always passes the merged pack.
const STRUCTURE_ONLY: PackContext = Object.freeze({});

// Returns every fault, not only the first. An empty list means the manifest is valid
// against the given pack.
export function validateManifest(value: unknown, pack: PackContext = STRUCTURE_ONLY): ManifestError[] {
  const r = new Report();
  const m = fields(r, value, '', TOP, TOP_REQUIRED);
  if (m === null) return r.errors;

  if (m.manifest !== undefined && m.manifest !== MANIFEST_VERSION) r.add('version_unsupported', 'manifest');
  positive(r, m.version, 'version');
  named(r, m.name, 'name', NAME);
  text(r, m.title, 'title');
  choice(r, m.package, 'package', PACKAGES);
  choice(r, m.state, 'state', STATES);
  text(r, m.description, 'description');

  const inputs = m.trigger === undefined ? new Set<string>() : trigger(r, m.trigger);
  const flags = collect(r, m.collect, pack);
  if (m.run_if !== undefined) {
    const flag = named(r, m.run_if, 'run_if', IDENT);
    if (flags === null) r.add('run_if_without_collect', 'run_if');
    else if (flag !== null && !flags.has(flag)) r.add('unknown_flag', 'run_if');
  }
  if (m.model !== undefined) model(r, m.model, pack);
  if (m.permissions !== undefined) permissions(r, m.permissions, pack, inputs);
  if (m.done !== undefined) done(r, m.done, pack, isObj(m.collect) && Array.isArray(m.collect.outputs) ? m.collect.outputs : [], isObj(m.output) && isObj(m.output.fields) ? m.output.fields : {});
  if (m.output !== undefined) output(r, m.output);
  memory(r, m.memory, pack);
  return r.errors;
}

// The typed manifest for connection, or null when the value has faults. The pack is required.
export function asManifest(value: unknown, pack: PackContext): Manifest | null {
  return validateManifest(value, pack).length === 0 ? (value as Manifest) : null;
}
