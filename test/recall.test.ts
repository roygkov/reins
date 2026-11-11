// The memory in daily work: the records of the place of work at the start of a session, a record
// for all projects, and the mark of the human "this was wrong".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { beforeAction } from '../src/client/before.ts';
import { sessionStart } from '../src/client/session.ts';
import { addRecord, findRecords, listRecords, memoryDir, recordsForInput, restoreRecord, shareRecord, vetoRecord, wrongRecord } from '../src/memory/store.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const NOW = Date.now();

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged: loadPacks(packs), stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4' }, root, cwd, config };
}
const note = (b: Box, text: string, paths: string[] = [], at = NOW - 1000) => {
  const r = addRecord(b.rt, { type: 'pitfall', text, paths, by: 'human' }, at);
  assert.ok(r.ok, JSON.stringify(r));
  return r.record.id;
};
const other = (b: Box): Runtime => ({ ...b.rt, project: 'p9z8y7x6' });

// ---- The start of a session.

test('recall: the start of a session gives the agent the records of the project that are in use', () => {
  const b = box();
  const whole = note(b, 'the cache must be cleared before a build');
  const place = note(b, 'the parser reads dates in local time', ['src/parser.ts']);
  const gone = note(b, 'an old note that the human removed');
  vetoRecord(b.rt, gone);
  const elsewhere = addRecord(other(b), { type: 'pitfall', text: 'a note of another project', paths: [], by: 'human' }, NOW - 1000);
  assert.ok(elsewhere.ok);
  const context = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.join('\n');
  assert.match(context, new RegExp(`${whole} \\(pitfall\\): the cache must be cleared before a build`));
  assert.match(context, new RegExp(`${place} \\(pitfall, src/parser.ts\\): the parser reads dates`));
  assert.doesNotMatch(context, new RegExp(gone));
  assert.doesNotMatch(context, new RegExp(elsewhere.record.id));
  assert.match(context, /cite the id of a record/);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.read');
  assert.deepEqual(rows.map((r) => r.data?.n), [2]);
});

test('recall: the records at the start fit a size limit, the most cited first', () => {
  const b = box();
  for (let i = 0; i < 40; i += 1) note(b, `note ${i} ${'x'.repeat(200)}`, [], NOW - 100_000 + i);
  const context = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.join('\n');
  const shown = context.match(/\bm[0-9a-f]{10} \(pitfall\)/g) ?? [];
  assert.ok(shown.length >= 5 && shown.length < 40, `shown: ${shown.length}`);
  assert.match(context, /more records: `reins memory`/);
});

// ---- A record for all projects.

test('recall: a record that the human shares is found in every project', () => {
  const b = box();
  const own = note(b, 'a note of this project only');
  const shared = note(b, 'never push to the release branch on a Friday');
  assert.equal(shareRecord(b.rt, shared, NOW), true);
  assert.equal(shareRecord(b.rt, shared, NOW), false, 'it is shared already');
  assert.deepEqual(findRecords(other(b), { paths: [] }, NOW).map((r) => r.id), [shared]);
  assert.deepEqual(findRecords(b.rt, { paths: [] }, NOW).map((r) => r.id).sort(), [own, shared].sort());
  assert.match(sessionStart(other(b), { session: 's2', cwd: b.cwd }).context.join('\n'), new RegExp(`${shared} \\(pitfall, common\\)`));
  const file = fs.readFileSync(path.join(memoryDir(b.rt), 'pitfall', `${shared}.md`), 'utf8');
  assert.match(file, /^scope: common$/m);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

// ---- "This was wrong".

test('recall: a record that the human marks as wrong loses its place, and after the second mark it is out of use', () => {
  const b = box();
  const first = note(b, 'the first note', [], NOW - 3000);
  const second = note(b, 'the second note', [], NOW - 2000);
  const order = () => recordsForInput(b.rt, { paths: [], maxBytes: 4000 }, NOW).map((r) => r.id);
  assert.deepEqual(order(), [second, first], 'the newest first');
  assert.equal(wrongRecord(b.rt, second, NOW), true);
  assert.deepEqual(order(), [first, second], 'a record that was wrong once goes after the others');
  assert.equal(wrongRecord(b.rt, second, NOW), true);
  assert.deepEqual(order(), [first]);
  assert.equal(listRecords(b.rt, NOW).find((r) => r.id === second)?.state, 'stale');
  assert.equal(restoreRecord(b.rt, second, NOW), true);
  assert.deepEqual([listRecords(b.rt, NOW).find((r) => r.id === second)?.state, listRecords(b.rt, NOW).find((r) => r.id === second)?.wrong], ['active', undefined], 'the human says that it holds: the marks are gone');
  const decision = addRecord(b.rt, { type: 'decision', text: 'we keep one cache', because: 'two caches went out of step', paths: [], by: 'human' }, NOW);
  assert.ok(decision.ok);
  assert.equal(wrongRecord(b.rt, decision.record.id, NOW), false, 'a decision is replaced by a decision, not marked');
});

test('recall: the command line shares a record and marks one as wrong, and both are words of the human', () => {
  const b = box();
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  const made = run(['memory', 'decide', 'we keep one cache', 'because=two caches went out of step']);
  const id = run(['memory']).records[0].id;
  assert.equal(made.ok, true);
  assert.deepEqual(run(['memory', 'share', id]), { ok: true, record: id, scope: 'common' });
  assert.deepEqual(run(['memory', 'wrong', id]).error, 'unknown_record', 'a decision takes no mark');
  assert.deepEqual(run(['memory', 'wrong', 'm0000000000']).error, 'unknown_record');
  for (const command of [`reins memory share ${id}`, `reins memory wrong ${id}`]) {
    const r = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command } }, { shell: { kind: 'shell', command: 'command' } });
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
});

// ---- Cases of the review.

test('recall: at the start the most cited record is first, and the journal counts the records that the agent got', async () => {
  const { countUses } = await import('../src/memory/store.ts');
  const b = box();
  const ids: string[] = [];
  for (let i = 0; i < 40; i += 1) ids.push(note(b, `note ${i} ${'x'.repeat(200)}`, [], NOW - 100_000 + i));
  countUses(b.rt, `the work used ${ids[3]}`, NOW);
  const lines = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.filter((l) => /^- m[0-9a-f]{10} /.test(l));
  assert.ok(lines[0]?.startsWith(`- ${ids[3]} `));
  const read = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.read').map((r) => r.data?.n);
  assert.deepEqual(read, [lines.length]);
  assert.ok(lines.join('\n').length <= 2000);
});

test('recall: a share does not start the term of a record again', () => {
  const b = box();
  const old = note(b, 'a note that nobody cited for a long time', [], NOW - 200 * 24 * 60 * 60 * 1000);
  assert.equal(listRecords(b.rt, NOW).find((r) => r.id === old)?.state, 'stale');
  shareRecord(b.rt, old, NOW);
  assert.equal(listRecords(b.rt, NOW).find((r) => r.id === old)?.state, 'stale');
});

test('recall: a session in a subdirectory of a repository is in the project of the repository', () => {
  const b = box();
  spawnSync('git', ['init', '-q'], { cwd: b.cwd });
  const sub = path.join(b.cwd, 'deep', 'er');
  fs.mkdirSync(sub, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const run = (cwd: string, args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env }).stdout);
  run(b.cwd, ['memory', 'decide', 'we keep one cache', 'because=two caches went out of step']);
  const [top, deep] = [run(b.cwd, ['memory']).records[0].project, run(sub, ['memory']).records[0].project];
  assert.equal(deep, top, 'the record of the repository is seen from its subdirectory');
  run(sub, ['memory', 'decide', 'we log in UTC', 'because=the servers are in three zones']);
  assert.deepEqual(run(b.cwd, ['memory']).records.map((r: any) => r.project), [top, top]);
});
