// The citation check: every finding of a report names a file and a line and quotes the source.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCitations, parseFindings } from '../src/check/citations.ts';
import { loadCases } from './cases.ts';

type Case = {
  name: string;
  files: Record<string, string[]>;
  report: string[];
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

const ONE = ['review: 1 findings (0 blocking)', '1. [note] [likely] bounds — src/a.ts:1 — wrong — evidence: quote "const limit = items.length;" — fix: x'].join('\n');
const TREE = { 'src/a.ts': ['const limit = items.length;'] };

for (const c of loadCases<Case>('citations-cases')) {
  test(`citations: ${c.name}`, () => {
    const a = checkCitations(c.report.join('\n'), {
      root: source(c.files),
      ...(c.changed !== undefined ? { changed: c.changed } : {}),
      ...(c.max !== undefined ? { maxFindings: c.max } : {}),
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
  const report = ['review: 1 findings (0 blocking)', '1. [note] [likely] leak — src/link.ts:1 — wrong — evidence: quote "const secret = \'outside\';" — fix: x'].join('\n');
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

test('citations: the parser reads the two axes, the place and the quote', () => {
  const [f] = parseFindings('2) [should-fix] [confirmed] error path -- `lib/x.js:12-9` -- no check -- evidence: trace “if (value == null) return” -- fix: add the check');
  assert.deepEqual(f, {
    severity: 'should-fix', level: 'confirmed', category: 'error path', file: 'lib/x.js', from: 9, to: 12,
    quote: 'if (value == null) return', evidence: 'trace', parsed: true, plan: false,
  });
  assert.deepEqual(parseFindings('some text\n- [note] not numbered\n'), []);
});
