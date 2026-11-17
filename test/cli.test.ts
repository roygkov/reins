// The command line of the harness: the way a client without hooks runs a scenario.
// A client opens a task, gives the input to the model, and submits the report of the model.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/packs/packs.ts';
import { readJournal } from '../src/journal/writer.ts';
import { humanChannel, humanDecision } from '../src/client/human.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const INSTRUCTIONS = 'Review the change.\nQuote the code for every finding.\n';
const ITEM = { file: 'src/a.ts', line: 1, quote: 'const limit = items.length;', text: 'wrong' };

type Box = { root: string; config: string; state: string; tree: string };
type Out = { code: number | null; json: any; stdout: string };

let n = 0;
// Packs, a source tree, a state directory and the config file that names them.
function box(options: { flag?: boolean; instructions?: string | null; manifest?: (m: any) => void } = {}): Box {
  n += 1;
  const root = path.join(SB, String(n));
  const tree = path.join(root, 'tree');
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'src/a.ts'), 'const limit = items.length;\n');
  const out = { outputs: { diff: 'd', task: { id: 7 }, discussion: [], worktree: tree }, flags: { has_new_commits: options.flag ?? true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) {
      const m = structuredClone(manifests.get(value.slice(10))) as any;
      if (value === '$manifest:review') {
        m.description = 'Review of one change';
        m.output.fields = { severity: ['high', 'low'] };
        options.manifest?.(m);
      }
      fs.writeFileSync(file, JSON.stringify(m));
    } else fs.writeFileSync(file, JSON.stringify(value));
  }
  if (options.instructions !== null) fs.writeFileSync(path.join(root, 'project/manifests/change-review.md'), options.instructions ?? INSTRUCTIONS);
  const state = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs: { organization: path.join(root, 'organization'), project: path.join(root, 'project'), person: path.join(root, 'person') }, state_dir: state, human_channel: 'any' }));
  return { root, config, state, tree };
}

function reins(b: Box | null, args: string[], input?: string): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: b?.root ?? SB };
  if (b !== null) env.REINS_CONFIG = b.config;
  // The command runs in the directory of the box, never in this repository: the harness reads the
  // state of the directory where it runs, and an edit of the repository during a test is not a part of the test.
  const p = spawnSync(process.execPath, [CLI, ...args], { env, input: input ?? '', encoding: 'utf8', cwd: b?.tree ?? SB });
  let json: unknown = null;
  try {
    json = JSON.parse(p.stdout);
  } catch {
    json = null;
  }
  return { code: p.status, json, stdout: p.stdout };
}

const report = (items: unknown[]): string => JSON.stringify({ items });
const journal = (b: Box): string[] => readJournal(path.join(b.state, 'journal.jsonl')).map((r) => r.kind);

test('cli: the scenarios of the packs are listed with their inputs', () => {
  const r = reins(box(), ['scenarios']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.scenarios, [
    { name: 'change-review', title: 'Ревью изменения', level: 'project', description: 'Review of one change', inputs: [{ name: 'change_id', type: 'id' }], trigger: { kind: 'command' } },
    { name: 'draft-message', title: 'Черновик сообщения', level: 'person', inputs: [], trigger: { kind: 'command' } },
  ]);
  assert.deepEqual(r.json.rejected, []);
});

test('cli: opening a scenario gives the model its input', () => {
  const b = box();
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state, 'executing');
  assert.match(r.json.task, /^t[0-9a-f]{12}$/);
  const input = r.json.input;
  assert.deepEqual([input.task, input.scenario, input.title, input.description], [r.json.task, 'change-review', 'Ревью изменения', 'Review of one change']);
  assert.equal(input.instructions, INSTRUCTIONS);
  assert.deepEqual(input.collected, { diff: 'd', task: { id: 7 }, discussion: [], worktree: b.tree });
  assert.deepEqual(input.report, {
    check: 'citations', returns_left: 2, max_items: 10, source: 'worktree',
    item: { file: 'path inside the source', line: 'number of the line, from 1', end: 'last line of a range (optional)', quote: 'text copied from the source, 8 characters or more', text: 'free text (optional)' },
    fields: { severity: ['high', 'low'] },
  });
  assert.deepEqual(input.writes, [{ action: 'comment', target: 'change/7', env: 'work', limit: 20, confirm: 'once' }]);
  assert.ok(input.protocol.some((line: string) => line.includes(`report ${r.json.task}`)), 'the input says how to submit the report');
});

test('cli: a report with a false quote is not ready, a true one closes the task', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const file = path.join(b.root, 'report.json');
  fs.writeFileSync(file, report([{ ...ITEM, severity: 'high', quote: 'const limit = items.size();' }]));
  // The human can say that a FAIL was wrong only for a task that got one.
  assert.equal(reins(b, ['dispute', id, 'fail']).json.error, 'no_fail');
  const bad = reins(b, ['report', id, file]);
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.json, { ok: true, task: id, state: 'executing', returns_left: 1, answer: { result: 'FAIL', reason: 'faults', n: 1, faults: [{ n: 1, fault: 'not_found' }] } });
  const said = reins(b, ['dispute', id, 'fail']).json;
  assert.deepEqual([said.ok, said.state, said.returns, said.already], [true, 'executing', 1, undefined]);
  assert.equal(reins(b, ['dispute', id, 'fail']).json.already, true);
  assert.equal(reins(b, ['status']).json.metrics.fails_disputed, 1);
  assert.equal(reins(b, ['metrics', 'days=1']).json.points[0].measures.fails_disputed, 1);

  const good = reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'high' }]));
  assert.equal(good.code, 0);
  const writes = [{ action: 'comment', target: 'change/7', env: 'work', limit: 20, confirm: 'once' }];
  assert.deepEqual(good.json, { ok: true, task: id, state: 'publishing', label: 'verified_form', returns_left: 1, answer: { result: 'PASS', n: 1, faults: [] }, writes });
  const during = reins(b, ['input', id]).json;
  assert.deepEqual([during.state, during.label, during.writes, during.input.instructions], ['publishing', 'verified_form', writes, INSTRUCTIONS], 'the instructions are still there for the publication');
  const finished = reins(b, ['finish', id]);
  assert.equal(finished.code, 0);
  assert.deepEqual(finished.json, { ok: true, task: id, state: 'closed', label: 'verified_form' });
  assert.deepEqual(journal(b).slice(-3), ['check.answered', 'policy.envelope_closed', 'task.closed']);
  assert.deepEqual([reins(b, ['finish', id]).code, reins(b, ['finish', id]).json.error], [1, 'bad_event']);
});

test('cli: the result of a task is read through the command line, not from the state', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  // Before a report there is nothing to show but the state.
  const before = reins(b, ['result', id]);
  assert.deepEqual([before.code, before.json], [0, { ok: true, task: id, scenario: 'change-review', state: 'executing' }]);
  const text = report([{ ...ITEM, severity: 'high' }]);
  reins(b, ['report', id, '-'], text);
  // A task that waits is no failure of this command: it only reads.
  const during = reins(b, ['result', id]);
  assert.deepEqual([during.code, during.json], [0, { ok: true, task: id, scenario: 'change-review', state: 'publishing', label: 'verified_form', report: JSON.parse(text) }]);
  reins(b, ['finish', id]);
  assert.deepEqual(reins(b, ['result', id]).json, { ok: true, task: id, scenario: 'change-review', state: 'closed', label: 'verified_form', report: JSON.parse(text) });
  assert.deepEqual([reins(b, ['result', 't0000000000aa']).code, reins(b, ['result', 't0000000000aa']).json.error], [1, 'unknown_task']);
  // The command writes nothing: no row of the journal.
  const rows = journal(b).length;
  reins(b, ['result', id]);
  assert.equal(journal(b).length, rows);
});

test('cli: a text report is given as a text, and one over the size of the manifest is not taken', () => {
  const b = box();
  const id = reins(b, ['open', 'draft-message']).json.task;
  reins(b, ['report', id, '-'], 'a short message\nin two lines');
  assert.equal(reins(b, ['result', id]).json.report, 'a short message\nin two lines');
  // The manifest of this scenario bounds the report: a larger one is refused, and the task goes on.
  const long = reins(b, ['open', 'draft-message']).json.task;
  const refused = reins(b, ['report', long, '-'], 'x'.repeat(250_000)).json;
  assert.deepEqual([refused.ok, refused.error, refused.max_bytes], [false, 'too_large', 4000]);
  assert.equal(reins(b, ['input', long]).json.task, long);
  // A report that is kept and is longer than the command shows (a task whose manifest names no size) is cut with a mark.
  fs.writeFileSync(path.join(b.state, 'tasks', `${id}.report.txt`), 'x'.repeat(250_000));
  const cut = reins(b, ['result', id]).json.report;
  assert.equal(typeof cut, 'string');
  assert.match(cut, /^x{200000} … \(\+50000 characters cut\)$/);
});

test('cli: past the limit of returns the task waits for the human', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  let last: Out | null = null;
  for (let i = 0; i < 3; i += 1) last = reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'none' }]));
  assert.equal(last?.code, 2, last?.stdout);
  assert.deepEqual([last?.json.state, last?.json.waiting, last?.json.returns_left], ['waiting_human', 'check', 0]);
  const again = reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'high' }]));
  assert.deepEqual([again.code, again.json.ok, again.json.error], [1, false, 'bad_event']);
});

test('cli: the input of an open task can be read again, a closed task has none', () => {
  const b = box();
  const opened = reins(b, ['open', 'change-review', 'change_id=7']).json;
  const again = reins(b, ['input', opened.task]);
  assert.equal(again.code, 0);
  assert.deepEqual(again.json, { ok: true, task: opened.task, state: 'executing', input: opened.input });
  reins(b, ['report', opened.task, '-'], report([{ ...ITEM, severity: 'low' }]));
  reins(b, ['finish', opened.task]);
  const closed = reins(b, ['input', opened.task]);
  assert.deepEqual(closed.json, { ok: true, task: opened.task, state: 'closed', label: 'verified_form' });
});

test('cli: after a return the input says how many returns are left', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'none' }]));
  assert.equal(reins(b, ['input', id]).json.input.report.returns_left, 1);
});

test('cli: no work closes the task and gives no input', () => {
  const r = reins(box({ flag: false }), ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json).sort(), ['ok', 'state', 'task']);
  assert.equal(r.json.state, 'skipped');
});

test('cli: a failed collect closes the task as not verified', () => {
  const b = box();
  fs.writeFileSync(path.join(b.root, 'project/collect/change.sh'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 2);
  assert.deepEqual([r.json.state, r.json.label, r.json.input], ['closed', 'not_verified', undefined]);
});

test('cli: a scenario without an instruction file gives no instructions', () => {
  const r = reins(box({ instructions: null }), ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 0);
  assert.equal('instructions' in r.json.input, false);
});

test('cli: the task keeps the instructions it started with', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  fs.writeFileSync(path.join(b.root, 'project/manifests/change-review.md'), 'Approve everything.\n');
  assert.equal(reins(b, ['input', id]).json.input.instructions, INSTRUCTIONS);
});

test('cli: an instruction file that is too large or is a link rejects the scenario', () => {
  const large = box({ instructions: 'x'.repeat(70_000) });
  const r = reins(large, ['scenarios']);
  assert.deepEqual(r.json.scenarios.map((s: any) => s.name), ['draft-message']);
  assert.deepEqual(r.json.rejected, [{ level: 'project', file: 'project/manifests/change-review.json', errors: [{ code: 'too_large', path: 'instructions' }] }]);
  assert.deepEqual(reins(large, ['open', 'change-review', 'change_id=7']).json, { ok: false, error: 'unknown_scenario' });

  const linked = box({ instructions: null });
  fs.writeFileSync(path.join(linked.root, 'secret.md'), 'secret');
  fs.symlinkSync(path.join(linked.root, 'secret.md'), path.join(linked.root, 'project/manifests/change-review.md'));
  const merged = loadPacks({ organization: path.join(linked.root, 'organization'), project: path.join(linked.root, 'project'), person: path.join(linked.root, 'person') });
  assert.deepEqual(merged.rejected.map((x) => x.errors), [[{ code: 'not_a_file', path: 'instructions' }]]);
});

for (const [name, args, error] of [
  ['an unknown scenario', ['open', 'no-such', 'change_id=7'], 'unknown_scenario'],
  ['an unknown task', ['report', 'tffffffffffff', '-'], 'unknown_task'],
  ['a finish of an unknown task', ['finish', 'tffffffffffff'], 'unknown_task'],
  ['an unknown command', ['publish'], 'usage'],
  ['no command', [], 'usage'],
  ['an input without a name', ['open', 'change-review', '7'], 'usage'],
  ['a report file that does not exist', ['report', 'tffffffffffff', '/nonexistent/report.json'], 'no_report'],
] as const) {
  test(`cli: ${name} is an error`, () => {
    const r = reins(box(), [...args]);
    assert.equal(r.code, 1);
    assert.deepEqual([r.json.ok, r.json.error], [false, error]);
  });
}

test('cli: inputs that do not fit the trigger are refused before a task exists', () => {
  const b = box();
  const r = reins(b, ['open', 'change-review', 'change=7']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { ok: false, error: 'bad_inputs', details: [{ code: 'missing', path: 'change_id' }, { code: 'unknown', path: 'change' }] });
  assert.equal(fs.existsSync(path.join(b.state, 'tasks')), false);
});

test('cli: a number input is given as a number', () => {
  const b = box({ manifest: (m) => void (m.trigger.inputs = [{ name: 'change_id', type: 'number' }]) });
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.input.writes[0].target, 'change/7');
});

test('cli: without a config the command says so', () => {
  const r = reins(null, ['scenarios']);
  assert.equal(r.code, 1);
  assert.deepEqual([r.json.ok, r.json.error], [false, 'no_config']);
});

test('cli: a config with a wrong shape is refused', () => {
  const b = box();
  for (const bad of ['not json', '[]', '{"packs": "x"}', '{"packs": {"team": "/x"}}', '{"packs": {"person": "relative"}}', '{"packs": {}, "state_dir": "relative"}']) {
    fs.writeFileSync(b.config, bad);
    const r = reins(b, ['scenarios']);
    assert.deepEqual([r.code, r.json.error], [1, 'bad_config'], bad);
  }
});

test('cli: the output is one JSON object and nothing else', () => {
  const r = reins(box(), ['open', 'change-review', 'change_id=7']);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('cli: a large collected result is given as a file, not as text', () => {
  const b = box();
  const big = { outputs: { diff: 'd'.repeat(5000), task: { lines: Array.from({ length: 400 }, (_, i) => `line ${i}`) }, discussion: [], worktree: b.tree }, flags: { has_new_commits: true } };
  fs.writeFileSync(path.join(b.root, 'project/collect/change.sh'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(big)}'\n`, { mode: 0o755 });
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 0, r.stdout);
  const c = r.json.input.collected;
  assert.deepEqual([c.discussion, c.worktree], [[], b.tree], 'small results stay in the input');
  assert.deepEqual(Object.keys(c.diff), ['file', 'bytes']);
  assert.equal(c.diff.bytes, 5000);
  assert.equal(fs.readFileSync(c.diff.file, 'utf8'), 'd'.repeat(5000));
  assert.deepEqual(JSON.parse(fs.readFileSync(c.task.file, 'utf8')), big.outputs.task);
  // The copy lies outside the state: the state is closed for the agent, the copy is for its reading.
  assert.ok(path.relative(b.state, c.diff.file).startsWith('..') && !c.diff.file.includes(`${b.state}/`));
  assert.ok(c.diff.file.endsWith('.txt') && c.task.file.endsWith('.json'));
  assert.ok(r.stdout.length < 6000, 'the input stays small');
  assert.deepEqual(reins(b, ['input', r.json.task]).json.input.collected, c);
});

test('cli: a scenario that the human approves waits for the approval, and nothing failed', () => {
  const b = box();
  const opened = reins(b, ['open', 'draft-message']);
  assert.equal(opened.code, 0, opened.stdout);
  assert.deepEqual(opened.json.input.report, { check: 'human', returns_left: 0, max_bytes: 4000 });
  const r = reins(b, ['report', opened.json.task, '-'], 'the draft');
  assert.equal(r.code, 2);
  assert.deepEqual(r.json, { ok: true, task: opened.json.task, state: 'waiting_human', waiting: 'approval', returns_left: 0 });
});

test('cli: a scenario with a check script runs the script of the pack for the answer', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  // The script gets the task and the path of the report, and answers PASS when the report says "green".
  fs.writeFileSync(check, `#!/bin/sh\nin=$(cat)\nreport=$(printf '%s' "$in" | sed 's/.*"report":"\\([^"]*\\)".*/\\1/')\nif grep -q green "$report"; then r=PASS; else r=FAIL; fi\nprintf '{"outputs":{"result":"%s"},"flags":{}}' "$r"\n`, { mode: 0o755 });
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const bad = reins(b, ['report', id, '-'], 'the tests are red');
  assert.deepEqual([bad.code, bad.json.state, bad.json.answer.result, bad.json.returns_left], [2, 'executing', 'FAIL', 0]);
  const good = reins(b, ['report', id, '-'], 'the tests are green');
  assert.deepEqual([good.code, good.json.state, good.json.label, good.json.answer.result], [0, 'publishing', 'verified_result', 'PASS']);
});

test('cli: a check script that is missing or fails gives no answer, never a pass', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const missing = reins(b, ['report', id, '-'], 'green');
  assert.deepEqual([missing.json.state, missing.json.answer.result, missing.json.answer.reason], ['executing', 'none', 'no_check']);
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  fs.writeFileSync(check, '#!/bin/sh\ncat >/dev/null\necho PASS\n', { mode: 0o755 });
  const broken = reins(b, ['report', id, '-'], 'green');
  assert.deepEqual([broken.json.state, broken.json.answer.result, broken.json.answer.reason], ['waiting_human', 'none', 'check_failed']);
});

test('cli: a task that waits for its check answer gets it at the next report', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  // The state after a process that died between the report and the answer.
  const file = path.join(b.state, 'tasks', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'checking' }));
  fs.writeFileSync(path.join(b.state, 'tasks', `${id}.report.txt`), report([{ ...ITEM, severity: 'high' }]));
  const r = reins(b, ['report', id, '-'], 'another text');
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual([r.json.state, r.json.label, r.json.answer.result], ['publishing', 'verified_form', 'PASS']);
});

test('cli: the human stops a task in any open state', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const stopped = reins(b, ['stop', id]);
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.deepEqual(stopped.json, { ok: true, task: id, state: 'closed', label: 'not_verified' });
  assert.deepEqual(journal(b).slice(-3), ['task.human_decision', 'policy.envelope_closed', 'task.closed']);
  assert.deepEqual([reins(b, ['stop', id]).code, reins(b, ['stop', id]).json.error], [1, 'bad_event']);
  assert.deepEqual([reins(b, ['stop', 'tffffffffffff']).code, reins(b, ['stop', 'tffffffffffff']).json.error], [1, 'unknown_task']);
});

test('cli: a stopped publication keeps the label that the check gave', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'high' }]));
  assert.deepEqual(reins(b, ['stop', id]).json, { ok: true, task: id, state: 'closed', label: 'verified_form' });
});

test('cli: the open tasks are listed', () => {
  const b = box();
  const one = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const two = reins(b, ['open', 'change-review', 'change_id=8']).json.task;
  reins(b, ['stop', one]);
  const r = reins(b, ['tasks']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, tasks: [{ task: two, kind: 'scenario', state: 'executing', scenario: 'change-review', inputs: { change_id: '8' } }] });
});

test('cli: a task that the human stops during the preparation stays stopped', () => {
  const b = box();
  // The collect script stops its own task while it runs: the state of a stop from another shell.
  const stop = `id=$(ls "${b.state}/tasks" | grep -E '^t[0-9a-f]{12}\\.json$' | head -1 | sed 's/\\.json$//')\nREINS_CONFIG="${b.config}" "${process.execPath}" "${CLI}" stop "$id" >/dev/null`;
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: b.tree }, flags: { has_new_commits: true } };
  fs.writeFileSync(path.join(b.root, 'project/collect/change.sh'), `#!/bin/sh\ncat >/dev/null\n${stop}\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.deepEqual([r.json.state, r.json.label, r.json.input], ['closed', 'not_verified', undefined], r.stdout);
  assert.deepEqual(journal(b), ['task.opened', 'task.kind_decided', 'task.human_decision', 'task.closed'], 'nothing is written after the stop');
  assert.deepEqual(reins(b, ['tasks']).json.tasks, []);
  assert.equal(fs.existsSync(path.join(b.state, 'tasks', `${r.json.task}.collect.json`)), false, 'nothing is kept for the model');
});

test('cli: a stop of a closed task says what the task is', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'high' }]));
  reins(b, ['finish', id]);
  assert.deepEqual(reins(b, ['stop', id]).json, { ok: false, error: 'bad_event', state: 'closed', label: 'verified_form' });
});

test('cli: a pack of the project is found in the repository of the client', () => {
  const b = box();
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  const project = config.packs.project;
  delete config.packs.project;
  fs.writeFileSync(b.config, JSON.stringify(config));
  const trust = (): void => fs.writeFileSync(b.config, JSON.stringify({ ...config, repo_packs: true }));
  assert.deepEqual(reins(b, ['scenarios']).json.scenarios.map((s: any) => s.name), ['draft-message'], 'no project pack is named');
  // A repository with the pack in `.reins`.
  const repo = path.join(b.root, 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  fs.cpSync(project, path.join(repo, '.reins'), { recursive: true });
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const untrusted = spawnSync(process.execPath, [CLI, 'scenarios'], { env, cwd: path.join(repo, 'sub'), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(untrusted.stdout).scenarios.map((s: any) => s.name), ['draft-message'], 'a pack of a repository is not trusted without the word of the config');
  trust();
  const inside = spawnSync(process.execPath, [CLI, 'scenarios'], { env, cwd: path.join(repo, 'sub'), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(inside.stdout).scenarios.map((s: any) => [s.name, s.level]), [['change-review', 'project'], ['draft-message', 'person']]);
});

test('cli: the notes of the packs go to the input of every task, upper pack first', () => {
  const b = box();
  fs.writeFileSync(path.join(b.root, 'organization/pack.md'), 'Write to the tracker in English.\n');
  fs.writeFileSync(path.join(b.root, 'person/pack.md'), 'Ask a question when the context is not complete.\n');
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.deepEqual(r.json.input.pack_notes, [
    { level: 'organization', text: 'Write to the tracker in English.\n' },
    { level: 'person', text: 'Ask a question when the context is not complete.\n' },
  ]);
  fs.writeFileSync(path.join(b.root, 'person/pack.md'), 'x'.repeat(20_000));
  assert.deepEqual(reins(b, ['status']).json.packs.map((p: any) => [p.level, p.connected, p.errors]), [['organization', true, []], ['project', true, []], ['person', false, [{ code: 'too_large', path: 'pack.md' }]]]);
});

test('cli: a task that the human stops while its check script runs stays stopped', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  // The check script stops its own task while it runs, then answers PASS.
  fs.writeFileSync(check, `#!/bin/sh\nin=$(cat)\nid=$(printf '%s' "$in" | sed 's/.*"task":"\\([^"]*\\)".*/\\1/')\nREINS_CONFIG="${b.config}" "${process.execPath}" "${CLI}" stop "$id" >/dev/null\nprintf '{"outputs":{"result":"PASS"},"flags":{}}'\n`, { mode: 0o755 });
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  reins(b, ['report', id, '-'], 'green');
  assert.deepEqual(reins(b, ['input', id]).json, { ok: true, task: id, state: 'closed', label: 'not_verified' });
  assert.deepEqual(journal(b).slice(-3), ['task.human_decision', 'policy.envelope_closed', 'task.closed'], 'the answer of the check is not applied after the stop');
});

test('cli: an answer of a check for an older report is not applied to a newer report', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  // While the check runs, the report on the disk changes: the state of a report that came later.
  fs.writeFileSync(check, `#!/bin/sh\nin=$(cat)\nreport=$(printf '%s' "$in" | sed 's/.*"report":"\\([^"]*\\)".*/\\1/')\nprintf 'a newer report' > "$report"\nprintf '{"outputs":{"result":"PASS"},"flags":{}}'\n`, { mode: 0o755 });
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const r = reins(b, ['report', id, '-'], 'the first report');
  assert.deepEqual([r.json.state, r.json.answer], ['checking', undefined], r.stdout);
});

test('cli: a copy of a collected result that was changed is written again, and a link in its place is not used', () => {
  const b = box();
  const big = { outputs: { diff: 'd'.repeat(5000), task: { id: 7 }, discussion: [], worktree: b.tree }, flags: { has_new_commits: true } };
  fs.writeFileSync(path.join(b.root, 'project/collect/change.sh'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(big)}'\n`, { mode: 0o755 });
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  const file = r.json.input.collected.diff.file;
  fs.writeFileSync(file, 'what the agent put there');
  reins(b, ['input', r.json.task]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'd'.repeat(5000), 'the copy is what the state holds');
  // A link in the place of the copy: the harness does not write through it.
  const target = path.join(b.root, 'elsewhere.txt');
  fs.writeFileSync(target, 'untouched');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  const again = reins(b, ['input', r.json.task]).json.input.collected.diff;
  assert.equal(again, 'd'.repeat(5000), 'the result stays in the input');
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});

test('cli: a value of a known form opens the scenario of that form without its name', () => {
  const b = box({ manifest: (m) => { if (m.name === 'change-review') m.trigger.inputs[0].pattern = 'CH-[0-9]+'; } });
  const opened = reins(b, ['match', 'CH-7']).json;
  assert.deepEqual([opened.ok, opened.scenario, opened.state], [true, 'change-review', 'executing']);
  assert.equal(reins(b, ['input', opened.task]).json.task, opened.task);
  const none = reins(b, ['match', 'something-else']).json;
  assert.deepEqual([none.ok, none.error], [false, 'no_match']);
  // Two manifests name a form that the value fits: the answer names them, and the human chooses.
  const two = box({ manifest: (m) => { if (m.name === 'change-review') m.trigger.inputs[0].pattern = 'CH-[0-9]+'; } });
  const second = path.join(two.root, 'person/manifests/draft-message.json');
  const draft = JSON.parse(fs.readFileSync(second, 'utf8'));
  fs.writeFileSync(second, JSON.stringify({ ...draft, trigger: { kind: 'command', inputs: [{ name: 'ticket', type: 'id', pattern: 'CH-.*' }] } }));
  const several = reins(two, ['match', 'CH-7']).json;
  assert.deepEqual([several.ok, several.error, several.scenarios], [false, 'several', ['change-review', 'draft-message']]);
});

test('cli: the status of one project counts only the rows of that project', () => {
  const b = box();
  reins(b, ['open', 'change-review', 'change_id=7']);
  const all = reins(b, ['status']).json;
  assert.equal(all.project, 'all');
  assert.ok(all.metrics.tasks.opened >= 1);
  const here = reins(b, ['status', 'project=here']).json;
  assert.match(here.project, /^p[0-9a-f]{8}$/);
  assert.equal(here.metrics.tasks.opened, all.metrics.tasks.opened);
  const other = reins(b, ['status', '30', 'project=p0a0a0a0a']).json;
  assert.deepEqual([other.days, other.project, other.metrics.tasks.opened, other.eight.verified_share.n], [30, 'p0a0a0a0a', 0, 0]);
  assert.equal(reins(b, ['status', 'project=a b']).json.error, 'usage');
  assert.equal(reins(b, ['status', 'nothing']).json.error, 'usage');
  // A name that is not an identifier of a project is a wrong call, not a count of zero.
  assert.equal(reins(b, ['status', 'project=ums']).json.error, 'usage');
});

test('cli: a check script that gives no answer says why: the exit code and the end of its error text', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 4 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  fs.writeFileSync(check, '#!/bin/sh\ncat >/dev/null\necho "the repository is not an absolute path" >&2\nexit 2\n', { mode: 0o755 });
  const failed = reins(b, ['report', id, '-'], 'green').json.answer;
  assert.deepEqual([failed.result, failed.reason, failed.why], ['none', 'check_failed', [{ name: 'tests', cause: 'exit', exit: 2, stderr: 'the repository is not an absolute path' }]]);
  // An answer that is not the form of a result: the cause is named, there is no exit code.
  fs.writeFileSync(check, '#!/bin/sh\ncat >/dev/null\necho PASS\n', { mode: 0o755 });
  assert.deepEqual(reins(b, ['report', id, '-'], 'green').json.answer.why, [{ name: 'tests', cause: 'bad_json' }]);
  // A result that is neither PASS nor FAIL.
  fs.writeFileSync(check, '#!/bin/sh\ncat >/dev/null\nprintf \'{"outputs":{"result":"maybe"},"flags":{}}\'\n', { mode: 0o755 });
  assert.deepEqual(reins(b, ['report', id, '-'], 'green').json.answer.why, [{ name: 'tests', cause: 'bad_result' }]);
  // Only the end of a long error text is kept.
  fs.writeFileSync(check, '#!/bin/sh\ncat >/dev/null\ni=0; while [ $i -lt 400 ]; do echo "line $i of the error text" >&2; i=$((i+1)); done\nexit 1\n', { mode: 0o755 });
  const long = reins(b, ['report', id, '-'], 'green').json.answer.why[0];
  assert.ok(long.stderr.length <= 2000 && long.stderr.endsWith('line 399 of the error text'), long.stderr.slice(-60));
  // The journal has the cause as a code, never the text.
  const rows = fs.readFileSync(path.join(b.root, 'state/journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('check.no_answer')).map((l) => JSON.parse(l).data);
  assert.deepEqual(rows.map((d) => [d.reason, d.cause, d.stderr]), [['check_failed', 'exit', undefined], ['check_failed', 'bad_json', undefined], ['check_failed', 'bad_result', undefined], ['check_failed', 'exit', undefined]]);
});

test('cli: a check script that answers FAIL says why: the end of its error text', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 4 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  const answer = (result: string, note: string): string => `#!/bin/sh\ncat >/dev/null\n${note}printf '{"outputs":{"result":"${result}"},"flags":{}}'\n`;
  fs.writeFileSync(check, answer('FAIL', 'echo "this task did not change: m0123456789" >&2\n'), { mode: 0o755 });
  const red = reins(b, ['report', id, '-'], 'red').json.answer;
  assert.deepEqual([red.result, red.reason, red.why], ['FAIL', undefined, [{ name: 'tests', cause: 'fail', stderr: 'this task did not change: m0123456789' }]]);
  // A FAIL without an error text has no cause to name.
  fs.writeFileSync(check, answer('FAIL', ''), { mode: 0o755 });
  const silent = reins(b, ['report', id, '-'], 'red').json.answer;
  assert.deepEqual([silent.result, silent.why], ['FAIL', undefined]);
  // Only the end of a long error text is kept.
  fs.writeFileSync(check, answer('FAIL', 'i=0; while [ $i -lt 400 ]; do echo "line $i of the error text" >&2; i=$((i+1)); done\n'), { mode: 0o755 });
  const long = reins(b, ['report', id, '-'], 'red').json.answer.why[0];
  assert.ok(long.stderr.length <= 2000 && long.stderr.endsWith('line 399 of the error text'), long.stderr.slice(-60));
  // A PASS says nothing more: the error text of a script that passed is not a cause.
  fs.writeFileSync(check, answer('PASS', 'echo "a note of the script" >&2\n'), { mode: 0o755 });
  const green = reins(b, ['report', id, '-'], 'green').json.answer;
  assert.deepEqual([green.result, green.why], ['PASS', undefined]);
  // The journal has neither the cause nor the text of an answer.
  const rows = fs.readFileSync(path.join(b.root, 'state/journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('check.answered')).map((l) => JSON.parse(l).data);
  assert.deepEqual(rows.map((d) => [d.result, d.cause, d.stderr]), [['FAIL', undefined, undefined], ['FAIL', undefined, undefined], ['FAIL', undefined, undefined], ['PASS', undefined, undefined]]);
});

test('cli: the human says that the result of a closed task was wrong, and the journal has it once', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  // Only a result can be wrong: a task that still runs has none.
  assert.deepEqual([reins(b, ['dispute', id]).json.ok, reins(b, ['dispute', id]).json.error], [false, 'not_closed']);
  assert.equal(reins(b, ['dispute', 't0000000000']).json.error, 'unknown_task');
  reins(b, ['stop', id]);
  const first = reins(b, ['dispute', id]).json;
  assert.deepEqual([first.ok, first.task, first.state, first.label, first.already], [true, id, 'closed', 'not_verified', undefined]);
  assert.match(first.disputed, /^\d{4}-\d{2}-\d{2}T/);
  // The second word changes nothing: the same time, no second row.
  const second = reins(b, ['dispute', id]).json;
  assert.deepEqual([second.ok, second.already, second.disputed], [true, true, first.disputed]);
  const rows = fs.readFileSync(path.join(b.root, 'state/journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('task.result_disputed')).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.task, r.data.label]), [[id, 'not_verified']]);
  assert.deepEqual(reins(b, ['status']).json.metrics.disputed, { not_verified: 1 });
});

test('cli: a probe names the state of the work tree that its command is asked in', () => {
  const b = box();
  fs.writeFileSync(path.join(b.root, 'person/gate-probes.json'), JSON.stringify([
    // The work of the human is lost only where there is a changed file: the probe names that state.
    { command: 'git reset --hard', expect: 'ask', tree: 'changed', note: 'the work of the human is lost' },
    // The same command in a clean work tree loses nothing: git can take it back.
    { command: 'git reset --hard', expect: 'pass', tree: 'clean' },
    // A state that the harness does not know is no probe.
    { command: 'ls', expect: 'pass', tree: 'burning' },
    // A probe without a state is asked in the directory of the command, as before.
    { command: 'ls -la', expect: 'pass' },
  ]));
  const r = reins(b, ['probes']).json;
  assert.deepEqual([r.ok, r.n, r.bad, r.misses, r.noise], [true, 3, 1, [], []]);
  // The answer does not follow the directory of the command: a clean repository gives the same counts.
  const repo = path.join(b.root, 'clean-repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]): void => { spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }); };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('init', '-q');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const there = JSON.parse(spawnSync(process.execPath, [CLI, 'probes'], { env, cwd: repo, encoding: 'utf8' }).stdout);
  assert.deepEqual([there.n, there.bad, there.misses, there.noise], [3, 1, [], []]);
  // The command of the probe ran nowhere: the file of the repository is as it was.
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'a\n');
});

test('cli: the barrier is asked about the commands with a known answer of a pack', () => {
  const b = box();
  // No file: nothing to ask.
  assert.deepEqual(reins(b, ['probes']).json, { ok: true, n: 0, bad: 0, misses: [], noise: [] });
  const file = path.join(b.root, 'person/gate-probes.json');
  fs.writeFileSync(file, JSON.stringify([
    { command: 'ls -la', expect: 'pass' },
    { command: 'git reset --hard', expect: 'ask', note: 'the work of the human is lost' },
    { command: 'cat {state}/journal.jsonl', expect: 'ask' },
    // The barrier is softer than this probe wants: a miss.
    { command: 'ls -la', expect: 'ask', note: 'a miss for the test' },
    // The barrier is stricter than this probe wants: a noise.
    { command: 'git reset --hard', expect: 'pass' },
    { command: '', expect: 'ask' }, { command: 'ls', expect: 'maybe' }, 'not a probe',
  ]));
  const r = reins(b, ['probes']).json;
  assert.deepEqual([r.ok, r.n, r.bad], [true, 5, 3]);
  assert.deepEqual(r.misses, [{ pack: 'person', n: 4, expect: 'ask', got: 'allow', note: 'a miss for the test' }]);
  assert.deepEqual(r.noise.map((f: { pack: string; n: number; expect: string; got: string }) => [f.pack, f.n, f.expect, f.got]), [['person', 5, 'pass', 'ask']]);
  // The summary has the counts only.
  assert.deepEqual(reins(b, ['status']).json.barrier, { n: 5, bad: 3, misses: 1, noise: 1 });
  // The packs name no target: the summary has none above. A target of the packs is checked against each day.
  assert.deepEqual(reins(b, ['status']).json.targets, { over: [], unknown: [] });
  const pack = path.join(b.root, 'person/pack.json');
  const before = fs.readFileSync(pack, 'utf8');
  fs.writeFileSync(pack, JSON.stringify({ ...JSON.parse(before), targets: { probe_misses: 0, probe_noise: 5, no_such: 1 } }));
  assert.deepEqual(reins(b, ['status']).json.targets, { over: [{ name: 'probe_misses', max: 0, days: 1, days_over: 1, worst: 1 }, { name: 'probe_noise', max: 5, days: 1, days_over: 0, worst: 1 }], unknown: ['no_such'] });
  assert.deepEqual(reins(b, ['metrics', 'days=1']).json.targets, { probe_misses: 0, probe_noise: 5, no_such: 1 });
  fs.writeFileSync(pack, before);
  // The run wrote its counts to the journal: the series of the metrics has them. The run without a file wrote nothing.
  assert.deepEqual(reins(b, ['status']).json.metrics.probes, { runs: 1, n: 5, misses: 1, noise: 1 });
  const last = reins(b, ['metrics', 'days=1']).json.points[0].measures;
  assert.deepEqual([last.probe_misses, last.probe_noise], [1, 1]);
  // A file that is no list is one bad file.
  fs.writeFileSync(file, '{}');
  assert.deepEqual(reins(b, ['probes']).json, { ok: true, n: 0, bad: 1, misses: [], noise: [] });
});

test('cli: the config gives the time limit of a check script, and the answer names the limit', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  fs.writeFileSync(check, '#!/bin/sh\ncat >/dev/null\nsleep 20\n', { mode: 0o755 });
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  fs.writeFileSync(b.config, JSON.stringify({ ...config, check_timeout_s: 1 }));
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  assert.deepEqual(reins(b, ['report', id, '-'], 'green').json.answer.why, [{ name: 'tests', cause: 'timeout', limit_s: 1 }]);
  for (const bad of [0, -5, 1.5, '60', 86_401]) {
    fs.writeFileSync(b.config, JSON.stringify({ ...config, check_timeout_s: bad }));
    assert.equal(reins(b, ['status']).json.error, 'bad_config', String(bad));
  }
});

test('cli: the metrics are a series of the eight numbers by day or by week, in a form with a version', () => {
  const b = box();
  reins(b, ['open', 'change-review', 'change_id=7']);
  const before = Date.now();
  const r = reins(b, ['metrics']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual([r.json.ok, r.json.metrics, r.json.step, r.json.project, r.json.points.length], [true, 12, 'day', 'all', 14]);
  assert.deepEqual(r.json.measures, ['asks_per_task', 'hook_ms_p50', 'hook_ms_p95', 'hook_ms_max', 'check_ms_p50', 'check_ms_p95', 'context_bytes', 'disputed', 'pitfall_repeats', 'denied', 'checks_no_answer', 'probe_misses', 'probe_noise', 'tokens_total', 'model_calls', 'fails_disputed', 'memory_finds', 'memory_find_misses', 'memory_wrong', 'memory_bytes', 'memory_active', 'memory_cited', 'memory_dead', 'memory_unseen', 'cache_rewrites', 'actions', 'tasks_opened', 'session_context_min', 'session_context_max', 'session_context_avg', 'sessions_measured', 'harness_context_share', 'craft_proposed', 'craft_accepted', 'craft_rejected', 'craft_open', 'craft_last_ts']);
  // No proposal of the craft waits in a new state: the count is a zero, not a gap.
  assert.deepEqual(r.json.points.map((p: { measures: { craft_open: number | null } }) => p.measures.craft_open), Array(14).fill(0));
  assert.deepEqual(Object.keys(r.json.points[0].measures), r.json.measures);
  assert.deepEqual(r.json.by, ['questions_asked', 'questions_yes', 'context_bytes', 'disputed', 'model_tokens', 'model_calls', 'executor_tokens', 'executor_calls', 'token_kinds', 'memory_given', 'memory_bytes', 'session_context', 'session_context_min', 'session_context_avg', 'session_harness_tokens', 'scenario_tokens', 'scenario_cost_tasks']);
  assert.deepEqual(Object.keys(r.json.points[0].by), r.json.by);
  assert.deepEqual(r.json.names, ['verified_share', 'returns_per_task', 'gate_yes_share', 'no_model_share', 'cost_per_scenario', 'memory_use', 'proposal_effect', 'harness_failures']);
  // The buckets follow one another without a gap; the last one ends at the end of the day of today.
  const points = r.json.points as { from: string; to: string }[];
  for (let i = 1; i < points.length; i += 1) assert.equal(points[i]?.from, points[i - 1]?.to);
  assert.equal(points.at(-1)?.to.slice(11), '00:00:00.000Z');
  const end = Date.parse(points.at(-1)?.to ?? '');
  assert.ok(end > before && end - before <= 24 * 60 * 60 * 1000);
  assert.deepEqual([r.json.from, r.json.to], [points[0]?.from, points.at(-1)?.to]);
  // By hours: a short window, the last bucket is this hour.
  const hours = reins(b, ['metrics', 'days=1', 'step=hour']).json;
  assert.deepEqual([hours.points.length, hours.step, Date.parse(hours.to) - Date.parse(hours.points[23].from)], [24, 'hour', 3600_000]);
  assert.ok(Date.parse(hours.to) > Date.now() && Date.parse(hours.to) - Date.now() <= 3600_000);
  assert.equal(reins(b, ['metrics', 'days=8', 'step=hour']).json.error, 'usage');
  const weeks = reins(b, ['metrics', 'days=15', 'step=week', 'project=here']).json;
  assert.deepEqual([weeks.points.length, weeks.step], [3, 'week']);
  // The series of the machine names the projects of the window; the series of one project does not.
  assert.equal(weeks.projects, undefined);
  const named = reins(b, ['metrics', 'days=1']).json.projects;
  assert.ok(Array.isArray(named) && named.length >= 1 && named.every((id: string) => /^p[0-9a-f]{8}$/.test(id)), JSON.stringify(named));
  assert.match(weeks.project, /^p[0-9a-f]{8}$/);
  for (const bad of [['days=0'], ['days=367'], ['step=month'], ['days=3', 'days=4'], ['project=ums'], ['14'], ['format=csv']]) {
    assert.equal(reins(b, ['metrics', ...bad]).json.error, 'usage', bad.join(' '));
  }
});

test('cli: the check runs before the report when the packs give a count for it, and it spends no return', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const check = path.join(b.root, 'project/check/tests.sh');
  fs.mkdirSync(path.dirname(check), { recursive: true });
  fs.writeFileSync(check, `#!/bin/sh\nin=$(cat)\nreport=$(printf '%s' "$in" | sed 's/.*"report":"\\([^"]*\\)".*/\\1/')\nif grep -q green "$report"; then r=PASS; else r=FAIL; fi\nprintf '{"outputs":{"result":"%s"},"flags":{}}' "$r"\n`, { mode: 0o755 });
  // The packs name no count: there is no check before the report.
  const closed = reins(b, ['open', 'change-review', 'change_id=7']).json;
  assert.equal(closed.input.report.checks_left, undefined);
  assert.equal(reins(b, ['check', closed.task, '-'], 'green').json.error, 'not_allowed');
  reins(b, ['stop', closed.task]);
  const pack = path.join(b.root, 'organization/pack.json');
  const value = JSON.parse(fs.readFileSync(pack, 'utf8'));
  fs.writeFileSync(pack, JSON.stringify({ ...value, limits: { ...value.limits, probes: 3 } }));
  const opened = reins(b, ['open', 'change-review', 'change_id=7']).json;
  const id = opened.task;
  assert.equal(opened.input.report.checks_left, 3);
  // A script can run without a report: it then reads an empty text, never an older report of the task.
  const bare = reins(b, ['check', id]);
  assert.deepEqual([bare.code, bare.json.answer.result, bare.json.checks_left], [2, 'FAIL', 2]);
  // A red answer: the exit code says "not ready", the task executes, no return is spent.
  const red = reins(b, ['check', id, '-'], 'the tests are red');
  assert.deepEqual([red.code, red.json.state, red.json.probe, red.json.answer.result, red.json.checks_left, red.json.returns_left], [2, 'executing', true, 'FAIL', 1, 1]);
  const green = reins(b, ['check', id, '-'], 'the tests are green');
  assert.deepEqual([green.code, green.json.state, green.json.answer.result, green.json.checks_left], [0, 'executing', 'PASS', 0]);
  // The count is spent. A green answer of a check before the report accepts nothing: the report does.
  assert.equal(reins(b, ['check', id, '-'], 'green').json.error, 'limit');
  assert.equal(reins(b, ['input', id]).json.input.report.checks_left, 0);
  const done = reins(b, ['report', id, '-'], 'the tests are green');
  assert.deepEqual([done.code, done.json.state, done.json.answer.result], [0, 'publishing', 'PASS']);
  // The rows of a check before the report say so, and the counts of the checks leave them out.
  const rows = fs.readFileSync(path.join(b.root, 'state/journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).filter((r) => r.task === id && r.kind === 'check.answered');
  assert.deepEqual(rows.map((r) => [r.data.result, r.data.probe]), [['FAIL', 1], ['FAIL', 1], ['PASS', 1], ['PASS', undefined]]);
  assert.deepEqual(reins(b, ['status']).json.metrics.checks, { PASS: 1, FAIL: 0, none: 0 });
});

test('cli: a red check before the report protects the files of the check, and a scenario that the human approves has no such check', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'human', retries: 0 }) });
  const pack = path.join(b.root, 'organization/pack.json');
  const value = JSON.parse(fs.readFileSync(pack, 'utf8'));
  fs.writeFileSync(pack, JSON.stringify({ ...value, limits: { ...value.limits, probes: 2 } }));
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  assert.equal(reins(b, ['check', id, '-'], 'x').json.error, 'not_allowed');
  assert.equal(reins(b, ['check', 't000000000000', '-'], 'x').json.error, 'unknown_task');
});

test('cli: a command that the state of a task does not take says the state and the command that it takes', () => {
  const b = box();
  const id = reins(b, ['open', 'draft-message']).json.task;
  // The task takes a report: it has no publication to end.
  const early = reins(b, ['finish', id]);
  assert.deepEqual([early.code, early.json], [1, { ok: false, error: 'bad_event', state: 'executing', next: `the task takes a report: reins report ${id} <file>` }]);
  const input = reins(b, ['input', id]).json.input;
  // A task that names no write has no publication: its protocol does not send the agent to `finish`.
  assert.deepEqual(input.writes, []);
  assert.equal(input.protocol.some((line: string) => /finish/.test(line)), false);
  assert.equal(input.protocol.some((line: string) => /publishing/.test(line)), false);
  assert.ok(input.protocol.some((line: string) => line === 'Exit code 0: the check passed and the task is closed. Exit code 2: not ready; read `answer`, correct the report and submit it again.'));
  assert.ok(input.protocol.some((line: string) => line === 'The task names no write to a system: it has no publication, and every write to a system asks the human.'));
  // The report of this scenario waits for the word of the human: a second report is not taken, and the answer says who acts.
  assert.equal(reins(b, ['report', id, '-'], 'a draft').json.state, 'waiting_human');
  const waiting = reins(b, ['report', id, '-'], 'a draft');
  assert.deepEqual([waiting.code, waiting.json], [1, { ok: false, error: 'bad_event', state: 'waiting_human', waiting: 'approval', next: `the task waits for the human: reins approve ${id} accepts the result, reins retry ${id} sends it back, reins stop ${id} ends the task` }]);
  const late = reins(b, ['finish', id]);
  assert.deepEqual([late.json.error, late.json.state, late.json.waiting], ['bad_event', 'waiting_human', 'approval']);
  // A closed task takes nothing: the answer says what it is, with no next command.
  assert.equal(reins(b, ['approve', id]).json.state, 'closed');
  assert.deepEqual(reins(b, ['finish', id]).json, { ok: false, error: 'bad_event', state: 'closed', label: 'approved_by_human' });
  assert.deepEqual(reins(b, ['report', id, '-'], 'a draft').json, { ok: false, error: 'bad_event', state: 'closed', label: 'approved_by_human' });
});

// ---- A decision of the human comes from a terminal, never from a shell of a client.

test('cli: a decision of the human needs a terminal and a shell that is not of a client', () => {
  const b = box();
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8')) as Record<string, unknown>;
  const write = (channel?: string): void => {
    const { human_channel: _, ...rest } = config;
    fs.writeFileSync(b.config, JSON.stringify(channel === undefined ? rest : { ...rest, human_channel: channel }));
  };
  const call = (args: string[], more: Record<string, string> = {}): Out => {
    const p = spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config, ...more }, input: '', encoding: 'utf8', cwd: b.tree });
    return { code: p.status, json: JSON.parse(p.stdout), stdout: p.stdout };
  };
  const state = (id: string): string | undefined => (call(['tasks']).json.tasks as { task: string; state: string }[]).find((t) => t.task === id)?.state;
  write('any');
  const id = call(['open', 'change-review', 'change_id=7']).json.task as string;
  // No key in the config: the command reads no terminal, so it is not a word of the human.
  write();
  for (const args of [['stop', id], ['approve', id], ['retry', id], ['pause', '5'], ['queue', 'approve', 'q000000000000'], ['memory', 'decide', 'text', 'because=cause'], ['craft', 'accept', 'c00000000000']]) {
    const r = call(args);
    assert.deepEqual([r.code, r.json.ok, r.json.error, r.json.reason], [1, false, 'human_only', 'no_terminal'], args.join(' '));
    assert.match(String(r.json.next), /terminal/);
  }
  assert.equal(state(id), 'executing');
  assert.equal(fs.existsSync(path.join(b.state, 'pause.json')), false);
  // The shell of a client: the variables of the client say so, whatever the config says.
  write('any');
  for (const more of [{ CLAUDE_CODE_SESSION_ID: 's1' }, { CLAUDECODE: '1' }]) {
    const r = call(['stop', id], more);
    assert.deepEqual([r.code, r.json.error, r.json.reason], [1, 'human_only', 'agent_shell'], JSON.stringify(more));
  }
  assert.equal(state(id), 'executing');
  // A command of the agent is no decision: it runs in the shell of a client as before.
  assert.equal(call(['tasks'], { CLAUDECODE: '1' }).json.ok, true);
  assert.equal(call(['input', id], { CLAUDECODE: '1' }).json.ok, true);
  // A start of a client (`run`, `tick run`, `fire`) is no decision either: the timer has no terminal.
  assert.notEqual(call(['tick', 'run']).json.error, 'human_only');
  // The config of a test names the other channel: the command works without a terminal.
  assert.deepEqual(call(['stop', id]).json, { ok: true, task: id, state: 'closed', label: 'not_verified' });
  // A value that the config does not know is a bad config.
  write('agent');
  assert.equal(call(['tasks']).json.error, 'bad_config');
});

test('cli: the channel of the human is a terminal on the standard input with no variable of a client', () => {
  const markers = ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE'];
  assert.equal(humanChannel({ tty: true, env: {}, markers, mode: 'terminal' }), null);
  assert.equal(humanChannel({ tty: false, env: {}, markers, mode: 'terminal' }), 'no_terminal');
  assert.equal(humanChannel({ tty: false, env: {}, markers, mode: 'any' }), null);
  assert.equal(humanChannel({ tty: true, env: { CLAUDECODE: '1' }, markers, mode: 'terminal' }), 'agent_shell');
  assert.equal(humanChannel({ tty: true, env: { CLAUDECODE: '' }, markers, mode: 'any' }), 'agent_shell');
  // The words that are a decision: the list of the barrier without the starts of a client.
  for (const words of ['stop t1', 'pause 5', 'enable x', 'approve t1', 'dispute t1', 'retry t1', 'memory decide x', 'memory wrong m1', 'memory step m1 x', 'craft reject c1', 'queue approve q1']) assert.equal(humanDecision(words.split(' ')), true, words);
  for (const words of ['run x', 'tick run', 'fire x', 'tasks', 'report t1 -', 'memory find x', 'memory next m1 x', 'queue', 'craft', 'tick']) assert.equal(humanDecision(words.split(' ')), false, words);
});
