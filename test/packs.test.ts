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

// ---- A pack holds no secret and no code outside its scripts.

let boxes = 0;
function three(more: Files = {}, mode?: Record<string, number>): Merged {
  boxes += 1;
  const root = path.join(SB, `guard-${boxes}`);
  write(root, { ...(bases.get('three') ?? {}), ...more });
  for (const [rel, bits] of Object.entries(mode ?? {})) fs.chmodSync(path.join(root, rel), bits);
  return loadPacks({ organization: path.join(root, 'organization'), project: path.join(root, 'project'), person: path.join(root, 'person') });
}
const faults = (m: Merged, level: string): string[] => (m.packs.find((p) => p.level === level)?.errors ?? []).map((e) => `${e.code} ${e.path}`);
// Forms of secrets, put together here so that no scan reads this file as one that holds a secret.
const KEY = ['glpat', 'AbCdEfGhIjKlMnOpQrSt'].join('-');
const BEARER = ['Bearer', 'abcdefghijklmnopqrstuvwxyz012345'].join(' ');
const PEM = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');

test('packs: a pack with a secret does not connect', () => {
  assert.deepEqual(three().packs.map((p) => p.connected), [true, true, true]);
  // In the note, in a script, in the settings: the pack is refused, and the levels below it too.
  const note = three({ 'person/pack.md': `Use the token ${KEY} for the tracker.` });
  assert.deepEqual(faults(note, 'person'), ['secret pack.md']);
  assert.equal(note.packs.find((p) => p.level === 'person')?.connected, false);
  assert.deepEqual(faults(three({ 'project/collect/change.sh': `#!/bin/sh\ncurl -H "Authorization: ${BEARER}" x\n` }), 'project'), ['secret collect/change.sh']);
  assert.deepEqual(faults(three({ 'project/check/keys.sh': `#!/bin/sh\n# ${PEM}\n` }), 'project'), ['secret check/keys.sh']);
  const org = structuredClone(bases.get('three')?.['organization/pack.json']) as Record<string, unknown>;
  assert.deepEqual(faults(three({ 'organization/pack.json': { ...org, name: KEY } }), 'organization').filter((e) => e.startsWith('secret')), ['secret pack.json']);
  // Every file of the pack is read: a test of a script, a data file, a helper beside the scripts.
  for (const rel of ['tests/test_collect.py', 'README.md', 'data/list.json', 'collect/Helper.py']) assert.deepEqual(faults(three({ [`person/${rel}`]: `x = "${KEY}"\n` }), 'person'), [`secret ${rel}`]);
  // A file too large to read is not known to hold no secret.
  assert.deepEqual(faults(three({ 'person/data/big.txt': 'x'.repeat((1 << 20) + 1) }), 'person'), ['too_large data/big.txt']);
  // A script that reads a secret from the environment holds none.
  assert.deepEqual(faults(three({ 'project/collect/change.sh': '#!/bin/sh\ntoken="$TRACKER_TOKEN"\npassword=$(cat "$HOME/.netrc")\n' }), 'project'), []);
});

test('packs: a manifest or its instruction with a secret is refused', () => {
  const m = three({ 'project/manifests/change-review.md': `Call the tracker with ${KEY}.` });
  assert.deepEqual(m.rejected.map((r) => [r.file, r.errors.map((e) => `${e.code} ${e.path}`)]), [['project/manifests/change-review.json', ['secret instructions']]]);
  assert.equal(m.scenarios.some((x) => x.name === 'change-review'), false);
  const review = structuredClone(manifests.get('review')) as Record<string, unknown>;
  const inJson = three({ 'project/manifests/change-review.json': { ...review, description: `token ${KEY}` } });
  assert.deepEqual(inJson.rejected.map((r) => r.errors.map((e) => `${e.code} ${e.path}`)), [['secret $']]);
});

test('packs: code outside the scripts of a pack refuses the pack', () => {
  assert.deepEqual(faults(three({ 'person/helper.py': 'print(1)\n' }), 'person'), ['not_allowed helper.py']);
  assert.deepEqual(faults(three({ 'project/manifests/run.sh': '#!/bin/sh\n' }), 'project'), ['not_allowed manifests/run.sh']);
  assert.deepEqual(faults(three({ 'project/lib/deep/tool.js': 'x\n' }), 'project'), ['not_allowed lib/deep/tool.js']);
  // A file that the system can run, and a file that starts as a script.
  assert.deepEqual(faults(three({ 'person/notes.txt': 'plain\n' }, { 'person/notes.txt': 0o755 }), 'person'), ['not_allowed notes.txt']);
  assert.deepEqual(faults(three({ 'person/notes.txt': '#!/usr/bin/env python3\n' }), 'person'), ['not_allowed notes.txt']);
  // A pack with more files than the harness reads is refused, not passed on the part that was read.
  const many: Files = {};
  for (let i = 0; i < 2001; i += 1) many[`person/aaa/f${i}.txt`] = '';
  assert.deepEqual(faults(three({ ...many, 'person/zzz/run.sh': 'x\n' }), 'person'), ['too_large .']);
  // Data, the scripts themselves, the tests of the scripts and hidden names are not such code.
  const fine = three({ 'person/README.md': 'text\n', 'person/data/list.json': '[]', 'person/tests/test_collect.py': 'x\n', 'person/.cache/x.py': 'x\n', 'person/collect/extra.py': 'x\n' });
  assert.deepEqual(faults(fine, 'person'), []);
});

test('packs: the limit of reads of a task is the lowest one of the levels', () => {
  const org = structuredClone(bases.get('three')?.['organization/pack.json']) as { limits?: Record<string, unknown> };
  const person = structuredClone(bases.get('three')?.['person/pack.json']) as { limits?: Record<string, unknown> };
  const merged = (o: number | undefined, p: number | undefined) => three({
    'organization/pack.json': { ...org, limits: { ...org.limits, ...(o !== undefined ? { reads: o } : {}) } },
    'person/pack.json': { ...person, limits: { ...person.limits, ...(p !== undefined ? { reads: p } : {}) } },
  });
  assert.equal(merged(50, 10).context.maxReads, 10);
  assert.equal(merged(10, 50).context.maxReads, 10);
  assert.equal(merged(50, undefined).context.maxReads, 50);
  assert.equal(merged(undefined, undefined).context.maxReads, undefined);
  assert.deepEqual(merged(50, 10).packs.map((p) => p.errors), [[], [], []]);
});
