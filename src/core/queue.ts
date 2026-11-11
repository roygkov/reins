// The queue of deferred actions. A rule of a pack can say "not now": the action is not done, it
// waits for the human. The human approves it or rejects it; an approval lets the same call pass once.
// Specification: docs/spec/harness-core, page 3.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from './runtime.ts';

// `key`: the session, the tool and the input of the call. `what`: the action in the words of the
// policy, for the human who decides.
export type Queued = {
  id: string;
  key: string;
  state: 'waiting' | 'approved' | 'rejected' | 'used';
  at: string;
  tool: string;
  rule: string;
  what: string;
  task: string;
  project: string;
  session?: string;
};

const ID = /^q[0-9a-f]{10}$/;
const DAY = 24 * 60 * 60 * 1000;
const APPROVAL_MS = DAY; // an approval that nobody used for this long is gone
const WAIT_MS = 7 * DAY; // an action that nobody answered for this long waits no more
const KEEP_MS = 7 * DAY; // an entry that ended stays this long for the human who looks back
const MAX_WHAT = 4000; // the text of the action for the human: the whole command, within reason
const dirOf = (rt: Runtime): string => path.join(rt.stateDir, 'queue');
const fileOf = (rt: Runtime, id: string): string => path.join(dirOf(rt), `${id}.json`);

export const queueKey = (session: string | undefined, tool: string, input: unknown): string =>
  crypto.createHash('sha256').update(`${session ?? ''}\n${tool}\n${JSON.stringify(input)}`).digest('hex').slice(0, 32);

function read(rt: Runtime, id: string): Queued | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(fileOf(rt, id), 'utf8'));
    return value !== null && typeof value === 'object' && (value as Queued).id === id ? (value as Queued) : null;
  } catch {
    return null;
  }
}

function write(rt: Runtime, q: Queued): void {
  fs.mkdirSync(dirOf(rt), { recursive: true });
  const tmp = `${fileOf(rt, q.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(q));
  fs.renameSync(tmp, fileOf(rt, q.id));
}

// The actions that wait and the approvals that nobody used yet, oldest first.
export function listQueue(rt: Runtime, now: number = Date.now()): Queued[] {
  let names: string[];
  try {
    names = fs.readdirSync(dirOf(rt));
  } catch {
    return [];
  }
  const out: Queued[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    const q = ID.test(id) && name.endsWith('.json') ? read(rt, id) : null;
    if (q === null) continue;
    const age = now - Date.parse(q.at);
    if ((q.state === 'waiting' && age <= WAIT_MS) || (q.state === 'approved' && age <= APPROVAL_MS)) out.push(q);
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

function row(rt: Runtime, kind: 'policy.action_deferred' | 'policy.deferred_resolved', q: Queued, data: Record<string, string>): void {
  rt.journal.write({ kind, project: rt.project, task: q.task, ...(q.session !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(q.session) ? { session: q.session } : {}), data });
}

// The text of an action for the human. A text that is too long is cut, and the cut is said: the
// human must know that the approval covers more than the text shows.
function shown(what: string): string {
  const text = what.replace(/\s+/g, ' ');
  return text.length <= MAX_WHAT ? text : `${text.slice(0, MAX_WHAT)} … (+${text.length - MAX_WHAT} characters cut: the approval covers the whole action)`;
}

// A call that the policy defers. An approval of the human for this call is used up and the call
// passes. Else the call waits: once, however many times the agent tries it.
export function deferCall(rt: Runtime, call: { session?: string; tool: string; input: unknown }, more: { rule: string; what: string; task: string }): { pass: true } | { pass: false; id: string } {
  const key = queueKey(call.session, call.tool, call.input);
  const known = listQueue(rt).filter((q) => q.key === key);
  const approved = known.find((q) => q.state === 'approved');
  if (approved !== undefined) {
    // Only one call takes the approval: the file is moved away first, and a move works once.
    const taken = `${fileOf(rt, approved.id)}.taken`;
    try {
      fs.renameSync(fileOf(rt, approved.id), taken);
      write(rt, { ...approved, state: 'used' });
      fs.rmSync(taken, { force: true });
      return { pass: true };
    } catch {
      // another call took it
    }
  }
  const waiting = known.find((q) => q.state === 'waiting');
  if (waiting !== undefined) return { pass: false, id: waiting.id };
  const q: Queued = {
    id: `q${crypto.randomBytes(5).toString('hex')}`, key, state: 'waiting', at: new Date().toISOString(),
    tool: call.tool, rule: more.rule, what: shown(more.what), task: more.task, project: rt.project,
    ...(call.session !== undefined ? { session: call.session } : {}),
  };
  write(rt, q);
  row(rt, 'policy.action_deferred', q, { queued: q.id, rule: q.rule });
  return { pass: false, id: q.id };
}

// The answer of the human for an action that waits. False: nothing waits under this name.
export function resolveQueued(rt: Runtime, id: string, state: 'approved' | 'rejected', now: number = Date.now()): boolean {
  const q = ID.test(id) ? read(rt, id) : null;
  // An action that waited past its term waits no more: an answer that comes too late answers nothing.
  if (q === null || q.state !== 'waiting' || now - Date.parse(q.at) > WAIT_MS) return false;
  // The time of the approval starts its term.
  write(rt, { ...q, state, at: new Date(now).toISOString() });
  row(rt, 'policy.deferred_resolved', q, { queued: q.id, state });
  return true;
}

// Removes the entries that ended long ago: used, rejected, an approval that nobody used, an action
// that nobody answered. Returns the count.
export function pruneQueue(rt: Runtime, now: number = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(dirOf(rt));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    const q = ID.test(id) && name.endsWith('.json') ? read(rt, id) : null;
    if (q === null) {
      // What a process left when it died in the middle of a write.
      try {
        if (/\.(taken|tmp)$/.test(name) && now - fs.statSync(path.join(dirOf(rt), name)).mtimeMs > KEEP_MS) fs.rmSync(path.join(dirOf(rt), name), { force: true });
      } catch {
        // the file went away
      }
      continue;
    }
    const age = now - Date.parse(q.at);
    const life = q.state === 'waiting' ? WAIT_MS : q.state === 'approved' ? APPROVAL_MS : 0;
    if (age <= life + KEEP_MS) continue;
    fs.rmSync(fileOf(rt, q.id), { force: true });
    removed += 1;
  }
  return removed;
}
