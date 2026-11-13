// The counts of the journal: what a number counts and what it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalRow } from '../src/contracts/journal.ts';
import { EIGHT, eight, ofProject, series, summarize } from '../src/journal/metrics.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const row = (kind: string, data: Record<string, unknown>, more: Record<string, unknown> = {}): JournalRow =>
  ({ ts: new Date(NOW - 60_000).toISOString(), v: 1, kind, project: 'p1a2b3c4', ...more, data }) as JournalRow;

test('metrics: only a check of the result counts as verified, and the parts name the other labels', () => {
  const closed = (label: string): JournalRow => row('task.closed', { label }, { scenario: 'review', task: 't1' });
  const rows = [closed('verified_result'), closed('verified_form'), closed('verified_form'), closed('approved_by_human'), closed('not_verified')];
  const n = eight(rows, NOW).verified_share;
  assert.deepEqual([n.value, n.n], [0.2, 5]);
  // A check of the form and an approval of the human are not a check of the result: the parts show them.
  assert.deepEqual(n.parts, { verified_result: 1, verified_form: 2, approved_by_human: 1 });
  // The other numbers have no parts.
  assert.equal(eight(rows, NOW).returns_per_task.parts, undefined);
});

test('metrics: a record that was replaced, went stale or came back is not a written record', () => {
  const changed = (data: Record<string, unknown>): JournalRow => row('memory.record_changed', { record: 'm1', type: 'pitfall', ...data });
  const rows = [changed({ state: 'active' }), changed({ state: 'pending' }), changed({ state: 'replaced' }), changed({ state: 'stale' }), changed({ state: 'active', restored: 1 }), changed({ state: 'vetoed' })];
  assert.deepEqual(summarize(rows).memory, { written: 2, vetoed: 1, reads: 0 });
});

test('metrics: a refusal at a protected place is counted apart from a question about it', () => {
  const at = (outcome: string): JournalRow => row('policy.protected_attempt', { rule: 'protect.state', outcome });
  const m = summarize([at('deny'), at('deny'), at('ask')]);
  assert.deepEqual([m.protected_attempts, m.protected], [3, { ask: 1, deny: 2 }]);
});

test('metrics: the counts of one project leave out the rows of the other projects', () => {
  const rows = [row('task.opened', {}), row('task.opened', {}, { project: 'p9z9z9z9' }), row('task.closed', { label: 'verified_result' }, { scenario: 's', project: 'p9z9z9z9' })];
  assert.equal(summarize(ofProject(rows, 'p1a2b3c4')).tasks.opened, 1);
  assert.equal(eight(ofProject(rows, 'p1a2b3c4'), NOW).verified_share.n, 0);
  assert.equal(eight(rows, NOW).verified_share.n, 1);
});

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string, kind: string, data: Record<string, unknown>, more: Record<string, unknown> = {}): JournalRow =>
  ({ ts: iso, v: 1, kind, project: 'p1a2b3c4', ...more, data }) as JournalRow;

test('metrics: a series gives the eight numbers for each day, by the same formulas as the week', () => {
  const rows = [
    at('2026-11-11T10:00:00.000Z', 'task.closed', { label: 'verified_result' }, { scenario: 's' }),
    at('2026-11-11T23:59:59.000Z', 'task.closed', { label: 'verified_form' }, { scenario: 's' }),
    at('2026-11-13T00:00:00.000Z', 'task.closed', { label: 'verified_result' }, { scenario: 's' }),
    at('2026-11-13T08:00:00.000Z', 'harness.failure', { where: 'pack' }),
  ];
  const from = Date.parse('2026-11-11T00:00:00Z');
  const points = series(rows, from, from + 3 * DAY, DAY);
  assert.deepEqual(points.map((p) => [p.from, p.to]), [
    ['2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z'],
    ['2026-11-12T00:00:00.000Z', '2026-11-13T00:00:00.000Z'],
    ['2026-11-13T00:00:00.000Z', '2026-11-14T00:00:00.000Z'],
  ]);
  assert.deepEqual(points.map((p) => [p.verified_share.value, p.verified_share.n]), [[0.5, 2], [null, 0], [1, 1]]);
  assert.deepEqual(points[0]?.verified_share.parts, { verified_result: 1, verified_form: 1 });
  assert.deepEqual(points.map((p) => p.harness_failures.value), [0, 0, 1]);
  for (const p of points) assert.deepEqual(Object.keys(p).slice(2), [...EIGHT]);
  // One bucket over the whole span gives what the week gives for the same rows.
  const [all] = series(rows, from, from + 7 * DAY, 7 * DAY);
  const week = eight(rows, from + 7 * DAY - 1);
  for (const name of EIGHT) assert.deepEqual([all?.[name].value, all?.[name].n], [week[name].value, week[name].n], name);
});

test('metrics: the summary counts the checks that answered PASS and FAIL for one work and one report', () => {
  const check = (result: string, fp: string, report: string): JournalRow => row('check.answered', { result, check_kind: 'command', report }, { scenario: 's', fp });
  const m = summarize([check('FAIL', 'a'.repeat(32), 'r1'), check('PASS', 'a'.repeat(32), 'r1'), check('PASS', 'b'.repeat(32), 'r1')]);
  assert.equal(m.unstable_checks, 1);
  assert.equal(summarize([check('PASS', 'a'.repeat(32), 'r1')]).unstable_checks, 0);
});
