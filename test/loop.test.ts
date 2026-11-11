// The task loop past one scenario in one session: a task that belongs to a session, a task with
// a contract, several executors, the level of the model.
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
import { applyEvent, approveContract, loadTask, mutateTask, openScenario, proposeContract, raiseLevel, type Runtime } from '../src/core/runtime.ts';
import { afterAction, beforeAction, type ClientTools } from '../src/client/before.ts';
import { executorReported, executorStarted } from '../src/client/executors.ts';
import { humanRequest, resumeTask, sessionEnd, sessionStart } from '../src/client/session.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const HOOK = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { read_file: { kind: 'read' } };
const TOOLS = { 'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' } };

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), tools: TOOLS, models: { weak: 'small-1', medium: 'mid-2', strong: 'big-3' } }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
const comment = (b: Box, session: string, change = '7') => ({ cwd: b.cwd, tool: 'tracker__add_comment', input: { change }, session });
function open(b: Box, session: string | undefined, change = '7'): string {
  const opened = openScenario(b.rt, 'change-review', { change_id: change }, session === undefined ? {} : { session });
  assert.ok(opened.ok);
  return opened.task.id;
}
const CONTRACT = {
  manifest: 1, name: 'fix-flaky-test', title: 'Fix the flaky test', package: 'person',
  trigger: { kind: 'command' }, model: { level: 'medium', token_limit: 50000 }, permissions: { read: ['code-host'] },
  done: { kind: 'human', retries: 1 }, output: { format: 'text', max_bytes: 2000 },
};

// ---- A task belongs to a session.

test('loop: the envelope of a task answers only the session that holds the task', () => {
  const b = box();
  const id = open(b, 's1');
  assert.equal(loadTask(b.rt, id)?.session, 's1');
  assert.deepEqual([beforeAction(b.rt, comment(b, 's2'), CLIENT).envelope, beforeAction(b.rt, comment(b, 's2'), CLIENT).task], ['none', undefined]);
  const own = beforeAction(b.rt, comment(b, 's1'), CLIENT);
  assert.deepEqual([own.envelope, own.task], ['confirm', id]);
  assert.ok(readJournal(b.rt.journal.file).some((r) => r.task === id && r.session === 's1'), 'the rows of the task carry its session');
});

test('loop: a task that no session holds answers any session', () => {
  const b = box();
  const id = open(b, undefined);
  assert.equal(beforeAction(b.rt, comment(b, 's9'), CLIENT).task, id);
});

test('loop: a new scenario in a session suspends the one before it, a resume brings it back', () => {
  const b = box();
  const first = open(b, 's1', '7');
  const second = open(b, 's1', '8');
  assert.equal(beforeAction(b.rt, comment(b, 's1', '7'), CLIENT).task, undefined, 'the first task is not the current one');
  assert.equal(beforeAction(b.rt, comment(b, 's1', '8'), CLIENT).task, second);
  assert.equal(loadTask(b.rt, first)?.state, 'executing', 'a suspended task stays open');
  assert.equal(resumeTask(b.rt, first, 's1'), true);
  assert.equal(beforeAction(b.rt, comment(b, 's1', '7'), CLIENT).task, first);
  assert.equal(beforeAction(b.rt, comment(b, 's1', '8'), CLIENT).task, undefined);
});

test('loop: a task continues in another session after a resume there', () => {
  const b = box();
  const id = open(b, 's1');
  sessionEnd(b.rt, { session: 's1', cwd: b.cwd });
  assert.equal(loadTask(b.rt, id)?.state, 'executing', 'the end of a session does not close a scenario task');
  assert.equal(resumeTask(b.rt, id, 's2'), true);
  assert.equal(loadTask(b.rt, id)?.session, 's2');
  assert.equal(beforeAction(b.rt, comment(b, 's2'), CLIENT).task, id);
  assert.equal(beforeAction(b.rt, comment(b, 's1'), CLIENT).task, undefined);
  assert.equal(resumeTask(b.rt, 'tffffffffffff', 's2'), false);
});

test('loop: the command line binds a task to the session that last spoke in that directory', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  spawnSync(process.execPath, [HOOK, 'prompt'], { input: JSON.stringify({ session_id: 'live-1', cwd: b.cwd, hook_event_name: 'UserPromptSubmit' }), env, encoding: 'utf8' });
  const opened = JSON.parse(spawnSync(process.execPath, [CLI, 'open', 'change-review', 'change_id=7'], { env, cwd: b.cwd, encoding: 'utf8' }).stdout);
  assert.equal(loadTask(b.rt, opened.task)?.session, 'live-1');
  // Another session takes the task over by reading its input.
  spawnSync(process.execPath, [HOOK, 'prompt'], { input: JSON.stringify({ session_id: 'live-2', cwd: b.cwd, hook_event_name: 'UserPromptSubmit' }), env, encoding: 'utf8' });
  spawnSync(process.execPath, [CLI, 'input', opened.task], { env, cwd: b.cwd, encoding: 'utf8' });
  assert.equal(loadTask(b.rt, opened.task)?.session, 'live-2');
});

// ---- A task with a contract.

test('loop: a contract is proposed by the agent and waits for the human', () => {
  const b = box();
  const r = proposeContract(b.rt, CONTRACT, { session: 's1' });
  assert.ok(r.ok);
  assert.deepEqual([r.task.kind, r.task.state, r.task.waiting, r.task.session], ['contract', 'waiting_human', 'contract', 's1']);
  const kinds = readJournal(b.rt.journal.file).map((x) => x.kind);
  assert.deepEqual(kinds, ['task.opened', 'task.kind_decided', 'task.contract_proposed', 'task.waiting_human']);
  // The agent cannot approve its own contract, and no work starts before the approval.
  assert.deepEqual(applyEvent(b.rt, r.task.id, { type: 'human', decision: 'accept' }, 'agent'), { error: 'not_allowed' });
  const report = applyEvent(b.rt, r.task.id, { type: 'report', size: 1, fp: '00000000' }, 'agent');
  assert.ok('task' in report && report.error === 'bad_event');
});

test('loop: the approval of the human starts the work of a contract, and its result is checked as the contract says', () => {
  const b = box();
  const r = proposeContract(b.rt, CONTRACT, {});
  assert.ok(r.ok);
  const started = approveContract(b.rt, r.task.id);
  assert.ok('task' in started);
  assert.equal(started.task.state, 'executing');
  const rows = readJournal(b.rt.journal.file);
  assert.deepEqual(rows.map((x) => x.kind).slice(4), ['task.human_decision', 'task.contract_approved', 'task.prepared', 'task.started']);
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  const reported = applyEvent(b.rt, r.task.id, { type: 'report', size: 10, fp: '00000000' }, 'agent');
  assert.ok('task' in reported);
  assert.deepEqual([reported.task.state, reported.task.waiting], ['waiting_human', 'approval']);
  assert.deepEqual(approveContract(b.rt, r.task.id), { error: 'not_a_proposal' }, 'an approval of a result is not an approval of a contract');
});

test('loop: the human refuses a contract: the task closes and nothing ran', () => {
  const b = box();
  const r = proposeContract(b.rt, CONTRACT, {});
  assert.ok(r.ok);
  const stopped = applyEvent(b.rt, r.task.id, { type: 'human', decision: 'stop' }, 'human');
  assert.ok('task' in stopped);
  assert.deepEqual([stopped.task.state, stopped.task.label], ['closed', 'not_verified']);
});

for (const [name, change, errors] of [
  ['needs a limit of tokens', (m: any) => void delete m.model.token_limit, ['missing model.token_limit']],
  ['cannot ask for more than the packs allow', (m: any) => void (m.model.token_limit = 900_000), ['above_pack model.token_limit']],
  ['cannot name a write that the packs do not have', (m: any) => void (m.permissions.write = [{ action: 'deploy', target: 'app/x', env: 'work', limit: 1, confirm: 'once' }]), ['not_in_pack permissions.write[0].action']],
  ['cannot take the name of a scenario', (m: any) => void (m.name = 'change-review'), ['duplicate name']],
  ['belongs to the person', (m: any) => void (m.package = 'organization'), ['not_allowed package']],
  ['is started by a command', (m: any) => void (m.trigger = { kind: 'schedule', value: '0 9 * * 1' }), ['not_allowed trigger.kind']],
] as const) {
  test(`loop: a contract ${name}`, () => {
    const b = box();
    const m = structuredClone(CONTRACT) as any;
    change(m);
    const r = proposeContract(b.rt, m, {});
    assert.ok(!r.ok);
    assert.deepEqual(r.details.map((e) => `${e.code} ${e.path}`), [...errors]);
    assert.equal(fs.existsSync(path.join(b.rt.stateDir, 'tasks')), false, 'no task exists for a refused contract');
  });
}

test('loop: the command line proposes a contract, and the approval is a command of the human', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const file = path.join(b.root, 'contract.json');
  fs.writeFileSync(file, JSON.stringify(CONTRACT));
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { env, cwd: b.cwd, encoding: 'utf8' }).stdout);
  const proposed = run(['propose', file]);
  assert.deepEqual([proposed.ok, proposed.state, proposed.waiting, proposed.contract.title], [true, 'waiting_human', 'contract', 'Fix the flaky test']);
  const approved = run(['approve', proposed.task]);
  assert.deepEqual([approved.state, approved.input.scenario, approved.input.report.check], ['executing', 'fix-flaky-test', 'human']);
  assert.deepEqual(run(['approve', proposed.task]).error, 'not_a_proposal');
  fs.writeFileSync(file, JSON.stringify({ ...CONTRACT, model: { level: 'medium' } }));
  assert.deepEqual(run(['propose', file]), { ok: false, error: 'bad_contract', details: [{ code: 'missing', path: 'model.token_limit' }] });
  const asked = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: `reins approve ${proposed.task}` } }, { shell: { kind: 'shell', command: 'command' } });
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'protect.human-command']);
});

// ---- Several executors and the level of the model.

test('loop: a subordinate executor starts only in a role and a count that the manifest names', () => {
  const b = box();
  const id = open(b, 's1');
  const first = executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' });
  assert.deepEqual([first.outcome, first.task], ['allow', id]);
  assert.deepEqual([executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }).rule], ['executor.limit']);
  assert.deepEqual([executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'coder' }).outcome, executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'coder' }).rule], ['deny', 'executor.role']);
  executorReported(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer', size: 100 });
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }).outcome, 'allow', 'a place is free after the report');
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind.startsWith('executor.'));
  assert.deepEqual(rows.map((r) => [r.kind, r.executor, r.parent, r.role]), [
    ['executor.started', 'sub', id, 'reviewer'], ['executor.report_received', 'sub', id, 'reviewer'], ['executor.started', 'sub', id, 'reviewer'],
  ]);
  for (const row of rows) assert.deepEqual(validateRow(row), []);
});

test('loop: a role name of a client is read in the form of the packs', () => {
  const b = box();
  open(b, 's1');
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'Plugin:Reviewer' }).rule, 'executor.role');
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'Reviewer' }).outcome, 'allow');
});

test('loop: outside a scenario the packs limit the count of executors', () => {
  const b = box();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const run = () => executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'anything' });
  assert.deepEqual([run().outcome, run().outcome, run().outcome, run().rule], ['allow', 'allow', 'deny', 'executor.limit']);
});

test('loop: the input names the level of the model, and the agent can raise it once to the level that the manifest allows', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { env, cwd: b.cwd, encoding: 'utf8' }).stdout);
  const opened = run(['open', 'change-review', 'change_id=7']);
  assert.deepEqual(opened.input.model, { level: 'medium', name: 'mid-2', raise_to: 'strong' });
  const raised = run(['raise', opened.task]);
  assert.deepEqual([raised.ok, raised.input.model], [true, { level: 'strong', name: 'big-3' }]);
  assert.deepEqual(run(['raise', opened.task]).error, 'not_allowed');
  assert.ok(readJournal(b.rt.journal.file).some((r) => r.kind === 'executor.level_raised' && r.level === 'strong'));
});

test('loop: a level cannot be raised when the manifest names no higher level', () => {
  const b = box();
  const r = proposeContract(b.rt, CONTRACT, {});
  assert.ok(r.ok);
  approveContract(b.rt, r.task.id);
  assert.deepEqual(raiseLevel(b.rt, r.task.id), { error: 'not_allowed' });
});

test('loop: the Claude Code adapter asks the core before a subordinate starts', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const hook = (mode: string, event: Record<string, unknown>) => spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, ...event }), env, encoding: 'utf8' }).stdout;
  hook('prompt', { hook_event_name: 'UserPromptSubmit' });
  spawnSync(process.execPath, [CLI, 'open', 'change-review', 'change_id=7'], { env, cwd: b.cwd, encoding: 'utf8' });
  assert.equal(hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'reviewer', prompt: 'x' } }), '');
  const denied = JSON.parse(hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'x' } }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /executor\.role/);
  assert.equal(hook('subagent-stop', { hook_event_name: 'SubagentStop', agent_type: 'reviewer' }), '');
  assert.ok(readJournal(b.rt.journal.file).some((r) => r.kind === 'executor.report_received'));
});

test('loop: a command in a subdirectory belongs to the session that spoke in the directory above', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  spawnSync(process.execPath, [HOOK, 'prompt'], { input: JSON.stringify({ session_id: 'live-1', cwd: b.cwd, hook_event_name: 'UserPromptSubmit' }), env, encoding: 'utf8' });
  const sub = path.join(b.cwd, 'deep', 'er');
  fs.mkdirSync(sub, { recursive: true });
  const opened = JSON.parse(spawnSync(process.execPath, [CLI, 'open', 'change-review', 'change_id=7'], { env, cwd: sub, encoding: 'utf8' }).stdout);
  assert.equal(loadTask(b.rt, opened.task)?.session, 'live-1');
});

test('loop: a report that names no running role frees no place', () => {
  const b = box();
  open(b, 's1');
  executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' });
  assert.deepEqual(executorReported(b.rt, { session: 's1', cwd: b.cwd, role: 'coder' }), {});
  assert.deepEqual(executorReported(b.rt, { session: 's1', cwd: b.cwd }), {}, 'a report without a role frees nothing');
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }).rule, 'executor.limit');
});

test('loop: an executor keeps its place and its parent when the free task of the session changes', () => {
  const b = box();
  const first = humanRequest(b.rt, { session: 's1', cwd: b.cwd }).task;
  const run = () => executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'helper' });
  assert.deepEqual([run().outcome, run().outcome], ['allow', 'allow']);
  const second = humanRequest(b.rt, { session: 's1', cwd: b.cwd }).task;
  assert.notEqual(first, second);
  assert.equal(run().rule, 'executor.limit', 'the two that still run keep their places');
  assert.deepEqual(executorReported(b.rt, { session: 's1', cwd: b.cwd, role: 'helper' }), { task: first }, 'the report goes to the task of the start');
  assert.equal(run().outcome, 'allow');
});

test('loop: an executor that did not report for an hour has no place any more', () => {
  const b = box();
  open(b, 's1');
  const t0 = Date.now();
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }, t0).outcome, 'allow');
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }, t0 + 30 * 60_000).rule, 'executor.limit');
  assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }, t0 + 61 * 60_000).outcome, 'allow');
});

test('loop: a proposal of a contract does not suspend the task of the session, its approval does', () => {
  const b = box();
  const id = open(b, 's1');
  const r = proposeContract(b.rt, CONTRACT, { session: 's1' });
  assert.ok(r.ok);
  assert.equal(beforeAction(b.rt, comment(b, 's1'), CLIENT).task, id, 'the scenario task still answers');
  approveContract(b.rt, r.task.id);
  assert.equal(beforeAction(b.rt, comment(b, 's1'), CLIENT).task, undefined, 'the contract is the current task now');
});

test('loop: a contract has no inputs', () => {
  const b = box();
  const r = proposeContract(b.rt, { ...CONTRACT, trigger: { kind: 'command', inputs: [{ name: 'x', type: 'id' }] } }, {});
  assert.ok(!r.ok);
  assert.deepEqual(r.details.map((e) => `${e.code} ${e.path}`), ['not_allowed trigger.inputs']);
});

test('loop: changes of one session file from many writers keep every field', () => {
  const b = box();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const id = open(b, 's1');
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const file = JSON.parse(fs.readFileSync(path.join(b.rt.stateDir, 'sessions', 's1.json'), 'utf8'));
  assert.deepEqual([file.scenario, file.requests, typeof file.task], [id, 2, 'string']);
});

// ---- Cases of the third review.

test('loop: a contract that waits for the human is not taken by reading its input', () => {
  const b = box();
  const id = open(b, 's1');
  const proposed = proposeContract(b.rt, CONTRACT, { session: 's1' });
  assert.ok(proposed.ok);
  assert.equal(resumeTask(b.rt, proposed.task.id, 's1'), false);
  assert.equal(beforeAction(b.rt, comment(b, 's1'), CLIENT).task, id, 'the task of the session still answers');
});

test('loop: a scenario task that does not execute starts no executor', () => {
  const b = box();
  const id = open(b, 's1');
  mutateTask(b.rt, id, (t) => ({ ...t, state: 'publishing' }));
  const r = executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'anything' });
  assert.deepEqual([r.outcome, r.rule, r.task], ['deny', 'executor.state', id]);
});

test('loop: a report frees the place of an executor that still runs, not of one that is too old', () => {
  const b = box();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const t0 = Date.now();
  const run = (at: number) => executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'helper' }, at);
  assert.deepEqual([run(t0).outcome, run(t0 + 30 * 60_000).outcome], ['allow', 'allow']);
  executorReported(b.rt, { session: 's1', cwd: b.cwd, role: 'helper' }, t0 + 65 * 60_000);
  assert.deepEqual([run(t0 + 70 * 60_000).outcome, run(t0 + 70 * 60_000).outcome, run(t0 + 70 * 60_000).rule], ['allow', 'allow', 'executor.limit']);
});

test('loop: the end of a session removes its file, and every request is counted', () => {
  const b = box();
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  const file = path.join(b.rt.stateDir, 'sessions', 's1.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).requests, 2);
  sessionEnd(b.rt, { session: 's1', cwd: b.cwd });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});
