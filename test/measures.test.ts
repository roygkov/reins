// The measures of the harness itself in the summary of the journal: the questions by rule, the
// cost in time, the text given to the agent, the results that a human disputed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JournalRow } from '../src/contracts/journal.ts';
import { BY, MEASURES, series, summarize } from '../src/journal/metrics.ts';

let tick = 0;
const row = (kind: string, data: Record<string, unknown>, more: Record<string, unknown> = {}): JournalRow =>
  ({ ts: new Date(Date.UTC(2026, 10, 13, 10, 0, (tick += 1))).toISOString(), v: 1, kind, project: 'p0a0a0a0a', task: 't000001', session: 's1', data, ...more }) as unknown as JournalRow;

test('measures: the questions that the human saw are counted by the rule that asked', () => {
  const rows = [
    // A decision "ask" gets its rule from the basis row after it.
    row('policy.decision', { outcome: 'ask', action_kind: 'write', env: 'work' }), row('policy.basis', { layer: 'core', rule: 'default.write' }),
    row('task.human_decision', { decision: 'answered', rule: 'default.write' }),
    row('policy.decision', { outcome: 'ask', action_kind: 'write', env: 'work' }), row('policy.basis', { layer: 'core', rule: 'default.write' }),
    // An allowed action has a basis too: it is no question.
    row('policy.decision', { outcome: 'allow', action_kind: 'read', env: 'local' }), row('policy.basis', { layer: 'core', rule: 'default.read' }),
    // A question that no human saw is not counted.
    row('policy.decision', { outcome: 'ask', action_kind: 'write', env: 'work', unshown: 1 }), row('policy.basis', { layer: 'core', rule: 'default.write' }),
    // A protected place names its rule in its own row.
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask' }), row('task.human_decision', { decision: 'answered', rule: 'protect.harness' }),
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask' }), row('task.human_decision', { decision: 'answered', rule: 'protect.harness' }),
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask' }), row('task.human_decision', { decision: 'refused', rule: 'protect.harness' }),
    row('policy.protected_attempt', { rule: 'protect.state', outcome: 'deny' }),
    // The basis of another task does not answer the question of this one.
    row('policy.decision', { outcome: 'ask', action_kind: 'write', env: 'work' }, { task: 't000002' }), row('policy.basis', { layer: 'core', rule: 'default.read' }), row('policy.basis', { layer: 'person', rule: 'my.rule' }, { task: 't000002' }),
  ];
  const m = summarize(rows);
  assert.deepEqual(m.questions, { 'protect.harness': { asked: 3, yes: 2 }, 'default.write': { asked: 2, yes: 1 }, 'my.rule': { asked: 1, yes: 0 } });
  // The most asked rule stands first.
  assert.deepEqual(Object.keys(m.questions), ['protect.harness', 'default.write', 'my.rule']);
});

test('measures: the time of a decision of the hook and of a done check is a middle, a tail and a top', () => {
  const rows: JournalRow[] = [];
  for (let ms = 1; ms <= 20; ms += 1) rows.push(row('policy.decision', { outcome: 'allow', action_kind: 'read', env: 'local', ms: ms * 10 }));
  rows.push(row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask', ms: 900 }));
  // A row of an older journal has no time: it is not counted.
  rows.push(row('policy.decision', { outcome: 'allow', action_kind: 'read', env: 'local' }));
  rows.push(row('check.answered', { result: 'PASS', check_kind: 'command', ms: 4000 }), row('check.answered', { result: 'FAIL', check_kind: 'command', ms: 6000, probe: 1 }), row('check.no_answer', { check_kind: 'command', ms: 300_000 }));
  const m = summarize(rows);
  assert.deepEqual(m.timing.hook_ms, { n: 21, p50: 110, p95: 200, max: 900 });
  assert.deepEqual(m.timing.check_ms, { n: 3, p50: 6000, p95: 300_000, max: 300_000 });
  assert.deepEqual(summarize([]).timing, { hook_ms: { n: 0, p50: null, p95: null, max: null }, check_ms: { n: 0, p50: null, p95: null, max: null } });
});

test('measures: the text that the hooks gave to the agent is counted by its place', () => {
  const m = summarize([
    row('harness.context_given', { where: 'session_start', bytes: 9000 }), row('harness.context_given', { where: 'session_start', bytes: 11_000 }),
    row('harness.context_given', { where: 'after', bytes: 120 }), row('harness.context_given', { where: 'after' }),
  ]);
  assert.deepEqual(m.context, { session_start: { n: 2, bytes: 20_000 }, after: { n: 1, bytes: 120 } });
});

test('measures: a result that the human said was wrong is counted by the label that it had', () => {
  const m = summarize([row('task.result_disputed', { label: 'verified_result' }), row('task.result_disputed', { label: 'verified_form' }), row('task.result_disputed', { label: 'verified_result' })]);
  assert.deepEqual(m.disputed, { verified_result: 2, verified_form: 1 });
});

test('measures: the questions that the human saw fall on the opened tasks', () => {
  const rows = [
    row('task.opened', {}), row('task.opened', {}, { task: 't000002' }), row('task.opened', {}, { task: 't000003' }), row('task.opened', {}, { task: 't000004' }),
    row('policy.decision', { outcome: 'ask', action_kind: 'write', env: 'work' }), row('policy.basis', { layer: 'core', rule: 'default.write' }),
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask' }),
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask', unshown: 1 }),
    row('policy.protected_attempt', { rule: 'protect.state', outcome: 'deny' }),
    row('policy.decision', { outcome: 'allow', action_kind: 'read', env: 'local' }),
  ];
  assert.deepEqual(summarize(rows).asks, { shown: 2, per_task: 0.5 });
  assert.deepEqual(summarize([]).asks, { shown: 0, per_task: null });
});

test('measures: a pitfall that names an older record of the same pitfall is a repeat', () => {
  const m = summarize([
    row('memory.record_changed', { record: 'm0000000001', type: 'pitfall', state: 'pending' }),
    row('memory.record_changed', { record: 'm0000000002', type: 'pitfall', state: 'pending', repeats: 'm0000000001' }),
    row('memory.record_changed', { record: 'm0000000003', type: 'pitfall', state: 'active', repeats: 'm0000000001' }),
    // A veto, a mark and a record of another type are not a written pitfall.
    row('memory.record_changed', { record: 'm0000000002', type: 'pitfall', state: 'vetoed' }),
    row('memory.record_changed', { record: 'm0000000001', type: 'pitfall', state: 'active', wrong: 1 }),
    row('memory.record_changed', { record: 'm0000000004', type: 'state', state: 'active' }),
  ]);
  assert.deepEqual(m.pitfalls, { written: 3, repeats: 2 });
});

test('measures: a run of the probes of the barrier gives the counts of the last run of the period', () => {
  const m = summarize([row('harness.barrier_probed', { n: 36, misses: 3, noise: 1 }), row('harness.barrier_probed', { n: 36, misses: 1, noise: 0 }), row('harness.barrier_probed', { n: 36 })]);
  assert.deepEqual(m.probes, { runs: 2, n: 36, misses: 1, noise: 0 });
  assert.deepEqual(summarize([]).probes, { runs: 0, n: null, misses: null, noise: null });
});

test('measures: a point of the series carries the numbers by rule, by place and by label (the form 3)', () => {
  const day = 24 * 60 * 60 * 1000;
  const from = Date.UTC(2026, 10, 13);
  const rows = [
    row('task.opened', {}),
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask', ms: 100 }), row('task.human_decision', { decision: 'answered', rule: 'protect.harness' }),
    row('policy.protected_attempt', { rule: 'protect.harness', outcome: 'ask', ms: 300 }),
    row('policy.protected_attempt', { rule: 'protect.state', outcome: 'deny', ms: 900 }),
    row('policy.decision', { outcome: 'deny', action_kind: 'write', env: 'prod' }),
    row('harness.context_given', { where: 'session_start', bytes: 9000 }), row('harness.context_given', { where: 'after', bytes: 120 }),
    row('task.result_disputed', { label: 'verified_form' }),
    row('check.answered', { result: 'PASS', check_kind: 'command', ms: 4000 }), row('check.no_answer', { check_kind: 'command', ms: 300_000 }),
    row('harness.barrier_probed', { n: 36, misses: 1, noise: 2 }),
    row('executor.cost', { tokens: 1500, ms: 0, calls: 3, model: 'claude-fable-5-2', input: 100, output: 400, cache_write: 1000, cache_read: 90_000 }),
    row('executor.cost', { tokens: 200, ms: 0, calls: 1, model: 'claude-haiku-5-5', input: 50, output: 150, cache_write: 0, cache_read: 0 }),
    // A row of an older journal: no model, no kinds.
    row('executor.cost', { tokens: 300, ms: 0, calls: 1 }),
  ];
  const points = series(rows, from, from + 2 * day, day);
  assert.equal(points.length, 2);
  assert.deepEqual(Object.keys(points[0]?.measures ?? {}), [...MEASURES]);
  assert.deepEqual(Object.keys(points[0]?.by ?? {}), [...BY]);
  assert.deepEqual(points[0]?.by, { questions_asked: { 'protect.harness': 2 }, questions_yes: { 'protect.harness': 1 }, context_bytes: { session_start: 9000, after: 120 }, disputed: { verified_form: 1 }, model_tokens: { 'claude-fable-5-2': 1500, 'claude-haiku-5-5': 200, unknown: 300 }, model_calls: { 'claude-fable-5-2': 3, 'claude-haiku-5-5': 1, unknown: 1 }, token_kinds: { input: 150, output: 550, cache_write: 1000, cache_read: 90_000 } });
  assert.deepEqual(points[0]?.measures, { asks_per_task: 2, hook_ms_p50: 300, hook_ms_p95: 900, hook_ms_max: 900, check_ms_p50: 4000, check_ms_p95: 300_000, context_bytes: 9120, disputed: 1, pitfall_repeats: 0, denied: 2, checks_no_answer: 1, probe_misses: 1, probe_noise: 2, tokens_total: 2000, model_calls: 5 });
  // A day without rows: no name by rule, no value of the barrier.
  assert.deepEqual(points[1]?.by, { questions_asked: {}, questions_yes: {}, context_bytes: {}, disputed: {}, model_tokens: {}, model_calls: {}, token_kinds: {} });
  assert.equal(points[1]?.measures.probe_misses, null);
  assert.equal(points[1]?.measures.denied, 0);
});
