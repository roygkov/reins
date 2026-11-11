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
