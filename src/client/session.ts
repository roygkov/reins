// The events of a client session. A request of the human opens a free task; the actions of the
// session belong to it until the agent stops or the next request comes. The words of the human
// never reach the core: a request is only the fact that it happened.
// Specification: docs/spec/harness-client, page 1.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyEvent, loadTask, openFreeTask, openTasks, type Runtime } from '../core/runtime.ts';
import { listRecords } from '../memory/store.ts';

export type SessionEvent = { session?: string; cwd: string; client?: string };

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const nameOf = (session: string | undefined): string =>
  session !== undefined && SESSION.test(session) ? session : crypto.createHash('sha256').update(session ?? '').digest('hex').slice(0, 16);
const fileOf = (rt: Runtime, session: string | undefined): string => path.join(rt.stateDir, 'sessions', `${nameOf(session)}.json`);

// The free task that the session file names, when it still executes.
function current(rt: Runtime, session: string | undefined): { id?: string; stale: boolean } {
  try {
    const known: unknown = JSON.parse(fs.readFileSync(fileOf(rt, session), 'utf8'));
    const id = known !== null && typeof known === 'object' ? (known as { task?: unknown }).task : undefined;
    if (typeof id === 'string' && loadTask(rt, id)?.state === 'executing') return { id, stale: false };
    return { stale: true };
  } catch {
    return { stale: false };
  }
}

// The free task of a session: an action outside a scenario belongs to it, so every decision of
// the policy has a task in the journal. A session without a request event gets one at its first action.
export function sessionTask(rt: Runtime, session: string | undefined): string {
  const now = current(rt, session);
  if (now.id !== undefined) return now.id;
  const file = fileOf(rt, session);
  const task = openFreeTask(rt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // Hooks of parallel calls are separate processes: only the first one names the task.
    if (now.stale) fs.rmSync(file, { force: true });
    fs.writeFileSync(file, JSON.stringify({ task: task.id }), { flag: 'wx' });
    return task.id;
  } catch {
    try {
      const other = (JSON.parse(fs.readFileSync(file, 'utf8')) as { task?: unknown }).task;
      if (typeof other === 'string' && loadTask(rt, other) !== null) return other;
    } catch {
      // the other writer is not done: this call keeps its own task
    }
    return task.id;
  }
}

// The start of a session: what the agent must know before it acts.
export function sessionStart(rt: Runtime, e: SessionEvent): { context: string[] } {
  rt.journal.write({ kind: 'harness.client_level_detected', project: rt.project, data: { client: e.client ?? 'unknown', level: 'full' } });
  const context = ['reins: the harness of this workspace. It decides before every action and checks the result of a scenario.'];
  const scenarios = rt.merged.scenarios.filter((s) => s.manifest.state !== 'disabled');
  if (scenarios.length > 0) {
    context.push('Scenarios (start one with `reins open <name> name=value`):');
    for (const s of scenarios) context.push(`- ${s.name}: ${s.manifest.title}`);
  }
  const open = openTasks(rt).filter((t) => t.kind === 'scenario');
  if (open.length > 0) {
    context.push('Open scenario tasks (read one with `reins input <task>`):');
    for (const t of open) context.push(`- ${t.id}: ${t.scenario ?? ''}, ${t.state}`);
  }
  // The records that the harness wrote and that the human can still veto.
  const pending = listRecords(rt).filter((r) => r.state === 'pending' && r.project === rt.project);
  if (pending.length > 0) {
    context.push('Memory records that wait for a veto of the human (say them to the human; `reins memory veto <id>` removes one):');
    for (const r of pending.slice(0, 10)) context.push(`- ${r.id} (${r.type}, until ${r.veto_until ?? ''}): ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return { context };
}

// A request of the human: the free task of the request before it ends, a new one opens.
export function humanRequest(rt: Runtime, e: SessionEvent): { task: string } {
  const before = current(rt, e.session).id;
  if (before !== undefined) applyEvent(rt, before, { type: 'expire' }, 'harness');
  const task = openFreeTask(rt);
  const file = fileOf(rt, e.session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ task: task.id }));
  return { task: task.id };
}

// The agent stopped: its answer is the report of the free task. Nothing checks it, so the result
// is "not verified" (harness-core, page 2, rule 4).
export function agentStopped(rt: Runtime, e: SessionEvent): { task?: string; label?: string } {
  const id = current(rt, e.session).id;
  if (id === undefined) return {};
  const r = applyEvent(rt, id, { type: 'report', size: 0, fp: '00000000' }, 'agent');
  if (!('task' in r) || r.error !== undefined) return {};
  return r.task.label === undefined ? { task: id } : { task: id, label: r.task.label };
}

// The end of a session: its free task ends and the session is forgotten.
export function sessionEnd(rt: Runtime, e: SessionEvent): { closed: string[] } {
  const id = current(rt, e.session).id;
  const closed: string[] = [];
  if (id !== undefined) {
    const r = applyEvent(rt, id, { type: 'expire' }, 'harness');
    if ('task' in r && r.error === undefined) closed.push(id);
  }
  fs.rmSync(fileOf(rt, e.session), { force: true });
  return { closed };
}
