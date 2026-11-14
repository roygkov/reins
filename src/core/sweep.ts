// The term of a task. A task that nobody touched for longer than its term ends: the harness does
// not wait for a human to close what was left open. The time of a task is the time of its file.
// Specification: docs/spec/harness-core, page 2.

import fs from 'node:fs';
import path from 'node:path';
import { applyEvent, collectedDir, openTasks, runCheck, type Runtime } from './runtime.ts';
import type { Task } from './task.ts';
import { pruneArchive } from '../journal/writer.ts';
import { pruneQueue } from './queue.ts';
import { pruneRecords } from '../memory/store.ts';
import { switchOffIdle } from './idle.ts';

const HOUR = 60 * 60 * 1000;
// A free task: half a day. A scenario task: a day. A publication: an hour, as its envelope.
const termOf = (task: Task): number => (task.state === 'publishing' ? HOUR : task.kind === 'free' ? 12 * HOUR : 24 * HOUR);

// The soak of a check is over: the check gives its second answer. A script of a pack can run for
// minutes, so this is a step of the timer and of the `sweep` command, never of a session start.
export function dueChecks(rt: Runtime, now: number = Date.now()): string[] {
  const ran: string[] = [];
  for (const task of openTasks(rt)) {
    if (task.state !== 'checking' || task.soak === undefined || now < task.soak) continue;
    if ('step' in runCheck(rt, task.id, now)) ran.push(task.id);
  }
  return ran;
}

export function sweep(rt: Runtime, now: number = Date.now()): string[] {
  const closed: string[] = [];
  for (const task of openTasks(rt)) {
    let touched: number;
    try {
      touched = fs.statSync(path.join(rt.stateDir, 'tasks', `${task.id}.json`)).mtimeMs;
    } catch {
      continue;
    }
    if (now - touched <= termOf(task)) continue;
    const r = applyEvent(rt, task.id, { type: 'expire' }, 'harness');
    if ('task' in r && r.error === undefined) closed.push(task.id);
  }
  // A question that nobody answered for a day waits for nothing any more.
  try {
    const pending = path.join(rt.stateDir, 'pending');
    for (const name of fs.readdirSync(pending)) {
      const file = path.join(pending, name);
      if (now - fs.statSync(file).mtimeMs > 24 * HOUR) fs.rmSync(file, { force: true });
    }
  } catch {
    // no questions wait
  }
  pruneQueue(rt, now);
  // The copies of collected results that nobody touched for a week: their tasks ended long ago.
  // A link is never followed. The copies of an earlier version lay beside the tasks in the state.
  for (const [base, pattern] of [[collectedDir(rt), /^t[0-9a-f]{12}$/], [path.join(rt.stateDir, 'tasks'), /^t[0-9a-f]{12}\.collected$/]] as const) {
    try {
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        const stat = fs.lstatSync(dir);
        if (pattern.test(name) && stat.isDirectory() && now - stat.mtimeMs > 7 * 24 * HOUR) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // no copies
    }
  }
  // The compiled code that the first file of a hook of a client keeps in the state. Node
  // has one directory for each of its versions and writes a file again when its source changes.
  // A directory where nothing was written for 30 days is of a Node that left, or of a code that
  // did not change: it goes away whole, and Node writes it again at the next call when it is in use.
  try {
    const cache = path.join(rt.stateDir, 'compile-cache');
    for (const name of fs.readdirSync(cache)) {
      const dir = path.join(cache, name);
      const stat = fs.lstatSync(dir);
      if (!/^v[0-9]/.test(name) || !stat.isDirectory()) continue;
      const last = fs.readdirSync(dir).reduce((at, file) => Math.max(at, fs.lstatSync(path.join(dir, file)).mtimeMs), stat.mtimeMs);
      if (now - last > 30 * 24 * HOUR) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // no cache
  }
  // The archive of the journal past the term that the packs name goes away.
  pruneArchive(rt.stateDir, rt.merged.journalKeepDays, now);
  // The file of a memory record that the human removed, past the term that the packs name.
  pruneRecords(rt, now);
  // A scenario that nobody called for the term that the packs name acts no more.
  switchOffIdle(rt, now);
  return closed;
}
