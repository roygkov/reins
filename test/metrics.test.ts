// The counts of the journal: what a number counts and what it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalRow } from '../src/contracts/journal.ts';
import { eight, ofProject, summarize } from '../src/journal/metrics.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const row = (kind: string, data: Record<string, unknown>, more: Record<string, unknown> = {}): JournalRow =>
  ({ ts: new Date(NOW - 60_000).toISOString(), v: 1, kind, project: 'p1a2b3c4', ...more, data }) as JournalRow;

test('metrics: the share of verified results says how each result was verified', () => {
  const closed = (label: string): JournalRow => row('task.closed', { label }, { scenario: 'review', task: 't1' });
  const rows = [closed('verified_result'), closed('verified_form'), closed('verified_form'), closed('approved_by_human'), closed('not_verified')];
  const n = eight(rows, NOW).verified_share;
  assert.deepEqual([n.value, n.n], [0.8, 5]);
  // A check of the form is not a check of the result: the number shows the parts.
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
