// The term of a task. A task that nobody touched for longer than its term ends: the harness does
// not wait for a human to close what was left open. The time of a task is the time of its file.
// Specification: docs/spec/harness-core, page 2.

import fs from 'node:fs';
import path from 'node:path';
import { applyEvent, openTasks, type Runtime } from './runtime.ts';
import type { Task } from './task.ts';
import { pruneArchive } from '../journal/writer.ts';
import { pruneQueue } from './queue.ts';

const HOUR = 60 * 60 * 1000;
// A free task: half a day. A scenario task: a day. A publication: an hour, as its envelope.
const termOf = (task: Task): number => (task.state === 'publishing' ? HOUR : task.kind === 'free' ? 12 * HOUR : 24 * HOUR);

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
  // The archive of the journal past the term that the packs name goes away.
  pruneArchive(rt.stateDir, rt.merged.journalKeepDays, now);
  return closed;
}
