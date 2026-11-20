// The task loop as a pure state machine. Cases are data: test/data/task-cases.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFreeTask, newScenarioTask, step, decideFor, confirmGrant, grantsOf, type Task, type TaskEvent, type RowDraft } from '../src/core/task.ts';
import { validateRow } from '../src/contracts/journal.ts';
import type { Manifest } from '../src/contracts/manifest.ts';
import type { Action } from '../src/contracts/policy.ts';
import { loadCases } from './cases.ts';

type Case = {
  name: string;
  task: 'review' | 'minimal' | 'free';
  events: TaskEvent[];
  expect: { state: string; waiting?: string; label?: string; returns: number; errors: number; rows: string[] };
};

const manifests = new Map(loadCases<{ name: string; manifest: Manifest }>('manifest-bases').map((b) => [b.name, b.manifest]));

function start(kind: Case['task']): { task: Task; rows: RowDraft[] } {
  if (kind === 'free') return newFreeTask('t0001');
  const manifest = manifests.get(kind);
  assert.ok(manifest !== undefined);
  const made = newScenarioTask('t0001', manifest, kind === 'review' ? { change_id: '7' } : {});
  assert.ok('task' in made, 'the inputs are valid');
  return made;
}

const show = (r: RowDraft): string =>
  [r.kind, ...Object.entries(r.data ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${String(v)}`)].join(' ');

// Every row that the loop drafts must pass the check of the journal.
function assertWritable(rows: RowDraft[]): void {
  for (const r of rows) {
    const row = { ts: '2026-11-11T08:00:00.000Z', v: 1, kind: r.kind, project: 'p1', task: 't0001', ...(r.data !== undefined && { data: r.data }) };
    assert.deepEqual(validateRow(row), [], `the row ${show(r)} can be written`);
  }
}

for (const c of loadCases<Case>('task-cases')) {
  test(`task: ${c.name}`, () => {
    const opened = start(c.task);
    assertWritable(opened.rows);
    let task = opened.task;
    const rows: RowDraft[] = [];
    let errors = 0;
    for (const event of c.events) {
      const s = step(task, event);
      if (s.error !== undefined) {
        errors += 1;
        assert.deepEqual(s.rows, [], 'a refused event writes nothing');
        assert.deepEqual(s.task, task, 'a refused event changes nothing');
      }
      task = s.task;
      rows.push(...s.rows);
    }
    assertWritable(rows);
    const got: Case['expect'] = { state: task.state, returns: task.returns, errors, rows: rows.map(show) };
    if (task.waiting !== undefined) got.waiting = task.waiting;
    if (task.label !== undefined) got.label = task.label;
    // `rows: null` in a case: the rows are not a part of what the case checks.
    if (c.expect.rows === null) got.rows = null as unknown as string[];
    assert.deepEqual(got, c.expect);
  });
}

test('task: opening a scenario task writes the kind and its reason', () => {
  assert.deepEqual(start('review').rows.map(show), ['task.opened', 'task.kind_decided kind=scenario reason=scenario_name']);
  assert.deepEqual(start('free').rows.map(show), ['task.opened', 'task.kind_decided kind=free reason=facts']);
  assert.equal(start('review').task.state, 'preparing');
  assert.equal(start('free').task.state, 'executing');
});

test('task: the inputs of a scenario are checked against the trigger', () => {
  const manifest = manifests.get('review');
  assert.ok(manifest !== undefined);
  const errors = (inputs: Record<string, string | number>): string[] => {
    const made = newScenarioTask('t1', manifest, inputs);
    return 'errors' in made ? made.errors.map((e) => `${e.code} ${e.path}`) : [];
  };
  assert.deepEqual(errors({}), ['missing change_id']);
  assert.deepEqual(errors({ change_id: '7', other: 'x' }), ['unknown other']);
  assert.deepEqual(errors({ change_id: 'has spaces' }), ['bad_type change_id']);
  assert.deepEqual(errors({ change_id: 7 }), ['bad_type change_id']);
  assert.deepEqual(errors({ change_id: '7' }), []);
});

test('task: the envelope is the write grants of the manifest with the inputs filled in', () => {
  const manifest = manifests.get('review');
  assert.ok(manifest !== undefined);
  assert.deepEqual(grantsOf(manifest, { change_id: '7' }), [{ action: 'comment', target: 'change/7', env: 'work', limit: 20, confirm: 'once' }]);
});

const comment = (target: string): Action => ({ via: 'tool', kind: 'write', name: 'comment', target, env: { name: 'work', known: true, production: false } });

test('task: the envelope acts only while the task executes, and only after its one confirmation', () => {
  let task = start('review').task;
  let d = decideFor(task, comment('change/7'), []);
  assert.deepEqual([d.decision.outcome, d.decision.envelope], ['ask', 'none'], 'no envelope before the execution');

  task = step(task, { type: 'prepared', work: true, outputs: 3, bytes: 10 }).task;
  d = decideFor(task, comment('change/7'), []);
  assert.deepEqual([d.decision.outcome, d.decision.scope, d.decision.envelope], ['ask', 'task', 'confirm']);
  assertWritable(d.rows);
  assert.deepEqual(d.rows.map(show), ['policy.decision action_kind=write env=work outcome=ask', 'policy.basis layer=core rule=default.write']);

  task = confirmGrant(d.task, 'comment change/7 work');
  d = decideFor(task, comment('change/7'), []);
  assert.deepEqual([d.decision.outcome, d.decision.envelope], ['allow', 'applied']);
  assert.equal(d.task.use.used['comment change/7 work'], 1, 'a use of the grant is counted');

  d = decideFor(d.task, comment('change/8'), []);
  assert.deepEqual([d.decision.outcome, d.decision.envelope], ['ask', 'not_named'], 'another change is not covered');

  assert.deepEqual(confirmGrant(task, 'merge change/7 work'), task, 'a grant that the manifest does not name cannot be confirmed');
  const fresh = start('review').task;
  assert.equal(confirmGrant(fresh, 'comment change/7 work'), fresh, 'a task that has not started takes no confirmation');
  const ended = step(fresh, { type: 'expire' }).task;
  assert.equal(confirmGrant(ended, 'comment change/7 work'), ended, 'a closed task takes no confirmation');
});

test('task: the write limit of a grant holds', () => {
  let task = step(start('review').task, { type: 'prepared', work: true, outputs: 3, bytes: 10 }).task;
  task = confirmGrant(task, 'comment change/7 work');
  for (let i = 0; i < 20; i += 1) {
    const d = decideFor(task, comment('change/7'), []);
    assert.equal(d.decision.outcome, 'allow');
    task = d.task;
  }
  const d = decideFor(task, comment('change/7'), []);
  assert.deepEqual([d.decision.outcome, d.decision.envelope], ['ask', 'limit']);
});

test('task: a closed task has no envelope', () => {
  let task = step(start('review').task, { type: 'prepared', work: true, outputs: 3, bytes: 10 }).task;
  task = confirmGrant(task, 'comment change/7 work');
  task = step(task, { type: 'report', size: 100, fp: '9f3ac2d41b07' }).task;
  const waiting = decideFor(task, comment('change/7'), []);
  assert.deepEqual([waiting.decision.outcome, waiting.decision.envelope], ['ask', 'none'], 'no envelope while the check runs');
  task = step(task, { type: 'check', result: 'PASS' }).task;
  const publishing = decideFor(task, comment('change/7'), []);
  assert.deepEqual([task.state, publishing.decision.outcome, publishing.decision.envelope], ['publishing', 'allow', 'applied'], 'the envelope acts while the result is published');
  task = step(publishing.task, { type: 'finish' }).task;
  const d = decideFor(task, comment('change/7'), []);
  assert.deepEqual([task.state, d.decision.outcome, d.decision.envelope], ['closed', 'ask', 'none']);
});

test('task: an approval of the human for another work drops the tree of the check; for the same work the tree stays (contracts AD14)', () => {
  const checked: Task = { ...start('review').task, state: 'waiting_human', waiting: 'approval', work: 'a'.repeat(32), tree: 'b'.repeat(40) };
  // The human saw a work that the check did not read: the tree of the check is not the tree of that work.
  const other = step(checked, { type: 'human', decision: 'accept', work: 'c'.repeat(32), at: 1 });
  assert.equal(other.error, undefined);
  assert.deepEqual([other.task.label, other.task.work, other.task.tree], ['approved_by_human', 'c'.repeat(32), undefined]);
  assert.equal('tree' in other.task, false);
  // The same work: the tree of the check is the tree of the approval.
  const same = step(checked, { type: 'human', decision: 'accept', work: 'a'.repeat(32), at: 1 });
  assert.deepEqual([same.task.label, same.task.work, same.task.tree], ['approved_by_human', 'a'.repeat(32), 'b'.repeat(40)]);
});
