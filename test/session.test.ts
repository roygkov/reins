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
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, loadTask, openScenario, openTasks, type Runtime } from '../src/core/runtime.ts';
import { afterAction, beforeAction } from '../src/client/before.ts';
import { agentStopped, humanRequest, sessionEnd, sessionStart } from '../src/client/session.ts';
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
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
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
  // A session that works on a scenario walks the tools of the scenario by design: its decisions name no tool.
  const opened = openScenario(b.rt, 'draft-message', {}, { session: 's1' });
  assert.ok(opened.ok);
  beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__get_change', input: {}, session: 's1' }, CLIENT);
  assert.equal(readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.decision').at(-1)?.data?.tool, undefined);
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
