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
import type { JournalRow } from '../src/contracts/journal.ts';
import { applyDue, detect, listProposals, measure, propose, resolveProposal, proposalLine } from '../src/craft/craft.ts';
import { addRecord, countUses, listRecords, restoreRecord, searchRecords } from '../src/memory/store.ts';
import { writeWeek, weekText } from '../src/craft/weekly.ts';
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

test('craft: a rule that asked many times and got "yes" every time is a pattern of its own', () => {
  const b = box();
  const answer = (rule: string, decision: string) => ({ kind: 'task.human_decision', data: { decision, rule } });
  const asked = (rule: string, decision: string) => [...question(rule), answer(rule, decision)];
  // Five questions, five times "yes"; another rule got one "no"; a third rule has no answers in the journal (old rows).
  rows(b, NOW - DAY, [...times(5, asked('git.push', 'answered')), ...times(4, asked('shell.rm', 'answered')), ...asked('shell.rm', 'refused'), ...times(5, question('default.unknown-tool'))]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file)).map((p) => [p.pattern, p.key, p.n]).sort(), [['repeated_approval', 'git.push', 5], ['repeated_question', 'default.unknown-tool', 5], ['repeated_question', 'shell.rm', 5]]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { min_approvals: 6 }).map((p) => [p.pattern, p.key]).sort(), [['repeated_question', 'default.unknown-tool'], ['repeated_question', 'git.push'], ['repeated_question', 'shell.rm']]);
  // A rule that guards the harness itself is never a pattern, however often the human said "yes".
  const guarded = box();
  rows(guarded, NOW - DAY, times(9, [answer('protect.packs', 'answered'), answer('adapter.shape', 'answered')]));
  assert.deepEqual(detect(readJournal(guarded.rt.journal.file)), []);
  const made = propose(b.rt, NOW);
  assert.equal(made.find((p) => p.key === 'git.push')?.pattern, 'repeated_approval');
  // A rule that has a proposal about its questions already gets no second one about its approvals.
  const c = box();
  rows(c, NOW - 2 * DAY, times(5, question('git.push')));
  assert.deepEqual(propose(c.rt, NOW - DAY).map((p) => p.pattern), ['repeated_question']);
  rows(c, NOW - DAY, times(5, asked('git.push', 'answered')));
  assert.deepEqual(propose(c.rt, NOW), []);
  // A proposal about the questions that the human rejected stops the rule only until it grew twice.
  const d = box();
  rows(d, NOW - 2 * DAY, times(5, question('git.push')));
  const first = propose(d.rt, NOW - DAY);
  resolveProposal(d.rt, first[0]?.id ?? '', 'rejected', NOW - DAY);
  rows(d, NOW - DAY, times(9, asked('git.push', 'answered')));
  assert.deepEqual(propose(d.rt, NOW), [], 'nine approvals are less than twice five');
  rows(d, NOW - DAY, asked('git.push', 'answered'));
  assert.deepEqual(propose(d.rt, NOW).map((p) => [p.pattern, p.n]), [['repeated_approval', 10]]);
  // The effect is the count of the questions of the rule, as for a repeated question.
  resolveProposal(b.rt, made.find((p) => p.key === 'git.push')?.id ?? '', 'accepted', NOW);
  rows(b, NOW + DAY, asked('git.push', 'answered'));
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY).map((p) => [p.pattern, p.effect]), [['repeated_approval', 'better']]);
});

test('craft: a tool that fails often is a pattern, and its effect is the count of its failures', () => {
  const b = box();
  const failed = (tool: string) => ({ kind: 'executor.tool_failed', data: { tool } });
  rows(b, NOW - DAY, [...times(5, [failed('mcp__tracker__get_change')]), ...times(4, [failed('Read')])]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file)), [{ pattern: 'tool_fails_often', key: 'mcp__tracker__get_change', n: 5 }]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { min_tool_failures: 4 }).map((p) => p.key).sort(), ['Read', 'mcp__tracker__get_change']);
  const made = propose(b.rt, NOW);
  // The ready change is a pitfall for the memory. Its text is written by the code: the name of the tool and the count.
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.change?.kind]), [['tool_fails_often', 'mcp__tracker__get_change', 'pitfall']]);
  const text = made[0]?.change?.kind === 'pitfall' ? made[0].change.text : '';
  assert.match(text, /mcp__tracker__get_change/);
  assert.match(text, /5 times/);
  assert.deepEqual(listRecords(b.rt).filter((r) => r.type === 'pitfall'), []);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW);
  // The human accepted: the pitfall is a record of the memory of this project, in use at once.
  const written = listRecords(b.rt).filter((r) => r.type === 'pitfall');
  assert.deepEqual(written.map((r) => [r.text, r.state, r.project]), [[text, 'active', b.rt.project]]);
  const kept = listProposals(b.rt).find((p) => p.id === made[0]?.id);
  assert.deepEqual([kept?.applied, kept?.change?.kind === 'pitfall' ? kept.change.record : undefined], [true, written[0]?.id]);
  assert.match(text, /days to \d{4}-\d{2}-\d{2}\./);
  // No action of the agent after the acceptance: nothing is measured. With work and fewer failures: better.
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY), []);
  rows(b, NOW + DAY, [...question('default.write'), failed('mcp__tracker__get_change')]);
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY).map((p) => [p.pattern, p.effect]), [['tool_fails_often', 'better']]);
});

test('craft: the same chain of three tools in several free tasks is a candidate for a scenario', () => {
  const b = box();
  const act = (task: string, tool: string, more: Record<string, unknown> = {}) => ({ kind: 'policy.decision', task, data: { outcome: 'allow', action_kind: 'read', env: 'local', tool }, ...more });
  const chain = ['jira__get_issue', 'gitlab__get_mr', 'gitlab__get_diff'];
  // Three free tasks walk the same three tools; a repeat of one tool in a row is one step.
  rows(b, NOW - DAY, [
    ...chain.map((t) => act('t000000000001', t)),
    act('t000000000002', 'jira__get_issue'), act('t000000000002', 'jira__get_issue'), ...chain.slice(1).map((t) => act('t000000000002', t)),
    act('t000000000003', 'slack__read'), ...chain.map((t) => act('t000000000003', t)),
    // Another order, a task of a scenario and a decision with no tool name are no part of the chain.
    ...[...chain].reverse().map((t) => act('t000000000004', t)),
    ...chain.map((t) => act('t000000000005', t, { scenario: 'mr-review', scenario_v: 1 })),
    { kind: 'policy.decision', task: 't000000000006', data: { outcome: 'allow', action_kind: 'read', env: 'local' } },
    // A task that has a row of a scenario is a task of a scenario, also when its decisions name none.
    { kind: 'task.started', task: 't000000000007', scenario: 'mr-review', scenario_v: 1 }, ...chain.map((t) => act('t000000000007', t)),
    // A session that holds a scenario writes its decisions to its free task, with a mark: they are the walk of the scenario.
    ...chain.map((t) => ({ kind: 'policy.decision', task: 't000000000008', data: { outcome: 'allow', action_kind: 'read', env: 'local', tool: t, in_scenario: 1 } })),
  ]);
  const found = detect(readJournal(b.rt.journal.file));
  assert.deepEqual(found, [{ pattern: 'repeated_chain', key: 'jira__get_issue > gitlab__get_mr > gitlab__get_diff', n: 3 }]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { min_chains: 4 }), []);
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.change]), [['repeated_chain', undefined]]);
  // The journal takes the find: the key there is the number of the proposal, and nothing failed.
  assert.deepEqual(readJournal(b.rt.journal.file).filter((r) => r.kind === 'craft.pattern_found').map((r) => r.data), [{ pattern: 'repeated_chain', key: made[0]?.id, n: 3 }]);
  assert.equal(readJournal(b.rt.journal.file).some((r) => r.kind === 'harness.failure'), false);
  for (const row of readJournal(b.rt.journal.file).filter((r) => r.kind.startsWith('craft.'))) assert.deepEqual(validateRow(row), []);
  // The effect of such a proposal is not measured: the human writes a scenario, and the scenario has its own numbers.
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW);
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY), []);
});

// ---- The class "with a veto window".

test('craft: the summary of the week puts a proposal with a term among what waits for its term, not among what needs a decision', () => {
  const b = box();
  b.rt.merged.craft = { auto_days: 5 };
  const note = addRecord(b.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 40 * DAY);
  assert.ok(note.ok);
  rows(b, NOW - DAY, times(5, question('default.unknown-tool')));
  const made = propose(b.rt, NOW);
  const timed = made.find((p) => p.auto_at !== undefined)?.id ?? '';
  const plain = made.find((p) => p.auto_at === undefined)?.id ?? '';
  assert.ok(timed !== '' && plain !== '');
  const text = weekText(b.rt, NOW);
  const part = (title: string): string => text.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
  // Only the human resolves the one; the other applies itself, and the human can still say "no".
  assert.ok(part('Needs a decision of the human').includes(plain) && !part('Needs a decision of the human').includes(timed));
  assert.ok(part('Waits for its term').includes(timed));
  assert.match(part('Waits for its term'), new RegExp(`applies itself on .*reins craft reject ${timed}`));
});

test('craft: with a term of the packs a proposal whose change can be taken back applies itself, unless the human rejected it', () => {
  const b = box();
  b.rt.merged.craft = { auto_days: 5 };
  const old = NOW - 40 * DAY;
  const one = addRecord(b.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, old);
  const two = addRecord(b.rt, { type: 'pitfall', text: 'the queue keeps the order', paths: [], by: 'human' }, old);
  assert.ok(one.ok && two.ok);
  rows(b, NOW - DAY, times(5, question('default.unknown-tool')));
  const made = propose(b.rt, NOW);
  // A record that goes stale comes back with one command: it gets the term. A question about a rule has no ready change: only the human.
  assert.deepEqual(made.map((p) => [p.pattern, p.auto_at]).sort(), [
    ['record_unused', new Date(NOW + 5 * DAY).toISOString()], ['record_unused', new Date(NOW + 5 * DAY).toISOString()], ['repeated_question', undefined],
  ]);
  const first = made.find((p) => p.key === one.record.id);
  const second = made.find((p) => p.key === two.record.id);
  // The human rejects one inside the window.
  assert.equal(resolveProposal(b.rt, second?.id ?? '', 'rejected', NOW + DAY), true);
  assert.deepEqual(applyDue(b.rt, NOW + 4 * DAY), [], 'the window is not over');
  const applied = applyDue(b.rt, NOW + 6 * DAY);
  assert.deepEqual(applied.map((p) => [p.id, p.state, p.applied, p.auto]), [[first?.id, 'accepted', true, true]]);
  assert.equal(listRecords(b.rt, NOW + 6 * DAY).find((r) => r.id === one.record.id)?.state, 'stale');
  assert.equal(listRecords(b.rt, NOW + 6 * DAY).find((r) => r.id === two.record.id)?.state, 'active', 'the rejected one stays');
  assert.deepEqual(applyDue(b.rt, NOW + 7 * DAY), [], 'once');
  assert.equal(listProposals(b.rt).find((p) => p.pattern === 'repeated_question')?.state, 'open');
  const resolved = readJournal(b.rt.journal.file).filter((r) => r.kind === 'craft.proposal_resolved');
  assert.deepEqual(resolved.map((r) => r.data), [{ proposal: second?.id, state: 'rejected' }, { proposal: first?.id, state: 'accepted', auto: 1 }]);
  for (const row of resolved) assert.deepEqual(validateRow(row), []);
  // The human takes it back with one command.
  assert.equal(restoreRecord(b.rt, one.record.id, NOW + 8 * DAY), true);
  // The rejected pattern grew twice and opens again: it waits for the human, with no term.
  const again = propose(b.rt, NOW + 45 * DAY).find((p) => p.key === two.record.id);
  assert.deepEqual([again?.state, again?.auto_at], ['open', undefined]);
  // The term went away from the packs after the proposal was made: nothing applies itself.
  const gone = box();
  gone.rt.merged.craft = { auto_days: 5 };
  const kept = addRecord(gone.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, old);
  assert.ok(kept.ok);
  assert.equal(propose(gone.rt, NOW).length, 1);
  gone.rt.merged.craft = {};
  assert.deepEqual(applyDue(gone.rt, NOW + 6 * DAY), []);
  assert.equal(listRecords(gone.rt, NOW + 6 * DAY)[0]?.state, 'active');
  // Without the term nothing applies itself.
  const plain = box();
  const note = addRecord(plain.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, old);
  assert.ok(note.ok);
  assert.deepEqual(propose(plain.rt, NOW).map((p) => p.auto_at), [undefined]);
  assert.deepEqual(applyDue(plain.rt, NOW + 400 * DAY), []);
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

test('craft: the period before the acceptance needs the same count as the period after it', () => {
  const b = box();
  const accepted = NOW - 8 * DAY;
  const check = (result: string) => ({ kind: 'check.answered', scenario: 'change-review', scenario_v: 1, data: { result, check_kind: 'citations' } });
  // Four checks made the pattern, but only one of them is in the period that the measure reads.
  rows(b, accepted - 10 * DAY, ['FAIL', 'FAIL', 'FAIL'].map(check));
  rows(b, accepted - DAY, [check('FAIL')]);
  const made = propose(b.rt, accepted);
  assert.deepEqual(made.map((p) => p.pattern), ['check_fails_often']);
  resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', accepted);
  rows(b, accepted + DAY, ['FAIL', 'FAIL', 'FAIL', 'PASS'].map(check));
  // One check before is a share of 0 or of 1: it says nothing, and "worse" would propose an undo.
  assert.deepEqual(measure(b.rt, NOW), []);
  assert.equal(listProposals(b.rt)[0]?.effect, 'not_measured');
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

// ---- The effect of "the record is stale".

test('craft: a record that went stale and nobody brought back is a better memory; one that the human restored is worse', () => {
  const stale = (b: Box): { record: string; proposal: string } => {
    const note = addRecord(b.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 40 * DAY);
    assert.ok(note.ok);
    const made = propose(b.rt, NOW).filter((p) => p.pattern === 'record_unused');
    assert.equal(resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW), true);
    return { record: note.record.id, proposal: made[0]?.id ?? '' };
  };
  // Nobody worked after the acceptance: nothing is measured.
  const idle = box();
  stale(idle);
  assert.deepEqual(measure(idle.rt, NOW + 8 * DAY), []);
  // The agent worked, and nobody needed the record.
  const quiet = box();
  stale(quiet);
  rows(quiet, NOW + DAY, question('default.write'));
  assert.deepEqual(measure(quiet.rt, NOW + 8 * DAY).map((p) => [p.pattern, p.effect]), [['record_unused', 'better']]);
  // The human brought the record back: the change was wrong. The record is back already: no undo is proposed.
  const back = box();
  const made = stale(back);
  rows(back, NOW + DAY, [...question('default.write'), { kind: 'memory.record_changed', data: { record: made.record, type: 'pitfall', state: 'active' } }]);
  assert.deepEqual(measure(back.rt, NOW + 8 * DAY).map((p) => [p.pattern, p.effect]), [['record_unused', 'worse']]);
  assert.equal(listProposals(back.rt).some((p) => p.pattern === 'rollback'), false);
  // A change that was not made is not measured, whatever follows.
  const unmade = box();
  const skipped = stale(unmade);
  const file = path.join(unmade.rt.stateDir, 'craft', `${skipped.proposal}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), applied: false }));
  rows(unmade, NOW + DAY, question('default.write'));
  assert.deepEqual(measure(unmade.rt, NOW + 8 * DAY), []);
  // A step of a case and a share of another record are not a restore of this one.
  const other = box();
  const kept = stale(other);
  rows(other, NOW + DAY, [...question('default.write'), { kind: 'memory.record_changed', data: { record: kept.record, type: 'case', state: 'active', step: 1 } }, { kind: 'memory.record_changed', data: { record: 'm0000000000', type: 'pitfall', state: 'active' } }, { kind: 'memory.record_changed', data: { record: kept.record, type: 'pitfall', state: 'active', wrong: 1 } }]);
  assert.deepEqual(measure(other.rt, NOW + 8 * DAY).map((p) => p.effect), ['better']);
});

// ---- The level of the model is higher than the work needs.

// A row of a scenario with its data, as the core writes it.
const fact = (kind: string, scenario: string, data?: Record<string, unknown>) => ({ kind, scenario, scenario_v: 1, ...(data !== undefined ? { data } : {}) });

test('craft: a scenario whose tasks never came back and never raised the level has a level that is too high', () => {
  const b = box();
  const started = (scenario: string, level?: string) => fact('task.started', scenario, level === undefined ? undefined : { level });
  // Ten tasks at the strong level, no return and no raise. Another scenario came back once. A third runs at the weak level.
  rows(b, NOW - DAY, [...times(10, [started('change-review', 'strong')]), ...times(10, [started('draft-message', 'strong')]), fact('task.returned', 'draft-message', { n: 1, reason: 'check_fail' }), ...times(10, [started('wrapup', 'weak')])]);
  assert.deepEqual(detect(readJournal(b.rt.journal.file)), [{ pattern: 'level_too_high', key: 'change-review', n: 10 }]);
  // The packs: the threshold, and the scenario that the craft leaves alone. Fewer tasks than the threshold say nothing.
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { min_smooth: 11 }), []);
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { keep: ['change-review'] }), []);
  assert.deepEqual(detect(readJournal(b.rt.journal.file), { min_smooth: 5 }).map((p) => p.key), ['change-review']);
  // A task whose level the journal does not name is not known to be above the weak level.
  const unnamed = box();
  rows(unnamed, NOW - DAY, times(10, [started('change-review')]));
  assert.deepEqual(detect(readJournal(unnamed.rt.journal.file)), []);
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.n, p.change]), [['level_too_high', 'change-review', 10, undefined]]);
  assert.match(proposalLine(made[0] as never), /level_too_high of "change-review"/);
  assert.equal(resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW), true);
  // The human did not lower the level: nothing changed, nothing is measured.
  rows(b, NOW + 2 * DAY, times(4, [started('change-review', 'strong')]));
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY), []);
  for (const row of readJournal(b.rt.journal.file).filter((r) => r.kind.startsWith('craft.'))) assert.deepEqual(validateRow(row), []);
});

test('craft: a lowered level that brings returns or raises is worse, and one that brings none is better', () => {
  const started = (scenario: string, level: string) => fact('task.started', scenario, { level });
  const lowered = (after: Record<string, unknown>[]): string[] => {
    const b = box();
    rows(b, NOW - DAY, times(10, [started('change-review', 'strong')]));
    const made = propose(b.rt, NOW);
    resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW);
    rows(b, NOW + 2 * DAY, after);
    return measure(b.rt, NOW + 8 * DAY).map((p) => `${p.pattern} ${p.effect}`);
  };
  assert.deepEqual(lowered(times(5, [started('change-review', 'medium')])), ['level_too_high better']);
  assert.deepEqual(lowered([...times(5, [started('change-review', 'medium')]), fact('executor.level_raised', 'change-review', { level: 'strong' })]), ['level_too_high worse']);
  assert.deepEqual(lowered([...times(5, [started('change-review', 'medium')]), fact('task.returned', 'change-review', { n: 1, reason: 'check_fail' })]), ['level_too_high worse']);
  assert.deepEqual(lowered(times(4, [started('change-review', 'medium')])), [], 'too few tasks after the change');
  // The human lowered the level some days after the acceptance: the tasks at the old level between do not hide the change.
  assert.deepEqual(lowered([...times(6, [started('change-review', 'strong')]), ...times(5, [started('change-review', 'medium')])]), ['level_too_high better']);
});

// ---- The craft is switched off by one setting.

test('craft: with the setting of a pack the craft finds nothing, applies nothing and measures nothing; the rest works', () => {
  const b = box();
  rows(b, NOW - DAY, times(6, question('default.write')));
  const off: typeof b.rt = { ...b.rt, merged: { ...b.rt.merged, craft: { ...b.rt.merged.craft, off: true } } };
  assert.deepEqual(propose(off, NOW), []);
  assert.deepEqual(listProposals(off), []);
  // A proposal that was made before stays for the human: it is listed and can be resolved.
  const made = propose(b.rt, NOW);
  assert.equal(made.length, 1);
  assert.deepEqual(listProposals(off).map((p) => p.id), [made[0]?.id]);
  assert.equal(resolveProposal(off, made[0]?.id ?? '', 'accepted', NOW), true);
  rows(b, NOW + DAY, question('default.read'));
  assert.deepEqual(measure(off, NOW + 8 * DAY), []);
  assert.equal(measure(b.rt, NOW + 8 * DAY).length, 1, 'the same proposal is measured when the craft is on');
  // Nothing applies itself while the craft is off.
  const due = box();
  const note = addRecord(due.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 40 * DAY);
  assert.ok(note.ok);
  const auto: typeof due.rt = { ...due.rt, merged: { ...due.rt.merged, craft: { auto_days: 5 } } };
  assert.equal(propose(auto, NOW).length, 1);
  const twin = box();
  const same = addRecord(twin.rt, { type: 'pitfall', text: 'the cache must be cleared first', paths: [], by: 'human' }, NOW - 40 * DAY);
  assert.ok(same.ok);
  const twinAuto: typeof twin.rt = { ...twin.rt, merged: { ...twin.rt.merged, craft: { auto_days: 5 } } };
  assert.match(proposalLine(propose(twinAuto, NOW)[0] as never), /applies itself/);
  assert.deepEqual(applyDue({ ...twinAuto, merged: { ...twinAuto.merged, craft: { auto_days: 5, off: true } } }, NOW + 6 * DAY), []);
  // The proposal lost its term: the craft that is on again does not apply it at once, it waits for the human.
  assert.doesNotMatch(proposalLine(listProposals(twinAuto)[0] as never), /applies itself/);
  assert.deepEqual(applyDue(twinAuto, NOW + 7 * DAY), []);
  assert.equal(listProposals(twinAuto)[0]?.state, 'open');
  assert.equal(applyDue(auto, NOW + 6 * DAY).length, 1);
});

test('craft: the switch of a pack is the word "true", and nothing else', () => {
  const errors = (craft: unknown) => validateSettings({ pack: 1, level: 'person', name: 'me', craft }, 'person').errors.map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors({ off: true }), []);
  assert.deepEqual(errors({ off: false }), ['not_allowed craft.off']);
  assert.deepEqual(errors({ off: 'yes' }), ['not_allowed craft.off']);
});

test('craft: a pitfall that the human rejects is not written, and one that did not help is taken out of the work by its undo', () => {
  const failed = (tool: string) => ({ kind: 'executor.tool_failed', data: { tool } });
  const rejected = box();
  rows(rejected, NOW - DAY, times(5, [failed('mcp__tracker__get_change')]));
  assert.equal(resolveProposal(rejected.rt, propose(rejected.rt, NOW)[0]?.id ?? '', 'rejected', NOW), true);
  assert.deepEqual(listRecords(rejected.rt), []);
  // Accepted, and the tool fails more often after it: the craft proposes the undo, with the record as its change.
  const b = box();
  rows(b, NOW - DAY, times(5, [failed('mcp__tracker__get_change')]));
  const first = propose(b.rt, NOW)[0];
  resolveProposal(b.rt, first?.id ?? '', 'accepted', NOW);
  const record = listRecords(b.rt).find((r) => r.type === 'pitfall');
  rows(b, NOW + DAY, [...question('default.write'), ...times(9, [failed('mcp__tracker__get_change')])]);
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY).map((p) => p.effect), ['worse']);
  const undo = listProposals(b.rt).find((p) => p.pattern === 'rollback');
  assert.deepEqual(undo?.change, { kind: 'memory', record: record?.id, state: 'stale', undo: true });
  assert.equal(resolveProposal(b.rt, undo?.id ?? '', 'accepted', NOW + 8 * DAY), true);
  assert.equal(listRecords(b.rt, NOW + 8 * DAY).find((r) => r.id === record?.id)?.state, 'stale');
  assert.ok(listProposals(b.rt).find((p) => p.id === first?.id)?.undone !== undefined);
});

test('craft: a check that answers PASS and FAIL for one work and one report is unstable', () => {
  const check = (result: string, fp: string, report: string, more: Record<string, unknown> = {}): JournalRow =>
    ({ ts: new Date(NOW - DAY).toISOString(), v: 1, kind: 'check.answered', project: 'p1a2b3c4', scenario: 'code-change', scenario_v: 1, fp, data: { result, check_kind: 'command', report, ...more } }) as JournalRow;
  const same = 'a'.repeat(32);
  // The same work and the same report, two answers: one pattern. A check before the report counts too.
  assert.deepEqual(detect([check('FAIL', same, 'r1'), check('PASS', same, 'r1', { probe: 1 })]), [{ pattern: 'check_unstable', key: 'code-change', n: 1 }]);
  // Another report or another work is another question to the check: no pattern.
  assert.deepEqual(detect([check('FAIL', same, 'r1'), check('PASS', same, 'r2')]), []);
  assert.deepEqual(detect([check('FAIL', same, 'r1'), check('PASS', 'b'.repeat(32), 'r1')]), []);
  // A check that was changed between the two answers is another check: no pattern.
  assert.deepEqual(detect([check('FAIL', same, 'r1', { check: 'v1' }), check('PASS', same, 'r1', { check: 'v2' })]), []);
  assert.equal(detect([check('FAIL', same, 'r1', { check: 'v1' }), check('PASS', same, 'r1', { check: 'v1' })]).length, 1);
  // A scenario that the packs tell the craft to leave alone gets no proposal.
  assert.deepEqual(detect([check('FAIL', same, 'r1'), check('PASS', same, 'r1')], { keep: ['code-change'] }), []);
});

// ---- The measures of the harness as patterns.

test('craft: a memory record that the agent got many times and that no report cited is a pattern, and the acceptance makes it stale', () => {
  const b = box();
  const dead = addRecord(b.rt, { type: 'pitfall', text: 'the gateway needs a warm cache', paths: [], by: 'human' }, NOW - DAY);
  const live = addRecord(b.rt, { type: 'pitfall', text: 'the gateway needs a token of the day', paths: [], by: 'human' }, NOW - DAY);
  const decision = addRecord(b.rt, { type: 'decision', text: 'the gateway keeps one cache', because: 'two caches went out of step', paths: [], by: 'human' }, NOW - DAY);
  assert.ok(dead.ok && live.ok && decision.ok);
  // Every record is given five times; one of them is cited by a report.
  for (let i = 0; i < 5; i += 1) searchRecords(b.rt, ['gateway'], 20, NOW);
  countUses(b.rt, `the work used ${live.record.id}`, NOW);
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.n, p.change]), [['record_dead', dead.record.id, 5, { kind: 'memory', record: dead.record.id, state: 'stale', dead: true }]], 'a decision is not judged by citations');
  assert.equal(resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW), true);
  assert.equal(listRecords(b.rt, NOW).find((r) => r.id === dead.record.id)?.state, 'stale');
  // A record that a report cited after the proposal stays in the work.
  const next = box();
  const late = addRecord(next.rt, { type: 'pitfall', text: 'the gateway needs a warm cache', paths: [], by: 'human' }, NOW - DAY);
  assert.ok(late.ok);
  for (let i = 0; i < 5; i += 1) searchRecords(next.rt, ['gateway'], 20, NOW);
  const open = propose(next.rt, NOW);
  countUses(next.rt, `the work used ${late.record.id}`, NOW);
  assert.equal(resolveProposal(next.rt, open[0]?.id ?? '', 'accepted', NOW), true);
  assert.deepEqual([listRecords(next.rt, NOW).find((r) => r.id === late.record.id)?.state, listProposals(next.rt)[0]?.applied], ['active', false]);
  // The same for a record that the answer of a free task cited after the proposal: it is in use.
  const third = box();
  const free = addRecord(third.rt, { type: 'pitfall', text: 'the gateway needs a warm cache', paths: [], by: 'human' }, NOW - DAY);
  assert.ok(free.ok);
  for (let i = 0; i < 5; i += 1) searchRecords(third.rt, ['gateway'], 20, NOW);
  const waits = propose(third.rt, NOW);
  countUses(third.rt, `the answer rests on ${free.record.id}`, NOW, true);
  assert.equal(resolveProposal(third.rt, waits[0]?.id ?? '', 'accepted', NOW), true);
  assert.deepEqual([listRecords(third.rt, NOW).find((r) => r.id === free.record.id)?.state, listProposals(third.rt)[0]?.applied], ['active', false]);
});

test('craft: a dead record that the human brought back is a worse memory, and no undo is proposed: the record is back already', () => {
  const b = box();
  const dead = addRecord(b.rt, { type: 'pitfall', text: 'the gateway needs a warm cache', paths: [], by: 'human' }, NOW - DAY);
  assert.ok(dead.ok);
  for (let i = 0; i < 5; i += 1) searchRecords(b.rt, ['gateway'], 20, NOW);
  const made = propose(b.rt, NOW).filter((p) => p.pattern === 'record_dead');
  assert.equal(resolveProposal(b.rt, made[0]?.id ?? '', 'accepted', NOW), true);
  rows(b, NOW + DAY, [...question('default.write'), { kind: 'memory.record_changed', data: { record: dead.record.id, type: 'pitfall', state: 'active' } }]);
  assert.deepEqual(measure(b.rt, NOW + 8 * DAY).map((p) => [p.pattern, p.effect]), [['record_dead', 'worse']]);
  assert.equal(listProposals(b.rt).some((p) => p.pattern === 'rollback'), false);
});

test('craft: a measure above its target of the packs on several days is a pattern, and its effect is the count of such days', () => {
  const b = box();
  const hook = (ms: number) => ({ kind: 'policy.decision', data: { outcome: 'allow', action_kind: 'read', env: 'local', ms } });
  const day0 = Math.floor(NOW / DAY) * DAY;
  // No target in the packs: no pattern, whatever the numbers.
  rows(b, day0 - 2 * DAY + 3600_000, times(20, [hook(900)]));
  rows(b, day0 - DAY + 3600_000, times(20, [hook(900)]));
  assert.deepEqual(propose(b.rt, NOW), []);
  b.rt.merged.targets = { hook_ms_p95: 300, harness_failures: 0, not_a_measure: 1 };
  const made = propose(b.rt, NOW);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.n, p.change]), [['target_exceeded', 'hook_ms_p95', 2, undefined]]);
  for (const r of readJournal(b.rt.journal.file).filter((x) => x.kind.startsWith('craft.'))) assert.deepEqual(validateRow(r), []);
  // One day above the target is an accident: no pattern.
  const one = box();
  one.rt.merged.targets = { hook_ms_p95: 300 };
  rows(one, day0 - DAY + 3600_000, times(20, [hook(900)]));
  assert.deepEqual(propose(one.rt, NOW), []);
  // The effect: after the acceptance the hook is fast again.
  const id = made[0]?.id ?? '';
  assert.equal(resolveProposal(b.rt, id, 'accepted', NOW), true);
  for (let d = 1; d <= 8; d += 1) rows(b, NOW + d * DAY, times(20, [hook(100)]));
  const measured = measure(b.rt, NOW + 9 * DAY);
  assert.deepEqual(measured.map((p) => [p.id, p.effect]), [[id, 'better']]);
});

test('craft: the summary names the targets, and the packs set how often it is written', () => {
  const b = box();
  b.rt.merged.targets = { hook_ms_p95: 300 };
  const day0 = Math.floor(NOW / DAY) * DAY;
  rows(b, day0 - DAY + 3600_000, times(5, [{ kind: 'policy.decision', data: { outcome: 'allow', action_kind: 'read', env: 'local', ms: 700 } }]));
  const text = weekText(b.rt, NOW);
  assert.match(text, /## Targets\n\n\| measure \| target \| days above \| days with a value \| worst day \|\n\|---\|---\|---\|---\|---\|\n\| hook_ms_p95 \| 300 \| 1 \| 1 \| 700 \|/);
  // Seven days by the code: the fourth day writes nothing. Three days by the packs: it writes.
  assert.notEqual(writeWeek(b.rt, NOW), null);
  assert.equal(writeWeek(b.rt, NOW + 4 * DAY), null);
  b.rt.merged.craft = { summary_days: 3 };
  assert.notEqual(writeWeek(b.rt, NOW + 4 * DAY), null);
  assert.equal(writeWeek(b.rt, NOW + 5 * DAY), null);
  // The form of the section of the targets.
  assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', targets: { hook_ms_p95: 300, probe_noise: 0, asks_per_task: 1.5, disputed: -1, 'Bad Name': 1 } }, 'person').errors.map((e) => `${e.code} ${e.path}`).sort(), ['bad_name targets.Bad Name', 'not_integer targets.asks_per_task', 'not_positive targets.disputed']);
  assert.equal(validateSettings({ pack: 1, level: 'person', name: 'me', targets: [] }, 'person').errors[0]?.code, 'not_object');
});
