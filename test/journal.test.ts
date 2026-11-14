import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRow, EVENT_KINDS, SOURCES, sourceOf } from '../src/contracts/journal.ts';
import { loadCases, patch } from './cases.ts';

type Case = { name: string; patch?: unknown; row?: unknown; errors: string[] };

const base = { ts: '2026-11-11T08:00:00.000Z', v: 1, kind: 'task.opened', project: 'p1a2b3c4', task: 't0001' };

for (const c of loadCases<Case>('journal-cases')) {
  test(`journal: ${c.name}`, () => {
    const row = c.row === undefined ? patch(base, c.patch ?? {}) : c.row;
    const found = validateRow(row).map((e) => `${e.code} ${e.path}`).sort();
    assert.deepEqual(found, [...c.errors].sort());
  });
}

test('journal: the list of kinds is closed and matches the specification', () => {
  assert.equal(EVENT_KINDS.length, 49);
  assert.equal(new Set(EVENT_KINDS).size, 49);
  const perSource = Object.fromEntries(SOURCES.map((s) => [s, EVENT_KINDS.filter((k) => sourceOf(k) === s).length]));
  assert.deepEqual(perSource, { task: 13, policy: 7, check: 5, executor: 7, memory: 3, craft: 4, harness: 10 });
});
