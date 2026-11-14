// What a task spends and where it stops: the tokens of a task and its limit, the judgement of a
// report of a subordinate executor, a contract task that needs more than its contract, and the
// words of the human for a task that waits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { eight } from '../src/journal/metrics.ts';
import { applyEvent, approveContract, loadTask, openScenario, proposeContract, type Runtime } from '../src/core/runtime.ts';
import { afterAction, beforeAction, type ClientTools } from '../src/client/before.ts';
import { noteCost } from '../src/client/cost.ts';
import { executorReported, executorStarted } from '../src/client/executors.ts';
import { agentStopped, humanRequest } from '../src/client/session.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CLAUDE = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const STDIO = fileURLToPath(new URL('../clients/stdio/hook.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: Record<string, any> }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { read_file: { kind: 'read' } };
const TOOLS = {
  'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' },
  // A read names its connector: a contract that does not name the connector does not cover the read.
  'tracker__get_change': { kind: 'read', connector: 'tracker' },
  'host__get_file': { kind: 'read', connector: 'code-host' },
  'plain__get': { kind: 'read' },
  // What the connector says about an action: it cannot be undone, another human sees it, it holds secrets.
  'tracker__purge_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work', irreversible: true },
  'vault__get_secret': { kind: 'read', sensitive: true },
  'tracker__say': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work', outward: true },
  // A tool that writes, and that reads when its text is a query: its reads go through a connector too.
  'db__query': { kind: 'write', action: 'comment', target: 'change/{sql}', env: 'work', read_when: { field: 'sql', pattern: 'select\\b.*' }, connector: 'tracker' },
};
const CONTRACT = {
  manifest: 1, name: 'fix-flaky-test', title: 'Fix the flaky test', package: 'person',
  trigger: { kind: 'command' }, model: { level: 'medium', token_limit: 1000 }, permissions: { read: ['code-host'] },
  done: { kind: 'human', retries: 1 }, output: { format: 'text', max_bytes: 2000 },
};

type Box = { rt: Runtime; root: string; cwd: string; config: string; env: Record<string, string> };
let n = 0;
function box(review: Record<string, unknown> = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'the first line of the file\nthe second line\n');
  const out = JSON.stringify({ outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${out}'\n`, { mode: 0o755 });
    else if (value === '$manifest:review') fs.writeFileSync(file, JSON.stringify({ ...manifests.get('review'), ...review }));
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), tools: TOOLS }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  assert.deepEqual(merged.rejected, []);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config, env: { PATH: process.env.PATH ?? '', HOME: root, REINS_CONFIG: config } };
}
function scenario(b: Box, session = 's1'): string {
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session });
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'executing');
  return opened.task.id;
}
const LIMITED = { model: { level: 'medium', raise_to: 'strong', executors: [{ role: 'reviewer', count: 1 }], token_limit: 1000 } };
const comment = (b: Box) => beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__add_comment', input: { change: '7' }, session: 's1' }, CLIENT);

// ---- The tokens of a task.

test('budget: the tokens that a client reports are counted in the task of the session', () => {
  const b = box(LIMITED);
  const id = scenario(b);
  assert.deepEqual(noteCost(b.rt, { session: 's1', tokens: 400 }), { task: id, tokens: 400, over: false });
  assert.deepEqual(noteCost(b.rt, { session: 's1', tokens: 300 }), { task: id, tokens: 700, over: false });
  assert.equal(loadTask(b.rt, id)?.cost?.tokens, 700);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost');
  assert.deepEqual(rows.map((r) => [r.task, r.scenario, r.data?.tokens]), [[id, 'change-review', 400], [id, 'change-review', 300]]);
  for (const r of rows) assert.deepEqual(validateRow(r), []);
  assert.deepEqual(eight(readJournal(b.rt.journal.file)).cost_per_scenario, { value: 700, prev: null, n: 1 });
});

test('budget: a task past its limit of tokens stops and waits for the human', () => {
  const b = box(LIMITED);
  const id = scenario(b);
  assert.equal(comment(b).task, id, 'the envelope answers before the limit');
  assert.deepEqual(noteCost(b.rt, { session: 's1', tokens: 1200 }), { task: id, tokens: 1200, over: true });
  assert.deepEqual([loadTask(b.rt, id)?.state, loadTask(b.rt, id)?.waiting], ['waiting_human', 'limit']);
  assert.equal(comment(b).task, undefined, 'the envelope of a task that waits does not answer');
  // The human gives the task one more budget of the same size, on top of what it spent.
  const more = applyEvent(b.rt, id, { type: 'human', decision: 'return' }, 'human');
  assert.ok('task' in more && more.error === undefined);
  assert.equal(more.task.state, 'executing');
  assert.equal(noteCost(b.rt, { session: 's1', tokens: 700 }).over, false, '1900 of 2200');
  assert.equal(noteCost(b.rt, { session: 's1', tokens: 400 }).over, true, '2300 of 2200');
  const stopped = applyEvent(b.rt, id, { type: 'human', decision: 'stop' }, 'human');
  assert.ok('task' in stopped);
  assert.deepEqual([stopped.task.state, stopped.task.label], ['closed', 'not_verified']);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

test('budget: without a limit in the manifest the limit of the packs holds, and a free task has no limit', () => {
  const b = box();
  const id = scenario(b);
  assert.equal(noteCost(b.rt, { session: 's1', tokens: 99_000 }).over, false);
  assert.equal(noteCost(b.rt, { session: 's1', tokens: 2_000 }).over, true, 'the project pack gives 100000');
  const free = humanRequest(b.rt, { session: 's2', cwd: b.cwd }).task;
  assert.deepEqual(noteCost(b.rt, { session: 's2', tokens: 5_000_000 }), { task: free, tokens: 5_000_000, over: false });
  assert.deepEqual(noteCost(b.rt, { session: 's2', tokens: 0 }), { task: free, tokens: 5_000_000, over: false }, 'nothing new is no row');
  assert.equal(readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost' && r.task === free).length, 1);
});

test('budget: a count of nothing after the end of the request opens no task', () => {
  const b = box();
  const free = humanRequest(b.rt, { session: 's3', cwd: b.cwd }).task;
  agentStopped(b.rt, { session: 's3', cwd: b.cwd });
  assert.equal(loadTask(b.rt, free)?.state, 'closed');
  const opened = (): number => readJournal(b.rt.journal.file).filter((r) => r.kind === 'task.opened').length;
  const before = opened();
  // The client ends a helper of its own after the turn: it spent nothing that the harness can see.
  assert.deepEqual(noteCost(b.rt, { session: 's3', tokens: 0 }), {});
  assert.equal(opened(), before, 'no empty task');
  // What was spent after the end of the request still needs a task.
  const late = noteCost(b.rt, { session: 's3', tokens: 50 });
  assert.equal(late.tokens, 50);
  assert.equal(opened(), before + 1);
});

test('budget: the clients report what the model spent', () => {
  const b = box(LIMITED);
  const stdio = (event: Record<string, unknown>) => spawnSync(process.execPath, [STDIO], { input: JSON.stringify({ cwd: b.cwd, session: 'live', ...event }), env: b.env, encoding: 'utf8' }).stdout;
  stdio({ event: 'request' });
  const opened = JSON.parse(spawnSync(process.execPath, [CLI, 'open', 'change-review', 'change_id=7'], { env: b.env, cwd: b.cwd, encoding: 'utf8' }).stdout);
  stdio({ event: 'after', tool: 'read_file', input: {}, tokens: 250 });
  // Every row that the adapter of the second client writes names that client.
  const ofStdio = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost');
  assert.ok(ofStdio.length > 0 && ofStdio.every((r) => r.client === 'stdio'), JSON.stringify(ofStdio.find((r) => r.client !== 'stdio')));
  assert.equal(loadTask(b.rt, opened.task)?.cost?.tokens, 250);
  // The first client reads the transcript of the session: only the lines that are new.
  const transcript = path.join(b.root, 'transcript.jsonl');
  const line = (input: number, output: number) => `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 10, cache_read_input_tokens: 9000 } } })}\n`;
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user' })}\n${line(100, 40)}not json\n`);
  const post = () => spawnSync(process.execPath, [CLAUDE, 'post'], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, transcript_path: transcript }), env: b.env, encoding: 'utf8' });
  post();
  assert.equal(loadTask(b.rt, opened.task)?.cost?.tokens, 400, '250 and 100 + 40 + 10');
  post();
  assert.equal(loadTask(b.rt, opened.task)?.cost?.tokens, 400, 'the same lines are not counted twice');
  fs.appendFileSync(transcript, line(500, 200));
  post();
  assert.deepEqual([loadTask(b.rt, opened.task)?.cost?.tokens, loadTask(b.rt, opened.task)?.waiting], [1110, 'limit']);
  // A row of the first client carries the kinds of the tokens and the count of the answers; these lines name no model.
  const ofClaude = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost' && r.client !== 'stdio');
  assert.deepEqual(ofClaude.map((r) => r.data), [{ tokens: 150, ms: 0, calls: 1, input: 100, output: 40, cache_write: 10, cache_read: 9000 }, { tokens: 710, ms: 0, calls: 1, input: 500, output: 200, cache_write: 10, cache_read: 9000 }]);
  // Each model of the new lines gets its own row with its name; a name that is no token is left out.
  const named = (id: string, model: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1, output_tokens: output } } })}\n`;
  fs.appendFileSync(transcript, named('a1', 'claude-fable-5-2', 10) + named('a2', 'claude-haiku-5-5', 20) + named('a3', 'claude-fable-5-2', 30) + named('a4', '<synthetic>', 5));
  post();
  const last = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost').slice(-3);
  assert.deepEqual(last.map((r) => [r.data?.model, r.data?.tokens, r.data?.calls]), [['claude-fable-5-2', 42, 2], ['claude-haiku-5-5', 21, 1], [undefined, 6, 1]]);
  for (const r of last) assert.deepEqual(validateRow(r), []);
});

// ---- The report of a subordinate executor.

test('budget: the report of a subordinate is a claim: the code judges its citations against the source of the task', () => {
  const b = box();
  const id = scenario(b);
  const run = (report?: string) => {
    assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer' }).outcome, 'allow');
    return executorReported(b.rt, { session: 's1', cwd: b.cwd, role: 'reviewer', ...(report !== undefined ? { report } : {}) });
  };
  const good = JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'the first line of the file', text: 'x' }] });
  const bad = JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'a line that the file does not have', text: 'x' }] });
  assert.deepEqual(run(good), { task: id, judged: 'PASS' });
  assert.deepEqual(run(bad), { task: id, judged: 'FAIL' });
  assert.deepEqual(run('plain words without citations'), { task: id, judged: 'FAIL' });
  assert.deepEqual(run(), { task: id }, 'without the text nothing is judged');
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.report_judged');
  assert.deepEqual(rows.map((r) => [r.executor, r.parent, r.role, r.data?.result]), [['sub', id, 'reviewer', 'PASS'], ['sub', id, 'reviewer', 'FAIL'], ['sub', id, 'reviewer', 'FAIL']]);
  for (const r of rows) assert.deepEqual(validateRow(r), []);
});

test('budget: outside a task with a source a report of a subordinate is not judged', () => {
  const b = box();
  const free = humanRequest(b.rt, { session: 's1', cwd: b.cwd }).task;
  executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: 'helper' });
  assert.deepEqual(executorReported(b.rt, { session: 's1', cwd: b.cwd, role: 'helper', report: 'done' }), { task: free });
});

// ---- A contract task that needs more.

test('budget: a contract task that needs a write that its contract does not name stops and asks for a new contract', () => {
  const b = box();
  const proposed = proposeContract(b.rt, CONTRACT, { session: 's1' });
  assert.ok(proposed.ok);
  const id = proposed.task.id;
  approveContract(b.rt, id);
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'read_file', input: {}, session: 's1' }, CLIENT).outcome, 'allow');
  const r = comment(b);
  assert.deepEqual([r.outcome, r.rule, r.task], ['deny', 'contract.scope', undefined]);
  assert.deepEqual([loadTask(b.rt, id)?.state, loadTask(b.rt, id)?.waiting], ['waiting_human', 'scope']);
  // The human lets the task go on: the write is then a plain question.
  applyEvent(b.rt, id, { type: 'human', decision: 'return' }, 'human');
  assert.equal(loadTask(b.rt, id)?.state, 'executing');
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'task.waiting_human' && x.data?.reason === 'scope'));
  for (const x of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(x), []);
});

test('budget: a contract task that reads through a connector that its contract does not name stops, too', () => {
  const b = box();
  const read = (tool: string, session = 's1') => beforeAction(b.rt, { cwd: b.cwd, tool, input: {}, session }, CLIENT);
  // No task: a read is a read.
  assert.equal(read('tracker__get_change').outcome, 'allow');
  const proposed = proposeContract(b.rt, CONTRACT, { session: 's1' });
  assert.ok(proposed.ok);
  const id = proposed.task.id;
  approveContract(b.rt, id);
  // The connector of the contract, a read with no connector, a read of the client: all pass.
  assert.equal(read('host__get_file').outcome, 'allow');
  assert.equal(read('plain__get').outcome, 'allow');
  assert.equal(read('read_file').outcome, 'allow');
  assert.equal(read('tracker__get_change', 's2').outcome, 'allow', 'another session holds no contract');
  const r = read('tracker__get_change');
  assert.deepEqual([r.outcome, r.rule, r.task], ['deny', 'contract.scope', undefined]);

  assert.deepEqual([loadTask(b.rt, id)?.state, loadTask(b.rt, id)?.waiting], ['waiting_human', 'scope']);
  // The human lets the task go on: the read is then a plain read.
  applyEvent(b.rt, id, { type: 'human', decision: 'return' }, 'human');
  assert.equal(read('tracker__get_change').outcome, 'allow');
  // A write tool whose call is a read goes through its connector, too.
  const again = proposeContract(b.rt, { ...CONTRACT, name: 'second-fix' }, { session: 's4' });
  assert.ok(again.ok);
  approveContract(b.rt, again.task.id);
  const q = beforeAction(b.rt, { cwd: b.cwd, tool: 'db__query', input: { sql: 'select 1' }, session: 's4' }, CLIENT);
  assert.deepEqual([q.outcome, q.rule], ['deny', 'contract.scope']);
  for (const x of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(x), []);
  // A scenario of a pack is not a contract: its reads are not stopped.
  const other = box();
  scenario(other);
  assert.equal(beforeAction(other.rt, { cwd: other.cwd, tool: 'tracker__get_change', input: {}, session: 's1' }, CLIENT).outcome, 'allow');
  // The pack: the connector of a read is a read connector of the pack.
  const base = { pack: 1, level: 'organization', name: 'acme', connectors: { read: ['tracker'], write: ['comment'] }, envs: { known: ['work'] } };
  assert.deepEqual(validateSettings({ ...base, tools: { a__get: { kind: 'read', connector: 'other' }, b__get: { kind: 'read', connector: 7 }, c__get: { kind: 'read', connector: 'tracker' } } }, 'organization').errors.map((e) => `${e.code} ${e.path}`), ['not_in_list tools.a__get.connector', 'not_in_list tools.b__get.connector']);
  // A write tool names a read connector only with `read_when`: without it the tool has no read.
  assert.deepEqual(validateSettings({ ...base, tools: { d__put: { kind: 'write', action: 'comment', target: 'x/{id}', env: 'work', connector: 'tracker' } } }, 'organization').errors.map((e) => `${e.code} ${e.path}`), ['not_in_list tools.d__put.connector']);
});

test('budget: the envelope of a task does not cover a write that cannot be undone, and a read of secrets asks', () => {
  const b = box();
  const id = scenario(b);
  // The manifest names the comment on this change, with one confirmation for the task.
  const first = comment(b);
  assert.deepEqual([first.outcome, first.envelope], ['ask', 'confirm']);
  afterAction(b.rt, { cwd: b.cwd, tool: 'tracker__add_comment', input: { change: '7' }, session: 's1' }, CLIENT);
  assert.deepEqual([comment(b).outcome, comment(b).envelope], ['allow', 'applied']);
  // The same action and the same target through a tool that cannot be undone: the human decides each one.
  const purge = () => beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__purge_comment', input: { change: '7' }, session: 's1' }, CLIENT);
  assert.deepEqual([purge().outcome, purge().envelope, purge().rule], ['ask', 'irreversible', 'default.write']);
  // A read of secrets asks, in a task and outside one.
  const secret = beforeAction(b.rt, { cwd: b.cwd, tool: 'vault__get_secret', input: {}, session: 's1' }, CLIENT);
  assert.deepEqual([secret.outcome, secret.rule], ['ask', 'default.sensitive-read']);
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'vault__get_secret', input: {}, session: 's9' }, CLIENT).outcome, 'ask');
  assert.equal(loadTask(b.rt, id)?.state, 'executing');
  for (const x of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(x), []);
  // The pack: a mark is `true` or it is not there; a read has no mark of a write.
  const base = { pack: 1, level: 'organization', name: 'acme', connectors: { read: ['tracker'], write: ['comment'] }, envs: { known: ['work'] } };
  const errors = (tools: unknown) => validateSettings({ ...base, tools }, 'organization').errors.map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors({ a__put: { kind: 'write', action: 'comment', target: 'x/{id}', env: 'work', irreversible: true, outward: true }, b__get: { kind: 'read', sensitive: true }, c__query: { kind: 'write', action: 'comment', target: 'x/{sql}', env: 'work', read_when: { field: 'sql', pattern: 'select\\b.*' }, sensitive: true } }), []);
  // The mark of secrets on a write that never reads says nothing: it is a mistake of the pack.
  assert.deepEqual(errors({ a__put: { kind: 'write', action: 'comment', target: 'x/{id}', env: 'work', sensitive: true } }), ['not_in_list tools.a__put.sensitive']);
  assert.deepEqual(errors({ a__put: { kind: 'write', action: 'comment', target: 'x/{id}', env: 'work', irreversible: false }, b__get: { kind: 'read', sensitive: 'yes', irreversible: true } }), ['not_in_list tools.a__put.irreversible', 'not_in_list tools.b__get.sensitive', 'unknown_field tools.b__get.irreversible']);
});

test('budget: a write that another human sees gets one confirmation for the task, also when the manifest asks for none', () => {
  const b = box({ permissions: { read: ['code-host', 'tracker'], write: [{ action: 'comment', target: 'change/{change_id}', env: 'work', limit: 3, confirm: 'none' }] } });
  scenario(b);
  const say = { cwd: b.cwd, tool: 'tracker__say', input: { change: '7' }, session: 's1' };
  // A plain comment passes at once: the manifest asks for no confirmation. The first of three.
  const plain = comment(b);
  assert.deepEqual([plain.outcome, plain.envelope], ['allow', 'applied']);
  // The tool that another human sees: one question for the task.
  const first = beforeAction(b.rt, say, CLIENT);
  assert.deepEqual([first.outcome, first.envelope, first.scope], ['ask', 'confirm', 'task']);
  // The tool ran: the human said "yes". The confirmation is kept, and the run is the second of three.
  assert.deepEqual(afterAction(b.rt, say, CLIENT), { confirmed: true });
  const second = beforeAction(b.rt, say, CLIENT);
  assert.deepEqual([second.outcome, second.envelope], ['allow', 'applied'], 'no second question; the third of three');
  const over = beforeAction(b.rt, say, CLIENT);
  assert.deepEqual([over.outcome, over.envelope], ['ask', 'limit'], 'the limit of the grant counts the confirmed tool too');
});

test('budget: a scenario task is not stopped by a write that its envelope does not name', () => {
  const b = box();
  const id = scenario(b);
  const r = beforeAction(b.rt, { cwd: b.cwd, tool: 'unknown__tool', input: {}, session: 's1' }, CLIENT);
  assert.deepEqual([r.outcome, r.rule], ['ask', 'default.unknown-tool']);
  assert.equal(loadTask(b.rt, id)?.state, 'executing');
});

// ---- The words of the human for a task that waits.

test('budget: the human accepts a result or gives one more try from the command line', () => {
  const b = box({ done: { kind: 'human', retries: 1 }, permissions: { read: ['code-host'] } });
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { env: b.env, cwd: b.cwd, encoding: 'utf8' }).stdout);
  const opened = run(['open', 'change-review', 'change_id=7']);
  const report = path.join(b.root, 'report.txt');
  fs.writeFileSync(report, 'the work is done');
  assert.deepEqual([run(['report', opened.task, report]).state, loadTask(b.rt, opened.task)?.waiting], ['waiting_human', 'approval']);
  assert.equal(run(['retry', opened.task]).state, 'executing');
  run(['report', opened.task, report]);
  const accepted = run(['approve', opened.task]);
  assert.deepEqual([accepted.state, accepted.label], ['closed', 'approved_by_human']);
  assert.equal(run(['retry', opened.task]).error, 'bad_event');
  const asked = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: `reins retry ${opened.task}` } }, { shell: { kind: 'shell', command: 'command' } });
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'protect.human-command']);
});

// ---- Cases of the review.

test('budget: one more budget counts from what the task spent while it waited', () => {
  const b = box(LIMITED);
  const id = scenario(b);
  noteCost(b.rt, { session: 's1', tokens: 1200 });
  noteCost(b.rt, { session: 's1', tokens: 1000 });
  applyEvent(b.rt, id, { type: 'human', decision: 'return' }, 'human');
  assert.equal(loadTask(b.rt, id)?.budget, 3200);
  assert.equal(noteCost(b.rt, { session: 's1', tokens: 500 }).over, false);
});

test('budget: a contract task stops also at a shell command that the gate reads as a write', () => {
  const b = box();
  const proposed = proposeContract(b.rt, CONTRACT, { session: 's1' });
  assert.ok(proposed.ok);
  approveContract(b.rt, proposed.task.id);
  const tools: ClientTools = { shell: { kind: 'shell', command: 'command' } };
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: 'ls -la' }, session: 's1' }, tools).outcome, 'allow');
  const r = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: 'git push --force origin main' }, session: 's1' }, tools);
  assert.deepEqual([r.outcome, r.rule], ['deny', 'contract.scope']);
  assert.equal(loadTask(b.rt, proposed.task.id)?.waiting, 'scope');
});

test('budget: what a session spent before the harness saw it is not counted', () => {
  // The harness can join a session that runs for hours: the plugin was installed in the middle.
  const b = box();
  const transcript = path.join(b.root, 'old-session.jsonl');
  const line = (id: string, at: string) => `${JSON.stringify({ type: 'assistant', timestamp: at, message: { id, usage: { input_tokens: 1000, output_tokens: 500 } } })}\n`;
  fs.writeFileSync(transcript, line('m1', '2020-01-01T00:00:00.000Z') + line('m2', '2020-01-01T00:05:00.000Z'));
  const post = () => spawnSync(process.execPath, [CLAUDE, 'post'], { input: JSON.stringify({ session_id: 'joined', cwd: b.cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, transcript_path: transcript }), env: b.env, encoding: 'utf8' });
  const counted = (): number => readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost').reduce((n, r) => n + Number((r.data as { tokens: number }).tokens), 0);
  post();
  assert.equal(counted(), 0, 'the lines are older than the first look of the harness');
  fs.appendFileSync(transcript, line('m3', new Date(Date.now() + 1000).toISOString()));
  post();
  assert.equal(counted(), 1500, 'a line after the first look is counted');
});

test('budget: the first look at a session sets its time, also when the look finds nothing to count', () => {
  const b = box();
  const transcript = path.join(b.root, 'new-session.jsonl');
  fs.writeFileSync(transcript, '');
  const post = () => spawnSync(process.execPath, [CLAUDE, 'post'], { input: JSON.stringify({ session_id: 'fresh', cwd: b.cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, transcript_path: transcript }), env: b.env, encoding: 'utf8' });
  const counted = (): number => readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost').reduce((n, r) => n + Number((r.data as { tokens: number }).tokens), 0);
  // The transcript is empty at the first look: nothing to count, but the session is known from now on.
  post();
  const line = `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm1', usage: { input_tokens: 700, output_tokens: 300 } } })}\n`;
  fs.appendFileSync(transcript, line);
  post();
  assert.equal(counted(), 1000, 'a line after the first look is counted, though the first look counted nothing');
});

test('budget: another transcript file is counted from its start', () => {
  const b = box(LIMITED);
  const line = `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 50 } } })}\n`;
  const post = (file: string) => spawnSync(process.execPath, [CLAUDE, 'post'], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, transcript_path: file }), env: b.env, encoding: 'utf8' });
  const first = path.join(b.root, 'one.jsonl');
  const second = path.join(b.root, 'two.jsonl');
  fs.writeFileSync(first, line + line + line);
  fs.writeFileSync(second, line);
  post(first);
  post(second);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost');
  assert.deepEqual(rows.map((r) => r.data?.tokens), [150, 150], 'one answer in three lines is counted once; the second file from its start');
});

// ---- Found in a live client.

test('budget: what the last answer of the model spent is counted at the end of the turn', () => {
  const b = box(LIMITED);
  const transcript = path.join(b.root, 'transcript.jsonl');
  const line = (id: string) => `${JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 100, output_tokens: 50 } } })}\n`;
  const hook = (mode: string, name: string) => spawnSync(process.execPath, [CLAUDE, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, hook_event_name: name, transcript_path: transcript, tool_name: 'Read', tool_input: {} }), env: b.env, encoding: 'utf8' });
  hook('prompt', 'UserPromptSubmit');
  fs.writeFileSync(transcript, line('m1'));
  hook('post', 'PostToolUse');
  fs.appendFileSync(transcript, line('m2'));
  hook('stop', 'Stop');
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost');
  assert.deepEqual(rows.map((r) => r.data?.tokens), [150, 150]);
  assert.equal(new Set(rows.map((r) => r.task)).size, 1, 'the cost of the last answer goes to the task of the turn, before it closes');
});

test('budget: a subordinate has a file of its own, and a helper of the client without a type is no executor', () => {
  const b = box(LIMITED);
  const main = path.join(b.root, 'main.jsonl');
  const sub = path.join(b.root, 'sub.jsonl');
  const line = (id: string, n: number) => `${JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: n, output_tokens: 0 } } })}\n`;
  const hook = (mode: string, event: Record<string, unknown>) => spawnSync(process.execPath, [CLAUDE, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, transcript_path: main, ...event }), env: b.env, encoding: 'utf8' });
  hook('prompt', { hook_event_name: 'UserPromptSubmit' });
  fs.writeFileSync(main, line('m1', 100));
  fs.writeFileSync(sub, line('s1', 40));
  hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } });
  hook('subagent-stop', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: sub, last_assistant_message: 'done' });
  fs.appendFileSync(main, line('m2', 7));
  hook('subagent-stop', { hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: '', last_assistant_message: 'a summary' });
  hook('stop', { hook_event_name: 'Stop' });
  const rows = readJournal(b.rt.journal.file);
  assert.deepEqual(rows.filter((r) => r.kind === 'executor.cost').map((r) => r.data?.tokens), [100, 40, 7], 'the main file, the file of the subordinate, the main file again: nothing twice');
  assert.equal(rows.filter((r) => r.kind === 'executor.report_received').length, 1, 'the helper without a type is no report');
});

test('budget: the file of the session keeps its mark however many subordinates the session runs', () => {
  const b = box(LIMITED);
  const main = path.join(b.root, 'main.jsonl');
  const line = (id: string) => `${JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, output_tokens: 0 } } })}\n`;
  const hook = (mode: string, event: Record<string, unknown>) => spawnSync(process.execPath, [CLAUDE, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, transcript_path: main, ...event }), env: b.env, encoding: 'utf8' });
  hook('prompt', { hook_event_name: 'UserPromptSubmit' });
  fs.writeFileSync(main, line('m1'));
  hook('stop', { hook_event_name: 'Stop' });
  // The session file as it is after sixty subordinates, each with a file of its own.
  const file = path.join(b.rt.stateDir, 'sessions', 'live.json');
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let i = 0; i < 60; i += 1) session.costMarks[`/tmp/sub-${i}.jsonl`] = 1;
  fs.writeFileSync(file, JSON.stringify(session));
  hook('prompt', { hook_event_name: 'UserPromptSubmit' });
  fs.appendFileSync(main, line('m2'));
  hook('stop', { hook_event_name: 'Stop' });
  hook('prompt', { hook_event_name: 'UserPromptSubmit' });
  hook('stop', { hook_event_name: 'Stop' });
  assert.deepEqual(readJournal(b.rt.journal.file).filter((r) => r.kind === 'executor.cost').map((r) => r.data?.tokens), [10, 10]);
});
