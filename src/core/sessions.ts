// What the harness keeps about a session of a client: its free task, its current scenario task,
// the state of the work tree at the last request. And which session last spoke in a directory:
// a command of the client has no session of its own, so the directory names it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from './runtime.ts';

// `executors`: the subordinate executors of the session that run now, each with its role, the task
// that it belongs to and the time of its start.
// `compacted`: the last time the client compacted the context of the session.
// `costMarks`: how far the cost is counted in each file of the client, by the path of the file.
// `since`: the time when the harness saw the session first.
// claims: the client said at the start that it tells the harness before an action (the name of the client).
// before: such a word came in this session. unguarded: an action ended and no such word had come.
// told: the human heard about it at a stop.
// returns: how many times a stop of a client without a window got the task back.
export type SessionFile = { returns?: { task: string; n: number }; claims?: string; noChoice?: boolean; before?: boolean; unguarded?: boolean; told?: boolean; since?: string; costMarks?: Record<string, number>; compacted?: string; task?: string; scenario?: string; work?: string | null; head?: string | null; top?: string; at?: number; opened?: string[]; returned?: boolean; returnedFor?: string; reviews?: { task: string; scenario: string; open: number; top: string; work: string }[]; requests?: number; fails?: Record<string, number>; executors?: { role: string; task: string; at: number }[]; judged?: string[] };

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
export const sessionName = (session: string | undefined): string =>
  session !== undefined && SESSION.test(session) ? session : crypto.createHash('sha256').update(session ?? '').digest('hex').slice(0, 16);
export const sessionFile = (rt: Runtime, session: string | undefined): string => path.join(rt.stateDir, 'sessions', `${sessionName(session)}.json`);
// A directory is named as the file system has it: a path through a link and the real path are one directory.
const realDir = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};
const dirFile = (rt: Runtime, cwd: string): string => path.join(rt.stateDir, 'dirs', `${crypto.createHash('sha256').update(realDir(cwd)).digest('hex').slice(0, 24)}.json`);

// The roles of the subordinates whose report got the answer FAIL and that the main executor did
// not hear yet. The list is taken once: the next reader gets nothing.
export function takeJudged(rt: Runtime, session: string | undefined): string[] {
  // A client that names no session has a file too: the report of its subordinate is written there.
  if ((readSession(rt, session)?.judged ?? []).length === 0) return [];
  return withSession(rt, session, (file) => {
    const { judged, ...rest } = file;
    return { next: rest, result: judged ?? [] };
  });
}

export function readSession(rt: Runtime, session: string | undefined): SessionFile | null {
  try {
    const known: unknown = JSON.parse(fs.readFileSync(sessionFile(rt, session), 'utf8'));
    return known !== null && typeof known === 'object' ? (known as SessionFile) : null;
  } catch {
    return null;
  }
}

// Reads the session file, lets the caller change it, and writes it back, all under one lock:
// hooks and commands are separate processes that write one file, and one change must not drop
// the fields of another. `change` returns the new content, null to leave the file as it is, or
// 'remove' to delete the file.
// `known`: the caller acts only on a session that the harness holds a file of. A session that
// ended has no file, and a late answer must not bring it back: `change` is not called then.
export function withSession<T>(rt: Runtime, session: string | undefined, change: (now: SessionFile) => { next: SessionFile | null | 'remove'; result: T }): T;
export function withSession<T>(rt: Runtime, session: string | undefined, change: (now: SessionFile) => { next: SessionFile | null | 'remove'; result: T }, only: 'known'): T | undefined;
export function withSession<T>(rt: Runtime, session: string | undefined, change: (now: SessionFile) => { next: SessionFile | null | 'remove'; result: T }, only?: 'known'): T | undefined {
  const file = sessionFile(rt, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let owned = false;
  for (let attempt = 0; attempt < 300 && !owned; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      owned = true;
    } catch {
      try {
        // A lock that nobody released: its holder is gone.
        if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.rmSync(lock, { force: true });
      } catch {
        // the lock went away: try again
      }
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  // Three seconds without the lock: its holder is taken for dead and the lock is taken over.
  if (!owned) {
    fs.rmSync(lock, { force: true });
    fs.closeSync(fs.openSync(lock, 'w'));
  }
  try {
    // A session that the harness sees first gets the time of this look: what the session did
    // before it is not the business of the harness.
    const known = readSession(rt, session);
    if (known === null && only === 'known') return undefined;
    const first: SessionFile = { since: new Date().toISOString() };
    const { next, result } = change(known ?? first);
    if (next === 'remove') fs.rmSync(file, { force: true });
    // The time of the first look is kept also when the caller changes nothing: a later look must
    // not take its own time for the first one.
    const keep = next !== null ? next : known === null ? first : null;
    if (keep !== null && next !== 'remove') {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(keep));
      fs.renameSync(tmp, file);
    }
    return result;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// Changes some fields of the session file and keeps the others.
export function patchSession(rt: Runtime, session: string | undefined, change: SessionFile): void {
  withSession(rt, session, (now) => ({ next: { ...now, ...change }, result: undefined }));
}

// The scenario task that the session works on now. A new scenario in the session takes this place:
// the task before it stays open but is suspended until a resume.
export const currentScenario = (rt: Runtime, session: string | undefined): string | undefined => readSession(rt, session)?.scenario;

export function noteDirectory(rt: Runtime, cwd: string, session: string | undefined): void {
  if (session === undefined || !SESSION.test(session)) return;
  const file = dirFile(rt, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ session }));
}

// The session of a directory, or of the nearest directory above it: a command that runs in a
// subdirectory of the place where the session spoke belongs to that session.
export function sessionOfDirectory(rt: Runtime, cwd: string): string | undefined {
  let dir = realDir(cwd);
  for (;;) {
    try {
      const value = JSON.parse(fs.readFileSync(dirFile(rt, dir), 'utf8')) as { session?: unknown };
      if (typeof value.session === 'string' && SESSION.test(value.session)) return value.session;
    } catch {
      // nothing is noted for this directory
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// The session of a command of the command line. A client can give its commands the number of
// the session in a variable of the environment; `names` are the variables that the clients name.
// The number is the session of the command when it has the form of a session and the harness
// knows the session: two sessions in one directory then never take the task of each other.
// Without such a number the directory answers.
export function sessionOfCommand(rt: Runtime, cwd: string, names: readonly string[], env: Record<string, string | undefined> = process.env): string | undefined {
  return sessionNamed(rt, names, env) ?? sessionOfDirectory(rt, cwd);
}

// The session that the client of the command names itself, when the harness knows it. A session
// that only the directory gives is not this one: it is a guess about who runs the command.
export function sessionNamed(rt: Runtime, names: readonly string[], env: Record<string, string | undefined> = process.env): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && SESSION.test(value) && readSession(rt, value) !== null) return value;
  }
  return undefined;
}

export function forgetDirectory(rt: Runtime, cwd: string, session: string | undefined): void {
  try {
    const value = JSON.parse(fs.readFileSync(dirFile(rt, cwd), 'utf8')) as { session?: unknown };
    if (value.session === session) fs.rmSync(dirFile(rt, cwd), { force: true });
  } catch {
    // nothing to forget
  }
}
