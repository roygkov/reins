// The runtime on the disk: packs, a collect script, the task store and the journal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, confirm, decideAction, loadTask, openFreeTask, openScenario, readCollected, type Runtime } from '../src/core/runtime.ts';
import { runCollect } from '../src/core/collect.ts';
import type { Action } from '../src/contracts/policy.ts';
import { loadCases } from './cases.ts';

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};

const GOOD = `#!/bin/sh
cat > "$0.stdin"
printf '%s' '{"outputs":{"diff":"d","task":{"id":7},"discussion":[]},"flags":{"has_new_commits":true}}'
`;
const script = (body: string): string => `#!/bin/sh\ncat >/dev/null\n${body}\n`;

let n = 0;
// A fresh set of packs and a fresh state directory. `collect` is the body of the collect script.
function runtime(collect: string = GOOD): Runtime {
  n += 1;
  const root = path.join(SB, String(n));
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, collect, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const merged = loadPacks({ organization: path.join(root, 'organization'), project: path.join(root, 'project'), person: path.join(root, 'person') });
  assert.deepEqual(merged.rejected, []);
  const stateDir = path.join(root, 'state');
  return { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', session: 's-01', collectTimeoutMs: 10_000 };
}

const kinds = (rt: Runtime): string[] => readJournal(rt.journal.file).map((r) => r.kind);
const comment = (target: string): Action => ({ via: 'tool', kind: 'write', name: 'comment', target, env: { name: 'work', known: true, production: false } });

test('runtime: a scenario runs from the trigger to a verified close', () => {
  const rt = runtime();
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  assert.equal(opened.task.state, 'executing');
  assert.deepEqual(readCollected(rt, id), { diff: 'd', task: { id: 7 }, discussion: [] });

  const asked = decideAction(rt, id, comment('change/7'), []);
  assert.deepEqual([asked?.outcome, asked?.scope, asked?.envelope], ['ask', 'task', 'confirm']);
  confirm(rt, id, 'comment change/7 work');
  const allowed = decideAction(rt, id, comment('change/7'), []);
  assert.deepEqual([allowed?.outcome, allowed?.envelope], ['allow', 'applied']);
  assert.equal(loadTask(rt, id)?.use.used['comment change/7 work'], 1, 'the use is saved with the task');

  applyEvent(rt, id, { type: 'report', size: 300, fp: '9f3ac2d41b07' }, 'agent');
  const closed = applyEvent(rt, id, { type: 'check', result: 'PASS' }, 'harness');
  assert.ok('task' in closed);
  assert.deepEqual([closed.task.state, closed.task.label], ['closed', 'verified_form']);
  assert.deepEqual(loadTask(rt, id)?.state, 'closed', 'the state is on the disk');

  assert.deepEqual(kinds(rt), [
    'task.opened', 'task.kind_decided', 'task.prepared', 'task.started', 'policy.envelope_opened',
    'policy.decision', 'policy.basis', 'task.human_decision', 'policy.decision', 'policy.basis',
    'task.report_submitted', 'check.started', 'check.answered', 'policy.envelope_closed', 'task.closed',
  ]);
  const rows = readJournal(rt.journal.file);
  for (const row of rows) assert.deepEqual(validateRow(row), [], `the row ${row.kind} is valid`);
  assert.ok(rows.every((r) => r.task === id && r.project === 'p1a2b3c4' && r.session === 's-01' && r.scenario === 'change-review' && r.scenario_v === 1));
  assert.equal(rt.journal.failures, 0);
});

test('runtime: the collect script gets the inputs on its standard input', () => {
  const rt = runtime();
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const scriptFile = rt.merged.scriptFiles['collect/change'];
  assert.ok(scriptFile !== undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${scriptFile}.stdin`, 'utf8')), { inputs: { change_id: '7' } });
});

test('runtime: no work closes the task without the model', () => {
  const rt = runtime(script(`printf '%s' '{"outputs":{"diff":"","task":null,"discussion":[]},"flags":{"has_new_commits":false}}'`));
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'skipped');
  assert.deepEqual(kinds(rt), ['task.opened', 'task.kind_decided', 'task.skipped']);
  assert.equal(readCollected(rt, opened.task.id), null, 'nothing is kept for the model');
});

for (const [name, body, reason] of [
  ['exits with an error', 'exit 3', 'exit'],
  ['prints no JSON', 'echo hello', 'bad_json'],
  ['misses a named result', `printf '%s' '{"outputs":{"diff":"d"},"flags":{"has_new_commits":true}}'`, 'missing_output'],
  ['misses the flag', `printf '%s' '{"outputs":{"diff":"d","task":1,"discussion":[]},"flags":{}}'`, 'missing_flag'],
  ['gives a flag that is not a boolean', `printf '%s' '{"outputs":{"diff":"d","task":1,"discussion":[]},"flags":{"has_new_commits":"yes"}}'`, 'bad_shape'],
  ['adds an unknown field', `printf '%s' '{"outputs":{"diff":"d","task":1,"discussion":[]},"flags":{"has_new_commits":true},"note":"x"}'`, 'bad_shape'],
  ['runs past its time', 'exec sleep 3', 'timeout'],
  ['leaves a child process that runs past the time', 'sleep 3', 'timeout'],
  ['ends and leaves a child process that holds the output', `(sleep 3; echo late) &\nprintf '%s' 'not json'`, 'bad_json'],
] as const) {
  test(`runtime: a collect script that ${name} closes the task as not verified`, () => {
    const rt = runtime(script(body));
    // The first run of a new file can take hundreds of milliseconds: only the timeout case has a short limit.
    rt.collectTimeoutMs = reason === 'timeout' ? 500 : 10_000;
    const before = Date.now();
    const opened = openScenario(rt, 'change-review', { change_id: '7' });
    assert.ok(Date.now() - before < 2500, 'the limits hold for the children of the script');
    assert.ok(opened.ok);
    assert.deepEqual([opened.task.state, opened.task.label], ['closed', 'not_verified']);
    const rows = readJournal(rt.journal.file);
    assert.deepEqual(rows.map((r) => r.kind), ['task.opened', 'task.kind_decided', 'harness.failure', 'task.closed']);
    assert.deepEqual(rows[2]?.data, { where: 'collect', reason });
  });
}

test('runtime: the output of a collect script has a size limit', () => {
  const rt = runtime(script(`head -c 300000 /dev/zero | tr '\\0' 'a'`));
  const file = rt.merged.scriptFiles['collect/change'];
  assert.ok(file !== undefined);
  const r = runCollect(file, { inputs: {} }, { outputs: ['diff'], flags: [], timeoutMs: 2000, maxBytes: 1000 });
  assert.deepEqual(r, { ok: false, reason: 'too_large' });
});

test('runtime: a collect script does not get the environment of the harness', () => {
  process.env.REINS_TEST_SECRET = 'do-not-leak';
  try {
    const rt = runtime(script(`printf '{"outputs":{"diff":"%s","task":1,"discussion":[]},"flags":{"has_new_commits":true}}' "\${REINS_TEST_SECRET:-none}"`));
    const opened = openScenario(rt, 'change-review', { change_id: '7' });
    assert.ok(opened.ok);
    assert.deepEqual(readCollected(rt, opened.task.id)?.diff, 'none');
  } finally {
    delete process.env.REINS_TEST_SECRET;
  }
});

test('runtime: a scenario without a collect script starts at once', () => {
  const rt = runtime();
  const opened = openScenario(rt, 'draft-message', {});
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'executing');
  assert.deepEqual(kinds(rt), ['task.opened', 'task.kind_decided', 'task.prepared', 'task.started']);
});

test('runtime: a scenario is opened by its name and with valid inputs only', () => {
  const rt = runtime();
  assert.deepEqual(openScenario(rt, 'no-such', {}), { ok: false, error: 'unknown_scenario' });
  const bad = openScenario(rt, 'change-review', {});
  assert.deepEqual(bad, { ok: false, error: 'bad_inputs', details: [{ code: 'missing', path: 'change_id' }] });
  assert.deepEqual(kinds(rt), [], 'a refused trigger opens no task');
});

test('runtime: a disabled scenario does not open', () => {
  const rt = runtime();
  const s = rt.merged.scenarios.find((x) => x.name === 'draft-message');
  assert.ok(s !== undefined);
  s.manifest.state = 'disabled';
  assert.deepEqual(openScenario(rt, 'draft-message', {}), { ok: false, error: 'disabled' });
});

test('runtime: a task keeps the manifest it started with', () => {
  const rt = runtime();
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const s = rt.merged.scenarios.find((x) => x.name === 'change-review');
  assert.ok(s !== undefined);
  s.manifest.done.retries = 0;
  applyEvent(rt, opened.task.id, { type: 'report', size: 1, fp: '9f3ac2d41b07' }, 'agent');
  const r = applyEvent(rt, opened.task.id, { type: 'check', result: 'FAIL' }, 'harness');
  assert.ok('task' in r);
  assert.equal(r.task.state, 'executing', 'the task still has the two send-backs of its own copy');
});

test('runtime: a free task opens without a manifest and closes as not verified', () => {
  const rt = runtime();
  const task = openFreeTask(rt);
  const r = applyEvent(rt, task.id, { type: 'report', size: 10, fp: '9f3ac2d41b07' }, 'agent');
  assert.ok('task' in r);
  assert.deepEqual([r.task.state, r.task.label], ['closed', 'not_verified']);
  const rows = readJournal(rt.journal.file);
  assert.ok(rows.every((x) => x.scenario === undefined));
});

test('runtime: an event for an unknown task is refused', () => {
  const rt = runtime();
  assert.deepEqual(applyEvent(rt, 'nope', { type: 'expire' }, 'harness'), { error: 'unknown_task' });
  assert.deepEqual(applyEvent(rt, 'tabcdef012345', { type: 'expire' }, 'harness'), { error: 'unknown_task' });
  assert.equal(decideAction(rt, 'nope', comment('change/7'), []), null);
  assert.deepEqual(applyEvent(rt, '../../etc/passwd', { type: 'expire' }, 'harness'), { error: 'unknown_task' });
});

test('journal: a row that fails the check is not written, and the failure is counted', () => {
  const rt = runtime();
  const before = readJournal(rt.journal.file).length;
  const r = rt.journal.write({ kind: 'task.returned', project: 'p1', task: 't1', data: { reason: 'free text is not a reason' } });
  assert.equal(r.written, false);
  assert.deepEqual(r.errors.map((e) => `${e.code} ${e.path}`), ['free_text data.reason']);
  assert.equal(rt.journal.failures, 1);
  const rows = readJournal(rt.journal.file);
  assert.deepEqual(rows.slice(before).map((x) => [x.kind, x.data]), [['harness.failure', { where: 'journal' }]]);
});

test('journal: rows are only added, and a broken line does not hide the others', () => {
  const rt = runtime();
  rt.journal.write({ kind: 'memory.read', project: 'p1' });
  fs.appendFileSync(rt.journal.file, 'not json\n');
  rt.journal.write({ kind: 'memory.read', project: 'p1' });
  assert.deepEqual(readJournal(rt.journal.file).map((r) => r.kind), ['memory.read', 'memory.read']);
  assert.equal(fs.readFileSync(rt.journal.file, 'utf8').split('\n').length, 4);
});

test('journal: a write error does not stop the work', () => {
  const dir = path.join(SB, 'blocked');
  fs.writeFileSync(dir, 'a file where the state directory should be');
  const journal = openJournal(dir);
  const r = journal.write({ kind: 'memory.read', project: 'p1' });
  assert.equal(r.written, false);
  assert.equal(journal.failures, 1);
});

test('runtime: the agent cannot give a check answer or an approval', () => {
  const rt = runtime();
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  applyEvent(rt, id, { type: 'report', size: 1, fp: '9f3ac2d41b07' }, 'agent');
  assert.deepEqual(applyEvent(rt, id, { type: 'check', result: 'PASS' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'human', decision: 'accept' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'expire' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'report', size: 1, fp: '9f3ac2d41b07' }, 'human'), { error: 'not_allowed' });
  assert.equal(loadTask(rt, id)?.state, 'checking', 'the task did not move');
  assert.deepEqual(kinds(rt).slice(-2), ['task.report_submitted', 'check.started'], 'a refused event writes nothing');
});

test('runtime: one writer per task: a held lock makes the call busy, a stale lock is taken over', () => {
  const rt = runtime();
  rt.lockWaitMs = 100;
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  const lock = path.join(rt.stateDir, 'tasks', `${id}.lock`);
  fs.writeFileSync(lock, '');
  assert.deepEqual(applyEvent(rt, id, { type: 'ask' }, 'agent'), { error: 'busy' });
  assert.equal(decideAction(rt, id, comment('change/7'), []), null);
  assert.equal(confirm(rt, id, 'comment change/7 work'), false);
  assert.equal(loadTask(rt, id)?.state, 'executing');

  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const r = applyEvent(rt, id, { type: 'ask' }, 'agent');
  assert.ok('task' in r);
  assert.equal(r.task.state, 'waiting_human');
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
});

test('runtime: a task file with a broken shape is no task', () => {
  const rt = runtime();
  const opened = openScenario(rt, 'draft-message', {});
  assert.ok(opened.ok);
  const file = path.join(rt.stateDir, 'tasks', `${opened.task.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: opened.task.id, state: 'done' }));
  assert.equal(loadTask(rt, opened.task.id), null);
  assert.deepEqual(applyEvent(rt, opened.task.id, { type: 'expire' }, 'harness'), { error: 'unknown_task' });
});
