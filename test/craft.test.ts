// The craft past its first cut: more detectors, a proposal that carries a ready change, and the
// measure of what an accepted proposal did.
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
import { approveContract, proposeContract, type Runtime } from '../src/core/runtime.ts';
import { detect, listProposals, measure, propose, resolveProposal } from '../src/craft/craft.ts';
import { addRecord, listRecords } from '../src/memory/store.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const CONTRACT = {
  manifest: 1, name: 'fix-flaky-test', title: 'Fix the flaky test', package: 'person',
  trigger: { kind: 'command' }, model: { level: 'medium', token_limit: 50000 }, permissions: { read: ['code-host'] },
  done: { kind: 'human', retries: 1 }, output: { format: 'text', max_bytes: 2000 },
};

type Box = { rt: Runtime; root: string; cwd: string; config: string; packs: Record<string, string> };
let n = 0;
function box(): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4' }, root, cwd, config, packs };
}
// Rows of the journal at a time in the past.
function rows(b: Box, at: number, list: Record<string, unknown>[]): void {
  fs.mkdirSync(b.rt.stateDir, { recursive: true });
  fs.appendFileSync(b.rt.journal.file, list.map((r) => `${JSON.stringify({ ts: new Date(at).toISOString(), v: 1, project: 'p1a2b3c4', task: 't000000000000', ...r })}\n`).join(''));
}
const question = (rule: string) => [
  { kind: 'policy.decision', data: { outcome: 'ask', action_kind: 'unknown', env: 'unknown' } },
  { kind: 'policy.basis', data: { layer: 'core', rule } },
];
const times = <T,>(k: number, list: T[]): T[] => Array.from({ length: k }, () => list).flat();

// ---- Detectors.

test('craft: contracts with one name that repeat are a candidate for a scenario', () => {
  const row = (name: string) => ({ ts: '2026-11-11T10:00:00.000Z', v: 1, kind: 'task.contract_approved', project: 'p1', task: 't000000000000', scenario: name, scenario_v: 1 }) as never;
  assert.deepEqual(detect([row('a'), row('a'), row('a'), row('b'), row('b')]), [{ pattern: 'repeated_contract', key: 'a', n: 3 }]);
});

test('craft: a memory record that no report cited for a month is a pattern, a decision is not', () => {
  const b = box();
  const old = NOW - 40 * DAY;
  const note = addRecord(b.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, old);
  const decision = addRecord(b.rt, { type: 'decision', text: 'we keep one cache', because: 'two caches went out of step', paths: [], by: 'human' }, old);
  const fresh = addRecord(b.rt, { type: 'pitfall', text: 'a new note about the cache', paths: [], by: 'human' }, NOW - DAY);
  assert.ok(note.ok && decision.ok && fresh.ok);
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.change]), [['record_unused', note.record.id, { kind: 'memory', record: note.record.id, state: 'stale' }]]);
});

test('craft: the packs set the thresholds, the count of proposals in a week, and the scenarios that the craft leaves alone', () => {
  const b = box();
  const check = (scenario: string, result: string) => ({ kind: 'check.answered', scenario, scenario_v: 1, data: { result, check_kind: 'citations' } });
  rows(b, NOW - DAY, [...times(3, question('tool.unknown')), ...times(2, question('shell.rm'))]);
  rows(b, NOW - DAY, [...times(4, [check('change-review', 'FAIL')]), ...times(4, [check('draft-message', 'FAIL')])]);
  // The thresholds of the code: three questions are no pattern; both scenarios fail often.
  assert.deepEqual(propose(b.rt, NOW).map((p) => [p.pattern, p.key]).sort(), [['check_fails_often', 'change-review'], ['check_fails_often', 'draft-message']]);
  // The packs: a lower threshold for questions, one scenario that the craft leaves alone, two proposals in a week.
  const next = box();
  rows(next, NOW - DAY, [...times(3, question('tool.unknown')), ...times(2, question('shell.rm')), ...times(2, question('git.push'))]);
  rows(next, NOW - DAY, [...times(4, [check('change-review', 'FAIL')]), ...times(4, [check('draft-message', 'FAIL')])]);
  next.rt.merged.craft = { min_questions: 2, keep: ['change-review'], per_week: 2 };
  const made = propose(next.rt, NOW);
  assert.equal(made.length, 2, 'the count of proposals in a week');
  assert.equal(made.some((p) => p.key === 'change-review'), false, 'the scenario that the craft leaves alone');
  // The rest waits: the same week gives nothing more, the next week gives the next two.
  assert.deepEqual(propose(next.rt, NOW + DAY), []);
  rows(next, NOW + 7 * DAY, [...times(3, question('tool.unknown')), ...times(2, question('shell.rm')), ...times(2, question('git.push'))]);
  rows(next, NOW + 7 * DAY, times(4, [check('draft-message', 'FAIL')]));
  const later = propose(next.rt, NOW + 8 * DAY);
  assert.equal(later.length, 2);
  assert.equal(new Set([...made, ...later].map((p) => p.id)).size, 4);
  // The term of an unused record and the count of contracts come from the packs too; the acceptance uses the same term.
  const third = box();
  third.rt.merged.craft = { unused_days: 10, min_contracts: 2, min_checks: 9 };
  const note = addRecord(third.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 15 * DAY);
  assert.ok(note.ok);
  rows(third, NOW - DAY, times(2, [{ kind: 'task.contract_approved', scenario: 'fix-flaky-test', scenario_v: 1 }]));
  rows(third, NOW - DAY, times(4, [check('draft-message', 'FAIL')]));
  const found = propose(third.rt, NOW);
  assert.deepEqual(found.map((p) => [p.pattern, p.key]).sort(), [['record_unused', note.record.id], ['repeated_contract', 'fix-flaky-test']].sort(), 'four checks are under the threshold of nine');
  assert.equal(resolveProposal(third.rt, found.find((p) => p.pattern === 'record_unused')?.id ?? '', 'accepted', NOW), true);
  assert.equal(listRecords(third.rt, NOW).find((r) => r.id === note.record.id)?.state, 'stale');
  // The form of the section, and the merge: a lower pack sets a number again, the lists add up.
  assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', craft: { min_questions: 0, per_week: 'two', keep: ['Bad Name'], more: 1 } }, 'person').errors.map((e) => `${e.code} ${e.path}`).sort(), ['bad_name craft.keep[0]', 'not_integer craft.per_week', 'not_positive craft.min_questions', 'unknown_field craft.more']);
  const packFile = (level: string) => path.join(b.root, 'packs', level, 'pack.json');
  const add = (level: string, craft: unknown) => fs.writeFileSync(packFile(level), JSON.stringify({ ...JSON.parse(fs.readFileSync(packFile(level), 'utf8')), craft }));
  add('organization', { min_questions: 8, min_checks: 6, keep: ['change-review'] });
  add('person', { min_questions: 3, unused_days: 60, keep: ['draft-message'] });
  assert.deepEqual(loadPacks(b.packs).craft, { min_questions: 3, min_checks: 6, unused_days: 60, keep: ['change-review', 'draft-message'] });
});

test('craft: a scenario whose tasks often ask for the higher level of the model is a pattern, and its effect is measured', () => {
  const b = box();
  const of = (kind: string, scenario: string, more: Record<string, unknown> = {}) => ({ kind, scenario, scenario_v: 1, ...more });
  // Four tasks of one scenario, three raised the level; another scenario raised once in four.
  rows(b, NOW - DAY, [...times(4, [of('task.started', 'change-review')]), ...times(3, [of('executor.level_raised', 'change-review', { level: 'strong' })])]);
  rows(b, NOW - DAY, [...times(4, [of('task.started', 'draft-message')]), of('executor.level_raised', 'draft-message', { level: 'strong' })]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file)), [{ pattern: 'level_too_low', key: 'change-review', n: 3 }]);
  // A raise of a task that started before these rows is not counted: its start is not in the share.
  const early = readJournal(b.rt.journal.file).map((r) => (r.kind === 'executor.level_raised' ? { ...r, task: 't111111111111' } : r));
  assert.deepEqual(detect(early), []);
  // The packs: the threshold, and the scenario that the craft leaves alone.
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { min_raises: 4 }), []);
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { keep: ['change-review'] }), []);
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.n, p.change]), [['level_too_low', 'change-review', 3, undefined]]);
  for (const row of readJournal(b.rt.journal.file).filter((r) => r.kind.startsWith('craft.'))) assert.deepEqual(validateRow(row), []);
  // The human raised the level in the manifest and accepted: a week later the tasks raise less.
  assert.equal(resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW), true);
  assert.deepEqual(measure(b.rt, NOW + 3 * DAY), [], 'too early');
  rows(b, NOW + 2 * DAY, [...times(4, [of('task.started', 'change-review')]), of('executor.level_raised', 'change-review', { level: 'strong' })]);
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY).map((p) => [p.pattern, p.effect]), [['level_too_low', 'better']]);
});

// ---- A proposal with a ready change.

test('craft: a repeated contract becomes a proposal with the manifest, and the acceptance puts it into the person pack', () => {
  const b = box();
  for (let i = 0; i < 3; i += 1) {
    const r = proposeContract(b.rt, CONTRACT, {});
    assert.ok(r.ok);
    approveContract(b.rt, r.task.id);
  }
  const made = propose(b.rt);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.n, p.change?.kind]), [['repeated_contract', 'fix-flaky-test', 3, 'manifest']]);
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  const out = run(['craft', 'accept', made[0]?.id ?? '']);
  assert.deepEqual([out.ok, out.state, out.applied], [true, 'accepted', true]);
  const merged = loadPacks(b.packs);
  assert.deepEqual(merged.rejected, []);
  assert.ok(merged.scenarios.some((s) => s.manifest.name === 'fix-flaky-test'), 'the scenario is connected');
  assert.equal(proposeContract({ ...b.rt, merged }, CONTRACT, {}).ok, false, 'the name is a scenario now');
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

test('craft: the acceptance of an unused record makes it stale', () => {
  const b = box();
  const note = addRecord(b.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 40 * DAY);
  assert.ok(note.ok);
  const made = propose(b.rt, NOW);
  assert.equal(resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW), true);
  assert.equal(listRecords(b.rt, NOW).find((r) => r.id === note.record.id)?.state, 'stale');
  assert.equal(listProposals(b.rt)[0]?.applied, true);
});

test('craft: a proposal without a ready change says so, and its acceptance applies nothing', () => {
  const b = box();
  rows(b, NOW - DAY, times(5, question('default.unknown-tool')));
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.change]), [['repeated_question', undefined]]);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW);
  assert.equal(listProposals(b.rt)[0]?.applied, false);
});

// ---- A rejected pattern.

test('craft: a rejected pattern is proposed again only when it grew twice', () => {
  const b = box();
  rows(b, NOW - DAY, times(5, question('default.unknown-tool')));
  const first = propose(b.rt, NOW);
  resolveProposal(b.rt, first[0]?.id ?? '', 'rejected', NOW);
  rows(b, NOW - DAY, times(4, question('default.unknown-tool')));
  assert.deepEqual(propose(b.rt, NOW), [], '9 is less than twice 5');
  rows(b, NOW - DAY, question('default.unknown-tool'));
  const again = propose(b.rt, NOW);
  assert.deepEqual(again.map((p) => [p.id, p.n, p.state]), [[first[0]?.id, 10, 'open']]);
});

// ---- The measure of the effect.

test('craft: an accepted proposal is measured after a week: fewer questions about the rule is better', () => {
  const b = box();
  const accepted = NOW - 8 * DAY;
  rows(b, accepted - 2 * DAY, times(6, question('default.unknown-tool')));
  const made = propose(b.rt, accepted);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', accepted);
  rows(b, accepted + 2 * DAY, question('default.unknown-tool'));
  assert.deepEqual(measure(b.rt, accepted + 3 * DAY), [], 'a week did not pass');
  assert.deepEqual(measure(b.rt, NOW).map((p) => [p.id, p.effect]), [[made[0]?.id, 'better']]);
  assert.deepEqual(measure(b.rt, NOW), [], 'one measure for one proposal');
  const found = readJournal(b.rt.journal.file).filter((r) => r.kind === 'craft.effect_measured');
  assert.deepEqual(found.map((r) => r.data), [{ proposal: made[0]?.id, effect: 'better' }]);
  for (const r of found) assert.deepEqual(validateRow(r), []);
});

test('craft: more questions after the acceptance is worse, the same count is the same', () => {
  for (const [after, effect] of [[8, 'worse'], [6, 'same']] as const) {
    const b = box();
    const accepted = NOW - 8 * DAY;
    rows(b, accepted - 2 * DAY, times(6, question('default.unknown-tool')));
    const made = propose(b.rt, accepted);
    resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', accepted);
    rows(b, accepted + 2 * DAY, times(after, question('default.unknown-tool')));
    assert.deepEqual(measure(b.rt, NOW).map((p) => p.effect), [effect]);
  }
});

test('craft: without enough data the effect is "not measured", and no row is written', () => {
  const b = box();
  const accepted = NOW - 8 * DAY;
  const check = (result: string) => ({ kind: 'check.answered', scenario: 'change-review', scenario_v: 1, data: { result, check_kind: 'citations' } });
  rows(b, accepted - DAY, ['FAIL', 'FAIL', 'FAIL', 'PASS'].map(check));
  const made = propose(b.rt, accepted);
  assert.deepEqual(made.map((p) => p.pattern), ['check_fails_often']);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', accepted);
  rows(b, accepted + DAY, [check('PASS')]);
  assert.deepEqual(measure(b.rt, NOW), []);
  assert.equal(listProposals(b.rt)[0]?.effect, 'not_measured');
  assert.equal(readJournal(b.rt.journal.file).filter((r) => r.kind === 'craft.effect_measured').length, 0);
  // With enough checks later the measure is made.
  rows(b, accepted + 2 * DAY, ['PASS', 'PASS', 'PASS'].map(check));
  assert.deepEqual(measure(b.rt, NOW).map((p) => p.effect), ['better']);
});

// ---- Cases of the review.

test('craft: without work after the acceptance the effect of a rule is not measured', () => {
  const b = box();
  const accepted = NOW - 8 * DAY;
  rows(b, accepted - 2 * DAY, times(6, question('default.unknown-tool')));
  const made = propose(b.rt, accepted);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', accepted);
  assert.deepEqual(measure(b.rt, NOW), []);
  assert.equal(listProposals(b.rt)[0]?.effect, 'not_measured');
});

test('craft: a scenario from contracts is measured by its returns for one task', () => {
  const b = box();
  const accepted = NOW - 8 * DAY;
  const r = (kind: string) => ({ kind, scenario: 'fix-flaky-test', scenario_v: 1, ...(kind === 'task.returned' ? { data: { n: 1, reason: 'human' } } : {}) });
  rows(b, accepted - DAY, [...times(3, [r('task.contract_approved'), r('task.started')]), ...times(3, [r('task.returned')])]);
  const made = propose(b.rt, accepted);
  assert.deepEqual(made.map((p) => p.pattern), ['repeated_contract']);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', accepted);
  rows(b, accepted + DAY, [...times(3, [r('task.started')]), r('task.returned')]);
  assert.deepEqual(measure(b.rt, NOW).map((p) => p.effect), ['better']);
});

test('craft: an accepted proposal that made things worse gets a proposal to undo it, and the acceptance undoes the ready change', () => {
  const b = box();
  const r = (kind: string) => ({ kind, scenario: 'fix-flaky-test', scenario_v: 1, ...(kind === 'task.returned' ? { data: { n: 1, reason: 'human' } } : {}) });
  for (let i = 0; i < 3; i += 1) {
    const made = proposeContract(b.rt, CONTRACT, {});
    assert.ok(made.ok);
    approveContract(b.rt, made.task.id);
  }
  rows(b, NOW - DAY, [...times(3, [r('task.started')]), r('task.returned')]);
  const accepted = Date.now() + 1000;
  const first = propose(b.rt, accepted);
  assert.deepEqual(first.map((p) => [p.pattern, p.change?.kind]), [['repeated_contract', 'manifest']]);
  assert.equal(resolveProposal(b.rt, first[0]?.id ?? '', 'accepted', accepted), true);
  const file = path.join(b.packs.person ?? '', 'manifests', 'fix-flaky-test.json');
  assert.equal(fs.existsSync(file), true);
  // The scenario returns more often than the contracts did: worse.
  rows(b, accepted + DAY, [...times(3, [r('task.started')]), ...times(3, [r('task.returned')])]);
  assert.deepEqual(measure(b.rt, accepted + 8 * DAY).map((p) => p.effect), ['worse']);
  const undo = listProposals(b.rt).find((p) => p.pattern === 'rollback');
  assert.deepEqual([undo?.key, undo?.state, undo?.change?.kind], [first[0]?.id, 'open', 'remove_manifest']);
  assert.deepEqual(measure(b.rt, accepted + 9 * DAY), [], 'one proposal to undo, once');
  assert.equal(listProposals(b.rt).filter((p) => p.pattern === 'rollback').length, 1);
  for (const row of readJournal(b.rt.journal.file).filter((x) => x.kind.startsWith('craft.'))) assert.deepEqual(validateRow(row), []);
  // The acceptance removes the manifest that the craft wrote, and the first proposal says that it was undone.
  assert.equal(resolveProposal(b.rt, undo?.id ?? '', 'accepted', accepted + 9 * DAY), true);
  assert.equal(fs.existsSync(file), false);
  const all = listProposals(b.rt);
  assert.equal(all.find((p) => p.id === undo?.id)?.applied, true);
  assert.equal(all.find((p) => p.id === first[0]?.id)?.undone, new Date(accepted + 9 * DAY).toISOString());
  // The pattern has its proposal already, accepted: it is not proposed again, before the undo and after it.
  assert.deepEqual(propose(b.rt, accepted + 9 * DAY).map((p) => p.pattern), []);
});

test('craft: a manifest that the human changed is not removed by an undo, and a proposal with no ready change is undone by hand', () => {
  const b = box();
  const r = (kind: string) => ({ kind, scenario: 'fix-flaky-test', scenario_v: 1, ...(kind === 'task.returned' ? { data: { n: 1, reason: 'human' } } : {}) });
  for (let i = 0; i < 3; i += 1) {
    const made = proposeContract(b.rt, CONTRACT, {});
    assert.ok(made.ok);
    approveContract(b.rt, made.task.id);
  }
  rows(b, NOW - DAY, [...times(3, [r('task.started')]), r('task.returned')]);
  const accepted = Date.now() + 1000;
  const first = propose(b.rt, accepted);
  resolveProposal(b.rt, first[0]?.id ?? '', 'accepted', accepted);
  const file = path.join(b.packs.person ?? '', 'manifests', 'fix-flaky-test.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Fix the flaky test', 'Fix the flaky test, my way'));
  rows(b, accepted + DAY, [...times(3, [r('task.started')]), ...times(3, [r('task.returned')])]);
  measure(b.rt, accepted + 8 * DAY);
  const undo = listProposals(b.rt).find((p) => p.pattern === 'rollback');
  assert.equal(resolveProposal(b.rt, undo?.id ?? '', 'accepted', accepted + 9 * DAY), true);
  assert.equal(fs.existsSync(file), true, 'the file of the human stays');
  assert.equal(listProposals(b.rt).find((p) => p.id === undo?.id)?.applied, false);
  assert.equal(listProposals(b.rt).find((p) => p.id === first[0]?.id)?.undone, undefined, 'nothing was undone');
  // A rule that asks more after its proposal was accepted: the human made that change by hand, so the undo has no ready change.
  const c = box();
  rows(c, NOW - 9 * DAY, times(5, question('default.unknown-tool')));
  const asked = propose(c.rt, NOW - 8 * DAY);
  resolveProposal(c.rt, asked[0]?.id ?? '', 'accepted', NOW - 8 * DAY);
  rows(c, NOW - 7 * DAY, times(9, question('default.unknown-tool')));
  assert.deepEqual(measure(c.rt, NOW).map((p) => p.effect), ['worse']);
  const byHand = listProposals(c.rt).find((p) => p.pattern === 'rollback');
  assert.deepEqual([byHand?.key, byHand?.change], [asked[0]?.id, undefined]);
  // The human undid the change by hand and accepted: the first proposal says that it was undone.
  resolveProposal(c.rt, byHand?.id ?? '', 'accepted', NOW);
  assert.equal(listProposals(c.rt).find((p) => p.id === asked[0]?.id)?.undone, new Date(NOW).toISOString());
  // An undo is outside the count of proposals in a week.
  c.rt.merged.craft = { per_week: 1 };
  rows(c, NOW - DAY, times(5, question('shell.rm')));
  assert.deepEqual(propose(c.rt, NOW + DAY).map((p) => p.key), ['shell.rm']);
});

test('craft: a record that a report cited in the last month is not unused, and is not made stale', () => {
  const b = box();
  const note = addRecord(b.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 40 * DAY);
  assert.ok(note.ok);
  const made = propose(b.rt, NOW);
  assert.equal(made.length, 1);
  // A report cites the record after the proposal: the acceptance does not make it stale.
  const file = path.join(b.rt.stateDir, 'memory-state', 'uses.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [note.record.id]: { n: 1, last: new Date(NOW - DAY).toISOString() } }));
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW);
  assert.equal(listProposals(b.rt)[0]?.applied, false);
  assert.equal(listRecords(b.rt, NOW).find((x) => x.id === note.record.id)?.state, 'active');
});
