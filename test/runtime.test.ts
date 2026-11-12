// The runtime on the disk: packs, a collect script, the task store and the journal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, confirm, decideAction, loadTask, openFreeTask, openScenario, readCollected, readReport, runCheck, submitReport, type Runtime } from '../src/core/runtime.ts';
import { runCollect } from '../src/core/collect.ts';
import type { Action } from '../src/contracts/policy.ts';
import { loadCases, patch } from './cases.ts';

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};

const GOOD = `#!/bin/sh
cat > "$0.stdin"
printf '%s' '{"outputs":{"diff":"d","task":{"id":7},"discussion":[],"worktree":"/nonexistent"},"flags":{"has_new_commits":true}}'
`;
const script = (body: string): string => `#!/bin/sh\ncat >/dev/null\n${body}\n`;

let n = 0;
// A fresh set of packs and a fresh state directory. `collect` is the body of the collect script.
function runtime(collect: string = GOOD, change: unknown = {}): Runtime {
  n += 1;
  const root = path.join(SB, String(n));
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, collect, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(patch(manifests.get(value.slice(10)), value === '$manifest:review' ? change : {})));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const merged = loadPacks({ organization: path.join(root, 'organization'), project: path.join(root, 'project'), person: path.join(root, 'person') });
  assert.deepEqual(merged.rejected, []);
  const stateDir = path.join(root, 'state');
  return { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', session: 's-01', collectTimeoutMs: 10_000 };
}

const kinds = (rt: Runtime): string[] => readJournal(rt.journal.file).map((r) => r.kind);
const comment = (target: string): Action => ({ via: 'tool', kind: 'write', name: 'comment', target, env: { name: 'work', known: true, production: false } });

// The citation check in the runtime: the report of the agent is checked against the source that
// the collect step named. The agent submits the text; the harness runs the check and gives the answer.
const ITEM = { file: 'src/a.ts', line: 1, quote: 'const limit = items.length;', text: 'wrong' };
const GOOD_REPORT = JSON.stringify({ items: [ITEM] });
const BAD_REPORT = JSON.stringify({ items: [{ ...ITEM, quote: 'const limit = items.size();' }] });
const WITH_SOURCE = { collect: { outputs: ['diff', 'task', 'discussion', 'worktree', 'files'] }, done: { source: 'worktree' } };

function reviewed(change: unknown = WITH_SOURCE, worktree?: unknown, files: unknown = [{ path: 'src/a.ts' }]): Runtime {
  const tree = fs.mkdtempSync(path.join(SB, 'tree-'));
  fs.mkdirSync(path.join(tree, 'src'));
  fs.writeFileSync(path.join(tree, 'src/a.ts'), 'const limit = items.length;\n');
  fs.writeFileSync(path.join(tree, 'src/b.ts'), 'const other = items.length;\n');
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: worktree ?? tree, files }, flags: { has_new_commits: true } };
  return runtime(script(`printf '%s' '${JSON.stringify(out)}'`), change);
}

function open(rt: Runtime): string {
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'executing');
  return opened.task.id;
}

test('runtime: a scenario runs from the trigger to a verified close', () => {
  const rt = reviewed();
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  assert.equal(opened.task.state, 'executing');
  assert.deepEqual(Object.keys(readCollected(rt, id) ?? {}), ['diff', 'task', 'discussion', 'worktree', 'files']);

  const asked = decideAction(rt, id, comment('change/7'), []);
  assert.deepEqual([asked?.outcome, asked?.scope, asked?.envelope], ['ask', 'task', 'confirm']);
  confirm(rt, id, 'comment change/7 work');
  const allowed = decideAction(rt, id, comment('change/7'), []);
  assert.deepEqual([allowed?.outcome, allowed?.envelope], ['allow', 'applied']);
  assert.equal(loadTask(rt, id)?.use.used['comment change/7 work'], 1, 'the use is saved with the task');

  const submitted = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in submitted);
  assert.deepEqual([submitted.step.task.state, submitted.step.task.label], ['publishing', 'verified_form'], 'the check passed: the publication is open');
  const published = decideAction(rt, id, comment('change/7'), []);
  assert.deepEqual([published?.outcome, published?.envelope], ['allow', 'applied'], 'the envelope acts during the publication');
  assert.deepEqual(applyEvent(rt, id, { type: 'check', result: 'PASS' }, 'harness'), { error: 'not_allowed' });
  const closed = applyEvent(rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in closed);
  assert.deepEqual([closed.task.state, closed.task.label], ['closed', 'verified_form']);
  assert.deepEqual(loadTask(rt, id)?.state, 'closed', 'the state is on the disk');

  assert.deepEqual(kinds(rt), [
    'task.opened', 'task.kind_decided', 'task.prepared', 'task.started', 'policy.envelope_opened',
    'policy.decision', 'policy.basis', 'task.human_decision', 'policy.decision', 'policy.basis',
    'task.report_submitted', 'check.started', 'check.answered', 'policy.decision', 'policy.basis', 'policy.envelope_closed', 'task.closed',
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
  const rt = runtime(script(`printf '%s' '{"outputs":{"diff":"","task":null,"discussion":[],"worktree":"/nonexistent"},"flags":{"has_new_commits":false}}'`));
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
  ['misses the flag', `printf '%s' '{"outputs":{"diff":"d","task":1,"discussion":[],"worktree":"/nonexistent"},"flags":{}}'`, 'missing_flag'],
  ['gives a flag that is not a boolean', `printf '%s' '{"outputs":{"diff":"d","task":1,"discussion":[],"worktree":"/nonexistent"},"flags":{"has_new_commits":"yes"}}'`, 'bad_shape'],
  ['adds an unknown field', `printf '%s' '{"outputs":{"diff":"d","task":1,"discussion":[],"worktree":"/nonexistent"},"flags":{"has_new_commits":true},"note":"x"}'`, 'bad_shape'],
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
    // A step past its time is a row of its own, before the failure.
    const rows = readJournal(rt.journal.file).filter((r) => r.kind !== 'harness.step_timeout');
    assert.equal(readJournal(rt.journal.file).some((r) => r.kind === 'harness.step_timeout'), reason === 'timeout');
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
    const rt = runtime(script(`printf '{"outputs":{"diff":"%s","task":1,"discussion":[],"worktree":"/nonexistent"},"flags":{"has_new_commits":true}}' "\${REINS_TEST_SECRET:-none}"`));
    const opened = openScenario(rt, 'change-review', { change_id: '7' });
    assert.ok(opened.ok);
    assert.deepEqual(readCollected(rt, opened.task.id)?.diff, 'none');
  } finally {
    delete process.env.REINS_TEST_SECRET;
  }
});

test('runtime: a script of a pack gets the path of the config of the harness', () => {
  // A script can call the command line of the harness: it must reach the same config and state.
  const before = process.env.REINS_CONFIG;
  process.env.REINS_CONFIG = '/some/where/config.json';
  try {
    const rt = runtime(script(`printf '{"outputs":{"diff":"%s","task":1,"discussion":[],"worktree":"/nonexistent"},"flags":{"has_new_commits":true}}' "\${REINS_CONFIG:-none}"`));
    const opened = openScenario(rt, 'change-review', { change_id: '7' });
    assert.ok(opened.ok);
    assert.deepEqual(readCollected(rt, opened.task.id)?.diff, '/some/where/config.json');
  } finally {
    if (before === undefined) delete process.env.REINS_CONFIG;
    else process.env.REINS_CONFIG = before;
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
  const rt = reviewed();
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const s = rt.merged.scenarios.find((x) => x.name === 'change-review');
  assert.ok(s !== undefined);
  s.manifest.done.retries = 0;
  const r = submitReport(rt, opened.task.id, BAD_REPORT);
  assert.ok('step' in r);
  assert.equal(r.step.task.state, 'executing', 'the task still has the two send-backs of its own copy');
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
  const r = rt.journal.write({ kind: 'task.started', project: 'p1', task: 't1', data: { reason: 'free text is not a reason' } });
  assert.equal(r.written, false);
  assert.deepEqual(r.errors.map((e) => `${e.code} ${e.path}`), ['free_text data.reason']);
  assert.equal(rt.journal.failures, 1);
  const rows = readJournal(rt.journal.file);
  assert.deepEqual(rows.slice(before).map((x) => [x.kind, x.data]), [['harness.failure', { where: 'journal' }]]);
});

test('journal: rows are only added, and a broken line does not hide the others', () => {
  const rt = runtime();
  rt.journal.write({ kind: 'memory.read', project: 'p1', data: { n: 1 } });
  fs.appendFileSync(rt.journal.file, 'not json\n');
  rt.journal.write({ kind: 'memory.read', project: 'p1', data: { n: 1 } });
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
  // A check that the core runs takes the report only as text, and its answer only from the core.
  assert.deepEqual(applyEvent(rt, id, { type: 'report', size: 1, fp: '9f3ac2d41b07' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'check', result: 'PASS' }, 'harness'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'check', result: 'PASS' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'human', decision: 'accept' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'expire' }, 'agent'), { error: 'not_allowed' });
  assert.deepEqual(applyEvent(rt, id, { type: 'report', size: 1, fp: '9f3ac2d41b07' }, 'human'), { error: 'not_allowed' });
  assert.equal(loadTask(rt, id)?.state, 'executing', 'the task did not move');
  assert.deepEqual(kinds(rt).slice(-2), ['task.started', 'policy.envelope_opened'], 'a refused event writes nothing');
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

test('runtime: a report with true citations closes the task as "form verified"', () => {
  const rt = reviewed();
  const id = open(rt);
  const r = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in r);
  assert.deepEqual([r.answer?.result, r.answer?.n], ['PASS', 1]);
  assert.deepEqual([r.step.task.state, r.step.task.label], ['publishing', 'verified_form']);
  assert.equal(readReport(rt, id), GOOD_REPORT);
  applyEvent(rt, id, { type: 'finish' }, 'agent');
  assert.equal(loadTask(rt, id)?.state, 'closed');
  const rows = readJournal(rt.journal.file);
  assert.deepEqual(rows.slice(-5).map((x) => x.kind), ['task.report_submitted', 'check.started', 'check.answered', 'policy.envelope_closed', 'task.closed']);
  assert.deepEqual(rows.find((x) => x.kind === 'task.report_submitted')?.data?.size, Buffer.byteLength(GOOD_REPORT));
  assert.deepEqual(rows.find((x) => x.kind === 'check.answered')?.data, { result: 'PASS', check_kind: 'citations', n: 1, faults: 0 });
  for (const row of rows) assert.deepEqual(validateRow(row), [], `the row ${row.kind} is valid`);
  assert.equal(rt.journal.failures, 0);
});

test('runtime: a report with a false citation goes back, and past the limit the human decides', () => {
  const rt = reviewed();
  const id = open(rt);
  for (const returns of [1, 2]) {
    const r = submitReport(rt, id, BAD_REPORT);
    assert.ok('step' in r);
    assert.deepEqual([r.answer?.result, r.answer?.faults], ['FAIL', [{ n: 1, fault: 'not_found' }]]);
    assert.deepEqual([r.step.task.state, r.step.task.returns], ['executing', returns]);
  }
  const last = submitReport(rt, id, BAD_REPORT);
  assert.ok('step' in last);
  assert.deepEqual([last.step.task.state, last.step.task.waiting], ['waiting_human', 'check']);
  const rows = readJournal(rt.journal.file);
  assert.deepEqual(rows.findLast((x) => x.kind === 'check.answered')?.data, { result: 'FAIL', check_kind: 'citations', n: 1, faults: 1, reason: 'faults' });
  assert.equal(rt.journal.failures, 0);
});

test('runtime: a corrected report passes after a return', () => {
  const rt = reviewed();
  const id = open(rt);
  submitReport(rt, id, BAD_REPORT);
  const r = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in r);
  assert.deepEqual([r.step.task.state, r.step.task.label, r.step.task.returns], ['publishing', 'verified_form', 1]);
  assert.equal(readReport(rt, id), GOOD_REPORT, 'the last report is the one that is kept');
});

for (const [name, change, worktree] of [
  ['the source is not a path', WITH_SOURCE, 42],
  ['the source is a relative path', WITH_SOURCE, 'tree'],
  ['the source does not exist', WITH_SOURCE, '/nonexistent/reins-test-tree'],
] as const) {
  test(`runtime: the citation check gives no answer when ${name}`, () => {
    const rt = reviewed(change, worktree);
    const id = open(rt);
    const r = submitReport(rt, id, GOOD_REPORT);
    assert.ok('step' in r);
    assert.deepEqual([r.answer?.result, r.answer?.reason], ['none', 'no_source']);
    assert.deepEqual([r.step.task.state, r.step.task.returns], ['executing', 1], 'no answer is "not ready"');
    const rows = readJournal(rt.journal.file);
    assert.deepEqual(rows.findLast((x) => x.kind === 'check.no_answer')?.data, { check_kind: 'citations', reason: 'no_source' });
    assert.equal(rt.journal.failures, 0);
  });
}

test('runtime: a finding outside the changed files fails when the manifest names the list', () => {
  const rt = reviewed({ ...WITH_SOURCE, done: { source: 'worktree', changed: 'files' } });
  const id = open(rt);
  const report = JSON.stringify({ items: [{ ...ITEM, file: 'src/b.ts', quote: 'const other = items.length;' }] });
  const r = submitReport(rt, id, report);
  assert.ok('step' in r);
  assert.deepEqual([r.answer?.result, r.answer?.faults], ['FAIL', [{ n: 1, fault: 'not_in_change' }]]);
});

test('runtime: a list of changed files with a wrong shape gives no answer', () => {
  const rt = reviewed({ ...WITH_SOURCE, done: { source: 'worktree', changed: 'files' } }, undefined, 'src/a.ts');
  const id = open(rt);
  const r = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in r);
  assert.deepEqual([r.answer?.result, r.answer?.reason], ['none', 'no_source']);
});

test('runtime: a report is refused for a task that does not run, and nothing is kept', () => {
  const rt = reviewed();
  const id = open(rt);
  submitReport(rt, id, GOOD_REPORT);
  const again = submitReport(rt, id, BAD_REPORT);
  assert.ok('step' in again);
  assert.equal(again.step.error, 'bad_event');
  assert.equal(readReport(rt, id), GOOD_REPORT);
  assert.deepEqual(submitReport(rt, 'tffffffffffff', GOOD_REPORT), { error: 'unknown_task' });
});

test('runtime: a report over the size limit is refused', () => {
  const rt = reviewed();
  const id = open(rt);
  assert.deepEqual(submitReport(rt, id, 'x'.repeat((1 << 20) + 1)), { error: 'too_large' });
  assert.equal(loadTask(rt, id)?.state, 'executing');
});

test('runtime: a check that did not get its answer runs again from the kept report', () => {
  const rt = reviewed();
  const id = open(rt);
  // The state after a process that died, or met a busy lock, between the report and the answer.
  const task = loadTask(rt, id);
  assert.ok(task !== null);
  fs.writeFileSync(path.join(rt.stateDir, 'tasks', `${id}.json`), JSON.stringify({ ...task, state: 'checking' }));
  fs.writeFileSync(path.join(rt.stateDir, 'tasks', `${id}.report.txt`), GOOD_REPORT);
  const r = runCheck(rt, id);
  assert.ok('step' in r);
  assert.deepEqual([r.answer?.result, r.step.task.state, r.step.task.label], ['PASS', 'publishing', 'verified_form']);
  assert.deepEqual(runCheck(rt, id), { error: 'not_checking' }, 'a task past its check has no check to run');
});

test('runtime: a busy lock after the report leaves a check that can run again', () => {
  const rt = reviewed();
  const id = open(rt);
  const task = loadTask(rt, id);
  assert.ok(task !== null);
  fs.writeFileSync(path.join(rt.stateDir, 'tasks', `${id}.json`), JSON.stringify({ ...task, state: 'checking' }));
  fs.writeFileSync(path.join(rt.stateDir, 'tasks', `${id}.report.txt`), GOOD_REPORT);
  rt.lockWaitMs = 50;
  const lock = path.join(rt.stateDir, 'tasks', `${id}.lock`);
  fs.writeFileSync(lock, '');
  assert.deepEqual(runCheck(rt, id), { error: 'busy' });
  fs.rmSync(lock);
  const r = runCheck(rt, id);
  assert.ok('step' in r);
  assert.equal(r.step.task.state, 'publishing');
});

test('runtime: the list of changed files can use "./" and repeated separators', () => {
  const rt = reviewed({ ...WITH_SOURCE, done: { source: 'worktree', changed: 'files' } }, undefined, ['./src//a.ts']);
  const id = open(rt);
  const r = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in r);
  assert.equal(r.answer?.result, 'PASS');
});

test('runtime: the fields of an item come from the manifest of the task', () => {
  const rt = reviewed({ ...WITH_SOURCE, output: { fields: { severity: ['blocking', 'note'] } } });
  const id = open(rt);
  const bare = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in bare);
  assert.deepEqual([bare.answer?.result, bare.answer?.faults], ['FAIL', [{ n: 1, fault: 'bad_field' }]]);
  const full = submitReport(rt, id, JSON.stringify({ items: [{ ...ITEM, severity: 'note' }] }));
  assert.ok('step' in full);
  assert.deepEqual([full.answer?.result, full.step.task.state], ['PASS', 'publishing']);
});

test('runtime: a scenario without writes closes at PASS: there is nothing to publish', () => {
  const rt = reviewed({ ...WITH_SOURCE, permissions: { read: ['code-host', 'tracker'], write: [] } });
  const id = open(rt);
  const r = submitReport(rt, id, GOOD_REPORT);
  assert.ok('step' in r);
  assert.deepEqual([r.step.task.state, r.step.task.label], ['closed', 'verified_form']);
  const late = applyEvent(rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in late && late.error === 'bad_event', 'a closed task has no publication to end');
  assert.equal(loadTask(rt, id)?.state, 'closed');
});

test('runtime: only the agent or the human ends a publication', () => {
  const rt = reviewed();
  const id = open(rt);
  submitReport(rt, id, GOOD_REPORT);
  assert.deepEqual(applyEvent(rt, id, { type: 'finish' }, 'harness'), { error: 'not_allowed' });
  const closed = applyEvent(rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in closed && closed.task.state === 'closed');
  const again = applyEvent(rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in again && again.error === 'bad_event');
});

test('runtime: the end of a preparation waits for a busy lock and is not lost', () => {
  const rt = reviewed();
  rt.lockWaitMs = 100;
  // The lock is held when the collect ends and goes away a moment later. The process that removes
  // it leaves the process group of the script: the supervisor kills that group when the script ends.
  const tasks = path.join(rt.stateDir, 'tasks');
  const file = rt.merged.scriptFiles['collect/change'];
  assert.ok(file !== undefined);
  const body = fs.readFileSync(file, 'utf8');
  // A function as the replacement: `$'` in a replacement string has a special meaning.
  fs.writeFileSync(file, body.replace('cat >/dev/null\n', () => `cat >/dev/null\nid=$(ls "${tasks}" | grep -E '^t[0-9a-f]{12}\\.json$' | head -1 | sed 's/\\.json$//')\n: > "${tasks}/$id.lock"\npython3 -I -c 'import os,sys,time\nif os.fork(): os._exit(0)\nos.setsid()\ntime.sleep(0.25)\nos.remove(sys.argv[1])' "${tasks}/$id.lock" >/dev/null 2>&1\n`), { mode: 0o755 });
  const opened = openScenario(rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'executing');
  assert.equal(fs.existsSync(path.join(tasks, `${opened.task.id}.lock`)), false, 'the lock was held and then released');
  assert.ok(opened.collected !== null);
});
