// The memory of the harness: short records that outlive a task. The harness writes them without
// a command of the human. A record of a scenario with the class "veto" waits for a veto before it
// is used; a decision is written only on the word of the human (docs/port, R14).
// Specification: docs/spec/harness-memory.
//
// Three parts, as the specification names them:
// - The source of truth: one record is one file that a human can read, in a directory that the
//   instance names. The history of the files is the business of that directory (a repository).
// - The working state: use counters. It lives in the state directory. Without it the records
//   stay, but a record that only citations kept fresh goes stale earlier.
// - No index yet: the records are read from the files at every call.
// The text of a record lives in its file. The journal gets only the fact and the type.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_TYPES, type RecordType } from '../contracts/manifest.ts';
import { loadTask, type Runtime } from '../core/runtime.ts';

// pending: a draft in its veto window. active: used. stale: its place changed or nobody cited it
// for its term. replaced: a newer decision took its place. vetoed: removed by the human.
// closed: a case that ended.
export type RecordState = 'pending' | 'active' | 'stale' | 'replaced' | 'vetoed' | 'closed';
export type MemoryRecord = {
  id: string;
  type: RecordType;
  state: RecordState;
  project: string;
  by: 'agent' | 'human';
  created: string;
  text: string;
  paths: string[]; // the places that the record is about, relative paths
  anchor?: { path: string; fp: string; root: string }; // the first place with the fingerprint of its content
  task?: string;
  veto_until?: string; // a pending record becomes active at this time
  verified?: string; // the last time a human said that the record still holds
  because?: string; // the reason of a decision
  rejected?: string;
  revisit?: string;
  supersedes?: string;
  source?: string; // the id of the record in the store that it was imported from
  history: { at: string; state: RecordState }[];
  uses: number; // how many reports cited the record; from the working state
  last_use?: string; // the time of the last report that cited the record
  scope?: 'common'; // the record is for every project, not only for the project that wrote it
  wrong?: number; // how many times the human said "this was wrong"
  // A case: what is not finished.
  next?: string; // the next step
  status?: string; // the outer status, when there is one: the state of a card, of a merge request
  carried?: number; // the days the case was shown at a start of a session since its last step
  carried_day?: string; // the last day that was counted
  // A state: where the work of a project is now. It also has `next`: what to do next.
  unverified?: string; // what was said without a check
};

export type NewRecord = {
  type: string; text: string; paths: string[]; by: 'agent' | 'human'; task?: string;
  verified?: string; // for an imported record: the time of the import, so its term starts then
  root?: string; // the directory that the paths are relative to: gives the record its anchor
  because?: string; rejected?: string; revisit?: string; supersedes?: string; source?: string; created?: string;
  next?: string; status?: string; // of a case
  unverified?: string; // of a state; a state has `next` too
};
export type AddError = 'bad_type' | 'bad_text' | 'bad_path' | 'human_only' | 'not_allowed' | 'no_reason' | 'unknown_record';

const VETO_DAYS = 7;
const IDLE_DAYS = 180; // a record that no report cited for this long goes stale
const DAY = 24 * 60 * 60 * 1000;
const MAX_TEXT = 2000;
const MAX_PATHS = 20;
const ID = /^m[0-9a-f]{10}$/;
const STATES: readonly string[] = ['pending', 'active', 'stale', 'replaced', 'vetoed', 'closed'];
const MAX_STEP = 500; // characters of a next step and of an outer status of a case
const MAX_STATE_PART = 1000; // characters of the next steps and of the unverified things of a state
const PLAIN = ['id', 'type', 'state', 'project', 'by', 'created', 'task', 'veto_until', 'verified', 'supersedes', 'scope', 'wrong', 'carried', 'carried_day'] as const;
const ENCODED = ['paths', 'anchor', 'because', 'rejected', 'revisit', 'source', 'history', 'next', 'status', 'unverified'] as const;

export const memoryDir = (rt: Runtime): string => rt.memoryDir ?? path.join(rt.stateDir, 'memory');
const fileOf = (rt: Runtime, type: string, id: string): string => path.join(memoryDir(rt), type, `${id}.md`);
const usesFile = (rt: Runtime): string => path.join(rt.stateDir, 'memory-state', 'uses.json');

// Secrets do not go into the memory: known forms of tokens and of "name = value" pairs are cut.
export function scrub(text: string): string {
  return text
    .replace(/glpat-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, '$1[redacted]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)("?)[^\s"']{6,}\2/gi, '$1[redacted]');
}

function serialize(r: MemoryRecord): string {
  const lines = ['---'];
  const fields = r as unknown as Record<string, unknown>;
  for (const key of PLAIN) if (fields[key] !== undefined) lines.push(`${key}: ${String(fields[key])}`);
  for (const key of ENCODED) if (fields[key] !== undefined) lines.push(`${key}: ${JSON.stringify(fields[key])}`);
  lines.push('---', r.text, '');
  return lines.join('\n');
}

function parse(text: string): Omit<MemoryRecord, 'uses'> | null {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(': ');
    if (at < 1) return null;
    const key = line.slice(0, at);
    const value = line.slice(at + 2);
    if ((PLAIN as readonly string[]).includes(key)) fields[key] = value;
    else if ((ENCODED as readonly string[]).includes(key)) {
      try {
        fields[key] = JSON.parse(value);
      } catch {
        return null;
      }
    }
  }
  const { id, type, state, project, by, created } = fields;
  if (typeof id !== 'string' || !ID.test(id) || typeof type !== 'string' || !(RECORD_TYPES as readonly string[]).includes(type)) return null;
  if (typeof state !== 'string' || typeof project !== 'string' || typeof created !== 'string' || (by !== 'agent' && by !== 'human')) return null;
  if (fields.paths !== undefined && !Array.isArray(fields.paths)) return null;
  if (fields.scope !== undefined && fields.scope !== 'common') delete fields.scope;
  if (fields.wrong !== undefined) {
    const wrong = Number(fields.wrong);
    if (Number.isInteger(wrong) && wrong > 0) fields.wrong = wrong;
    else delete fields.wrong;
  }
  if (fields.carried !== undefined) {
    const carried = Number(fields.carried);
    if (Number.isInteger(carried) && carried >= 0) fields.carried = carried;
    else delete fields.carried;
  }
  for (const key of ['next', 'status', 'unverified'] as const) if (fields[key] !== undefined && typeof fields[key] !== 'string') delete fields[key];
  const body = lines.slice(end + 1).join('\n').replace(/\n+$/, '');
  return { ...(fields as object), paths: (fields.paths as string[] | undefined) ?? [], history: Array.isArray(fields.history) ? fields.history : [], text: body } as Omit<MemoryRecord, 'uses'>;
}

function write(rt: Runtime, record: Omit<MemoryRecord, 'uses'> & { uses?: number }): void {
  const { uses: _, ...stored } = record;
  const file = fileOf(rt, record.type, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serialize(stored as MemoryRecord));
  fs.renameSync(tmp, file);
  changed(rt, record.id);
}

// ---- The history of the records. The directory of the records can be a repository. When the
// config says so (`memory_commit`), the harness commits the files of the records itself: one commit
// for one run of a command or of a hook, at its end. A command and a hook are one process each:
// that is how the harness runs. All the files of the records are committed, also one that an
// earlier run left: `<type>/*.md`. A file that is still being written, and what else lies in the
// directory, are not.

const pending = new Map<string, { rt: Runtime; ids: Set<string> }>();

function changed(rt: Runtime, id: string): void {
  if (rt.memoryCommit !== true) return;
  const dir = memoryDir(rt);
  let entry = pending.get(dir);
  if (entry === undefined) {
    entry = { rt, ids: new Set() };
    pending.set(dir, entry);
    if (pending.size === 1) process.once('exit', commitMemory);
  }
  entry.ids.add(id);
}

// Commits what this process changed. A directory that is no repository, and a commit that fails,
// stop nothing: the records are on the disk in every case.
export function commitMemory(): void {
  for (const [dir, { rt, ids }] of pending) {
    pending.delete(dir);
    const git = (args: string[]): { ok: boolean; out: string } => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
      return { ok: r.status === 0, out: typeof r.stdout === 'string' ? r.stdout : '' };
    };
    if (!git(['rev-parse', '--is-inside-work-tree']).ok) continue;
    const files = RECORD_TYPES.filter((type) => fs.existsSync(path.join(dir, type))).map((type) => `:(glob)${type}/*.md`);
    if (files.length === 0 || git(['status', '--porcelain', '--', ...files]).out.trim() === '') continue;
    const names = [...ids].slice(0, 5).join(' ');
    // The commit of the records is the work of the harness, not a change of the human: the hooks
    // of the repository and the signing do not run, so a rule for the commits of people cannot stop it.
    const done = git(['add', '--', ...files]).ok
      && git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', `reins memory: ${names}${ids.size > 5 ? ` and ${ids.size - 5} more` : ''}`, '--', ...files]).ok;
    if (!done) rt.journal.write({ kind: 'harness.failure', project: rt.project, data: { where: 'memory_commit' } });
  }
}

function readUses(rt: Runtime): Record<string, { n: number; last: string }> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(usesFile(rt), 'utf8'));
    return value !== null && typeof value === 'object' ? (value as Record<string, { n: number; last: string }>) : {};
  } catch {
    return {};
  }
}

const fingerprint = (root: string, rel: string): string | null => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
};

// The records as the files hold them, oldest first, with no computed state.
function stored(rt: Runtime): Omit<MemoryRecord, 'uses'>[] {
  const out: Omit<MemoryRecord, 'uses'>[] = [];
  for (const type of RECORD_TYPES) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(memoryDir(rt), type));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || !ID.test(name.slice(0, -3))) continue;
      try {
        const record = parse(fs.readFileSync(path.join(memoryDir(rt), type, name), 'utf8'));
        if (record !== null && record.id === name.slice(0, -3) && STATES.includes(record.state)) out.push(record);
      } catch {
        // a file that cannot be read is no record
      }
    }
  }
  return out.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

// The files of the memory directory that are no records: a human edited one and broke its header.
// They are shown to the human, not skipped in silence.
export function brokenRecords(rt: Runtime): string[] {
  const out: string[] = [];
  for (const type of RECORD_TYPES) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(memoryDir(rt), type));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      let ok = false;
      try {
        const record = parse(fs.readFileSync(path.join(memoryDir(rt), type, name), 'utf8'));
        ok = record !== null && record.id === name.slice(0, -3) && STATES.includes(record.state);
      } catch {
        ok = false;
      }
      if (!ok) out.push(`${type}/${name}`);
    }
  }
  return out.sort();
}

// The state of a record at a time. A draft past its veto window is active. An active record is
// stale when its place changed or is gone, or when no report cited it for its term. A decision
// does not age: it holds until another decision replaces it.
function at(record: Omit<MemoryRecord, 'uses'>, now: number, uses: { n: number; last: string } | undefined): MemoryRecord {
  const out: MemoryRecord = { ...record, uses: uses?.n ?? 0, ...(uses !== undefined ? { last_use: uses.last } : {}) };
  if (out.state === 'pending' && out.veto_until !== undefined && Date.parse(out.veto_until) < now) out.state = 'active';
  if (out.state !== 'active') return out;
  if (out.anchor !== undefined && fingerprint(out.anchor.root, out.anchor.path) !== out.anchor.fp) out.state = 'stale';
  else if (out.type !== 'decision') {
    const fresh = Math.max(Date.parse(out.created), out.verified === undefined ? 0 : Date.parse(out.verified), uses === undefined ? 0 : Date.parse(uses.last));
    if (now - fresh > IDLE_DAYS * DAY) out.state = 'stale';
  }
  return out;
}

const badPath = (p: unknown): boolean => typeof p !== 'string' || p === '' || p.length > 300 || path.isAbsolute(p) || p.split('/').includes('..') || /[\r\n]/.test(p);

// What the manifest of an open scenario task lets the agent write: null when the task is not there,
// is over, or its manifest does not name the type.
function mayWrite(rt: Runtime, id: string | undefined, type: RecordType): { class?: string } | null {
  const task = id === undefined ? null : loadTask(rt, id);
  const memory = task?.manifest?.memory;
  if (task === null || task === undefined || task.state === 'closed' || task.state === 'skipped' || memory === undefined || !memory.write.includes(type)) return null;
  return memory;
}

export function addRecord(rt: Runtime, input: NewRecord, now: number = Date.now()): { ok: true; record: MemoryRecord } | { ok: false; error: AddError } {
  if (!(RECORD_TYPES as readonly string[]).includes(input.type)) return { ok: false, error: 'bad_type' };
  const type = input.type as RecordType;
  if (typeof input.text !== 'string' || input.text.trim() === '' || input.text.length > MAX_TEXT) return { ok: false, error: 'bad_text' };
  if (!Array.isArray(input.paths) || input.paths.length > MAX_PATHS || input.paths.some(badPath)) return { ok: false, error: 'bad_path' };
  let pending = false;
  if (input.by === 'agent') {
    // The agent writes nothing on its own word: a decision never, any other type only when the
    // manifest of its scenario task names the type.
    if (type === 'decision') return { ok: false, error: 'human_only' };
    const memory = mayWrite(rt, input.task, type);
    if (memory === null) return { ok: false, error: 'not_allowed' };
    // A state is written anew at every wrap-up and the next one takes its place: it has no veto
    // window (harness-memory, page 4: "a task is closed: a new state, by itself").
    pending = memory.class !== 'auto' && type !== 'state';
  }
  // A next step is a thing of a case and of a state; an outer status of a case; what is not
  // verified of a state. The step of a case is one line; the parts of a state are short lists.
  for (const key of ['next', 'status', 'unverified'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const fits = key === 'next' ? type === 'case' || type === 'state' : key === 'status' ? type === 'case' : type === 'state';
    if (!fits) return { ok: false, error: 'bad_type' };
    if (typeof value !== 'string') return { ok: false, error: 'bad_text' };
    if (type === 'case' ? value.length > MAX_STEP || /[\r\n]/.test(value) : value.length > MAX_STATE_PART) return { ok: false, error: 'bad_text' };
  }
  // A decision without its reason is of no use in a month (harness-memory, page 2, rule 1).
  if (type === 'decision' && (input.because === undefined || input.because.trim() === '')) return { ok: false, error: 'no_reason' };
  // Only a decision of the human replaces a record, and only another decision.
  if (input.supersedes !== undefined && input.by !== 'human') return { ok: false, error: 'human_only' };
  if (input.supersedes !== undefined && type !== 'decision') return { ok: false, error: 'bad_type' };
  const before = input.supersedes === undefined ? undefined : stored(rt).find((r) => r.id === input.supersedes && r.type === 'decision' && r.state !== 'vetoed');
  if (input.supersedes !== undefined && before === undefined) return { ok: false, error: 'unknown_record' };

  const created = input.created !== undefined && !Number.isNaN(Date.parse(input.created)) ? new Date(input.created).toISOString() : new Date(now).toISOString();
  const state: RecordState = pending ? 'pending' : 'active';
  const record: MemoryRecord = {
    id: `m${crypto.randomBytes(5).toString('hex')}`, type, state, project: rt.project, by: input.by, created,
    text: scrub(input.text), paths: [...input.paths], history: [{ at: new Date(now).toISOString(), state }], uses: 0,
  };
  if (input.task !== undefined) record.task = input.task;
  if (input.verified !== undefined) record.verified = input.verified;
  if (pending) record.veto_until = new Date(now + (rt.merged.vetoDays ?? VETO_DAYS) * DAY).toISOString();
  for (const key of ['because', 'rejected', 'revisit', 'source'] as const) {
    const value = input[key];
    if (value !== undefined && value.trim() !== '') record[key] = scrub(value).slice(0, MAX_TEXT);
  }
  for (const key of ['next', 'status', 'unverified'] as const) {
    const value = input[key];
    if (value !== undefined && value.trim() !== '') record[key] = scrub(value.trim());
  }
  const place = input.paths[0];
  if (input.root !== undefined && place !== undefined && path.isAbsolute(input.root)) {
    const fp = fingerprint(input.root, place);
    if (fp !== null) record.anchor = { path: place, fp, root: input.root };
  }
  if (before !== undefined) {
    record.supersedes = before.id;
    write(rt, { ...before, state: 'replaced', history: [...before.history, { at: new Date(now).toISOString(), state: 'replaced' }] });
  }
  // A project has one state: a new one that is in use takes the place of the states before it.
  if (type === 'state' && state === 'active') {
    for (const old of stored(rt)) {
      if (old.type !== 'state' || old.project !== rt.project || (old.state !== 'active' && old.state !== 'pending')) continue;
      write(rt, { ...old, state: 'replaced', history: [...old.history, { at: new Date(now).toISOString(), state: 'replaced' }] });
      rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: old.id, type: 'state', state: 'replaced' } });
    }
  }
  write(rt, record);
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, ...(record.task !== undefined ? { task: record.task } : {}), data: { record: record.id, type, state: record.state } });
  return { ok: true, record };
}

// All records, oldest first, with their state at this time.
export function listRecords(rt: Runtime, now: number = Date.now()): MemoryRecord[] {
  const uses = readUses(rt);
  return stored(rt).map((r) => at(r, now, uses[r.id]));
}

// The veto of the human: the record is never used. The file stays: a removal leaves its trace.
export function vetoRecord(rt: Runtime, id: string, now: number = Date.now()): boolean {
  const record = stored(rt).find((r) => r.id === id);
  // A replaced decision and a closed case are out of use already: a veto of one would only open the way to restore it.
  if (record === undefined || record.state === 'vetoed' || record.state === 'replaced' || record.state === 'closed') return false;
  write(rt, { ...record, state: 'vetoed', history: [...record.history, { at: new Date(now).toISOString(), state: 'vetoed' }] });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state: 'vetoed' } });
  return true;
}

// The term of a removed record. The file of a record that the human removed stays for the term
// that the packs name, then it goes away: after that the record cannot come back. Without a term
// the file stays for ever. The term counts from the removal, not from the time of the file.
// The packs of a project set the term of its records only: the records of another project keep
// the term of their packs.
export function pruneRecords(rt: Runtime, now: number = Date.now()): string[] {
  const keepDays = rt.merged.memoryKeepDays;
  if (keepDays === undefined) return [];
  const gone: string[] = [];
  for (const record of stored(rt)) {
    if (record.state !== 'vetoed' || record.project !== rt.project) continue;
    const last = record.history[record.history.length - 1];
    const removed = last?.state === 'vetoed' ? Date.parse(last.at) : NaN;
    // A removal with no time that can be read is not judged: the file stays.
    if (!Number.isFinite(removed) || now - removed <= keepDays * DAY) continue;
    const file = fileOf(rt, record.type, record.id);
    try {
      // The human can take the record back at this same time: the file is read again just before it goes.
      if (parse(fs.readFileSync(file, 'utf8'))?.state !== 'vetoed') continue;
      fs.rmSync(file);
    } catch {
      continue;
    }
    changed(rt, record.id);
    // The list of the kinds of the journal is closed: the end of a removed record is its last change.
    rt.journal.write({ kind: 'memory.record_changed', project: record.project, data: { record: record.id, type: record.type, state: 'vetoed', gone: 1 } });
    gone.push(record.id);
  }
  return gone;
}

// A record that is in use goes out of use: nobody cited it. The human can restore it.
// `idleDays`: the record must be without a citation for this long, as it was when the change was proposed.
export function retireRecord(rt: Runtime, id: string, now: number = Date.now(), idleDays = 0): boolean {
  const record = stored(rt).find((r) => r.id === id);
  const uses = readUses(rt)[id];
  if (record === undefined || record.type === 'decision' || at(record, now, uses).state !== 'active') return false;
  if (uses !== undefined && now - Date.parse(uses.last) < idleDays * DAY) return false;
  write(rt, { ...record, state: 'stale', history: [...record.history, { at: new Date(now).toISOString(), state: 'stale' }] });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state: 'stale' } });
  return true;
}

// The human says that a record holds: a vetoed or stale record is active again. Its place gets
// the fingerprint that it has now, and the term of the record starts again.
export function restoreRecord(rt: Runtime, id: string, now: number = Date.now()): boolean {
  const record = stored(rt).find((r) => r.id === id);
  if (record === undefined) return false;
  // Only a record that is out of use comes back: a draft keeps its veto window, a replaced
  // decision stays replaced.
  const state = at(record, now, readUses(rt)[id]).state;
  if (state !== 'vetoed' && state !== 'stale') return false;
  const next = { ...record, state: 'active' as RecordState, verified: new Date(now).toISOString() };
  delete next.veto_until;
  // The human says that the record holds: the marks "this was wrong" are gone.
  delete next.wrong;
  if (next.anchor !== undefined) {
    const fp = fingerprint(next.anchor.root, next.anchor.path);
    // The place is gone and the human says that the record holds: it is no longer tied to the place.
    if (fp === null) delete next.anchor;
    else next.anchor = { ...next.anchor, fp };
  }
  if (record.state !== 'active') next.history = [...record.history, { at: new Date(now).toISOString(), state: 'active' }];
  write(rt, next);
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state: 'active' } });
  return true;
}

const about = (r: MemoryRecord, paths: string[]): boolean =>
  r.paths.length === 0 || r.paths.some((p) => paths.some((q) => q === p || q.endsWith(`/${p}`) || q.startsWith(`${p}/`) || q.includes(`/${p}/`)));

// The active records of a project about these places. A record is about a place when the place
// ends with a path of the record or lies under it. A record without paths is about the whole project.
// `all`: every record of the project, whatever its place. A record that the human shared is a
// record of every project.
// `silent`: the caller writes the read to the journal itself, with the count that the agent got.
export function findRecords(rt: Runtime, query: { paths: string[]; project?: string; all?: boolean; silent?: boolean }, now: number = Date.now()): MemoryRecord[] {
  const project = query.project ?? rt.project;
  const found = listRecords(rt, now).filter((r) => r.state === 'active' && (r.project === project || r.scope === 'common') && (query.all === true || about(r, query.paths)));
  // A read that found nothing is no event: only a read that gave records is written down.
  if (found.length > 0 && query.silent !== true) rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: found.length } });
  return found;
}

// The order of the records for the agent: a record that the human marked as wrong goes after the
// others, then the most cited first, then the newest.
const byWeight = (a: MemoryRecord, b: MemoryRecord): number =>
  (a.wrong ?? 0) - (b.wrong ?? 0) || b.uses - a.uses || b.created.localeCompare(a.created) || a.id.localeCompare(b.id);

// The records of the project for the start of a session: one line for a record, within a size
// limit. `more`: how many records did not fit.
export function recordsForStart(rt: Runtime, maxBytes: number, now: number = Date.now()): { lines: string[]; more: number } {
  // The cases and the state have their own places in the start of a session: see `casesForStart` and `stateForStart`.
  const found = findRecords(rt, { paths: [], all: true, silent: true }, now).filter((r) => r.type !== 'case' && r.type !== 'state').sort(byWeight);
  const lines: string[] = [];
  let size = 0;
  for (const r of found) {
    const where = [r.type, ...(r.paths[0] !== undefined ? [r.paths[0]] : []), ...(r.scope === 'common' ? ['common'] : [])].join(', ');
    const line = `- ${r.id} (${where}): ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`;
    if (size + Buffer.byteLength(line) + 1 > maxBytes) break;
    size += Buffer.byteLength(line) + 1;
    lines.push(line);
  }
  // The journal counts the records that the agent got, not those that did not fit.
  if (lines.length > 0) rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: lines.length } });
  return { lines, more: found.length - lines.length };
}

// The records that hold every one of these words, in every project. A word is matched as it is
// written, without the case of its letters, in the text of a record, its reason, what was rejected,
// its places and its source. Only records in use are found: no draft, no stale or removed record.
export function searchRecords(rt: Runtime, words: string[], limit = 20, now: number = Date.now()): { records: MemoryRecord[]; more: number } {
  const wanted = words.map((w) => w.trim().toLowerCase()).filter((w) => w !== '');
  if (wanted.length === 0) return { records: [], more: 0 };
  const found = listRecords(rt, now).filter((r) => {
    // A draft in its veto window is not given: the human has not let it pass yet.
    if (r.state !== 'active') return false;
    const hay = [r.text, r.because ?? '', r.rejected ?? '', r.revisit ?? '', r.source ?? '', ...r.paths].join('\n').toLowerCase();
    return wanted.every((w) => hay.includes(w));
  }).sort(byWeight);
  const records = found.slice(0, limit);
  // The journal counts the records that the agent got: the share of used records rests on it.
  if (records.length > 0) rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: records.length } });
  return { records, more: Math.max(0, found.length - limit) };
}

// ---- A case: what is not finished. It lives until it is closed; each step replaces the next step.

// `other_project`: the case is there, but it is a case of another project.
export type CaseError = 'not_allowed' | 'unknown_record' | 'other_project' | 'bad_type' | 'bad_text';
type Who = { by: 'agent' | 'human'; task?: string };

// The case that a change is about. The agent changes a case only in a task whose manifest lets
// it write cases; the human needs no task. Only a case in use takes a change.
function caseFor(rt: Runtime, id: string, who: Who, now: number): { ok: true; record: Omit<MemoryRecord, 'uses'> } | { ok: false; error: CaseError } {
  if (who.by === 'agent' && mayWrite(rt, who.task, 'case') === null) return { ok: false, error: 'not_allowed' };
  const record = stored(rt).find((r) => r.id === id);
  // A case of another project is not a case of this one: the memory directory is one for all projects.
  if (record === undefined) return { ok: false, error: 'unknown_record' };
  if (record.project !== rt.project && record.scope !== 'common') return { ok: false, error: 'other_project' };
  if (record.type !== 'case') return { ok: false, error: 'bad_type' };
  // A case in use, or a draft in its veto window: the agent that opened a case can go on with it.
  const state = at(record, now, readUses(rt)[id]).state;
  if (state !== 'active' && state !== 'pending') return { ok: false, error: 'unknown_record' };
  return { ok: true, record };
}

// A step of a case: its next step is another one now, and the count of carried days starts again.
export function stepCase(rt: Runtime, id: string, change: Who & { next: string; status?: string }, now: number = Date.now()): { ok: true; record: MemoryRecord } | { ok: false; error: CaseError } {
  const found = caseFor(rt, id, change, now);
  if (!found.ok) return found;
  const next = change.next.trim();
  const status = change.status?.trim();
  if (next === '' || next.length > MAX_STEP || /[\r\n]/.test(next) || (status !== undefined && (status.length > MAX_STEP || /[\r\n]/.test(status)))) return { ok: false, error: 'bad_text' };
  const { carried_day: _, ...rest } = found.record;
  // The step is a proof that the case is alive: its term starts again.
  const record = { ...rest, next: scrub(next), carried: 0, verified: new Date(now).toISOString(), ...(status !== undefined && status !== '' ? { status: scrub(status) } : {}) };
  write(rt, record);
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, ...(change.task !== undefined ? { task: change.task } : {}), data: { record: id, type: 'case', state: 'active', step: 1 } });
  return { ok: true, record: at(record, now, readUses(rt)[id]) };
}

// The end of a case: it is out of use. The file stays: an end leaves its trace.
export function closeCase(rt: Runtime, id: string, who: Who, now: number = Date.now()): { ok: true } | { ok: false; error: CaseError } {
  const found = caseFor(rt, id, who, now);
  if (!found.ok) return found;
  write(rt, { ...found.record, state: 'closed', history: [...found.record.history, { at: new Date(now).toISOString(), state: 'closed' }] });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, ...(who.task !== undefined ? { task: who.task } : {}), data: { record: id, type: 'case', state: 'closed' } });
  return { ok: true };
}

// The open cases of the project for the start of a session: one line for a case, with its next
// step, within a size limit. A case that is shown is carried one more day: once for a day,
// however many sessions start. The case that was carried most comes first.
export function casesForStart(rt: Runtime, maxBytes: number, now: number = Date.now()): { lines: string[]; more: number } {
  const day = new Date(now).toISOString().slice(0, 10);
  // The count of a case as it is after this start: a case that was not counted today gets a day.
  const cases = findRecords(rt, { paths: [], all: true, silent: true }, now).filter((r) => r.type === 'case')
    .map((r) => ({ r, carried: r.carried_day === day ? r.carried ?? 0 : (r.carried ?? 0) + 1 }))
    .sort((a, b) => b.carried - a.carried || b.r.created.localeCompare(a.r.created) || a.r.id.localeCompare(b.r.id));
  const lines: string[] = [];
  const shown: { id: string; carried: number }[] = [];
  let size = 0;
  const one = (text: string, max: number): string => text.replace(/\s+/g, ' ').slice(0, max);
  for (const { r, carried } of cases) {
    const line = `- ${r.id} ${carried > 1 ? `(carried ${carried}) ` : ''}${one(r.text, 160)}${r.next !== undefined ? ` → next: ${one(r.next, 160)}` : ''}${r.status !== undefined ? ` [${one(r.status, 60)}]` : ''}`;
    if (size + Buffer.byteLength(line) + 1 > maxBytes) break;
    size += Buffer.byteLength(line) + 1;
    lines.push(line);
    if (r.carried_day !== day) shown.push({ id: r.id, carried });
  }
  // Only a case that got a line was shown: a case that did not fit is not carried by this start.
  if (shown.length > 0) {
    const kept = stored(rt);
    for (const { id, carried } of shown) {
      const file = kept.find((x) => x.id === id);
      if (file !== undefined) write(rt, { ...file, carried, carried_day: day });
    }
  }
  if (lines.length > 0) rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: lines.length } });
  return { lines, more: cases.length - lines.length };
}

// ---- A state: where the work of a project is now, what to do next, what is not verified. One
// for a project; each new one takes the place of the one before it.

// The state of the project for the start of a session, whole: the newest state in use. A state
// that is too long for the size limit is cut, and the cut is said.
export function stateForStart(rt: Runtime, maxBytes: number, now: number = Date.now()): string[] {
  const state = listRecords(rt, now).filter((r) => r.type === 'state' && r.state === 'active' && r.project === rt.project)
    .sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id))[0];
  if (state === undefined) return [];
  const head = `State of this project (${state.id}, written ${state.created.slice(0, 10)}):`;
  const body = [state.text, ...(state.next !== undefined ? ['Next:', state.next] : []), ...(state.unverified !== undefined ? ['Not verified:', state.unverified] : [])].join('\n');
  rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: 1 } });
  if (Buffer.byteLength(head) + 1 + Buffer.byteLength(body) <= maxBytes) return [head, ...body.split('\n')];
  // The mark of the cut is a part of the size. Whole characters only: the cut is counted in bytes.
  const mark = `… cut: \`reins memory show ${state.id}\` gives the rest.`;
  const room = Math.max(0, maxBytes - Buffer.byteLength(head) - 1 - Buffer.byteLength(mark) - 1);
  let cut = body.slice(0, room);
  while (cut.length > 0 && Buffer.byteLength(cut) > room) cut = cut.slice(0, -1);
  return [head, ...(cut === '' ? [] : cut.split('\n')), mark];
}

// The human shares a record: it is a record of every project from now on.
export function shareRecord(rt: Runtime, id: string, _now: number = Date.now()): boolean {
  const record = stored(rt).find((r) => r.id === id);
  if (record === undefined || record.scope === 'common' || record.state === 'vetoed' || record.state === 'replaced') return false;
  // The term of the record does not start again: a record that nobody cited stays as old as it is.
  write(rt, { ...record, scope: 'common' });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state: record.state, scope: 'common' } });
  return true;
}

const WRONG_LIMIT = 2; // a record that was wrong this many times is out of use

// The human says "this was wrong" about a record. The record loses its place among the others;
// at the second mark it is out of use. A decision takes no mark: another decision replaces it.
export function wrongRecord(rt: Runtime, id: string, now: number = Date.now()): boolean {
  const record = stored(rt).find((r) => r.id === id);
  if (record === undefined || record.type === 'decision' || at(record, now, readUses(rt)[id]).state !== 'active') return false;
  const wrong = (record.wrong ?? 0) + 1;
  const state: RecordState = wrong >= WRONG_LIMIT ? 'stale' : 'active';
  write(rt, { ...record, wrong, state, ...(state === 'stale' ? { history: [...record.history, { at: new Date(now).toISOString(), state }] } : {}) });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state, wrong } });
  return true;
}

// The records that go into the input of a task: with their ids, the most cited first, then the
// newest, and only as many as fit the size limit.
export function recordsForInput(rt: Runtime, query: { paths: string[]; maxBytes: number }, now: number = Date.now()): { id: string; type: RecordType; text: string }[] {
  const found = findRecords(rt, { paths: query.paths }, now).sort(byWeight);
  const out: { id: string; type: RecordType; text: string }[] = [];
  let size = 0;
  for (const r of found) {
    const bytes = Buffer.byteLength(r.text);
    if (size + bytes > query.maxBytes) continue;
    size += bytes;
    out.push({ id: r.id, type: r.type, text: r.text });
  }
  return out;
}

// A record is used when a report cites it by its id (harness-memory, page 5). One report counts
// once for one record. Returns the ids that were counted.
export function countUses(rt: Runtime, report: string, now: number = Date.now()): string[] {
  const cited = [...new Set(report.match(/\bm[0-9a-f]{10}\b/g) ?? [])];
  if (cited.length === 0) return [];
  const known = new Set(stored(rt).filter((r) => r.state !== 'vetoed').map((r) => r.id));
  const ids = cited.filter((id) => known.has(id));
  if (ids.length === 0) return [];
  // The counts are one file for all the reports: the read, the change and the write run under
  // one lock, so two reports at one time lose no count. Without the lock nothing is counted: a
  // count that is not written is better than a count that removes another one.
  fs.mkdirSync(path.dirname(usesFile(rt)), { recursive: true });
  const counted = locked(`${usesFile(rt)}.lock`, () => {
    const uses = readUses(rt);
    for (const id of ids) uses[id] = { n: (uses[id]?.n ?? 0) + 1, last: new Date(now).toISOString() };
    const tmp = `${usesFile(rt)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(uses));
    fs.renameSync(tmp, usesFile(rt));
  });
  if (!counted) return [];
  for (const id of ids) rt.journal.write({ kind: 'memory.record_used', project: rt.project, data: { record: id } });
  return ids;
}

// Runs `work` while this process holds the lock file; false when the lock did not come in three
// seconds. The lock holds a mark of its owner: a process removes only its own lock. A lock that
// is older than two seconds has a dead holder (the work under it takes milliseconds) and is removed.
function locked(lock: string, work: () => void): boolean {
  const mark = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let owned = false;
  for (let attempt = 0; attempt < 300 && !owned; attempt += 1) {
    try {
      fs.writeFileSync(lock, mark, { flag: 'wx' });
      owned = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.rmSync(lock, { force: true });
      } catch {
        // the lock went away: try again
      }
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (!owned) return false;
  try {
    work();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8') === mark) fs.rmSync(lock, { force: true });
    } catch {
      // the lock is gone already
    }
  }
  return true;
}

// Records of another store, one JSON object on a line: type, text, and optionally paths, because,
// rejected, revisit, created, source. They are records of the human. A line whose type and text
// are already in the memory adds nothing.
export function importRecords(rt: Runtime, file: string, now: number = Date.now()): { added: number; skipped: { line: number; error: string }[] } {
  const have = new Set(stored(rt).map((r) => `${r.type}\n${r.text}`));
  const skipped: { line: number; error: string }[] = [];
  let added = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      value = parsed as Record<string, unknown>;
    } catch {
      skipped.push({ line: i + 1, error: 'bad_json' });
      return;
    }
    const text = typeof value.text === 'string' ? scrub(value.text) : '';
    if (have.has(`${String(value.type)}\n${text}`)) return;
    const input: NewRecord = { type: String(value.type), text: typeof value.text === 'string' ? value.text : '', paths: Array.isArray(value.paths) ? (value.paths as string[]) : [], by: 'human' };
    for (const key of ['because', 'rejected', 'revisit', 'created', 'source', 'root', 'next', 'status', 'unverified'] as const) if (typeof value[key] === 'string') input[key] = value[key];
    // The record is old in its own store and new here: its term starts at the import.
    input.verified = new Date(now).toISOString();
    const r = addRecord(rt, input, now);
    if (!r.ok) skipped.push({ line: i + 1, error: r.error });
    else {
      added += 1;
      have.add(`${r.record.type}\n${r.record.text}`);
    }
  });
  return { added, skipped };
}
