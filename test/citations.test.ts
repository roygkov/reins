// The citation check: every finding of a report names a file and a line and quotes the source.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCitations } from '../src/check/citations.ts';
import { loadCases } from './cases.ts';

type Case = {
  name: string;
  files: Record<string, string[]>;
  report?: unknown;
  raw?: string; // a report that is not JSON
  fields?: Record<string, string[]>;
  changed?: string[];
  max?: number;
  result: 'PASS' | 'FAIL' | 'none';
  reason?: string;
  n: number;
  faults: string[];
};

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'citations-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

let n = 0;
function source(files: Record<string, string[]>): string {
  n += 1;
  const root = path.join(SB, String(n), 'tree');
  for (const [rel, lines] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
  }
  // A file beside the source: a path that leaves the source must not reach it.
  fs.writeFileSync(path.join(root, '..', 'outside.ts'), "const secret = 'outside';\n");
  return root;
}

const ONE = JSON.stringify({ items: [{ file: 'src/a.ts', line: 1, quote: 'const limit = items.length;' }] });
const TREE = { 'src/a.ts': ['const limit = items.length;'] };

for (const c of loadCases<Case>('citations-cases')) {
  test(`citations: ${c.name}`, () => {
    const a = checkCitations(c.raw ?? JSON.stringify(c.report), {
      root: source(c.files),
      ...(c.changed !== undefined ? { changed: c.changed } : {}),
      ...(c.max !== undefined ? { maxItems: c.max } : {}),
      ...(c.fields !== undefined ? { fields: c.fields } : {}),
    });
    assert.deepEqual(a.faults.map((f) => `${f.n} ${f.fault}`), c.faults);
    assert.deepEqual([a.result, a.reason, a.n], [c.result, c.reason, c.n]);
  });
}

test('citations: a source that is not a directory gives no answer', () => {
  const root = source(TREE);
  for (const bad of [path.join(root, 'missing'), path.join(root, 'src/a.ts'), '', 'relative/dir']) {
    const a = checkCitations(ONE, { root: bad });
    assert.deepEqual([a.result, a.reason], ['none', 'no_source']);
  }
});

test('citations: a symbolic link out of the source is not read', () => {
  const root = source(TREE);
  fs.symlinkSync(path.join(root, '..', 'outside.ts'), path.join(root, 'src/link.ts'));
  const report = JSON.stringify({ items: [{ file: 'src/link.ts', line: 1, quote: "const secret = 'outside';" }] });
  const a = checkCitations(report, { root });
  assert.deepEqual([a.result, a.faults], ['FAIL', [{ n: 1, fault: 'no_file' }]]);
});

test('citations: a file over the size limit is not read', () => {
  const root = source({ 'src/a.ts': ['const limit = items.length;', 'x'.repeat((1 << 20) + 1)] });
  const a = checkCitations(ONE, { root });
  assert.deepEqual([a.result, a.faults], ['FAIL', [{ n: 1, fault: 'no_file' }]]);
});

test('citations: a passed deadline gives no answer, never a pass', () => {
  const a = checkCitations(ONE, { root: source(TREE), expired: () => true });
  assert.deepEqual([a.result, a.reason], ['none', 'deadline']);
});

test('citations: the core has no words of a report format', () => {
  const code = fs.readFileSync(new URL('../src/check/citations.ts', import.meta.url), 'utf8');
  for (const word of ['blocking', 'should-fix', 'confirmed', 'likely', 'evidence', 'findings', 'severity']) {
    assert.ok(!code.includes(word), `the word "${word}" belongs to a pack`);
  }
});

// ---- A named text as a source, and the values of a field that decide.

const TEXTS = { ticket: 'Status: In Progress\nThe proxy of version 1.27 rejects unknown fields.', log: 'HTTP 400 Bad Request: unknown field initNote' };
const check = (items: unknown[], more: Record<string, unknown> = {}) => {
  const a = checkCitations(JSON.stringify({ items }), { root: source(TREE), texts: TEXTS, ...more });
  return [a.result, ...a.faults.map((f) => `${f.n} ${f.fault}`)];
};

test('citations: a quote of a named text is found in that text', () => {
  assert.deepEqual(check([{ source: 'ticket', quote: 'rejects unknown fields' }, { source: 'log', quote: 'HTTP 400   Bad Request', text: 'x' }]), ['PASS']);
  // A quote that spans lines of the text, and parts around `...`.
  assert.deepEqual(check([{ source: 'ticket', quote: 'In Progress The proxy' }, { source: 'ticket', quote: 'Status: ... unknown fields.' }]), ['PASS']);
  assert.deepEqual(check([{ source: 'ticket', quote: 'ignores unknown fields' }]), ['FAIL', '1 not_found']);
  assert.deepEqual(check([{ source: 'log', quote: 'rejects unknown fields' }]), ['FAIL', '1 not_found'], 'the text that the item names, not any text');
  assert.deepEqual(check([{ source: 'other', quote: 'rejects unknown fields' }, { source: 7, quote: 'rejects unknown fields' }]), ['FAIL', '1 no_text', '2 no_text']);
  assert.deepEqual(check([{ source: 'ticket', quote: 'short' }, { source: 'ticket' }]), ['FAIL', '1 short_quote', '2 no_quote']);
  // One item has one place: a file or a named text.
  assert.deepEqual(check([{ source: 'ticket', file: 'src/a.ts', line: 1, quote: 'rejects unknown fields' }]), ['FAIL', '1 no_location']);
  // A file item works as before beside a text item, and a text item is not bound to the changed files.
  assert.deepEqual(check([{ file: 'src/a.ts', line: 1, quote: 'const limit = items.length;' }, { source: 'ticket', quote: 'rejects unknown fields' }], { changed: ['src/a.ts'] }), ['PASS']);
  // Without named texts the field names nothing.
  const none = checkCitations(JSON.stringify({ items: [{ source: 'ticket', quote: 'rejects unknown fields' }] }), { root: source(TREE) });
  assert.deepEqual(none.faults, [{ n: 1, fault: 'no_text' }]);
});

test('citations: a value of a field can fail an item, and a value can free an item from its quote', () => {
  const fields = { state: ['proven', 'unknown', 'asserted'] };
  const more = { fields, reject: { state: ['asserted'] }, unquoted: { state: ['unknown'] } };
  assert.deepEqual(check([
    { state: 'proven', source: 'ticket', quote: 'rejects unknown fields', text: 'the proxy rejects unknown fields' },
    { state: 'unknown', text: 'the behaviour of the old proxy is not verified' },
  ], more), ['PASS']);
  // The value that the manifest rejects fails the item, with a quote or without one.
  assert.deepEqual(check([{ state: 'asserted', text: 'the old proxy ignores the field' }, { state: 'asserted', source: 'ticket', quote: 'rejects unknown fields', text: 'x' }], more), ['FAIL', '1 rejected', '2 rejected']);
  // An item without a quote says what it is about.
  assert.deepEqual(check([{ state: 'unknown' }, { state: 'unknown', text: '  ' }], more), ['FAIL', '1 no_text', '2 no_text']);
  // An item that says "not verified" carries no quote: a quote beside it would look verified.
  assert.deepEqual(check([{ state: 'unknown', text: 'x', file: 'src/a.ts', line: 1, quote: 'not in the file at all' }, { state: 'unknown', text: 'x', source: 'ticket', quote: 'rejects unknown fields' }], more), ['FAIL', '1 no_location', '2 no_location']);
  // A proven item needs its quote; without the lists every item needs one.
  assert.deepEqual(check([{ state: 'proven', text: 'the proxy rejects unknown fields' }], more), ['FAIL', '1 no_location']);
  assert.deepEqual(check([{ state: 'unknown', text: 'not verified' }], { fields }), ['FAIL', '1 no_location']);
});
