// The events of a client session: start, request of the human, stop of the agent, end.
// A request opens a free task; the actions of the session belong to it until the next request.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { readSession } from '../src/core/sessions.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, loadTask, mutateTask, openScenario, openTasks, submitReport, type Runtime } from '../src/core/runtime.ts';
import { workNow, workState } from '../src/core/work.ts';
import { afterAction, beforeAction } from '../src/client/before.ts';
import { agentStopped, humanRequest, resumeTask, sessionEnd, sessionStart } from '../src/client/session.ts';
import { loadCases } from './cases.ts';
import { mergeView } from '../src/core/merged.ts';
import { resolveQueued } from '../src/core/queue.ts';
import { loadRuntime } from '../src/client/config.ts';
import { weekText } from '../src/craft/weekly.ts';

const HOOK = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT = { read_file: { kind: 'read' as const } };

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(): Box {
  n += 1;
  const root = path.join(SB, String(n));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir, human_channel: 'any' }));
  return { rt: { merged: loadPacks(packs), stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
const kinds = (b: Box): string[] => readJournal(b.rt.journal.file).map((r) => r.kind);
const act = (b: Box, session: string): string | undefined => {
  beforeAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session }, CLIENT);
  return readJournal(b.rt.journal.file).at(-1)?.task;
};

test('session: a request of the human opens a free task, the actions of the session belong to it', () => {
  const b = box();
  const first = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  assert.equal(loadTask(b.rt, first.task)?.kind, 'free');
  assert.equal(act(b, 's1'), first.task);
  assert.equal(act(b, 's1'), first.task);
  assert.notEqual(act(b, 's2'), first.task, 'another session has its own task');
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
  assert.equal(b.rt.journal.failures, 0);
});

test('session: the next request closes the task of the request before it', () => {
  const b = box();
  const first = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const second = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  assert.notEqual(first.task, second.task);
  assert.deepEqual([loadTask(b.rt, first.task)?.state, loadTask(b.rt, first.task)?.label], ['closed', 'not_verified']);
  assert.equal(act(b, 's1'), second.task);
  assert.deepEqual(openTasks(b.rt).map((t) => t.id), [second.task]);
});

test('session: a client that says it tells the harness before an action is measured: an action with no word before it is a fact', () => {
  const b = box();
  const levels = () => readJournal(b.rt.journal.file).filter((r) => r.kind === 'harness.client_level_detected').map((r) => r.data);
  // The adapter says "full". The first action comes with its word before: nothing is said.
  sessionStart(b.rt, { session: 's1', cwd: b.cwd, client: 'test_client' });
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  beforeAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's1' }, CLIENT);
  afterAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's1' }, CLIENT);
  assert.equal(agentStopped(b.rt, { session: 's1', cwd: b.cwd }).unguarded, undefined);
  assert.deepEqual(levels(), [{ client: 'test_client', level: 'full' }]);
  // Another session of the same client: the actions end, and no word came before any of them.
  sessionStart(b.rt, { session: 's2', cwd: b.cwd, client: 'test_client' });
  humanRequest(b.rt, { session: 's2', cwd: b.cwd });
  afterAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's2' }, CLIENT);
  afterAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's2' }, CLIENT);
  assert.deepEqual(levels().slice(2), [{ client: 'test_client', level: 'no_before', measured: 1 }], 'the fact is written once');
  // A call that failed may never have started: it is no proof that the client is silent before its actions.
  sessionStart(b.rt, { session: 's5', cwd: b.cwd, client: 'test_client' });
  afterAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's5' }, CLIENT, true, true);
  assert.equal(agentStopped(b.rt, { session: 's5', cwd: b.cwd }).unguarded, undefined);
  assert.equal(agentStopped(b.rt, { session: 's2', cwd: b.cwd }).unguarded, true, 'the human is told at the stop');
  // Once: the next stop, which finds no open task, says nothing more.
  assert.deepEqual(agentStopped(b.rt, { session: 's2', cwd: b.cwd }), {});
  // A stop that finds no task says it all the same.
  sessionStart(b.rt, { session: 's4', cwd: b.cwd, client: 'test_client' });
  afterAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's4' }, CLIENT);
  assert.deepEqual(agentStopped(b.rt, { session: 's4', cwd: b.cwd }), { unguarded: true });
  // A client that says itself that it has no word before an action is not measured: the start said it.
  sessionStart(b.rt, { session: 's3', cwd: b.cwd, client: 'plain', capabilities: { before: false } });
  humanRequest(b.rt, { session: 's3', cwd: b.cwd });
  afterAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's3' }, CLIENT);
  assert.equal(agentStopped(b.rt, { session: 's3', cwd: b.cwd }).unguarded, undefined);
  assert.equal(levels().length, 7);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('session: a client without a window that stops with its scenario task not finished gets the task back, twice at most', () => {
  const b = box();
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  assert.equal(loadTask(b.rt, id)?.state, 'executing');
  // With a window the agent stops to speak with the human: nothing is returned.
  assert.equal(agentStopped(b.rt, { session: 's1', cwd: b.cwd }).unfinished, undefined);
  // Without a window nobody answers: the stop is not the end of the work, and the free task of the request stays open.
  const free = humanRequest(b.rt, { session: 's1', cwd: b.cwd }).task;
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd, headless: true }), { unfinished: { task: id, scenario: 'draft-message' } });
  assert.equal(loadTask(b.rt, free)?.state, 'executing');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd, headless: true }).unfinished, { task: id, scenario: 'draft-message' });
  const last = agentStopped(b.rt, { session: 's1', cwd: b.cwd, headless: true });
  assert.deepEqual([last.unfinished, last.task, loadTask(b.rt, free)?.state], [undefined, free, 'closed'], 'the third stop ends the run and closes the free task');
  // Another session does not hold the task; a task that is not executing is not returned.
  assert.equal(agentStopped(b.rt, { session: 's2', cwd: b.cwd, headless: true }).unfinished, undefined);
  const next = openScenario(b.rt, 'draft-message', {}, { session: 's3' });
  assert.ok(next.ok);
  applyEvent(b.rt, next.task.id, { type: 'expire' }, 'harness');
  assert.equal(agentStopped(b.rt, { session: 's3', cwd: b.cwd, headless: true }).unfinished, undefined);
});

test('session: the answer of the human to a question names the rule that asked', () => {
  const b = box();
  const answers = () => readJournal(b.rt.journal.file).filter((r) => r.kind === 'task.human_decision').map((r) => r.data);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const call = { cwd: b.cwd, tool: 'some_new_tool', input: {}, session: 's1' };
  // The tool ran after the question: the human said "yes" to the rule.
  assert.deepEqual([beforeAction(b.rt, call, CLIENT).outcome, beforeAction(b.rt, call, CLIENT).rule], ['ask', 'default.unknown-tool']);
  afterAction(b.rt, call, CLIENT);
  assert.deepEqual(answers(), [{ decision: 'answered', rule: 'default.unknown-tool' }]);
  // The turn ended and the tool did not run: the human said "no" to the rule.
  beforeAction(b.rt, call, CLIENT);
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  assert.deepEqual(answers().slice(1), [{ decision: 'refused', rule: 'default.unknown-tool' }]);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('session: the decision about a tool of a connector names the tool, the decision about a tool of the client does not', () => {
  const b = box();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  beforeAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's1' }, CLIENT);
  beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__get_change', input: {}, session: 's1' }, CLIENT);
  beforeAction(b.rt, { cwd: b.cwd, tool: 'a tool with spaces', input: {}, session: 's1' }, CLIENT);
  // A tool that the pack describes as a plain read is a tool of the interface of the client: no name.
  // A read that the pack ties to a connector is a tool of a work system.
  b.rt.merged.tools = { app__update_plan: { kind: 'read' }, 'app__*': { kind: 'read' }, tracker__list_changes: { kind: 'read', connector: 'tracker' }, tracker__add_comment: { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' } };
  beforeAction(b.rt, { cwd: b.cwd, tool: 'app__update_plan', input: {}, session: 's1' }, CLIENT);
  beforeAction(b.rt, { cwd: b.cwd, tool: 'app__show_pane', input: {}, session: 's1' }, CLIENT);
  beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__list_changes', input: {}, session: 's1' }, CLIENT);
  // A write is a tool of a work system, with a connector or without one.
  beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__add_comment', input: { change: '7' }, session: 's1' }, CLIENT);
  const tools = readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.decision').map((r) => r.data?.tool);
  assert.deepEqual(tools, [undefined, 'tracker__get_change', undefined, undefined, undefined, 'tracker__list_changes', 'tracker__add_comment']);
  // A session that works on a scenario walks the tools of the scenario by design. Its decisions name the
  // tool, so the human sees which tool a rule asked about, and carry a mark: the craft does not read them as a chain.
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.ok(opened.ok);
  beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__get_change', input: {}, session: 's1' }, CLIENT);
  const held = readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.decision').at(-1)?.data;
  assert.deepEqual([held?.tool, held?.in_scenario], ['tracker__get_change', 1]);
  // A decision outside a scenario carries no mark.
  assert.ok(readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.decision').slice(0, -1).every((r) => r.data?.in_scenario === undefined));
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('session: a tool that failed is a fact of the journal: the name of the tool, no text of the error', () => {
  const b = box();
  const failures = () => readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.tool_failed');
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const call = { cwd: b.cwd, tool: 'tracker__get_change', input: { change: '7' }, session: 's1' };
  beforeAction(b.rt, call, CLIENT);
  afterAction(b.rt, call, CLIENT, true, true);
  assert.deepEqual(failures().map((r) => [r.task, r.data]), [[task, { tool: 'tracker__get_change' }]]);
  // A tool of the client itself fails as a part of the work (a file that is not there): no row.
  afterAction(b.rt, { ...call, tool: 'read_file' }, CLIENT, true, true);
  // A tool that ran to its end writes no such row; a name that is no plain name is not written.
  afterAction(b.rt, call, CLIENT);
  afterAction(b.rt, { ...call, tool: 'a tool with spaces' }, CLIENT, true, true);
  assert.equal(failures().length, 1);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('session: when the agent stops, the free task closes as not verified', () => {
  const b = box();
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  // The directory of the work is no repository: the fact about the work comes from its files.
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: false });
  assert.equal(loadTask(b.rt, task)?.state, 'closed');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), {}, 'nothing is open: nothing to close');
  assert.notEqual(act(b, 's1'), task, 'an action without a request gets a new free task');
});

test('session: the end of the session closes its task and forgets the session', () => {
  const b = box();
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  assert.deepEqual(sessionEnd(b.rt, { session: 's1', cwd: b.cwd }), { closed: [task] });
  assert.deepEqual(openTasks(b.rt), []);
  assert.deepEqual(fs.readdirSync(path.join(b.rt.stateDir, 'sessions')), []);
  assert.deepEqual(sessionEnd(b.rt, { session: 's1', cwd: b.cwd }), { closed: [] });
});

test('session: a scenario task is not touched by the events of a session', () => {
  const b = box();
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  sessionEnd(b.rt, { session: 's1', cwd: b.cwd });
  assert.equal(loadTask(b.rt, opened.task.id)?.state, 'executing');
});

test('session: the start gives the agent the scenarios and the open scenario tasks', () => {
  const b = box();
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const { context } = sessionStart(b.rt, { session: 's1', cwd: b.cwd, client: 'test_client' });
  const text = context.join('\n');
  assert.match(text, /change-review/);
  assert.match(text, /draft-message/);
  assert.match(text, new RegExp(`${opened.task.id}.*executing`));
  assert.ok(kinds(b).includes('harness.client_level_detected'));
});

function hook(b: Box, mode: string, event: Record<string, unknown>): { code: number | null; stdout: string } {
  const p = spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, ...event }), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  return { code: p.status, stdout: p.stdout };
}

test('session: the Claude Code adapter passes the four events to the core', () => {
  const b = box();
  const start = hook(b, 'session-start', { hook_event_name: 'SessionStart' });
  assert.equal(start.code, 0);
  const out = JSON.parse(start.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /change-review/);
  assert.deepEqual(hook(b, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'do it' }), { code: 0, stdout: '' });
  const open = openTasks(b.rt);
  assert.deepEqual(open.map((t) => t.kind), ['free']);
  assert.deepEqual(hook(b, 'stop', { hook_event_name: 'Stop' }), { code: 0, stdout: '' });
  assert.deepEqual(openTasks(b.rt), []);
  hook(b, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  assert.deepEqual(hook(b, 'session-end', { hook_event_name: 'SessionEnd' }), { code: 0, stdout: '' });
  assert.deepEqual(openTasks(b.rt), []);
  const text = readJournal(b.rt.journal.file).map((r) => JSON.stringify(r)).join('\n');
  assert.ok(!text.includes('do it') && !text.includes('again'), 'the words of the human are not in the journal');
});

test('session: an event with a broken input never blocks the client', () => {
  const b = box();
  for (const mode of ['session-start', 'prompt', 'stop', 'session-end']) {
    const p = spawnSync(process.execPath, [HOOK, mode], { input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
    assert.deepEqual([p.status, p.stdout], [0, ''], mode);
  }
});

test('session: the plugin registers the session events', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../clients/claude-code/hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  for (const [name, mode] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop'], ['SessionEnd', 'session-end']]) {
    assert.match(hooks[name as string][0].hooks[0].command, new RegExp(`start\\.mjs" ${mode}$`), name);
  }
});

// ---- The merge of the packs is a fact of the journal.

test('session: the merge of the packs is written once, and again when a pack changes', () => {
  const b = box();
  const merges = () => readJournal(b.rt.journal.file).filter((r) => r.kind === 'harness.packs_merged').map((r) => r.data);
  sessionStart(b.rt, { session: 's1', cwd: b.cwd });
  sessionStart(b.rt, { session: 's2', cwd: b.cwd });
  assert.equal(merges().length, 1);
  assert.deepEqual([merges()[0]?.levels, merges()[0]?.rejected], [3, 0]);
  assert.match(String(merges()[0]?.merge), /^[0-9a-f]{12}$/);
  // A pack changed: a manifest is refused now, and the person pack does not connect.
  fs.writeFileSync(path.join(b.root, 'packs/project/manifests/change-review.json'), JSON.stringify({ ...(manifests.get('review') as object), done: { kind: 'none' } }));
  fs.writeFileSync(path.join(b.root, 'packs/person/pack.json'), '{');
  const changed: Runtime = { ...b.rt, merged: loadPacks({ organization: path.join(b.root, 'packs/organization'), project: path.join(b.root, 'packs/project'), person: path.join(b.root, 'packs/person') }) };
  sessionStart(changed, { session: 's3', cwd: b.cwd });
  sessionStart(changed, { session: 's4', cwd: b.cwd });
  assert.equal(merges().length, 2);
  assert.deepEqual([merges()[1]?.levels, merges()[1]?.rejected], [2, 1]);
  const rows = readJournal(b.rt.journal.file);
  assert.deepEqual(rows.filter((r) => r.kind === 'harness.manifest_rejected').map((r) => [r.data?.level, r.data?.manifest, r.data?.code]), [['project', 'change-review', 'missing']]);
  assert.deepEqual(rows.filter((r) => r.kind === 'harness.failure' && r.data?.where === 'pack').map((r) => [r.data?.level, r.data?.code]), [['person', 'bad_json']]);
  for (const row of rows) assert.deepEqual(validateRow(row), [], row.kind);
  // A change of what a pack says about a connector is a new merge too.
  sessionStart({ ...changed, merged: { ...changed.merged, connectorNetwork: ['tracker'] } }, { session: 's6', cwd: b.cwd });
  assert.equal(merges().length, 3);
  // Another project has its own merge in the same state.
  sessionStart({ ...b.rt, project: 'p9z9z9z9z' }, { session: 's5', cwd: b.cwd });
  assert.equal(merges().length, 4);
});

test('session: the human reads which level gave each value of the merge', () => {
  const b = box();
  const view = mergeView(b.rt);
  assert.deepEqual(view.packs.map((p) => [p.level, p.connected, p.errors]), [['organization', true, []], ['project', true, []], ['person', true, []]]);
  assert.deepEqual(view.rejected, []);
  assert.equal(view.values.maxTokens?.value, b.rt.merged.context.maxTokens);
  assert.equal(view.values.maxTokens?.level, b.rt.merged.origin.maxTokens);
  assert.ok(Object.values(view.values).some((v) => v.level === 'organization'));
});

// ---- The queue of the human is named: at the start of a session, in the summary, by a notice.

test('session: the start of a session names the actions that wait in the queue of this project', () => {
  const b = box();
  const call = { cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session: 's1', headless: true };
  const r = beforeAction(b.rt, call, CLIENT);
  assert.equal(r.outcome, 'defer');
  const text = sessionStart(b.rt, { session: 's2', cwd: b.cwd }).context.join('\n');
  assert.match(text, /wait in the queue of the human/);
  assert.match(text, new RegExp(`- ${r.queued}: unknown__tool \\(default\\.unknown-tool`));
  assert.match(text, /reins queue approve\|reject <id>/);
  // Another project does not see it; a start without a window names nothing: nobody reads it there.
  assert.doesNotMatch(sessionStart({ ...b.rt, project: 'p9z9z9z9z' }, { session: 's3', cwd: b.cwd }).context.join('\n'), /wait in the queue/);
  assert.doesNotMatch(sessionStart(b.rt, { session: 's4', cwd: b.cwd, headless: true }).context.join('\n'), /wait in the queue/);
  // The summary of the week names it among the decisions of the human.
  const week = weekText(b.rt);
  assert.match(week.split('## Applied by itself')[0] ?? '', new RegExp(`${r.queued}.*reins queue approve ${r.queued}`));
  // An entry that the human answered is not named any more.
  assert.equal(resolveQueued(b.rt, r.queued ?? '', 'rejected'), true);
  assert.doesNotMatch(sessionStart(b.rt, { session: 's5', cwd: b.cwd }).context.join('\n'), /wait in the queue/);
});

test('session: an action that enters the queue sends one notice by the command of the config', () => {
  const b = box();
  const out = path.join(b.root, 'notices.txt');
  const rt: Runtime = { ...b.rt, notify: [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')", out, '{text}'] };
  const call = { cwd: b.cwd, tool: 'unknown__tool', input: { secret: 'the text of the action' }, session: 's1', headless: true };
  const r = beforeAction(rt, call, CLIENT);
  beforeAction(rt, call, CLIENT);
  // The notice runs apart from the harness: the test waits for its file.
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 50 && !fs.existsSync(out); i += 1) Atomics.wait(wait, 0, 0, 100);
  Atomics.wait(wait, 0, 0, 300);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'the same action that waits sends no second notice');
  assert.match(lines[0] ?? '', new RegExp(`${r.queued}.*default\\.unknown-tool`));
  assert.doesNotMatch(lines[0] ?? '', /the text of the action/);
  // A command that fails, or no command, never stops the action from waiting.
  const broken = box();
  assert.equal(beforeAction({ ...broken.rt, notify: ['/no/such/command', '{text}'] }, { ...call, cwd: broken.cwd }, CLIENT).outcome, 'defer');
  assert.equal(beforeAction(broken.rt, { ...call, cwd: broken.cwd, input: { b: 2 } }, CLIENT).outcome, 'defer');
  // The command comes from the config of the machine: a list of words.
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  const load = (notify: unknown): unknown => {
    fs.writeFileSync(b.config, JSON.stringify({ ...config, notify }));
    const before = process.env.REINS_CONFIG;
    process.env.REINS_CONFIG = b.config;
    try {
      return loadRuntime(b.cwd).notify;
    } catch (e) {
      return e instanceof Error ? e.message : 'error';
    } finally {
      if (before === undefined) delete process.env.REINS_CONFIG;
      else process.env.REINS_CONFIG = before;
    }
  };
  assert.deepEqual(load(['notifier', '{text}']), ['notifier', '{text}']);
  for (const bad of [[], 'notifier', ['notifier', 7], ['']]) assert.notDeepEqual(load(bad), bad, JSON.stringify(bad));
});

// ---- A client that cannot show a question with a choice.

test('session: in a client without a question with a choice an action that needs the human waits in the queue', () => {
  const b = box();
  sessionStart(b.rt, { session: 's1', cwd: b.cwd, client: 'plain', capabilities: { choice: false } });
  sessionStart(b.rt, { session: 's2', cwd: b.cwd, client: 'full' });
  const call = (session: string) => ({ cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session });
  // The client of s1 cannot ask: the action is not done, it waits for the human.
  const r = beforeAction(b.rt, call('s1'), CLIENT);
  assert.deepEqual([r.outcome, r.rule], ['defer', 'default.unknown-tool']);
  assert.match(r.queued ?? '', /^q[0-9a-f]{10}$/);
  // A client that can ask asks, as before.
  assert.equal(beforeAction(b.rt, call('s2'), CLIENT).outcome, 'ask');
  // The approval of the human lets the same call of that session pass once.
  assert.equal(resolveQueued(b.rt, r.queued ?? '', 'approved'), true);
  assert.deepEqual([beforeAction(b.rt, call('s1'), CLIENT).outcome, beforeAction(b.rt, call('s1'), CLIENT).outcome], ['allow', 'defer']);
  // A read and a refusal are what they were.
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's1' }, CLIENT).outcome, 'allow');
  // The human of such a client sees the answer of the client: no notice goes out. A run without a window sends one.
  const out = path.join(b.root, 'notices.txt');
  const loud: Runtime = { ...b.rt, notify: [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], 'x')", out] };
  assert.equal(beforeAction(loud, { cwd: b.cwd, tool: 'unknown__tool', input: { b: 2 }, session: 's1' }, CLIENT).outcome, 'defer');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, 500);
  assert.equal(fs.existsSync(out), false);
  // The same session goes on in a client that can ask: its questions are questions again.
  sessionStart(b.rt, { session: 's1', cwd: b.cwd, client: 'full' });
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'unknown__tool', input: { c: 3 }, session: 's1' }, CLIENT).outcome, 'ask');
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

test('session: a start without a window writes no summary of the week, by the word of the event', () => {
  const b = box();
  // The client says that it has no window in the event itself: nobody reads the notice there.
  const blind = sessionStart(b.rt, { session: 's1', cwd: b.cwd, headless: true });
  assert.doesNotMatch(blind.context.join('\n'), /summary of the week/);
  assert.equal(fs.existsSync(path.join(b.rt.stateDir, 'summaries')), false);
  // The summary waits for a session with a window.
  assert.match(sessionStart(b.rt, { session: 's2', cwd: b.cwd }).context.join('\n'), /summary of the week/);
});

// A free task that changed the work and that no check of a scenario judged is returned once
// (contracts AA26 - AA30). The packs give the count of changed files from which this holds.
function repoBox(max?: number): Box {
  const b = box();
  const git = (...args: string[]): void => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: b.cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(b.cwd, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return max === undefined ? b : { ...b, rt: { ...b.rt, merged: { ...b.rt.merged, context: { ...b.rt.merged.context, maxFreeUnchecked: max } } } };
}

test('session: a free task that changed the work without a check of a scenario is returned once', () => {
  const b = repoBox(1);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  // The first stop does not end the request: the free task stays open, the agent hears the rule.
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
  assert.equal(loadTask(b.rt, task)?.state, 'executing');
  // The second stop of the same request passes: the result keeps the label "not verified".
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
  assert.equal(loadTask(b.rt, task)?.state, 'closed');
  // A new request is returned again: the count belongs to one request.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed again\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
});

test('session: no count of the packs, or a change below the count, returns nothing', () => {
  const none = repoBox();
  const first = humanRequest(none.rt, { session: 's1', cwd: none.cwd });
  fs.writeFileSync(path.join(none.cwd, 'a.txt'), 'changed\n');
  assert.deepEqual(agentStopped(none.rt, { session: 's1', cwd: none.cwd }), { task: first.task, label: 'not_verified', changed: true });
  const two = repoBox(2);
  const second = humanRequest(two.rt, { session: 's1', cwd: two.cwd });
  fs.writeFileSync(path.join(two.cwd, 'a.txt'), 'changed\n');
  assert.deepEqual(agentStopped(two.rt, { session: 's1', cwd: two.cwd }), { task: second.task, label: 'not_verified', changed: true });
  // A request that changed nothing is a question: it is never returned.
  const quiet = repoBox(1);
  const third = humanRequest(quiet.rt, { session: 's1', cwd: quiet.cwd });
  assert.deepEqual(agentStopped(quiet.rt, { session: 's1', cwd: quiet.cwd }), { task: third.task, label: 'not_verified', changed: false });
});

test('session: a commit of the request counts as its change', () => {
  const b = repoBox(2);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(b.cwd, 'b.txt'), 'changed\n');
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'work'], { cwd: b.cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The tree is clean now: the two files are in the commit that the request made.
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 2 } });
});

test('session: a check of a scenario of the session that judged the work as it is now lifts the return', () => {
  const b = repoBox(1);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const id = opened.task.id;
  const work = workState(b.cwd);
  assert.ok(work !== null);
  // The scenario task closed with a verified label for this very state of the work.
  mutateTask(b.rt, id, (t) => ({ ...t, state: 'closed', label: 'verified_result', work: work ?? '' }));
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
  // An edit after the check: the answer of the check is about another state of the work.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed after the check\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
});

test('session: the answer of a check counts by its label and by the work of its own directory', () => {
  // A scenario with writes is accepted and waits for its publication: the check judged the work.
  const b = repoBox(1);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  // The task names the root of its work: a directory inside the same repository as the session.
  const sub = path.join(b.cwd, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'new.txt'), 'new\n');
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, state: 'publishing', label: 'verified_result', root: sub, work: workState(sub) ?? '' }));
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
  // The human accepted the result: that is a decision about this work too.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed twice\n');
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, state: 'closed', label: 'approved_by_human', root: b.cwd, work: workState(b.cwd) ?? '' }));
  assert.equal(agentStopped(b.rt, { session: 's1', cwd: b.cwd }).unchecked, undefined);
  // A label without a check lifts nothing.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed three times\n');
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, state: 'closed', label: 'not_verified', root: b.cwd, work: workState(b.cwd) ?? '' }));
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 2 } });
});

test('session: a check of another repository does not judge the work of the session', () => {
  const b = repoBox(1);
  const other = repoBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  // The fingerprint is the one of the session directory, but the task checked another repository.
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, state: 'closed', label: 'verified_result', root: other.cwd, work: workState(b.cwd) ?? '' }));
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
});

test('session: the first commit of a repository, made by the request, counts as its change', () => {
  const b = box();
  const rt: Runtime = { ...b.rt, merged: { ...b.rt.merged, context: { ...b.rt.merged.context, maxFreeUnchecked: 2 } } };
  const git = (...args: string[]): void => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: b.cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  humanRequest(rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(b.cwd, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  assert.deepEqual(agentStopped(rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 2 } });
});

test('session: a request and a stop in two directories give no return', () => {
  // The request came in a directory that is no repository; the session then moved into one.
  const b = repoBox(1);
  const plain = path.join(b.root, 'plain');
  fs.mkdirSync(plain);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: plain });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  const stopped = agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  assert.equal(stopped.unchecked, undefined, 'the fingerprints are of two works: no count of files is a fact');
  assert.equal(stopped.task, task);
  // Two repositories: the commit of the request is not a commit of the repository of the stop.
  const other = repoBox(1);
  humanRequest(other.rt, { session: 's2', cwd: other.cwd });
  const moved = repoBox();
  fs.writeFileSync(path.join(moved.cwd, 'a.txt'), 'changed\n');
  assert.equal(agentStopped(other.rt, { session: 's2', cwd: moved.cwd }).unchecked, undefined);
});

test('session: a judged task of the same repository with an older state of the work lifts nothing', () => {
  const b = repoBox(1);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'checked\n');
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, state: 'closed', label: 'verified_result', root: b.cwd, work: workState(b.cwd) ?? '' }));
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'edited after the check\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
});

test('session: a scenario task that this request opened holds the return back; an older open task does not', () => {
  const b = repoBox(1);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  // A real open task: it executes, it has no report yet and so no root of its work.
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(loadTask(b.rt, opened.task.id)?.root, undefined);
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true }, 'the check of this change is under way');
  // The next request: the task is still open, but this request did not open it. It holds nothing back.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed again\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
  // A task that this request opened for another repository holds nothing back.
  const other = repoBox();
  const c = repoBox(1);
  humanRequest(c.rt, { session: 's1', cwd: c.cwd });
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'changed\n');
  const far = openScenario(c.rt, 'draft-message', {}, { session: 's1' });
  assert.equal(far.ok, true);
  if (!far.ok) return;
  mutateTask(c.rt, far.task.id, (t) => ({ ...t, root: other.cwd }));
  assert.deepEqual(agentStopped(c.rt, { session: 's1', cwd: c.cwd }), { unchecked: { files: 1 } });
});

test('session: a real check of a scenario lifts the return: the report goes through the check of the harness', () => {
  const b = repoBox(1);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  // The scenario reads its source from the directory of the session and checks the quotes there.
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a changed line of the work', text: 'x' }] }));
  assert.ok('step' in submitted);
  if (!('step' in submitted)) return;
  // The task has writes: it is accepted and waits for its publication. Its work is the one of now.
  assert.deepEqual([submitted.step.task.state, submitted.step.task.label], ['publishing', 'verified_form']);
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
  // A task that another session opened and holds: its answer is no answer for this session.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, session: 's9', opener: 's9' }));
  fs.writeFileSync(path.join(b.cwd, 'b.txt'), 'another change\n');
  mutateTask(b.rt, opened.task.id, (t) => ({ ...t, work: workState(b.cwd) ?? '' }));
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 2 } });
});

test('session: commits of other people that the request brought in are not its change', () => {
  const b = repoBox(1);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  // A commit with a time before the request: this is what a pull or a checkout brings.
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'from another person\n');
  const old = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'theirs'], { cwd: b.cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z' } });
  assert.equal(old.status, 0, old.stderr);
  const stopped = agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  assert.equal(stopped.unchecked, undefined);
  assert.equal(stopped.changed, true);
});

test('session: "this request opened the task" is a fact of the request, not the last task of the session', () => {
  const b = repoBox(1);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const x = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  const y = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.ok(x.ok && y.ok);
  if (!x.ok || !y.ok) return;
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  // The next request takes an older open task again: the session points at it, but the request did not open it.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed\n');
  assert.equal(resumeTask(b.rt, x.task.id, 's1'), true);
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unchecked: { files: 1 } });
  // A request opens a task and then takes an older one: the task it opened still counts.
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'changed again\n');
  const z = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.ok(z.ok);
  assert.equal(resumeTask(b.rt, y.task.id, 's1'), true);
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
});

test('work: a rename in the work tree column gives one changed file, not a made-up path', () => {
  const b = repoBox();
  const git = (...args: string[]): void => { assert.equal(spawnSync('git', args, { cwd: b.cwd }).status, 0); };
  fs.renameSync(path.join(b.cwd, 'a.txt'), path.join(b.cwd, 'renamed.txt'));
  git('add', '-N', 'renamed.txt');
  const facts = workNow(b.cwd).facts;
  assert.ok(facts !== null);
  for (const file of facts?.dirty ?? []) assert.ok(['a.txt', 'renamed.txt'].includes(file), `a path that is no file of the work: ${file}`);
});

// A review that left findings which need a fix, and a change of the work after it: the stop is
// returned once, until the same scenario judges the work as it is now (contracts AA31 - AA34).
function reviewBox(): Box {
  const b = repoBox();
  const file = path.join(b.root, 'packs/project/manifests/change-review.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { output: Record<string, unknown>; done: Record<string, unknown> };
  manifest.output = { ...manifest.output, format: 'list', fields: { severity: ['blocking', 'should-fix', 'note'] } };
  manifest.done = { ...manifest.done, recheck: { severity: ['blocking', 'should-fix'] } };
  fs.writeFileSync(file, JSON.stringify(manifest));
  const merged = loadPacks({ organization: path.join(b.root, 'packs/organization'), project: path.join(b.root, 'packs/project'), person: path.join(b.root, 'packs/person') });
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  return { ...b, rt: { ...b.rt, merged } };
}
function review(b: Box, severity: string, line: string): string {
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  if (!opened.ok) return '';
  const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: line, severity, text: 'x' }] }));
  assert.ok('step' in submitted);
  if ('step' in submitted) assert.equal(submitted.step.task.label, 'verified_form');
  return opened.task.id;
}

test('session: a fix after a review with findings is returned until the review runs again', () => {
  const b = reviewBox();
  const first = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const id = review(b, 'should-fix', 'a changed line of the work');
  // The work is the one that the review judged: the stop passes.
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task: first.task, label: 'not_verified', changed: true });
  // The fix: one file, below any count of the packs. Nobody judged it.
  const second = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the fix of the finding here\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: id, scenario: 'change-review', open: 1 } });
  assert.equal(loadTask(b.rt, second.task)?.state, 'executing');
  // The next request, with no second stop before it: the session still holds the review with the finding.
  const third = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  assert.deepEqual(readSession(b.rt, 's1')?.reviews?.map((r) => [r.task, r.open]), [[id, 1]]);
  // The review ran again on the fix and left nothing to fix: it ends the record. Later changes are free of this rule.
  review(b, 'note', 'the fix of the finding here');
  assert.equal(readSession(b.rt, 's1')?.reviews, undefined);
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'one more change after it\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task: third.task, label: 'not_verified', changed: true });
});

test('session: a review without findings to fix, or a request that changed nothing, returns nothing', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  review(b, 'note', 'a changed line of the work');
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  const next = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a change after a clean review\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task: next.task, label: 'not_verified', changed: true });
  // Findings to fix, and a request that is a question: the work is the one of the review.
  const c = reviewBox();
  humanRequest(c.rt, { session: 's1', cwd: c.cwd });
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'a changed line of the work\n');
  review(c, 'blocking', 'a changed line of the work');
  agentStopped(c.rt, { session: 's1', cwd: c.cwd });
  const question = humanRequest(c.rt, { session: 's1', cwd: c.cwd });
  assert.deepEqual(agentStopped(c.rt, { session: 's1', cwd: c.cwd }), { task: question.task, label: 'not_verified', changed: false });
});

test('session: a review under way in the request of the fix holds the return back', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  review(b, 'should-fix', 'a changed line of the work');
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  const next = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the fix of the finding here\n');
  // The agent opened the review of the fix and stopped before its report.
  const under = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(under.ok);
  if (!under.ok) return;
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task: next.task, label: 'not_verified', changed: true });
  // The same with a review that a client without a window took for its run: the author opened it.
  const c = reviewBox();
  humanRequest(c.rt, { session: 's1', cwd: c.cwd });
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'a changed line of the work\n');
  review(c, 'should-fix', 'a changed line of the work');
  agentStopped(c.rt, { session: 's1', cwd: c.cwd });
  const fix = humanRequest(c.rt, { session: 's1', cwd: c.cwd });
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'the fix of the finding here\n');
  const run = openScenario(c.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(run.ok);
  if (!run.ok) return;
  assert.equal(resumeTask(c.rt, run.task.id, 'headless'), true);
  assert.deepEqual(agentStopped(c.rt, { session: 's1', cwd: c.cwd }), { task: fix.task, label: 'not_verified', changed: true });
});

test('session: a review of another repository neither replaces nor ends the review of this one', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const id = review(b, 'should-fix', 'a changed line of the work');
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  // The same session reviews another repository: first with a finding to fix, then clean.
  const other = repoBox();
  fs.writeFileSync(path.join(other.cwd, 'a.txt'), 'a line of the other repository\n');
  for (const severity of ['should-fix', 'note']) {
    const far = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
    assert.ok(far.ok);
    if (!far.ok) return;
    const collected = path.join(b.rt.stateDir, 'tasks', `${far.task.id}.collect.json`);
    const value = JSON.parse(fs.readFileSync(collected, 'utf8')) as { worktree?: string; outputs?: { worktree?: string } };
    if (value.outputs !== undefined) value.outputs.worktree = other.cwd;
    else value.worktree = other.cwd;
    fs.writeFileSync(collected, JSON.stringify(value));
    // The task read the other repository at its preparation: its clean report is about the work of now there.
    mutateTask(b.rt, far.task.id, (t) => ({ ...t, read: workState(other.cwd) ?? '' }));
    const submitted = submitReport(b.rt, far.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a line of the other repository', severity, text: 'x' }] }));
    assert.ok('step' in submitted && submitted.step.task.label === 'verified_form', JSON.stringify(submitted));
  }
  // The fix in this repository: its review is still the one with the finding.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the fix of the finding here\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: id, scenario: 'change-review', open: 1 } });
});

test('session: the answer of a check after the end of the session does not bring the session file back', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  if (!opened.ok) return;
  sessionEnd(b.rt, { session: 's1', cwd: b.cwd });
  const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a changed line of the work', severity: 'should-fix', text: 'x' }] }));
  assert.ok('step' in submitted && submitted.step.task.label === 'verified_form');
  assert.equal(fs.existsSync(path.join(b.rt.stateDir, 'sessions', 's1.json')), false);
});

test('session: a review belongs to the session that opened it, also when another session reports it', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  // The review runs in a client without a window: that client takes the task before its report.
  const report = (severity: string, line: string): string => {
    const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
    assert.ok(opened.ok);
    if (!opened.ok) return '';
    assert.equal(resumeTask(b.rt, opened.task.id, 'headless'), true);
    const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: line, severity, text: 'x' }] }));
    assert.ok('step' in submitted && submitted.step.task.label === 'verified_form');
    return opened.task.id;
  };
  const id = report('should-fix', 'a changed line of the work');
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the fix of the finding here\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: id, scenario: 'change-review', open: 1 } });
  // The next request, with no second stop before it: the record of the author is still there.
  const next = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  assert.deepEqual(readSession(b.rt, 's1')?.reviews?.map((r) => r.task), [id]);
  // The review of the fix, again without a window, leaves nothing to fix: it ends the review of the session that opened it.
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the second fix of the finding\n');
  report('note', 'the second fix of the finding');
  assert.equal(readSession(b.rt, 's1')?.reviews, undefined);
  assert.equal(readSession(b.rt, 'headless')?.reviews, undefined);
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a change after the clean review\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task: next.task, label: 'not_verified', changed: true });
});

test('session: the second stop of a returned request ends the return for that review', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const id = review(b, 'should-fix', 'a changed line of the work');
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a change that is no fix here\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: id, scenario: 'change-review', open: 1 } });
  // The agent said to the human why it does not run the review again, and stopped.
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  // The human read it: a later request is not returned for the same review again.
  const later = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'one more change of the work\n');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task: later.task, label: 'not_verified', changed: true });
});

test('session: a check that this session opened and a client without a window finished judges its work', () => {
  const b = repoBox(1);
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  if (!opened.ok) return;
  assert.equal(resumeTask(b.rt, opened.task.id, 'headless'), true);
  const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a changed line of the work', text: 'x' }] }));
  assert.ok('step' in submitted && submitted.step.task.label === 'verified_form');
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
});

test('session: a review judges the work that it read, not the work at the moment of its check', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  // The review reads the work when it opens. The author goes on while the reviewer reads.
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  if (!opened.ok) return;
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\na fix that the review did not read\n');
  const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a changed line of the work', severity: 'should-fix', text: 'x' }] }));
  assert.ok('step' in submitted && submitted.step.task.label === 'verified_form');
  // The work of now is not the one that the review read: the fix has no review.
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: opened.task.id, scenario: 'change-review', open: 1 } });
  // A clean review that read an older state does not end the record either.
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const again = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(again.ok);
  if (!again.ok) return;
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\none more edit during the review\n');
  const clean = submitReport(b.rt, again.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a changed line of the work', severity: 'note', text: 'x' }] }));
  assert.ok('step' in clean && clean.step.task.label === 'verified_form');
  assert.deepEqual(readSession(b.rt, 's1')?.reviews?.map((r) => r.task), [opened.task.id]);
});

test('session: a check of another scenario does not end the review; the count of files does not apply; one return for a request', () => {
  const b = reviewBox();
  const rt: Runtime = { ...b.rt, merged: { ...b.rt.merged, context: { ...b.rt.merged.context, maxFreeUnchecked: 1 } } };
  humanRequest(rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const id = review({ ...b, rt }, 'should-fix', 'a changed line of the work');
  agentStopped(rt, { session: 's1', cwd: b.cwd });
  const fix = humanRequest(rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the fix of the finding here\n');
  // The tests ran on the fix and passed: a task of another scenario, judged on the work of now.
  const tests = openScenario(rt, 'draft-message', {}, { session: 's1' });
  assert.ok(tests.ok);
  if (!tests.ok) return;
  mutateTask(rt, tests.task.id, (t) => ({ ...t, state: 'closed', label: 'verified_result', root: b.cwd, work: workState(b.cwd) ?? '' }));
  // The review is still due; the rule of the count of files is silent: its check judged the work.
  assert.deepEqual(agentStopped(rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: id, scenario: 'change-review', open: 1 } });
  // The second stop of the request passes: the two rules share one return.
  assert.deepEqual(agentStopped(rt, { session: 's1', cwd: b.cwd }), { task: fix.task, label: 'not_verified', changed: true });
});

test('session: an unfinished task of another scenario does not hold the return of a review back', () => {
  const b = reviewBox();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  const id = review(b, 'should-fix', 'a changed line of the work');
  agentStopped(b.rt, { session: 's1', cwd: b.cwd });
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'the fix of the finding here\n');
  // The request opened the tests of the fix and they are not ended: that is no review of the fix.
  assert.ok(openScenario(b.rt, 'draft-message', {}, { session: 's1' }).ok);
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { unreviewed: { task: id, scenario: 'change-review', open: 1 } });
});

test('session: a task of a session that ended belongs to the session that took it over', () => {
  const b = repoBox(1);
  // Another session opened the check and ended. This session continues the task.
  humanRequest(b.rt, { session: 'old', cwd: b.cwd });
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 'old' });
  assert.ok(opened.ok);
  if (!opened.ok) return;
  sessionEnd(b.rt, { session: 'old', cwd: b.cwd });
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'a changed line of the work\n');
  assert.equal(resumeTask(b.rt, opened.task.id, 's1'), true);
  const submitted = submitReport(b.rt, opened.task.id, JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a changed line of the work', text: 'x' }] }));
  assert.ok('step' in submitted && submitted.step.task.label === 'verified_form');
  // The check that this session finished judges its work.
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified', changed: true });
});
