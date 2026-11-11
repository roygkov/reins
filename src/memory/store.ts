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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_TYPES, type RecordType } from '../contracts/manifest.ts';
import { loadTask, type Runtime } from '../core/runtime.ts';

// pending: a draft in its veto window. active: used. stale: its place changed or nobody cited it
// for its term. replaced: a newer decision took its place. vetoed: removed by the human.
export type RecordState = 'pending' | 'active' | 'stale' | 'replaced' | 'vetoed';
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
};

export type NewRecord = {
  type: string; text: string; paths: string[]; by: 'agent' | 'human'; task?: string;
  verified?: string; // for an imported record: the time of the import, so its term starts then
  root?: string; // the directory that the paths are relative to: gives the record its anchor
  because?: string; rejected?: string; revisit?: string; supersedes?: string; source?: string; created?: string;
};
export type AddError = 'bad_type' | 'bad_text' | 'bad_path' | 'human_only' | 'not_allowed' | 'no_reason' | 'unknown_record';

const VETO_DAYS = 7;
const IDLE_DAYS = 180; // a record that no report cited for this long goes stale
const DAY = 24 * 60 * 60 * 1000;
const MAX_TEXT = 2000;
const MAX_PATHS = 20;
const ID = /^m[0-9a-f]{10}$/;
const STATES: readonly string[] = ['pending', 'active', 'stale', 'replaced', 'vetoed'];
const PLAIN = ['id', 'type', 'state', 'project', 'by', 'created', 'task', 'veto_until', 'verified', 'supersedes'] as const;
const ENCODED = ['paths', 'anchor', 'because', 'rejected', 'revisit', 'source', 'history'] as const;

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
  const out: MemoryRecord = { ...record, uses: uses?.n ?? 0 };
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
    const task = input.task === undefined ? null : loadTask(rt, input.task);
    const memory = task?.manifest?.memory;
    if (task === null || task.state === 'closed' || task.state === 'skipped' || memory === undefined || !memory.write.includes(type)) return { ok: false, error: 'not_allowed' };
    pending = memory.class !== 'auto';
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
  const place = input.paths[0];
  if (input.root !== undefined && place !== undefined && path.isAbsolute(input.root)) {
    const fp = fingerprint(input.root, place);
    if (fp !== null) record.anchor = { path: place, fp, root: input.root };
  }
  if (before !== undefined) {
    record.supersedes = before.id;
    write(rt, { ...before, state: 'replaced', history: [...before.history, { at: new Date(now).toISOString(), state: 'replaced' }] });
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
  // A replaced decision is out of use already: a veto of it would only open the way to restore it.
  if (record === undefined || record.state === 'vetoed' || record.state === 'replaced') return false;
  write(rt, { ...record, state: 'vetoed', history: [...record.history, { at: new Date(now).toISOString(), state: 'vetoed' }] });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state: 'vetoed' } });
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
export function findRecords(rt: Runtime, query: { paths: string[]; project?: string }, now: number = Date.now()): MemoryRecord[] {
  const project = query.project ?? rt.project;
  const found = listRecords(rt, now).filter((r) => r.state === 'active' && r.project === project && about(r, query.paths));
  // A read that found nothing is no event: only a read that gave records is written down.
  if (found.length > 0) rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: found.length } });
  return found;
}

// The records that go into the input of a task: with their ids, the most cited first, then the
// newest, and only as many as fit the size limit.
export function recordsForInput(rt: Runtime, query: { paths: string[]; maxBytes: number }, now: number = Date.now()): { id: string; type: RecordType; text: string }[] {
  const found = findRecords(rt, { paths: query.paths }, now).sort((a, b) => b.uses - a.uses || b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
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
  const uses = readUses(rt);
  for (const id of ids) {
    uses[id] = { n: (uses[id]?.n ?? 0) + 1, last: new Date(now).toISOString() };
    rt.journal.write({ kind: 'memory.record_used', project: rt.project, data: { record: id } });
  }
  fs.mkdirSync(path.dirname(usesFile(rt)), { recursive: true });
  const tmp = `${usesFile(rt)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(uses));
  fs.renameSync(tmp, usesFile(rt));
  return ids;
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
    for (const key of ['because', 'rejected', 'revisit', 'created', 'source', 'root'] as const) if (typeof value[key] === 'string') input[key] = value[key];
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
