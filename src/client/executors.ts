// Several executors in one task. A subordinate executor starts only in a role and a count that
// the manifest of the task names; outside a scenario the packs limit the count. Its report is a
// claim, not a fact. Every row of the journal about it carries the parent task.
// Specification: docs/spec/harness-core, page 4.
//
// The executors that run are kept with the session, each with the task that it started under:
// the free task of a session changes at every request, and an executor that is still running
// must keep its place and its parent.

import { checkCitations } from '../check/citations.ts';
import { loadTask, readCollected, type Runtime } from '../core/runtime.ts';
import { currentScenario, withSession } from '../core/sessions.ts';
import type { Task } from '../core/task.ts';
import { sessionTask } from './session.ts';

// `report`: the text of the report of a subordinate, when the client gives it.
export type ExecutorEvent = { session?: string; cwd: string; role?: string; size?: number; report?: string };
export type ExecutorReply = { outcome: 'allow' | 'deny'; rule: string; task: string };

const STALE_MS = 60 * 60 * 1000; // an executor that did not report for this long has no place any more

// The role in the form of the packs: lower case, a dash for every other character.
export const roleOf = (role: string | undefined): string => (role ?? 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'general';

// The task that a new executor belongs to: the current scenario task of the session while it is
// open, else the free task of the session.
function parentOf(rt: Runtime, session: string | undefined): Task | null {
  const id = currentScenario(rt, session);
  const task = id === undefined ? null : loadTask(rt, id);
  return task !== null && task.session === session && task.state !== 'closed' && task.state !== 'skipped' ? task : loadTask(rt, sessionTask(rt, session));
}

function row(rt: Runtime, kind: 'executor.started' | 'executor.report_received', task: Task | null, id: string, role: string, session: string | undefined, data?: Record<string, number>): void {
  rt.journal.write({
    kind, project: rt.project, task: id, parent: id, executor: 'sub', role,
    ...(session !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(session) ? { session } : {}),
    ...(task?.scenario !== undefined ? { scenario: task.scenario, scenario_v: task.version ?? 1 } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

export function executorStarted(rt: Runtime, e: ExecutorEvent, now: number = Date.now()): ExecutorReply {
  const parent = parentOf(rt, e.session);
  const role = roleOf(e.role);
  if (parent === null) return { outcome: 'deny', rule: 'executor.busy', task: '' };
  // A scenario task that does not execute (it is checked, it waits for the human, it publishes)
  // starts no executor: the session is still in the scenario, so the free task does not answer.
  if (parent.state !== 'executing') return { outcome: 'deny', rule: 'executor.state', task: parent.id };
  const rule = withSession(rt, e.session, (file) => {
    const running = (file.executors ?? []).filter((x) => now - x.at <= STALE_MS);
    if (parent.manifest !== undefined) {
      // In a scenario only the roles of the manifest start, each up to its count.
      const place = (parent.manifest.model.executors ?? []).find((x) => x.role === role);
      if (place === undefined) return { next: null, result: 'executor.role' };
      if (running.filter((x) => x.task === parent.id && x.role === role).length >= place.count) return { next: null, result: 'executor.limit' };
    } else {
      const max = rt.merged.context.maxExecutors;
      if (max !== undefined && running.length >= max) return { next: null, result: 'executor.limit' };
    }
    return { next: { ...file, executors: [...running, { role, task: parent.id, at: now }] }, result: 'executor.allowed' };
  });
  if (rule !== 'executor.allowed') return { outcome: 'deny', rule, task: parent.id };
  row(rt, 'executor.started', parent, parent.id, role, e.session);
  return { outcome: 'allow', rule, task: parent.id };
}

// The subordinate ended. The place that it took is free again, and the report is written to the
// task that it started under. A report that names no running role frees nothing.
export function executorReported(rt: Runtime, e: ExecutorEvent, now: number = Date.now()): { task?: string; judged?: 'PASS' | 'FAIL' } {
  const role = e.role === undefined ? undefined : roleOf(e.role);
  const ended = withSession(rt, e.session, (file) => {
    // An executor that is too old has no place any more: the report is of the newest one that runs.
    const running = (file.executors ?? []).filter((x) => now - x.at <= STALE_MS);
    const at = role === undefined ? -1 : running.findLastIndex((x) => x.role === role);
    if (at < 0) return { next: null, result: undefined };
    return { next: { ...file, executors: running.filter((_, i) => i !== at) }, result: running[at] };
  });
  if (ended === undefined) return {};
  const parent = loadTask(rt, ended.task);
  row(rt, 'executor.report_received', parent, ended.task, ended.role, e.session, e.size === undefined ? undefined : { size: e.size });
  // The report is a claim. Where the task has a source, the code judges the citations of the
  // report against it, as it judges the report of the task itself. Without a source or without
  // the text nothing is judged.
  const done = parent?.manifest?.done;
  const root = done?.kind === 'citations' && done.source !== undefined ? readCollected(rt, ended.task)?.[done.source] : undefined;
  if (e.report === undefined || parent === null || typeof root !== 'string') return { task: ended.task };
  const answer = checkCitations(e.report, { root, ...(parent.manifest?.output.fields !== undefined ? { fields: parent.manifest.output.fields } : {}) });
  if (answer.result === 'none') return { task: ended.task };
  rt.journal.write({
    kind: 'executor.report_judged', project: rt.project, task: ended.task, parent: ended.task, executor: 'sub', role: ended.role,
    ...(e.session !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(e.session) ? { session: e.session } : {}),
    ...(parent.scenario !== undefined ? { scenario: parent.scenario, scenario_v: parent.version ?? 1 } : {}),
    data: { result: answer.result },
  });
  return { task: ended.task, judged: answer.result };
}
