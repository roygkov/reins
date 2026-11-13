// The measures of the harness itself in the summary of the journal: the questions by rule, the
// cost in time, the text given to the agent, the results that a human disputed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JournalRow } from '../src/contracts/journal.ts';
import { summarize } from '../src/journal/metrics.ts';

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
