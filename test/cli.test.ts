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
  fs.writeFileSync(config, JSON.stringify({ packs: { organization: path.join(root, 'organization'), project: path.join(root, 'project'), person: path.join(root, 'person') }, state_dir: state }));
  return { root, config, state, tree };
}

function reins(b: Box | null, args: string[], input?: string): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: b?.root ?? SB };
  if (b !== null) env.REINS_CONFIG = b.config;
  const p = spawnSync(process.execPath, [CLI, ...args], { env, input: input ?? '', encoding: 'utf8' });
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
    { name: 'change-review', title: 'Ревью изменения', level: 'project', description: 'Review of one change', inputs: [{ name: 'change_id', type: 'id' }] },
    { name: 'draft-message', title: 'Черновик сообщения', level: 'person', inputs: [] },
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
  const bad = reins(b, ['report', id, file]);
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.json, { ok: true, task: id, state: 'executing', returns_left: 1, answer: { result: 'FAIL', reason: 'faults', n: 1, faults: [{ n: 1, fault: 'not_found' }] } });

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

test('cli: past the limit of returns the task waits for the human', () => {
  const b = box();
  const id = reins(b, ['open', 'change-review', 'change_id=7']).json.task;
  let last: Out | null = null;
  for (let i = 0; i < 3; i += 1) last = reins(b, ['report', id, '-'], report([{ ...ITEM, severity: 'none' }]));
  assert.equal(last?.code, 2);
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
  assert.ok(c.diff.file.startsWith(b.state) && c.diff.file.endsWith('.txt') && c.task.file.endsWith('.json'));
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

test('cli: a scenario with a check that the core cannot run is not opened', () => {
  const b = box({ manifest: (m) => void (m.done = { kind: 'command', check: 'tests', retries: 1 }) });
  const r = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { ok: false, error: 'check_not_supported', check: 'command' });
  assert.equal(fs.existsSync(path.join(b.state, 'tasks')), false);
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
