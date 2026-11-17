// The events of a client session. A request of the human opens a free task; the actions of the
// session belong to it until the agent stops or the next request comes. The words of the human
// never reach the core: a request is only the fact that it happened.
// Specification: docs/spec/harness-client, page 1.

import { RULE_NAME } from '../contracts/journal.ts';
import fs from 'node:fs';
import path from 'node:path';
import { applyEvent, loadTask, mutateTask, openFreeTask, openTasks, ownerOf, type Runtime } from '../core/runtime.ts';
import type { Task } from '../core/task.ts';
import { currentScenario, forgetDirectory, noteDirectory, patchSession, readSession, sessionFile, sessionName, takeJudged, withSession, type SessionFile } from '../core/sessions.ts';
import { sweep } from '../core/sweep.ts';
import { changedFiles, workNow, workTop } from '../core/work.ts';
import { scenarioOff } from '../core/idle.ts';
import { readJournalSince } from '../journal/writer.ts';
import { applyDue, listProposals, measure, proposalLine, propose } from '../craft/craft.ts';
import { noteMerge } from '../core/merged.ts';
import { listQueue } from '../core/queue.ts';
import { notify } from '../core/notify.ts';
import { writeWeek } from '../craft/weekly.ts';
import { casesForStart, countUses, listRecords, recordsForStart, stateForStart } from '../memory/store.ts';

// `capabilities`: what the client can do. `before`: it tells the core before an action.
// `choice`: it can show the human a question with a choice. Absent: the client can.
// `headless`: the client runs without a window, nobody answers it.
export type SessionEvent = { session?: string; cwd: string; client?: string; capabilities?: { before?: boolean; choice?: boolean }; headless?: boolean; answer?: string };
export type ClientLevel = 'full' | 'no_choice' | 'no_before';

// The level of a client (harness-client, page 3). Without the event before an action the harness
// is no barrier; without a question with a choice the question goes as text.
export const levelOf = (c: SessionEvent['capabilities']): ClientLevel => (c?.before === false ? 'no_before' : c?.choice === false ? 'no_choice' : 'full');

const START_MEMORY_BYTES = 2000; // the memory records in the context of a session start
const START_CASES_BYTES = 1500; // the open cases in the context of a session start
const START_STATE_BYTES = 3000; // the state of the project in the context of a session start
const nameOf = sessionName;
const fileOf = sessionFile;

// The free task that the session file names, when it still executes.
function current(rt: Runtime, session: string | undefined): { id?: string; stale: boolean } {
  const known = readSession(rt, session);
  if (known === null) return { stale: false };
  if (typeof known.task === 'string' && loadTask(rt, known.task)?.state === 'executing') return { id: known.task, stale: false };
  return { stale: true };
}

// The free task that the session holds now, when it is open. Nothing opens here.
export const heldFreeTask = (rt: Runtime, session: string | undefined): string | undefined => current(rt, session).id;

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
    // A question that no human saw is no question to the human.
    questions: decisions.filter((r) => r.data?.outcome === 'ask' && r.data.unshown !== 1).length,
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

// The notes of the packs: rules of work that hold for every task. The start of a session gives
// them to the main executor. A subordinate executor has a context of its own and does not see
// that start: the client gives it the same lines when it starts.
export const rulesOfWork = (rt: Runtime): string[] => rt.merged.notes.flatMap((note) => [`Rules of work (${note.level} pack):`, note.text.trim()]);

// The start of a session: what the agent must know before it acts.
export function sessionStart(rt: Runtime, e: SessionEvent): { context: string[] } {
  noteDirectory(rt, e.cwd, e.session);
  // The merge of the packs is a fact of the journal: the first start, and every change of a pack.
  noteMerge(rt);
  // Housekeeping that needs no human: tasks past their term end, new patterns become proposals.
  sweep(rt);
  propose(rt);
  applyDue(rt);
  measure(rt);
  const level = levelOf(e.capabilities);
  rt.journal.write({ kind: 'harness.client_level_detected', project: rt.project, data: { client: e.client ?? 'unknown', level } });
  // The level is the word of the adapter. The harness measures it: see `afterAction`.
  if (level !== 'no_before') patchSession(rt, e.session, { claims: e.client ?? 'unknown' });
  // A client that cannot show a question with a choice: a question of the policy has nobody to
  // answer it there, so it waits in the queue (see `beforeAction`).
  // The flag is written at every start: a session that goes on in a client that can ask loses it.
  if (level !== 'no_before') patchSession(rt, e.session, { noChoice: level === 'no_choice' });
  // The harness does not pretend to protect: a client without the event before an action gets the words.
  const context = level === 'no_before'
    ? ['reins: the harness of this workspace. This client does not tell the harness before an action: the barriers do not act here. Say this to the human.']
    : ['reins: the harness of this workspace. It decides before every action and checks the result of a scenario.'];
  // The task that the session holds: after a compaction of the context the agent finds it here.
  const held = currentScenario(rt, e.session);
  const heldTask = held === undefined ? null : loadTask(rt, held);
  if (heldTask !== null && heldTask.session === e.session && heldTask.state !== 'closed' && heldTask.state !== 'skipped') {
    context.push(`this session holds the task ${heldTask.id} (${heldTask.scenario ?? ''}, ${heldTask.state}): \`reins input ${heldTask.id}\` prints its input again.`);
  }
  const last = readHandoff(rt);
  if (last !== null) {
    context.push(`Last session in this project ended ${last.ended}: ${count(last.requests, 'request')}, ${count(last.questions, 'question')} to the human, ${count(last.refusals, 'refusal')}.`);
    if (last.open.length > 0) context.push(`It left open: ${last.open.join('; ')}.`);
  }
  // A pack with a mistake is not connected: its rules, its tools and its scenarios do not act.
  for (const p of rt.merged.packs) {
    const first = p.errors[0];
    if (!p.connected && first !== undefined) context.push(`The ${p.level} pack is NOT connected: ${p.errors.length} mistake(s), the first is ${first.code} at ${first.path}. Say this to the human: \`reins scenarios\` lists the mistakes.`);
  }
  const scenarios = rt.merged.scenarios.filter((s) => s.manifest.state !== 'disabled' && !scenarioOff(rt, s.name));
  if (scenarios.length > 0) {
    context.push('Scenarios (start one with `reins open <name> name=value`):');
    for (const s of scenarios) context.push(`- ${s.name}: ${s.manifest.title}`);
  }
  context.push(...rulesOfWork(rt));
  const open = openTasks(rt).filter((t) => t.kind === 'scenario');
  if (open.length > 0) {
    context.push('Open scenario tasks (read one with `reins input <task>`):');
    for (const t of open) context.push(`- ${t.id}: ${t.scenario ?? ''}, ${t.state}`);
  }
  // Where the work of this project is now: the state that the last wrap-up wrote.
  context.push(...stateForStart(rt, START_STATE_BYTES));
  // What is not finished in this project: the cases with their next steps.
  const cases = casesForStart(rt, START_CASES_BYTES);
  if (cases.lines.length > 0) {
    context.push('Open cases of this project (what is not finished; a scenario that may write cases gives a step with `reins memory next <id> <step> task=<task>` and ends one with `reins memory close <id> task=<task>`):', ...cases.lines);
    if (cases.more > 0) context.push(`${cases.more} more cases: \`reins memory find <word>\`.`);
  }
  // The memory of the project: what was decided and what was learned, before the agent acts.
  const memory = recordsForStart(rt, START_MEMORY_BYTES);
  if (memory.lines.length > 0) {
    context.push('Memory of this project (cite the id of a record in your report when you use it):', ...memory.lines);
    if (memory.more > 0) context.push(`${memory.more} more records: \`reins memory\`.`);
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
    for (const p of proposals.slice(0, 10)) context.push(`- ${proposalLine(p)}`);
  }
  // The actions that wait for the human in the queue of this project. A start without a window names none: nobody reads it there.
  const waits = e.headless === true ? [] : listQueue(rt).filter((q) => q.state === 'waiting' && q.project === rt.project);
  if (waits.length > 0) {
    context.push(`Actions that wait in the queue of the human (${waits.length}; say them to the human; \`reins queue approve|reject <id>\` resolves one):`);
    for (const q of waits.slice(0, 5)) context.push(`- ${q.id}: ${q.tool} (${q.rule}${q.until !== undefined ? `, until ${q.until}` : ''})`);
  }
  // The summary of the week is a file and a notice: once in `craft.summary_days` days (seven by default) the harness writes it and says where it is.
  // A client without a window has no human who reads the notice: the summary waits for a session with one.
  // The client names itself in the event; the variable holds for a command that the harness started without a window.
  const week = e.headless === true || process.env.REINS_HEADLESS === '1' ? null : writeWeek(rt);
  if (week !== null) notify(rt, `reins: the summary of the week is written: ${week}`);
  if (week !== null) context.push(`The harness wrote the summary of the week: ${week}. Say this to the human; \`reins week\` prints it.`);
  return { context };
}

// Before the client compacts the context: the state of the task is on the disk already, so the
// harness only notes the time and says which task the session holds.
export function beforeCompaction(rt: Runtime, e: SessionEvent): { task?: string; state?: string } {
  const id = currentScenario(rt, e.session);
  const task = id === undefined ? null : loadTask(rt, id);
  if (task === null || task.session !== e.session || task.state === 'closed' || task.state === 'skipped') return {};
  patchSession(rt, e.session, { compacted: new Date().toISOString() });
  return { task: task.id, state: task.state };
}

// The questions of a session that no run of the tool answered. The turn is over, or the human
// started another: the tool did not run, so the human said "no". The fact goes to the journal once.
// `who`: whose questions end now. The end of a turn ends the questions of the session itself; a
// subordinate executor works on after it, so its questions end when it ends ({ sub }); the end of
// the session ends all of them ('all'). A question of another session is not touched.
export function settleQuestions(rt: Runtime, session: string | undefined, who: 'main' | 'all' | { sub: string } = 'main'): number {
  if (session === undefined) return 0;
  const dir = path.join(rt.stateDir, 'pending');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let settled = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let asked: { session?: unknown; task?: unknown; sub?: unknown; shown?: unknown; rule?: unknown; project?: unknown };
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value === null || typeof value !== 'object') continue;
      asked = value as { session?: unknown; task?: unknown; sub?: unknown; shown?: unknown; rule?: unknown; project?: unknown };
    } catch {
      continue;
    }
    if (asked.session !== session) continue;
    if (who === 'main' ? asked.sub !== undefined : who !== 'all' && asked.sub !== who.sub) continue;
    // A question that no human saw has no answer of a human: it ends without a word.
    const seen = asked.shown !== false;
    // The task of the question: the scenario task that asked for the whole task, else the task of the session now.
    const task = typeof asked.task === 'string' && loadTask(rt, asked.task) !== null ? asked.task : currentScenario(rt, session) ?? current(rt, session).id;
    // Without a task the fact has no place in the journal: the question stays for the sweep.
    if (seen && task === undefined) continue;
    // Only one process writes the fact: the removal of the file works once.
    try {
      fs.rmSync(file);
    } catch {
      continue;
    }
    if (!seen || task === undefined) continue;
    // The answer belongs to the project of its question: the session may have changed its directory since.
    const project = typeof asked.project === 'string' && /^p[0-9a-f]{8}$/.test(asked.project) ? asked.project : rt.project;
    rt.journal.write({ kind: 'task.human_decision', project, task, ...(/^[A-Za-z0-9_-]{1,64}$/.test(session) ? { session } : {}), data: { decision: 'refused', ...(typeof asked.rule === 'string' && RULE_NAME.test(asked.rule) ? { rule: asked.rule } : {}) } });
    settled += 1;
  }
  return settled;
}

// A request of the human: the free task of the request before it ends, a new one opens.
// `long`: the count of requests of a session that reached the count of the packs, or a multiple of
// it. The client tells the human to write the state and to start a new session: a long session
// reads its whole history again at every turn. A run without a window has no human to tell.
export function humanRequest(rt: Runtime, e: SessionEvent): { task: string; long?: number } {
  settleQuestions(rt, e.session);
  // The state of the work tree at the request: at the stop it says whether the request changed the work.
  // For a repository also its root and its commit: at the stop they name the files that the request
  // committed, and they say that the stop is in the same work as the request.
  const { state: work, facts } = workNow(e.cwd);
  // The count of requests and the new task change in one step under the lock of the session file:
  // two request events of one session must not lose a count.
  const { before, task, requests } = withSession(rt, e.session, (file) => {
    const opened = openFreeTask(rt);
    const requests = (file.requests ?? 0) + 1;
    // A new request can be returned again: the mark of the return belongs to one request.
    // The list of the scenario tasks that a request opened starts anew: a task that is still open
    // from an earlier request is not a check of the change of this one.
    const { returned: _returned, returnedFor: _for, head: _head, top: _top, opened: _opened, ...rest } = file;
    return { next: { ...rest, task: opened.id, work, at: Date.now(), ...(facts !== null ? { head: facts.head, top: facts.top } : {}), requests }, result: { before: file.task, task: opened.id, requests } };
  });
  if (typeof before === 'string' && loadTask(rt, before)?.state === 'executing') applyEvent(rt, before, { type: 'expire' }, 'harness');
  noteDirectory(rt, e.cwd, e.session);
  const max = rt.merged.context.maxSessionRequests;
  const long = max !== undefined && max > 0 && e.headless !== true && requests % max === 0 ? requests : undefined;
  return { task, ...(long !== undefined ? { long } : {}) };
}

// The agent stopped: its answer is the report of the free task. Nothing checks it, so the result
// is "not verified" (harness-core, page 2, rule 4).
const MAX_RETURNS = 2; // a stop gets the task back this many times; after that the run ends as it is

// The reply "return the report". A client without a window stopped, and the scenario task that
// its session holds still executes: there is no human to speak with, so the stop is not the end
// of the work. The client is told to go on, a few times at most for one task.
function unfinishedTask(rt: Runtime, e: SessionEvent): { task: string; scenario: string } | undefined {
  if (e.headless !== true) return undefined;
  const held = currentScenario(rt, e.session);
  const task = held === undefined ? null : loadTask(rt, held);
  if (task === null || task.session !== e.session || task.state !== 'executing') return undefined;
  const before = readSession(rt, e.session)?.returns;
  const n = before?.task === task.id ? before.n : 0;
  if (n >= MAX_RETURNS) return undefined;
  patchSession(rt, e.session, { returns: { task: task.id, n: n + 1 } });
  return { task: task.id, scenario: task.scenario ?? '' };
}

// `judged`: the roles of the subordinates whose report got the answer FAIL and that the main
// executor did not hear: it took no action after their end (a subordinate in the background).
// The client does not end the turn and says the answer to the agent, once.
// `unchecked`: the request changed that many files of the work, the packs name a count from which
// a check is due (`limits.free_unchecked`), and no check of a scenario of this session judged the
// work as it is now. The client does not end the turn and says it to the agent, once for a request.
type Stopped = { task?: string; label?: string; changed?: boolean; unguarded?: boolean; unfinished?: { task: string; scenario: string }; judged?: string[]; unchecked?: { files: number }; unreviewed?: { task: string; scenario: string; open: number } };

// The labels of a result that somebody judged: a check of the harness, or the human.
const JUDGED: readonly string[] = ['verified_result', 'verified_form', 'approved_by_human'];

// What the scenario tasks of the session say about the work of the session at a stop.
// A task counts for its owner (`ownerOf`): the session that opened it, or the session that holds
// it now when the opener ended. A task of another owner is no answer here.
// 'judged': the last scenario task of the session carries a label of a judged result (it is
// closed, or accepted and waits for its publication) and its answer is about the state of the
// work now. One repository has one fingerprint from any of its directories, so the fingerprint of
// the task is compared as it is.
// 'open': a task that this request opened (the list `opened` of the session) is not ended: a
// check of this change is under way. `only` names one scenario: then only its tasks count (a
// review that is under way, not any other check). A task that has no report yet
// has no root of its work: it counts. A task that the request only took again is not in the list.
// undefined: neither. A task whose work lies in another repository says nothing about this work.
function scenarioSays(rt: Runtime, session: string | undefined, seen: SessionFile, top: string, now: string, only?: string): 'judged' | 'open' | undefined {
  const here = (id: string | undefined): Task | null => {
    const task = id === undefined ? null : loadTask(rt, id);
    if (task === null || task.kind !== 'scenario' || ownerOf(rt, task) !== session) return null;
    return task.root !== undefined && workTop(task.root) !== top ? null : task;
  };
  const ended = (task: Task): boolean => task.state === 'closed' || task.state === 'publishing' || task.state === 'skipped';
  const last = here(seen.scenario);
  if (last !== null && (last.state === 'closed' || last.state === 'publishing') && last.label !== undefined && JUDGED.includes(last.label) && last.work === now) return 'judged';
  return (seen.opened ?? []).some((id) => { const task = here(id); return task !== null && !ended(task) && (only === undefined || task.scenario === only); }) ? 'open' : undefined;
}

export function agentStopped(rt: Runtime, e: SessionEvent): Stopped {
  settleQuestions(rt, e.session);
  // A measured fact: actions of this session ended, and the client told the harness before none
  // of them. The human hears it once, at the first stop after it, whatever the stop finds.
  const seen = readSession(rt, e.session);
  const unfinished = unfinishedTask(rt, e);
  const unguarded: Pick<Stopped, 'unguarded' | 'unfinished'> = { ...(seen?.unguarded === true && seen.told !== true ? { unguarded: true } : {}), ...(unfinished !== undefined ? { unfinished } : {}) };
  if (unguarded.unguarded === true) patchSession(rt, e.session, { told: true });
  // An answer FAIL about a report of a subordinate that waits: the agent hears it before the turn ends.
  const judged = takeJudged(rt, e.session);
  // The client goes on: this stop is not the end of the request, so its free task stays open.
  if (judged.length > 0) return { ...unguarded, judged };
  if (unfinished !== undefined) return { ...unguarded };
  const id = current(rt, e.session).id;
  if (id === undefined) return { ...unguarded };
  const before = seen?.work;
  // A fact, not the words of the agent: the work tree is not what it was at the request.
  // A work with no fingerprint (a directory of too many files, no answer of git) gives no fact: nothing is said.
  const { state: now, facts } = workNow(e.cwd);
  const changed = typeof before === 'string' && now !== null ? now !== before : undefined;
  // A free task that changed the work and that no check judged is returned once for a request
  // (contracts AA26 - AA30). The stop is then not the end of the request: its free task stays open.
  const max = rt.merged.context.maxFreeUnchecked;
  // The second stop of a request that was returned for a review: the agent said to the human why
  // the review does not run again. The human read it: that review returns no later request.
  if (seen?.returned === true && seen.returnedFor !== undefined) {
    const answered = seen.returnedFor;
    withSession(rt, e.session, (file) => {
      const { returnedFor: _for, reviews, ...rest } = file;
      const left = (reviews ?? []).filter((r) => r.task !== answered);
      return { next: left.length > 0 ? { ...rest, reviews: left } : rest, result: undefined };
    });
  }
  // A review of this session left findings to fix and the request changed the work after it: the
  // stop is returned once, until the same scenario judges the work as it is now (AA31 - AA34).
  // The session keeps one review for a scenario in a repository: the ones of this repository are
  // read. A review that this request opened and did not end yet holds the return back.
  if (changed === true && now !== null && facts !== null && seen?.returned !== true && seen?.top === facts.top) {
    const due = (seen.reviews ?? []).find((r) => {
      if (r.top !== facts.top) return false;
      const reviewed = loadTask(rt, r.task);
      return reviewed !== null && ownerOf(rt, reviewed) === e.session && r.work !== now;
    });
    // Only the same scenario under way holds the return back: tests that run are no review.
    if (due !== undefined && scenarioSays(rt, e.session, seen, facts.top, now, due.scenario) !== 'open') {
      patchSession(rt, e.session, { returned: true, returnedFor: due.task });
      return { ...unguarded, unreviewed: { task: due.task, scenario: due.scenario, open: due.open } };
    }
  }
  // The request and the stop must be in one repository: else the two fingerprints are of two works.
  if (changed === true && now !== null && facts !== null && max !== undefined && seen?.returned !== true && seen?.top === facts.top && scenarioSays(rt, e.session, seen, facts.top, now) === undefined) {
    const files = changedFiles(facts, seen.head, seen.at);
    if (files !== null && files >= max) {
      patchSession(rt, e.session, { returned: true });
      return { ...unguarded, unchecked: { files } };
    }
  }
  const r = applyEvent(rt, id, { type: 'report', size: 0, fp: '00000000', ...(changed === true ? { changed: true } : {}) }, 'agent');
  if (!('task' in r) || r.error !== undefined) return { ...unguarded };
  // The answer of the free task, when the client gives it: a record of the memory that it cites by
  // its id was used. The count is apart from the reports: no check judged the answer.
  if (e.answer !== undefined) countUses(rt, e.answer, Date.now(), true);
  const out: Stopped = { task: id, ...unguarded };
  if (r.task.label !== undefined) out.label = r.task.label;
  if (changed !== undefined) out.changed = changed;
  return out;
}

// The end of a session: its free task ends and the session is forgotten.
export function sessionEnd(rt: Runtime, e: SessionEvent): { closed: string[] } {
  settleQuestions(rt, e.session, 'all');
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
