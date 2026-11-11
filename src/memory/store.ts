// The memory of the harness: short records that outlive a task. The harness writes them without
// a command of the human. A record of a scenario with the class "veto" waits for a veto before it
// is used; a decision is written only on the word of the human (docs/port, R14).
// Specification: docs/spec/harness-memory.
//
// The text of a record lives here, in the store. The journal gets only the fact and the type.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_TYPES, type RecordType } from '../contracts/manifest.ts';
import { isObj } from '../contracts/shape.ts';
import { loadTask, type Runtime } from '../core/runtime.ts';

export type RecordState = 'pending' | 'active' | 'vetoed';
export type MemoryRecord = {
  id: string;
  type: RecordType;
  text: string;
  paths: string[]; // the places that the record is about, relative paths
  project: string;
  task?: string;
  by: 'agent' | 'human';
  created: string;
  state: RecordState;
  veto_until?: string; // a pending record becomes active at this time
};

export type NewRecord = { type: string; text: string; paths: string[]; task?: string; by: 'agent' | 'human' };
export type AddError = 'bad_type' | 'bad_text' | 'bad_path' | 'human_only' | 'not_allowed';

const VETO_DAYS = 7;
const MAX_TEXT = 2000;
const MAX_PATHS = 20;
const ID = /^m[0-9a-f]{10}$/;
const dirOf = (rt: Runtime): string => path.join(rt.stateDir, 'memory');
const fileOf = (rt: Runtime, id: string): string => path.join(dirOf(rt), `${id}.json`);

function read(rt: Runtime, id: string): MemoryRecord | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(fileOf(rt, id), 'utf8'));
    if (!isObj(value) || value.id !== id || typeof value.text !== 'string' || !Array.isArray(value.paths)) return null;
    return value as MemoryRecord;
  } catch {
    return null;
  }
}

function write(rt: Runtime, record: MemoryRecord): void {
  fs.mkdirSync(dirOf(rt), { recursive: true });
  const tmp = `${fileOf(rt, record.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, fileOf(rt, record.id));
}

// The state of a record at a time: a pending record past its veto window is active.
function at(record: MemoryRecord, now: number): MemoryRecord {
  if (record.state === 'pending' && record.veto_until !== undefined && Date.parse(record.veto_until) < now) return { ...record, state: 'active' };
  return record;
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
  const record: MemoryRecord = {
    id: `m${crypto.randomBytes(5).toString('hex')}`, type, text: input.text, paths: [...input.paths], project: rt.project,
    by: input.by, created: new Date(now).toISOString(), state: pending ? 'pending' : 'active',
  };
  if (input.task !== undefined) record.task = input.task;
  if (pending) record.veto_until = new Date(now + VETO_DAYS * 24 * 60 * 60 * 1000).toISOString();
  write(rt, record);
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, ...(record.task !== undefined ? { task: record.task } : {}), data: { record: record.id, type, state: record.state } });
  return { ok: true, record };
}

// All records, oldest first, with their state at this time.
export function listRecords(rt: Runtime, now: number = Date.now()): MemoryRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dirOf(rt));
  } catch {
    return [];
  }
  const out: MemoryRecord[] = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    const record = ID.test(id) ? read(rt, id) : null;
    if (record !== null) out.push(at(record, now));
  }
  return out.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

// The veto of the human: the record is never used.
export function vetoRecord(rt: Runtime, id: string): boolean {
  const record = ID.test(id) ? read(rt, id) : null;
  if (record === null || record.state === 'vetoed') return false;
  write(rt, { ...record, state: 'vetoed' });
  rt.journal.write({ kind: 'memory.record_changed', project: rt.project, data: { record: id, type: record.type, state: 'vetoed' } });
  return true;
}

// The active records of a project about these places. A record is about a place when the place
// ends with a path of the record or lies under it. A record without paths is about the whole project.
export function findRecords(rt: Runtime, query: { paths: string[]; project?: string }, now: number = Date.now()): MemoryRecord[] {
  const project = query.project ?? rt.project;
  const about = (r: MemoryRecord): boolean => r.paths.length === 0 || r.paths.some((p) => query.paths.some((q) => q === p || q.endsWith(`/${p}`) || q.startsWith(`${p}/`) || q.includes(`/${p}/`)));
  const found = listRecords(rt, now).filter((r) => r.state === 'active' && r.project === project && about(r));
  rt.journal.write({ kind: 'memory.read', project: rt.project, data: { n: found.length } });
  return found;
}
