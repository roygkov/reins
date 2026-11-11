// The events of a client session. A request of the human opens a free task; the actions of the
// session belong to it until the agent stops or the next request comes. The words of the human
// never reach the core: a request is only the fact that it happened.
// Specification: docs/spec/harness-client, page 1.

import fs from 'node:fs';
import path from 'node:path';
import { applyEvent, loadTask, mutateTask, openFreeTask, openTasks, type Runtime } from '../core/runtime.ts';
import { forgetDirectory, noteDirectory, patchSession, readSession, sessionFile, sessionName, withSession } from '../core/sessions.ts';
import { sweep } from '../core/sweep.ts';
import { workState } from '../core/work.ts';
import { readJournalSince } from '../journal/writer.ts';
import { listProposals, measure, propose } from '../craft/craft.ts';
import { listRecords } from '../memory/store.ts';

export type SessionEvent = { session?: string; cwd: string; client?: string };

const nameOf = sessionName;
const fileOf = sessionFile;

// The free task that the session file names, when it still executes.
function current(rt: Runtime, session: string | undefined): { id?: string; stale: boolean } {
  const known = readSession(rt, session);
  if (known === null) return { stale: false };
  if (typeof known.task === 'string' && loadTask(rt, known.task)?.state === 'executing') return { id: known.task, stale: false };
  return { stale: true };
}

// The free task of a session: an action outside a scenario belongs to it, so every decision of
// the policy has a task in the journal. A session without a request event gets one at its first action.
export function sessionTask(rt: Runtime, session: string | undefined): string {
  // The look and the write run under the lock of the session file: hooks of parallel calls are
  // separate processes, and only one of them opens the task.
  return withSession(rt, session, (now) => {
    if (typeof now.task === 'string' && loadTask(rt, now.task)?.state === 'executing') return { next: null, result: now.task };
    const task = openFreeTask(rt);
    return { next: { ...now, task: task.id }, result: task.id };
  });
}

// The handoff: what a session leaves for the next one. Facts of the journal and of the task
// store, no words of the human or of the agent. One handoff for one project, the last session.
type Handoff = { ended: string; requests: number; questions: number; refusals: number; open: string[] };
const handoffFile = (rt: Runtime): string => path.join(rt.stateDir, 'handoff', `${rt.project}.json`);

function writeHandoff(rt: Runtime, session: string | undefined): void {
  const requests = readSession(rt, session)?.requests ?? 0;
  if (requests === 0) return;
  const name = nameOf(session);
  // A decision of the policy and an attempt on the harness itself both end in a question or a refusal.
  // A session is not older than a week: the archive before that is not read.
  const decisions = readJournalSince(rt.stateDir, Date.now() - 7 * 24 * 60 * 60 * 1000).filter((r) => r.session === name && (r.kind === 'policy.decision' || r.kind === 'policy.protected_attempt'));
  const handoff: Handoff = {
    ended: new Date().toISOString(), requests,
    questions: decisions.filter((r) => r.data?.outcome === 'ask').length,
    refusals: decisions.filter((r) => r.data?.outcome === 'deny').length,
    open: openTasks(rt).filter((t) => t.kind === 'scenario').map((t) => `${t.id} (${t.scenario ?? ''}, ${t.state})`),
  };
  fs.mkdirSync(path.dirname(handoffFile(rt)), { recursive: true });
  fs.writeFileSync(handoffFile(rt), JSON.stringify(handoff));
}

function readHandoff(rt: Runtime): Handoff | null {
  try {
    const value = JSON.parse(fs.readFileSync(handoffFile(rt), 'utf8')) as Handoff;
    return typeof value.ended === 'string' && Array.isArray(value.open) ? value : null;
  } catch {
    return null;
  }
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// The start of a session: what the agent must know before it acts.
export function sessionStart(rt: Runtime, e: SessionEvent): { context: string[] } {
  noteDirectory(rt, e.cwd, e.session);
  // Housekeeping that needs no human: tasks past their term end, new patterns become proposals.
  sweep(rt);
  propose(rt);
  measure(rt);
  rt.journal.write({ kind: 'harness.client_level_detected', project: rt.project, data: { client: e.client ?? 'unknown', level: 'full' } });
  const context = ['reins: the harness of this workspace. It decides before every action and checks the result of a scenario.'];
  const last = readHandoff(rt);
  if (last !== null) {
    context.push(`Last session in this project ended ${last.ended}: ${count(last.requests, 'request')}, ${count(last.questions, 'question')} to the human, ${count(last.refusals, 'refusal')}.`);
    if (last.open.length > 0) context.push(`It left open: ${last.open.join('; ')}.`);
  }
  const scenarios = rt.merged.scenarios.filter((s) => s.manifest.state !== 'disabled');
  if (scenarios.length > 0) {
    context.push('Scenarios (start one with `reins open <name> name=value`):');
    for (const s of scenarios) context.push(`- ${s.name}: ${s.manifest.title}`);
  }
  for (const note of rt.merged.notes) context.push(`Rules of work (${note.level} pack):`, note.text.trim());
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
  const proposals = listProposals(rt).filter((p) => p.state === 'open');
  if (proposals.length > 0) {
    context.push('Proposals of the harness for the human (say them to the human; `reins craft accept|reject <id>` resolves one):');
    for (const p of proposals.slice(0, 10)) context.push(`- ${p.id}: ${p.pattern} of "${p.key}", seen ${p.n} times`);
  }
  return { context };
}

// A request of the human: the free task of the request before it ends, a new one opens.
export function humanRequest(rt: Runtime, e: SessionEvent): { task: string } {
  // The state of the work tree at the request: at the stop it says whether the request changed the work.
  const work = workState(e.cwd);
  // The count of requests and the new task change in one step under the lock of the session file:
  // two request events of one session must not lose a count.
  const { before, task } = withSession(rt, e.session, (file) => {
    const opened = openFreeTask(rt);
    return { next: { ...file, task: opened.id, work, requests: (file.requests ?? 0) + 1 }, result: { before: file.task, task: opened.id } };
  });
  if (typeof before === 'string' && loadTask(rt, before)?.state === 'executing') applyEvent(rt, before, { type: 'expire' }, 'harness');
  noteDirectory(rt, e.cwd, e.session);
  return { task };
}

// The agent stopped: its answer is the report of the free task. Nothing checks it, so the result
// is "not verified" (harness-core, page 2, rule 4).
export function agentStopped(rt: Runtime, e: SessionEvent): { task?: string; label?: string; changed?: boolean } {
  const id = current(rt, e.session).id;
  if (id === undefined) return {};
  const before = readSession(rt, e.session)?.work;
  const r = applyEvent(rt, id, { type: 'report', size: 0, fp: '00000000' }, 'agent');
  if (!('task' in r) || r.error !== undefined) return {};
  // A fact, not the words of the agent: the work tree is not what it was at the request.
  const now = workState(e.cwd);
  const out: { task: string; label?: string; changed?: boolean } = { task: id };
  if (r.task.label !== undefined) out.label = r.task.label;
  // Outside a repository there is no fact about the work: nothing is said.
  if (typeof before === 'string' && now !== null) out.changed = now !== before;
  return out;
}

// The end of a session: its free task ends and the session is forgotten.
export function sessionEnd(rt: Runtime, e: SessionEvent): { closed: string[] } {
  const id = current(rt, e.session).id;
  const closed: string[] = [];
  if (id !== undefined) {
    const r = applyEvent(rt, id, { type: 'expire' }, 'harness');
    if ('task' in r && r.error === undefined) closed.push(id);
  }
  writeHandoff(rt, e.session);
  // The removal runs under the lock of the session file: a hook that still writes must not bring the file back.
  withSession(rt, e.session, () => ({ next: 'remove', result: undefined }));
  forgetDirectory(rt, e.cwd, e.session);
  return { closed };
}

// A session takes a task: the task of a scenario or of a contract continues there, and it is the
// current task of that session. This is how a suspended task comes back, and how a task moves to
// another session. A task belongs to the harness, not to the session that opened it. A contract
// that the human did not approve is not a task to take: only its approval starts it.
export function resumeTask(rt: Runtime, id: string, session: string | undefined): boolean {
  if (session === undefined) return false;
  const task = mutateTask(rt, id, (t) => (t.kind === 'free' || t.state === 'closed' || t.state === 'skipped' || t.waiting === 'contract' ? null : { ...t, session }));
  if (task === null) return false;
  patchSession(rt, session, { scenario: id });
  return true;
}
