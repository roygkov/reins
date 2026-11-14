// The journal past its first cut: the eight numbers of the specification, the data fields of
// every kind that the code writes, and the archive of the file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, pruneArchive, readJournal, readJournalSince } from '../src/journal/writer.ts';
import { validateRow, type JournalRow } from '../src/contracts/journal.ts';
import { eight, summarize, costByScenario } from '../src/journal/metrics.ts';
import { openScenario, type Runtime } from '../src/core/runtime.ts';
import { scenarioOff } from '../src/core/idle.ts';
import { sweep } from '../src/core/sweep.ts';
import { addRecord, listRecords, restoreRecord, vetoRecord } from '../src/memory/store.ts';
import { weekText, writeWeek } from '../src/craft/weekly.ts';
import { sessionStart } from '../src/client/session.ts';
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
    row(1, 'task.closed', { task: 't1', scenario: 's', data: { label: 'verified_result' } }),
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
    // A question that no human saw (a mode of the client without questions) is no question to the human.
    row(3, 'policy.decision', { task: 't2', data: { outcome: 'ask', action_kind: 'write', env: 'local', unshown: 1 } }),
    row(3, 'policy.protected_attempt', { task: 't2', data: { rule: 'protect.packs', outcome: 'ask', unshown: 1 } }),
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
    // Only a check of the result counts: the approval of the human of this week and the check of
    // the form of the week before are named in the parts, not in the value.
    verified_share: { value: 0.25, prev: 0, n: 4, parts: { verified_result: 1, approved_by_human: 1 } },
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

test('week: the pack sets how long a removed record is kept, and the sweep removes its file', () => {
  const b = box({ organization: { memory: { keep_days: 30 } }, person: { memory: { keep_days: 10 } } });
  assert.equal(b.rt.merged.memoryKeepDays, 30, 'the longest term of the packs');
  const made = (text: string) => {
    const r = addRecord(b.rt, { type: 'decision', text, because: 'the owner said so', paths: [], by: 'human' }, NOW - 100 * DAY);
    assert.ok(r.ok);
    return r.record.id;
  };
  const [old, fresh, back, live] = [made('one cache'), made('logs in UTC'), made('one queue'), made('no retries')] as [string, string, string, string];
  vetoRecord(b.rt, old, NOW - 40 * DAY);
  vetoRecord(b.rt, fresh, NOW - 5 * DAY);
  // A record that the human took back counts from nothing: it is in use.
  vetoRecord(b.rt, back, NOW - 90 * DAY);
  restoreRecord(b.rt, back, NOW - 80 * DAY);
  sweep(b.rt, NOW);
  assert.deepEqual(listRecords(b.rt, NOW).map((r) => [r.id, r.state]).sort(), [[fresh, 'vetoed'], [back, 'active'], [live, 'active']].sort());
  const rows = readJournalSince(b.rt.stateDir).filter((r) => r.kind === 'memory.record_changed' && r.data?.gone === 1);
  assert.deepEqual(rows.map((r) => r.data), [{ record: old, type: 'decision', state: 'vetoed', gone: 1 }]);
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  // The end of the file is no veto and no new record in the numbers.
  assert.deepEqual(summarize(rows).memory, { written: 0, vetoed: 0, reads: 0, given: {}, bytes: {}, finds: { asked: 0, missed: 0 }, wrong: 0, census: null });
  // A second sweep finds nothing; the record cannot come back.
  sweep(b.rt, NOW);
  assert.equal(readJournalSince(b.rt.stateDir).filter((r) => r.kind === 'memory.record_changed' && r.data?.gone === 1).length, 1);
  assert.equal(restoreRecord(b.rt, old, NOW), false);
  // The term of this project is no term of another project: its records stay.
  const other = { ...b.rt, project: 'p9z8y7x6' };
  const foreign = addRecord(other, { type: 'decision', text: 'one bus', because: 'the owner said so', paths: [], by: 'human' }, NOW - 100 * DAY);
  assert.ok(foreign.ok);
  vetoRecord(other, foreign.record.id, NOW - 40 * DAY);
  sweep(b.rt, NOW);
  assert.equal(listRecords(b.rt, NOW).some((r) => r.id === foreign.record.id), true);
  sweep(other, NOW);
  assert.equal(listRecords(b.rt, NOW).some((r) => r.id === foreign.record.id), false);
  // Without a term nothing is removed.
  const none = box();
  const r = addRecord(none.rt, { type: 'decision', text: 'one cache', because: 'the owner said so', paths: [], by: 'human' }, NOW - 900 * DAY);
  assert.ok(r.ok);
  vetoRecord(none.rt, r.record.id, NOW - 800 * DAY);
  sweep(none.rt, NOW);
  assert.equal(listRecords(none.rt, NOW).length, 1);
  assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', memory: { keep_days: 0 } }, 'person').errors.map((e) => `${e.code} ${e.path}`), ['not_positive memory.keep_days']);
});

test('week: a scenario that nobody called for the term of the packs is switched off, and one command brings it back', () => {
  const b = box({ organization: { scenarios: { idle_days: 30 } }, person: { scenarios: { idle_days: 10 } } });
  assert.equal(b.rt.merged.scenarioIdleDays, 30, 'the longest term of the packs');
  // The term is one for the machine: a pack of a project does not set it.
  assert.deepEqual(validateSettings({ pack: 1, level: 'project', name: 'repo', scenarios: { idle_days: 5 } }, 'project').errors.map((e) => `${e.code} ${e.path}`), ['not_allowed scenarios.idle_days']);
  // A scenario of a project pack is counted for its project: the project of the command is the directory of the work.
  b.rt.project = `p${crypto.createHash('sha1').update(b.cwd).digest('hex').slice(0, 8)}`;
  const names = b.rt.merged.scenarios.map((s) => s.name);
  assert.ok(names.includes('change-review') && names.length > 1);
  const real = Date.now();
  // The first look only notes the time: the term does not start before the scenario is connected.
  sweep(b.rt, real - 40 * DAY);
  assert.equal(scenarioOff(b.rt, 'change-review'), false);
  assert.equal(openScenario(b.rt, 'change-review', { change_id: '7' }).ok, true);
  sweep(b.rt, real + 1000);
  const off = names.filter((name) => scenarioOff(b.rt, name));
  assert.deepEqual(off.sort(), names.filter((name) => name !== 'change-review').sort(), 'the scenario that was called stays');
  const rows = readJournalSince(b.rt.stateDir).filter((r) => r.kind === 'harness.pack_changed');
  assert.deepEqual(rows.map((r) => r.data?.scenario).sort(), [...off].sort());
  assert.deepEqual(rows[0]?.data, { scenario: rows[0]?.data?.scenario, state: 'off', reason: 'idle' });
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  // The term of the called scenario runs from the call.
  sweep(b.rt, real + 31 * DAY);
  assert.equal(scenarioOff(b.rt, 'change-review'), true);
  assert.deepEqual(openScenario(b.rt, 'change-review', { change_id: '7' }), { ok: false, error: 'idle' });
  // The command of the human, and what the agent sees.
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd }).stdout);
  assert.equal(reins('scenarios').scenarios.find((s: { name: string }) => s.name === 'change-review').off, 'idle');
  assert.equal(reins('open', 'change-review', 'change_id=7').error, 'idle');
  assert.deepEqual(reins('enable', 'change-review'), { ok: true, scenario: 'change-review' });
  assert.equal(reins('enable', 'change-review').error, 'not_off');
  assert.equal(reins('enable', 'no-such').error, 'unknown_scenario');
  assert.equal(scenarioOff(b.rt, 'change-review'), false);
  assert.equal(openScenario(b.rt, 'change-review', { change_id: '7' }).ok, true);
  // The agent can type the command, so a client with the hook asks the human first.
  const asked = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: 'reins enable change-review' } }, { shell: { kind: 'shell', command: 'command' } });
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'protect.human-command']);
  // Without a term nothing is switched off, and the term does not run: a term that comes later starts from its first look.
  const none = box();
  sweep(none.rt, real - 4000 * DAY);
  assert.equal(openScenario(none.rt, 'change-review', { change_id: '7' }).ok, true);
  sweep(none.rt, real);
  assert.deepEqual(none.rt.merged.scenarios.filter((s) => scenarioOff(none.rt, s.name)), []);
  none.rt.merged.scenarioIdleDays = 30;
  sweep(none.rt, real + 100 * DAY);
  assert.deepEqual(none.rt.merged.scenarios.filter((s) => scenarioOff(none.rt, s.name)), [], 'the first look with a term');
  sweep(none.rt, real + 131 * DAY);
  assert.equal(scenarioOff(none.rt, 'change-review'), true);
  // A term that goes away: nothing is off, and the count starts again when it comes back.
  delete none.rt.merged.scenarioIdleDays;
  assert.equal(scenarioOff(none.rt, 'change-review'), false);
  sweep(none.rt, real + 132 * DAY);
  none.rt.merged.scenarioIdleDays = 30;
  assert.equal(scenarioOff(none.rt, 'change-review'), false);
  // A scenario that a schedule or an event starts is never idle: a long period is no want of use.
  const timed = none.rt.merged.scenarios.find((s) => s.name === 'change-review');
  assert.ok(timed);
  sweep(none.rt, real + 133 * DAY);
  timed.manifest.trigger = { ...timed.manifest.trigger, kind: 'schedule', value: 'daily 09:00' };
  sweep(none.rt, real + 400 * DAY);
  assert.equal(scenarioOff(none.rt, 'change-review'), false);
  assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', scenarios: { idle_days: 0, more: 1 } }, 'person').errors.map((e) => `${e.code} ${e.path}`), ['unknown_field scenarios.more', 'not_positive scenarios.idle_days']);
});

test('week: the summary of the week is a file: the numbers, what needs a decision, what waits, what was accepted', () => {
  const b = box();
  b.rt.project = `p${crypto.createHash('sha1').update(b.cwd).digest('hex').slice(0, 8)}`;
  const real = Date.now();
  const task = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(task.ok);
  // A draft of the memory in its veto window, and a proposal of the craft.
  const decision = addRecord(b.rt, { type: 'decision', text: 'we keep one cache', because: 'two caches went out of step', paths: [], by: 'human' }, real);
  assert.ok(decision.ok);
  fs.mkdirSync(path.join(b.rt.stateDir, 'craft'), { recursive: true });
  fs.writeFileSync(path.join(b.rt.stateDir, 'craft', 'c0123456789.json'), JSON.stringify({ id: 'c0123456789', pattern: 'repeated_question', key: 'tool.unknown', n: 7, created: new Date(real).toISOString(), state: 'open' }));
  fs.writeFileSync(path.join(b.rt.stateDir, 'craft', 'c1123456789.json'), JSON.stringify({ id: 'c1123456789', pattern: 'check_fails_often', key: 'change-review', n: 4, created: new Date(real - 9 * DAY).toISOString(), state: 'accepted', resolved: new Date(real - 8 * DAY).toISOString(), effect: 'better' }));
  // An open undo, and a proposal that was undone.
  fs.writeFileSync(path.join(b.rt.stateDir, 'craft', 'c2123456789.json'), JSON.stringify({ id: 'c2123456789', pattern: 'rollback', key: 'c1123456789', n: 1, created: new Date(real).toISOString(), state: 'open' }));
  fs.writeFileSync(path.join(b.rt.stateDir, 'craft', 'c3123456789.json'), JSON.stringify({ id: 'c3123456789', pattern: 'repeated_contract', key: 'fix-flaky-test', n: 3, created: new Date(real - 9 * DAY).toISOString(), state: 'accepted', resolved: new Date(real - 8 * DAY).toISOString(), effect: 'worse', undone: new Date(real - DAY).toISOString() }));
  const text = weekText(b.rt, real);
  assert.match(text, /- c2123456789: undo of the proposal c1123456789, its effect was worse\. `reins craft accept c2123456789`/);
  assert.match(text, /- c3123456789: repeated_contract of "fix-flaky-test", seen 3 times, accepted \d{4}-\d{2}-\d{2}: worse, undone \d{4}-\d{2}-\d{2}/);
  assert.match(text, /^# reins: the week to \d{4}-\d{2}-\d{2}\n/);
  for (const name of ['verified_share', 'returns_per_task', 'gate_yes_share', 'no_model_share', 'cost_per_scenario', 'memory_use', 'proposal_effect', 'harness_failures']) assert.match(text, new RegExp(`^\\| ${name} \\| `, 'm'));
  assert.match(text, /## Needs a decision of the human\n\n- c0123456789: repeated_question of "tool.unknown", seen 7 times\. `reins craft accept c0123456789` or `reins craft reject c0123456789`/);
  assert.match(text, /## Waits for its term\n\nNothing\./);
  // What applied itself is named once, in its own part.
  fs.writeFileSync(path.join(b.rt.stateDir, 'craft', 'c4123456789.json'), JSON.stringify({ id: 'c4123456789', pattern: 'record_unused', key: 'm0123456789', n: 40, created: new Date(real - 9 * DAY).toISOString(), state: 'accepted', resolved: new Date(real - 2 * DAY).toISOString(), applied: true, auto: true, change: { kind: 'memory', record: 'm0123456789', state: 'stale' } }));
  const withAuto = weekText(b.rt, real);
  assert.equal(withAuto.split('c4123456789: record_unused').length - 1, 1);
  assert.match(withAuto, /## Applied by itself\n\n- c4123456789: record_unused of "m0123456789", seen 40 times, applied \d{4}-\d{2}-\d{2}\. `reins memory restore m0123456789` takes it back/);
  assert.match(text, /## Accepted, and the effect\n\n- c1123456789: check_fails_often of "change-review", seen 4 times, accepted \d{4}-\d{2}-\d{2}: better/);
  // A client without a window writes no summary: nobody reads its notice.
  process.env.REINS_HEADLESS = '1';
  try {
    assert.equal(sessionStart(b.rt, { session: 's0', cwd: b.cwd, client: 'test_client' }).context.some((line) => line.includes('summary of the week')), false);
  } finally {
    delete process.env.REINS_HEADLESS;
  }
  assert.equal(fs.existsSync(path.join(b.rt.stateDir, 'summaries')), false);
  // The file: the first start of a session writes it and says where it is; the next start of the week does not.
  const first = sessionStart(b.rt, { session: 's1', cwd: b.cwd, client: 'test_client' }).context.find((line) => line.includes('summary of the week'));
  const file = path.join(b.rt.stateDir, 'summaries', `week-${new Date().toISOString().slice(0, 10)}.md`);
  assert.ok(first?.includes(file));
  assert.match(fs.readFileSync(file, 'utf8'), /^# reins: the week to /);
  assert.equal(sessionStart(b.rt, { session: 's2', cwd: b.cwd, client: 'test_client' }).context.some((line) => line.includes('summary of the week')), false);
  assert.equal(writeWeek(b.rt, real + 6 * DAY), null);
  assert.match(writeWeek(b.rt, real + 8 * DAY) ?? '', /week-\d{4}-\d{2}-\d{2}\.md$/);
  // The command writes it at once.
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const out = JSON.parse(spawnSync(process.execPath, [CLI, 'week'], { encoding: 'utf8', env, cwd: b.cwd }).stdout);
  assert.deepEqual([out.ok, out.file], [true, file]);
  assert.match(out.text, /c0123456789/);
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

// ---- The cost of each scenario.

test('week: the cost of the week is counted for each scenario, with the week before beside it', () => {
  const cost = (daysAgo: number, task: string, scenario: string | undefined, tokens: number) =>
    row(daysAgo, 'executor.cost', { task, ...(scenario !== undefined ? { scenario, scenario_v: 1 } : {}), data: { tokens, ms: 10, calls: 1 } });
  const rows = [
    cost(1, 't1', 'mr-review', 4000), cost(1, 't1', 'mr-review', 2000), cost(2, 't2', 'mr-review', 6000),
    cost(3, 't3', 'firecheck', 30000),
    cost(1, 't9', undefined, 99999), // a free request is no scenario
    cost(9, 't4', 'mr-review', 20000), cost(10, 't5', 'wrapup', 1000),
  ];
  assert.deepEqual(costByScenario(rows, NOW), [
    { scenario: 'firecheck', tasks: 1, tokens: 30000, per_task: 30000, prev_per_task: null },
    { scenario: 'mr-review', tasks: 2, tokens: 12000, per_task: 6000, prev_per_task: 20000 },
  ]);
  assert.deepEqual(costByScenario([], NOW), []);
});

test('week: the summary has a table of the cost of each scenario', () => {
  const b = box();
  const write = (daysAgo: number, task: string, scenario: string, tokens: number) => {
    const at = new Date(Date.now() - daysAgo * DAY);
    openJournal(b.rt.stateDir, () => at).write({ kind: 'executor.cost', project: 'p1', task, scenario, scenario_v: 1, data: { tokens, ms: 10, calls: 1 } });
  };
  const empty = weekText(b.rt);
  assert.match(empty, /## Cost of each scenario\n\nNothing\./);
  write(1, 't000000000001', 'mr-review', 4000);
  write(2, 't000000000002', 'mr-review', 6000);
  write(9, 't000000000003', 'mr-review', 20000);
  const text = weekText(b.rt);
  assert.match(text, /## Cost of each scenario\n\n\| scenario \| tasks \| tokens \| tokens per task \| the week before \|\n\|---\|---\|---\|---\|---\|\n\| mr-review \| 2 \| 10000 \| 5000 \| 20000 \|/);
});
