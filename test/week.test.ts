// The journal past its first cut: the eight numbers of the specification, the data fields of
// every kind that the code writes, and the archive of the file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, pruneArchive, readJournal, readJournalSince } from '../src/journal/writer.ts';
import { validateRow, type JournalRow } from '../src/contracts/journal.ts';
import { eight } from '../src/journal/metrics.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { sweep } from '../src/core/sweep.ts';
import { afterAction, beforeAction, type ClientTools } from '../src/client/before.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'week-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T12:00:00Z');

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(extra: Record<string, object> = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const level = rel.split('/')[0] ?? '';
    if (rel.endsWith('.sh')) fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel.endsWith('pack.json')) fs.writeFileSync(file, JSON.stringify({ ...(value as object), ...(extra[level] ?? {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4' }, root, cwd, config };
}

// ---- The eight numbers.

const row = (daysAgo: number, kind: string, more: Partial<JournalRow> = {}): JournalRow =>
  ({ ts: new Date(NOW - daysAgo * DAY).toISOString(), v: 1, kind, project: 'p1', ...more }) as JournalRow;

test('week: the eight numbers of the specification are counted from the rows of the week', () => {
  const rows = [
    // this week
    // A result is the end of a scenario task, or of a free request that changed the work. A free
    // request that changed nothing is a question: it has no result, verified or not.
    row(1, 'task.closed', { task: 't1', scenario: 's', data: { label: 'verified_form' } }),
    row(1, 'task.closed', { task: 't2', data: { label: 'not_verified', changed: 1 } }),
    row(1, 'task.closed', { task: 't3', scenario: 's', data: { label: 'approved_by_human' } }),
    row(1, 'task.closed', { task: 't4', scenario: 's', data: { label: 'not_verified' } }),
    row(1, 'task.closed', { task: 't7', data: { label: 'not_verified' } }), row(1, 'task.closed', { task: 't8', data: { label: 'not_verified' } }),
    row(2, 'task.started', { task: 't1', scenario: 's' }), row(2, 'task.started', { task: 't3', scenario: 's' }),
    row(2, 'task.returned', { task: 't1', scenario: 's', data: { n: 1, reason: 'check_fail' } }),
    row(2, 'task.skipped', { task: 't5', scenario: 's' }), row(2, 'task.skipped', { task: 't6', scenario: 's' }),
    row(3, 'policy.decision', { task: 't2', data: { outcome: 'ask', action_kind: 'write', env: 'local' } }),
    row(3, 'policy.decision', { task: 't2', data: { outcome: 'ask', action_kind: 'write', env: 'local' } }),
    row(3, 'policy.decision', { task: 't2', data: { outcome: 'allow', action_kind: 'read', env: 'local' } }),
    row(3, 'policy.protected_attempt', { task: 't2', data: { rule: 'protect.packs', outcome: 'ask' } }),
    row(3, 'policy.protected_attempt', { task: 't2', data: { rule: 'protect.state', outcome: 'deny' } }),
    row(3, 'task.human_decision', { task: 't2', data: { decision: 'answered' } }),
    row(3, 'task.human_decision', { task: 't1', data: { decision: 'confirm' } }),
    row(3, 'task.human_decision', { task: 't1', data: { decision: 'stop' } }),
    row(4, 'executor.cost', { task: 't1', scenario: 's', data: { tokens: 3000, ms: 10, calls: 2 } }),
    row(4, 'executor.cost', { task: 't3', scenario: 's', data: { tokens: 1000, ms: 10, calls: 1 } }),
    // What a free request spent is not the cost of a scenario.
    row(4, 'executor.cost', { task: 't2', data: { tokens: 500000, ms: 10, calls: 1 } }),
    row(4, 'memory.read', { data: { n: 4 } }), row(4, 'memory.record_used', { data: { record: 'm0123456789' } }),
    row(5, 'craft.effect_measured', { data: { proposal: 'c1', effect: 'better' } }), row(5, 'craft.effect_measured', { data: { proposal: 'c2', effect: 'same' } }),
    row(5, 'harness.failure', { data: { where: 'collect' } }), row(5, 'harness.step_timeout'), row(5, 'harness.client_shape_changed', { data: { client: 'x', event: 'pre' } }),
    // the week before
    row(8, 'task.closed', { task: 'u1', scenario: 's', data: { label: 'verified_form' } }),
    row(9, 'harness.failure', { data: { where: 'journal' } }),
    // too old
    row(20, 'harness.failure', { data: { where: 'journal' } }),
  ];
  assert.deepEqual(eight(rows, NOW), {
    verified_share: { value: 0.5, prev: 1, n: 4 },
    returns_per_task: { value: 0.5, prev: null, n: 2 },
    gate_yes_share: { value: 0.67, prev: null, n: 3 },
    no_model_share: { value: 0.5, prev: null, n: 4 },
    cost_per_scenario: { value: 2000, prev: null, n: 2 },
    memory_use: { value: 0.25, prev: null, n: 4 },
    proposal_effect: { value: 0.5, prev: null, n: 2 },
    harness_failures: { value: 3, prev: 1, n: 3 },
  });
});

test('week: a number without rows has no value, and the count of failures is zero', () => {
  const e = eight([], NOW);
  assert.deepEqual(Object.keys(e), ['verified_share', 'returns_per_task', 'gate_yes_share', 'no_model_share', 'cost_per_scenario', 'memory_use', 'proposal_effect', 'harness_failures']);
  assert.deepEqual([e.verified_share, e.harness_failures], [{ value: null, prev: null, n: 0 }, { value: 0, prev: 0, n: 0 }]);
});

test('week: the status of the command line shows the eight numbers', () => {
  const b = box();
  const out = JSON.parse(spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  assert.deepEqual(Object.keys(out.eight).length, 8);
});

// ---- The answer of the human to a question.

test('week: a tool that ran after a question is the "yes" of the human, and it is written', () => {
  const b = box();
  const tools: ClientTools = { shell: { kind: 'shell', command: 'command' } };
  const call = { cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session: 's1' };
  assert.equal(beforeAction(b.rt, call, tools).outcome, 'ask');
  afterAction(b.rt, call, tools);
  afterAction(b.rt, call, tools);
  const yes = () => readJournal(b.rt.journal.file).filter((r) => r.kind === 'task.human_decision' && r.data?.decision === 'answered').length;
  assert.equal(yes(), 1, 'one question, one answer');
  // A mode of the client that shows no question: the run is no answer.
  assert.equal(beforeAction(b.rt, { ...call, input: { a: 2 } }, tools).outcome, 'ask');
  afterAction(b.rt, { ...call, input: { a: 2 } }, tools, false);
  assert.equal(yes(), 1);
  // A question about a shell command of the client counts too.
  const sh = { cwd: b.cwd, tool: 'shell', input: { command: `cat ${b.rt.stateDir}/journal.jsonl` }, session: 's1' };
  assert.equal(beforeAction(b.rt, sh, tools).outcome, 'ask');
  afterAction(b.rt, sh, tools);
  assert.equal(yes(), 2);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

// ---- The data fields of a kind.

for (const [name, kind, data, errors] of [
  ['a return has a count and a known reason', 'task.returned', { n: 'one', reason: 'because' }, ['not_number data.n', 'not_in_list data.reason']],
  ['a wait names a known reason', 'task.waiting_human', { reason: 'tired' }, ['not_in_list data.reason']],
  ['a decision of the human is a known one', 'task.human_decision', { decision: 'maybe' }, ['not_in_list data.decision']],
  ['a protected attempt names its rule and its outcome', 'policy.protected_attempt', { outcome: 'allow' }, ['missing data.rule', 'not_in_list data.outcome']],
  ['a report has a size', 'task.report_submitted', {}, ['missing data.size']],
  ['a memory change names the record and a known state', 'memory.record_changed', { record: 'm0123456789', type: 'pitfall', state: 'gone' }, ['not_in_list data.state']],
  ['a resolved proposal has a known state', 'craft.proposal_resolved', { proposal: 'c1', state: 'later' }, ['not_in_list data.state']],
  ['a pause has a count of minutes', 'harness.barriers_off', {}, ['missing data.minutes']],
] as const) {
  test(`week: data: ${name}`, () => {
    const r = { ts: '2026-11-20T12:00:00Z', v: 1, kind, project: 'p1', task: 't000000000000', data };
    assert.deepEqual(validateRow(r).map((e) => `${e.code} ${e.path}`), [...errors]);
  });
}

// ---- The archive.

test('week: a journal past its size limit moves to the archive, and a reader of a period sees both', () => {
  const dir = path.join(fs.mkdtempSync(path.join(SB, 'j-')), 'state');
  let t = NOW - 3 * DAY;
  const journal = openJournal(dir, () => new Date((t += 1000)), { maxBytes: 600 });
  for (let i = 0; i < 20; i += 1) assert.equal(journal.write({ kind: 'harness.step_timeout', project: 'p1' }).written, true);
  const archive = fs.readdirSync(path.join(dir, 'journal-archive'));
  assert.ok(archive.length >= 2, `archive files: ${archive.length}`);
  assert.ok(fs.statSync(journal.file).size <= 600 + 200);
  assert.ok(readJournal(journal.file).length < 20);
  const all = readJournalSince(dir);
  assert.equal(all.length, 20);
  assert.deepEqual(all.map((r) => r.ts), [...all.map((r) => r.ts)].sort(), 'the rows are in the order of time');
});

test('week: the pack sets how long the archive is kept, and the sweep removes what is older', () => {
  const b = box({ organization: { journal: { keep_days: 30 } }, person: { journal: { keep_days: 10 } } });
  assert.equal(b.rt.merged.journalKeepDays, 30, 'the longest term of the packs');
  const archive = path.join(b.rt.stateDir, 'journal-archive');
  fs.mkdirSync(archive, { recursive: true });
  const old = path.join(archive, 'old.jsonl');
  const fresh = path.join(archive, 'fresh.jsonl');
  fs.writeFileSync(old, '');
  fs.writeFileSync(fresh, '');
  fs.utimesSync(old, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
  fs.utimesSync(fresh, new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
  sweep(b.rt, NOW);
  assert.deepEqual(fs.readdirSync(archive), ['fresh.jsonl']);
  assert.equal(pruneArchive(b.rt.stateDir, undefined, NOW), 0, 'without a term nothing is removed');
  assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', journal: { keep_days: 0, more: 1 } }, 'person').errors.map((e) => `${e.code} ${e.path}`), ['unknown_field journal.more', 'not_positive journal.keep_days']);
});

// ---- Cases of the review.

test('week: a question that nobody answered for a day is removed by the sweep', () => {
  const b = box();
  const tools: ClientTools = {};
  beforeAction(b.rt, { cwd: b.cwd, tool: 'unknown__tool', input: { a: 1 }, session: 's1' }, tools);
  const pending = path.join(b.rt.stateDir, 'pending');
  assert.equal(fs.readdirSync(pending).length, 1);
  sweep(b.rt, Date.now() + 2 * DAY);
  assert.deepEqual(fs.readdirSync(pending), []);
});

test('week: a reader of a period does not open an archive file that is older than the period', () => {
  const dir = path.join(fs.mkdtempSync(path.join(SB, 'a-')), 'state');
  fs.mkdirSync(path.join(dir, 'journal-archive'), { recursive: true });
  const old = path.join(dir, 'journal-archive', 'old.jsonl');
  fs.writeFileSync(old, `${JSON.stringify(row(30, 'harness.step_timeout'))}\n`);
  fs.utimesSync(old, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
  assert.equal(readJournalSince(dir, NOW - 14 * DAY).length, 0);
  assert.equal(readJournalSince(dir).length, 1);
});
