// The client contract past one client: the level of a client, the event before a compaction, the
// actions of a subordinate executor, a run without a window, and a second client on the same core.
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
import { openScenario, raiseLevel, type Runtime } from '../src/core/runtime.ts';
import { listQueue, resolveQueued } from '../src/core/queue.ts';
import { beforeAction, type ClientTools } from '../src/client/before.ts';
import { executorStarted } from '../src/client/executors.ts';
import { beforeCompaction, humanRequest, sessionStart } from '../src/client/session.ts';
import { loadCases } from './cases.ts';

const CLAUDE = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const STDIO = fileURLToPath(new URL('../clients/stdio/hook.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'client-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { shell: { kind: 'shell', command: 'command' }, read_file: { kind: 'read' } };

type Box = { rt: Runtime; root: string; cwd: string; config: string; env: Record<string, string> };
let n = 0;
function box(): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const out = JSON.stringify({ outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${out}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000, configFile: config }, root, cwd, config, env: { PATH: process.env.PATH ?? '', HOME: root, REINS_CONFIG: config } };
}
const levels = (b: Box) => readJournal(b.rt.journal.file).filter((r) => r.kind === 'harness.client_level_detected').map((r) => r.data?.level);

// ---- The level of a client.

test('client: the harness names the level of a client at the start from what the client can do', () => {
  const b = box();
  sessionStart(b.rt, { session: 's1', cwd: b.cwd, client: 'one' });
  sessionStart(b.rt, { session: 's2', cwd: b.cwd, client: 'two', capabilities: { choice: false } });
  const none = sessionStart(b.rt, { session: 's3', cwd: b.cwd, client: 'three', capabilities: { before: false } });
  assert.deepEqual(levels(b), ['full', 'no_choice', 'no_before']);
  assert.match(none.context.join('\n'), /barriers do not act/);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

// ---- Before a compaction.

test('client: before a compaction the task of the session is kept, and the next start names it', () => {
  const b = box();
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  assert.deepEqual(beforeCompaction(b.rt, { session: 's1', cwd: b.cwd }), { task: opened.task.id, state: 'executing' });
  const context = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.join('\n');
  assert.match(context, new RegExp(`this session holds the task ${opened.task.id}`));
  assert.match(context, new RegExp(`reins input ${opened.task.id}`));
  assert.deepEqual(beforeCompaction(b.rt, { session: 's9', cwd: b.cwd }), {}, 'a session without a task keeps nothing');
});

// ---- The actions of a subordinate executor.

test('client: an action of a subordinate executor is written with its role and its parent task', () => {
  const b = box();
  const task = humanRequest(b.rt, { session: 's1', cwd: b.cwd }).task;
  beforeAction(b.rt, { cwd: b.cwd, tool: 'unknown__tool', input: {}, session: 's1', sub: 'Plugin:Reviewer' }, CLIENT);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind.startsWith('policy.'));
  assert.deepEqual(rows.map((r) => [r.executor, r.parent, r.role]), [['sub', task, 'plugin-reviewer'], ['sub', task, 'plugin-reviewer']]);
  for (const r of rows) assert.deepEqual(validateRow(r), []);
});

// ---- Without a window.

test('client: without a window a question becomes a place in the queue, and a refusal stays a refusal', () => {
  const b = box();
  const call = { cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session: 's1', headless: true };
  const r = beforeAction(b.rt, call, CLIENT);
  assert.deepEqual([r.outcome, r.rule], ['defer', 'default.unknown-tool']);
  assert.match(r.queued ?? '', /^q[0-9a-f]{10}$/);
  assert.equal(resolveQueued(b.rt, r.queued ?? '', 'approved'), true);
  assert.deepEqual([beforeAction(b.rt, call, CLIENT).outcome, beforeAction(b.rt, call, CLIENT).outcome], ['allow', 'defer']);
  const denied = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: `echo x > ${b.rt.stateDir}/pause.json` }, session: 's1', headless: true }, CLIENT);
  assert.deepEqual([denied.outcome, denied.queued], ['deny', undefined]);
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's1', headless: true }, CLIENT).outcome, 'allow');
});

// ---- A second client.

const stdio = (b: Box, event: Record<string, unknown>) => {
  const p = spawnSync(process.execPath, [STDIO], { input: JSON.stringify({ cwd: b.cwd, session: 'other-1', ...event }), env: b.env, encoding: 'utf8' });
  return p.stdout === '' ? {} : JSON.parse(p.stdout);
};

test('client: a call that the human broke off is no "yes" in the second client either', () => {
  const b = box();
  stdio(b, { event: 'session_start' });
  stdio(b, { event: 'request' });
  const asked = stdio(b, { event: 'before', tool: 'some_connector_tool', input: {} });
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'default.unknown-tool']);
  // The tool started and the human broke it off: this says neither "yes" nor "no".
  stdio(b, { event: 'after', tool: 'some_connector_tool', input: {}, failed: true, interrupted: true });
  assert.equal(readJournal(b.rt.journal.file).some((r) => r.kind === 'task.human_decision' && r.data?.decision === 'answered'), false);
});

test('client: a second client drives the same core through its own codec', () => {
  const b = box();
  const start = stdio(b, { event: 'session_start' });
  assert.match(start.context.join('\n'), /change-review/);
  assert.equal(typeof stdio(b, { event: 'request' }).task, 'string');
  assert.deepEqual(stdio(b, { event: 'before', tool: 'read_file', input: { path: 'a' } }), { outcome: 'allow', rule: 'default.read' });
  const denied = stdio(b, { event: 'before', tool: 'run_command', input: { command: `echo x > ${b.rt.stateDir}/pause.json` } });
  assert.deepEqual([denied.outcome, denied.rule], ['deny', 'protect.state']);
  const asked = stdio(b, { event: 'before', tool: 'some_connector_tool', input: {} });
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'default.unknown-tool']);
  assert.deepEqual(stdio(b, { event: 'after', tool: 'some_connector_tool', input: {} }), {});
  assert.equal(stdio(b, { event: 'executor_start', role: 'helper' }).outcome, 'allow');
  assert.equal(typeof stdio(b, { event: 'executor_report', role: 'helper' }).task, 'string');
  assert.deepEqual(Object.keys(stdio(b, { event: 'before_compaction' })), []);
  assert.equal(typeof stdio(b, { event: 'stop' }).task, 'string');
  assert.deepEqual(stdio(b, { event: 'session_end' }).closed, []);
  const rows = readJournal(b.rt.journal.file);
  for (const r of rows) assert.deepEqual(validateRow(r), []);
  assert.ok(rows.some((r) => r.kind === 'harness.client_level_detected' && r.data?.client === 'stdio'));
  assert.ok(rows.some((r) => r.kind === 'task.human_decision' && r.data?.decision === 'answered'));
});

test('client: an event of a second client with a broken form asks about a write and never fails', () => {
  const b = box();
  const p = spawnSync(process.execPath, [STDIO], { input: 'not json', env: b.env, encoding: 'utf8' });
  assert.equal(p.status, 0);
  assert.deepEqual(JSON.parse(p.stdout).outcome, 'ask');
  assert.deepEqual(stdio(b, { event: 'before', tool: 7 }).outcome, 'ask');
});

test('client: the core names no client', () => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (/claude|anthropic|cursor|codex/i.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(SRC, file));
    }
  };
  walk(SRC);
  assert.deepEqual(found, []);
});

// ---- The first client.

test('client: the Claude Code adapter passes the compaction, the subordinate and the run without a window', () => {
  const b = box();
  const hook = (mode: string, event: Record<string, unknown>, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLAUDE, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, ...event }), env: { ...b.env, ...env }, encoding: 'utf8' }).stdout;
  hook('prompt', { hook_event_name: 'UserPromptSubmit' });
  assert.equal(hook('pre-compact', { hook_event_name: 'PreCompact' }), '');
  hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: {}, agent_id: 'a1', agent_type: 'reviewer' });
  assert.ok(readJournal(b.rt.journal.file).some((r) => r.kind === 'policy.decision' && r.executor === 'sub' && r.role === 'reviewer'));
  // Every row that the adapter of a client writes names the client.
  const written = readJournal(b.rt.journal.file).filter((r) => r.session === 'live' || r.kind.startsWith('harness.'));
  assert.ok(written.length > 0 && written.every((r) => r.client === 'claude_code'), JSON.stringify(written.find((r) => r.client !== 'claude_code')));
  const out = JSON.parse(hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'mcp__x__z', tool_input: {} }, { REINS_HEADLESS: '1' })).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /reins queue approve q[0-9a-f]{10}/);
  const hooks = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../clients/claude-code/hooks/hooks.json', import.meta.url)), 'utf8')).hooks;
  assert.ok(Object.hasOwn(hooks, 'PreCompact'));
});

// ---- Cases of the review.

test('client: a subordinate that started under a scenario keeps that task as its parent, also for a write of the envelope', () => {
  const b = box();
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }).outcome, 'allow');
  beforeAction(b.rt, { cwd: b.cwd, tool: 'unknown__tool', input: {}, session: 's1', sub: 'reviewer' }, CLIENT);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.decision');
  assert.deepEqual(rows.map((r) => [r.executor, r.parent, r.role]), [['sub', opened.task.id, 'reviewer']]);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

// ---- The model of a subordinate executor.

const NAMES = { weak: 'small', medium: 'mid', strong: 'big' };
const leveled = (): { b: Box; task: string } => {
  const b = box();
  b.rt.merged.models = { ...NAMES };
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  return { b, task: opened.task.id };
};
const start = (b: Box, model?: string) => executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer', ...(model !== undefined ? { model } : {}) });

test('client: a subordinate of a scenario does not start with a model above the level of the task', () => {
  const { b, task } = leveled();
  // The task has the middle level: the strong model is above it and takes no place.
  assert.deepEqual(start(b, 'big'), { outcome: 'deny', rule: 'executor.level', task });
  assert.equal(readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.started').length, 0);
  // The model of the level and a model below it start.
  assert.equal(start(b, 'mid').outcome, 'allow');
  const low = leveled();
  assert.equal(start(low.b, 'small').outcome, 'allow');
});

test('client: after the level of the task is raised the subordinate can have the model of the new level', () => {
  const { b, task } = leveled();
  assert.ok('task' in raiseLevel(b.rt, task));
  assert.equal(start(b, 'big').outcome, 'allow');
});

test('client: a model that the packs do not name is not shown to be within the level: the subordinate does not start', () => {
  const { b, task } = leveled();
  assert.deepEqual(start(b, 'other'), { outcome: 'deny', rule: 'executor.level', task });
  // The packs name no model at all: the levels have no names, and the rule holds nothing.
  const bare = leveled();
  bare.b.rt.merged.models = {};
  assert.equal(start(bare.b, 'other').outcome, 'allow');
  const none = leveled();
  none.b.rt.merged.models = {};
  assert.equal(start(none.b, '').outcome, 'allow');
});

test('client: a subordinate without a named model and a subordinate of the free task are not judged by the level', () => {
  const { b } = leveled();
  assert.equal(start(b).outcome, 'allow');
  const free = box();
  free.rt.merged.models = { ...NAMES };
  humanRequest(free.rt, { session: 's2', cwd: free.cwd });
  assert.equal(executorStarted(free.rt, { session: 's2', cwd: free.cwd, role: 'reviewer', model: 'big' }).outcome, 'allow');
});

test('client: a client that cannot name the model of a subordinate says so with an empty name, and the subordinate of a scenario does not start', () => {
  const { b, task } = leveled();
  assert.deepEqual(start(b, ''), { outcome: 'deny', rule: 'executor.level', task });
  // The free task has no level to hold.
  const free = box();
  humanRequest(free.rt, { session: 's2', cwd: free.cwd });
  assert.equal(executorStarted(free.rt, { session: 's2', cwd: free.cwd, role: 'reviewer', model: '' }).outcome, 'allow');
});

test('client: the stdio event of a subordinate carries the model', () => {
  // The client process reads the packs from the files: the names of the models are written there.
  const { b, task } = leveled();
  const file = path.join(b.root, 'packs/organization/pack.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), models: NAMES }));
  const r = stdio(b, { event: 'executor_start', cwd: b.cwd, session: 's1', role: 'reviewer', model: 'big' });
  assert.deepEqual(r, { outcome: 'deny', rule: 'executor.level', task });
  assert.equal(stdio(b, { event: 'executor_start', cwd: b.cwd, session: 's1', role: 'reviewer', model: 'mid' }).outcome, 'allow');
});

test('client: the Claude Code adapter gives the core the model that the subordinate runs on, or says that it cannot name it', () => {
  const b = box();
  const file = path.join(b.root, 'packs/organization/pack.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), models: NAMES }));
  assert.ok(openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 'live' }).ok);
  const agent = (input: Record<string, unknown>, env: Record<string, string> = {}): string => {
    const out = spawnSync(process.execPath, [CLAUDE, 'pre'], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input }), env: { ...b.env, ...env }, encoding: 'utf8' }).stdout;
    return out === '' ? '' : JSON.parse(out).hookSpecificOutput.permissionDecisionReason ?? '';
  };
  assert.match(agent({ subagent_type: 'reviewer', model: 'big', prompt: 'x' }), /executor\.level/);
  // A role that the manifest does not name is refused as a role, with any model.
  assert.match(agent({ subagent_type: 'fork', model: 'mid', prompt: 'x' }), /executor\.role/);
  // A call without a model: the definition of the agent or the session decides, the adapter does not see them.
  assert.match(agent({ subagent_type: 'reviewer', prompt: 'x' }), /executor\.level: the call names no model/);
  // The client is set to ignore the model of the call: the model of the setting counts.
  const forced = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'big' };
  assert.match(agent({ subagent_type: 'reviewer', model: 'mid', prompt: 'x' }, forced), /executor\.level: the model "big"/);
  assert.match(agent({ subagent_type: 'reviewer', model: 'mid', prompt: 'x' }, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }), /executor\.level: the call names no model/);
  // A value of the setting that the documentation does not name: the adapter names no model.
  assert.match(agent({ subagent_type: 'reviewer', model: 'mid', prompt: 'x' }, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'yes', CLAUDE_CODE_SUBAGENT_MODEL: 'mid' }), /executor\.level: the call names no model/);
  assert.doesNotMatch(agent({ subagent_type: 'reviewer', model: 'mid', prompt: 'x' }), /executor\./);
});

test('client: an approval from the queue in a run without a window is a row of the journal', () => {
  const b = box();
  const call = { cwd: b.cwd, tool: 'shell', input: { command: `cat ${b.rt.stateDir}/journal.jsonl`, description: 'a long text of the agent' }, session: 's1', headless: true };
  const r = beforeAction(b.rt, call, CLIENT);
  assert.equal(r.outcome, 'defer');
  const queued = JSON.parse(fs.readFileSync(path.join(b.rt.stateDir, 'queue', `${r.queued}.json`), 'utf8'));
  assert.equal(queued.what, `cat ${b.rt.stateDir}/journal.jsonl`);
  resolveQueued(b.rt, r.queued ?? '', 'approved');
  assert.equal(beforeAction(b.rt, call, CLIENT).rule, 'queue.approved');
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'policy.basis' && x.data?.rule === 'queue.approved'));
});

// ---- Found in a live client.

test('client: without a window an approval is for the action in any session', () => {
  const b = box();
  const call = (session: string) => ({ cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session, headless: true });
  const first = beforeAction(b.rt, call('run-1'), CLIENT);
  assert.equal(first.outcome, 'defer');
  assert.equal(beforeAction(b.rt, call('run-2'), CLIENT).queued, first.queued, 'the next run waits in the same place');
  resolveQueued(b.rt, first.queued ?? '', 'approved');
  assert.equal(beforeAction(b.rt, call('run-3'), CLIENT).rule, 'queue.approved');
});

test('client: an approval without a window stays in its project, and with a window it stays in its session', () => {
  const b = box();
  const headless = (rt: Runtime) => beforeAction(rt, { cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session: 'run-1', headless: true }, CLIENT);
  const first = headless(b.rt);
  resolveQueued(b.rt, first.queued ?? '', 'approved');
  assert.equal(headless({ ...b.rt, project: 'p9z8y7x6' }).outcome, 'defer', 'another project waits on its own');
  assert.equal(headless(b.rt).rule, 'queue.approved');
  // With a window a deferred action is the action of one session.
  const DEFER = { ...b.rt, merged: { ...b.rt.merged, rules: [{ id: 'later', outcome: 'defer' as const, tool: 'unknown__tool', level: 'person' as const }] } };
  const windowed = (session: string) => beforeAction(DEFER, { cwd: b.cwd, tool: 'unknown__tool', input: { a: 2 }, session }, CLIENT);
  const waits = windowed('s-a');
  assert.equal(waits.outcome, 'defer');
  resolveQueued(b.rt, waits.queued ?? '', 'approved');
  assert.equal(windowed('s-b').outcome, 'defer');
  assert.equal(windowed('s-a').rule, 'queue.approved');
});

test('client: a change of a file that a rule of a pack defers names the file in the queue of the human', () => {
  const b = box();
  const tools: ClientTools = { ...CLIENT, write_file: { kind: 'local', path: 'path' } };
  const DEFER = { ...b.rt, merged: { ...b.rt.merged, rules: [{ id: 'later', outcome: 'defer' as const, tool: 'write_file', level: 'person' as const }] } };
  const r = beforeAction(DEFER, { cwd: b.cwd, tool: 'write_file', input: { path: 'src/a.txt', content: 'x' }, session: 's1' }, tools);
  assert.equal(r.outcome, 'defer');
  // The human approves an action that the queue shows: the name of the tool and the file, not only the kind of the action.
  assert.equal(listQueue(b.rt).find((q) => q.id === r.queued)?.what, 'write_file src/a.txt');
});

// ---- A failure of the adapter is a fact of the journal.

test('client: a failure of the adapter leaves a row of the journal, also for a read that passes without a word', () => {
  const b = box();
  const hook = (event: Record<string, unknown>) =>
    spawnSync(process.execPath, [CLAUDE, 'pre'], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, hook_event_name: 'PreToolUse', ...event }), env: b.env, encoding: 'utf8' }).stdout;
  // The place of the session files is a file: every decision fails.
  fs.mkdirSync(b.rt.stateDir, { recursive: true });
  fs.rmSync(path.join(b.rt.stateDir, 'sessions'), { recursive: true, force: true });
  fs.writeFileSync(path.join(b.rt.stateDir, 'sessions'), 'not a directory');
  const failures = () => readJournal(b.rt.journal.file).filter((r) => r.kind === 'harness.failure' && r.data?.where === 'adapter');
  // A write: the human decides, and the journal has the failure.
  const asked = JSON.parse(hook({ tool_name: 'mcp__x__y', tool_input: {} })).hookSpecificOutput;
  assert.equal(asked.permissionDecision, 'ask');
  assert.deepEqual(failures().map((r) => [r.data?.event, r.client]), [['pre', 'claude_code']]);
  // A read of the client passes without a word, as before; the failure is written all the same.
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: 'a.txt' } }), '');
  assert.equal(failures().length, 2);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

test('client: the second client writes down an input of an unknown form and a failure of its own', () => {
  const b = box();
  const stdio = (input: string) => spawnSync(process.execPath, [STDIO], { input, env: b.env, cwd: b.cwd, encoding: 'utf8' }).stdout;
  assert.deepEqual(JSON.parse(stdio('not json')), { outcome: 'ask', rule: 'adapter.shape' });
  assert.deepEqual(JSON.parse(stdio(JSON.stringify({ event: 'no-such-event', cwd: b.cwd }))), { outcome: 'ask', rule: 'adapter.shape' });
  const rows = readJournal(b.rt.journal.file);
  assert.deepEqual(rows.filter((r) => r.kind === 'harness.client_shape_changed').map((r) => [r.data?.client, r.data?.event]), [['stdio', 'unknown'], ['stdio', 'unknown']]);
  // An event with a known name and a part of an unknown form names the event.
  assert.deepEqual(JSON.parse(stdio(JSON.stringify({ event: 'before', cwd: b.cwd, tool: '', input: {} }))), { outcome: 'ask', rule: 'adapter.shape' });
  assert.deepEqual(readJournal(b.rt.journal.file).filter((r) => r.kind === 'harness.client_shape_changed').map((r) => r.data?.event), ['unknown', 'unknown', 'before']);
  fs.rmSync(path.join(b.rt.stateDir, 'sessions'), { recursive: true, force: true });
  fs.writeFileSync(path.join(b.rt.stateDir, 'sessions'), 'not a directory');
  assert.deepEqual(JSON.parse(stdio(JSON.stringify({ event: 'before', cwd: b.cwd, session: 'live', tool: 'unknown__tool', input: {} }))), { outcome: 'ask', rule: 'adapter.failure' });
  assert.deepEqual(readJournal(b.rt.journal.file).filter((r) => r.kind === 'harness.failure' && r.data?.where === 'adapter').map((r) => [r.data?.event, r.client]), [['before', 'stdio']]);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});
