// Packs are read from the disk and merged. Each case writes its files into a temp directory.
// Cases are data: test/data/packs-cases.json. A file value is a JSON object, the text of a script,
// or "$manifest:<name>" for a manifest from manifest-bases.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks, type Merged } from '../src/packs/packs.ts';
import { loadCases, patch } from './cases.ts';

type Files = Record<string, unknown>;
type Expect = {
  context: Record<string, unknown>;
  origin?: Record<string, string>;
  packs: { level: string; connected: boolean; errors: string[] }[];
  scenarios: string[];
  rejected: { file: string; errors: string[] }[];
};
type Case = { name: string; base?: string; patch?: Files; files?: Files; symlinks?: Record<string, string>; levels?: string[]; expect: Expect };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const bases = new Map(loadCases<{ name: string; files: Files }>('packs-bases').map((b) => [b.name, b.files]));

function write(root: string, files: Files): void {
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body: string;
    if (typeof value === 'string' && value.startsWith('$manifest:')) body = JSON.stringify(manifests.get(value.slice('$manifest:'.length)));
    else if (typeof value === 'string') body = value;
    else body = JSON.stringify(value);
    fs.writeFileSync(file, body);
  }
}

function view(m: Merged): Expect {
  return {
    context: { ...m.context },
    origin: { ...m.origin },
    packs: m.packs.map((p) => ({ level: p.level, connected: p.connected, errors: p.errors.map((e) => `${e.code} ${e.path}`) })),
    scenarios: m.scenarios.map((s) => `${s.name}@${s.level}`),
    rejected: m.rejected.map((r) => ({ file: r.file, errors: r.errors.map((e) => `${e.code} ${e.path}`) })),
  };
}

loadCases<Case>('packs-cases').forEach((c, i) => {
  test(`packs: ${c.name}`, () => {
    const root = path.join(SB, String(i));
    fs.mkdirSync(root, { recursive: true });
    const files = c.base === undefined ? (c.files ?? {}) : (patch(bases.get(c.base), c.patch ?? {}) as Files);
    write(root, files);
    for (const [rel, target] of Object.entries(c.symlinks ?? {})) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.symlinkSync(target, path.join(root, rel));
    }
    const dirs: Record<string, string> = {};
    for (const level of c.levels ?? ['organization', 'project', 'person']) {
      if (c.levels !== undefined || fs.existsSync(path.join(root, level))) dirs[level] = path.join(root, level);
    }
    const got = view(loadPacks(dirs));
    if (c.expect.origin === undefined) delete got.origin;
    assert.deepEqual(got, c.expect);
  });
});

test('packs: the example packs of the repository connect their scenario', () => {
  const root = new URL('../examples/packs/', import.meta.url).pathname;
  const m = loadPacks({ organization: path.join(root, 'organization'), project: path.join(root, 'project'), person: path.join(root, 'person') });
  assert.deepEqual(m.packs.map((p) => [p.level, p.connected, p.errors.length]), [['organization', true, 0], ['project', true, 0], ['person', true, 0]]);
  assert.deepEqual(m.rejected, []);
  assert.deepEqual(m.scenarios.map((s) => `${s.name}@${s.level}`), ['change-review@project']);
});
