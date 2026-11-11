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
import { loadTask, openScenario, openTasks, type Runtime } from '../src/core/runtime.ts';
import { beforeAction } from '../src/client/before.ts';
import { agentStopped, humanRequest, sessionEnd, sessionStart } from '../src/client/session.ts';
import { loadCases } from './cases.ts';

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

test('session: when the agent stops, the free task closes as not verified', () => {
  const b = box();
  const { task } = humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  assert.deepEqual(agentStopped(b.rt, { session: 's1', cwd: b.cwd }), { task, label: 'not_verified' });
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
    assert.match(hooks[name as string][0].hooks[0].command, new RegExp(`hook\\.ts" ${mode}$`), name);
  }
});
