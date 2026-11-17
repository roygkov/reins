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
import { addRecord, census, closeCase, countUses, findRecords, listRecords, memoryDir, recordsForInput, restoreRecord, searchRecords, shareRecord, vetoRecord, wrongRecord } from '../src/memory/store.ts';
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
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir, human_channel: 'any' }));
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
  // The second word changes nothing and says so; a record that is not in memory stays unknown.
  assert.deepEqual(run(['memory', 'share', id]), { ok: true, record: id, scope: 'common', already: true });
  assert.equal(run(['memory', 'share', 'm0000000000']).error, 'unknown_record');
  // A decision takes no mark, and the answer says so: the record is there, so "unknown" would be false.
  const marked = run(['memory', 'wrong', id]);
  assert.deepEqual([marked.ok, marked.error, marked.reason], [false, 'no_mark', 'decision']);
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

test('recall: the command line finds records by words, in every project', () => {
  const b = box();
  spawnSync('git', ['init', '-q'], { cwd: b.cwd });
  const other = path.join(b.root, 'other');
  fs.mkdirSync(other);
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const run = (cwd: string, args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env }).stdout);
  run(b.cwd, ['memory', 'decide', 'Релиз Solr идёт во вторник', 'because=в один день два релиза мешают друг другу']);
  run(b.cwd, ['memory', 'decide', 'we keep one cache', 'because=two caches went out of step', 'path=src/cache.ts']);
  run(other, ['memory', 'decide', 'the cache of the other project lives one hour', 'because=the data changes daily']);
  // Every word must be in the record; the case of the letters does not matter.
  const found = run(b.cwd, ['memory', 'find', 'CACHE']);
  assert.equal(found.ok, true);
  assert.deepEqual(found.records.map((r: any) => r.text).sort(), ['the cache of the other project lives one hour', 'we keep one cache']);
  assert.deepEqual(run(b.cwd, ['memory', 'find', 'cache', 'hour']).records.map((r: any) => r.text), ['the cache of the other project lives one hour']);
  // The reason, the place and words in another script are searched too.
  assert.equal(run(b.cwd, ['memory', 'find', 'out of step']).records.length, 1);
  assert.equal(run(b.cwd, ['memory', 'find', 'src/cache.ts']).records.length, 1);
  assert.equal(run(b.cwd, ['memory', 'find', 'solr', 'вторник']).records.length, 1);
  assert.deepEqual(run(b.cwd, ['memory', 'find', 'nothing-like-this']), { ok: true, records: [], more: 0 });
  // A record that is out of use is not found.
  const id = found.records.find((r: any) => r.text === 'we keep one cache').id;
  run(b.cwd, ['memory', 'veto', id]);
  // The phrase was in that record only. The other record holds the two words apart: it comes as a part, with a mark.
  const after = run(b.cwd, ['memory', 'find', 'one cache']);
  assert.equal(after.records.some((r: any) => r.id === id), false);
  assert.deepEqual([after.records.map((r: any) => [r.text, r.matched]), after.partial], [[['the cache of the other project lives one hour', ['one', 'cache']]], true]);
  assert.deepEqual(run(b.cwd, ['memory', 'find', 'we keep']).records, []);
});

test('recall: a decision that was given many times and never cited is not a dead record', () => {
  const b = box();
  const pitfall = note(b, 'a pitfall about the retry of the queue');
  const made = addRecord(b.rt, { type: 'decision', text: 'the retry of the queue waits one minute', because: 'the broker drops a faster retry', paths: [], by: 'human' }, NOW);
  assert.ok(made.ok, JSON.stringify(made));
  // Both records are given six times and no report cites them.
  for (let i = 0; i < 6; i += 1) searchRecords(b.rt, ['retry', 'queue'], 20, NOW);
  // A decision holds until another decision takes its place: nobody has to cite it. Only the pitfall is dead.
  const count = census(b.rt, NOW);
  assert.deepEqual([count.active, count.cited, count.dead, count.unseen], [2, 0, 1, 0]);
  assert.deepEqual(count.worst, [{ id: pitfall, type: 'pitfall', given: 6 }]);
});

test('recall: a citation in the answer of a free task is counted apart from the reports, and it keeps the record in the work', async () => {
  const { agentStopped, humanRequest } = await import('../src/client/session.ts');
  const b = box();
  const DAY = 24 * 60 * 60 * 1000;
  const old = note(b, 'a record that only the answers of free tasks cite', [], NOW - 190 * DAY);
  const of = () => listRecords(b.rt, NOW).find((r) => r.id === old);
  assert.equal(of()?.state, 'stale', 'nobody cited it for its term');
  for (let i = 0; i < 5; i += 1) searchRecords(b.rt, ['answers', 'free'], 20, NOW);
  humanRequest(b.rt, { session: 's1', cwd: b.cwd });
  agentStopped(b.rt, { session: 's1', cwd: b.cwd, answer: `The answer rests on ${old}.` });
  // The count of the reports stays: no check judged that answer. The record is fresh again.
  assert.deepEqual([of()?.uses, of()?.free_uses, of()?.state], [0, 1, 'active']);
  const count = census(b.rt, NOW);
  assert.deepEqual([count.cited, count.dead], [0, 0], 'not cited by a report, and not dead');
  // A stop without a request before it ends no free task: nothing is counted twice.
  agentStopped(b.rt, { session: 's1', cwd: b.cwd, answer: `The answer rests on ${old}.` });
  assert.equal(of()?.free_uses, 1);
  // A report counts as before, in its own number.
  countUses(b.rt, `the work used ${old}`, NOW);
  assert.deepEqual([of()?.uses, of()?.free_uses], [1, 1]);
});

test('recall: the count of the memory names the records that were given many times and never cited', () => {
  const b = box();
  const dead = note(b, 'a record that the agent gets and never cites');
  const live = note(b, 'a record that a report cites');
  const draft = note(b, 'a record that nobody was given');
  // A record that is given by the search is counted; the third record is never found.
  for (let i = 0; i < 5; i += 1) searchRecords(b.rt, ['report', 'cites'], 20, NOW);
  for (let i = 0; i < 4; i += 1) searchRecords(b.rt, ['never', 'cites'], 20, NOW);
  countUses(b.rt, `the work used ${live}`, NOW);
  // Four gives are not many yet.
  assert.deepEqual(census(b.rt, NOW), { active: 3, cited: 1, dead: 0, unseen: 1, worst: [] });
  searchRecords(b.rt, ['never', 'cites'], 20, NOW);
  assert.deepEqual(census(b.rt, NOW), { active: 3, cited: 1, dead: 1, unseen: 1, worst: [{ id: dead, type: 'pitfall', given: 5 }] });
  assert.ok(draft !== dead);
  // The command writes the count to the journal.
  const said = JSON.parse(spawnSync(process.execPath, [CLI, 'memory', 'census'], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  assert.deepEqual([said.ok, said.active, said.cited, said.dead, said.unseen], [true, 3, 1, 1, 1]);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.counted');
  assert.deepEqual(rows.map((r) => r.data), [{ active: 3, cited: 1, dead: 1, unseen: 1 }]);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

test('recall: a search gives only records in use, a limited count of them, and writes the read down', () => {
  const b = box();
  const draft = note(b, 'a draft about the gateway that waits for a veto');
  // A draft in its veto window: the human has not let it pass yet.
  const file = path.join(memoryDir(b.rt), 'pitfall', `${draft}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('state: active', 'state: pending'));
  assert.equal(listRecords(b.rt, NOW).find((r) => r.id === draft)?.state, 'pending');
  assert.deepEqual(searchRecords(b.rt, ['gateway'], 20, NOW), { records: [], more: 0 });
  assert.equal(readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.read').length, 0, 'a search that found nothing is no read');
  // It is a miss of the memory, with the count of the words of the search.
  assert.deepEqual(readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.search_missed').map((r) => r.data), [{ n: 1 }]);
  // The newest first, the count has a limit, and the rest is counted.
  for (let i = 0; i < 5; i += 1) note(b, `gateway note ${i}`, [], NOW - 10_000 + i);
  const found = searchRecords(b.rt, ['gateway', 'note'], 3, NOW);
  assert.deepEqual([found.records.map((r) => r.text), found.more], [['gateway note 4', 'gateway note 3', 'gateway note 2'], 2]);
  const reads = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.read');
  assert.deepEqual(reads.map((r) => r.data), [{ n: 3, how: 'find' }], 'the journal counts the records that the agent got, and names the way of the read');
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
  // No word is no search.
  assert.deepEqual(searchRecords(b.rt, ['  '], 20, NOW), { records: [], more: 0 });
});

test('recall: a search gives short rows, and one command gives a record whole', () => {
  const b = box();
  spawnSync('git', ['init', '-q'], { cwd: b.cwd });
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env }).stdout);
  const long = `The gateway ${'drops a request when the pool is full; '.repeat(20)}end.`;
  run(['memory', 'decide', long, 'because=the pool has ten places and the peak has thirty', 'rejected=a bigger pool', 'path=src/gateway.ts']);
  const [row] = run(['memory', 'find', 'gateway']).records;
  // A row says what the record is and where the whole of it is: no reason, no history.
  assert.deepEqual(Object.keys(row).sort(), ['id', 'paths', 'project', 'text', 'type']);
  assert.equal(row.text.length, 301);
  assert.match(row.text, /^The gateway drops a request .*…$/);
  assert.deepEqual([row.type, row.paths], ['decision', ['src/gateway.ts']]);
  // The record whole.
  const shown = run(['memory', 'show', row.id]);
  assert.deepEqual([shown.ok, shown.record.text, shown.record.because, shown.record.rejected, shown.record.state], [true, long, 'the pool has ten places and the peak has thirty', 'a bigger pool', 'active']);
  assert.deepEqual(run(['memory', 'show', 'm0000000000']), { ok: false, error: 'unknown_record' });
  // A record that the agent got is counted as given.
  assert.deepEqual(readJournal(path.join(b.root, 'state', 'journal.jsonl')).filter((r) => r.kind === 'memory.read').map((r) => r.data), [{ n: 1, how: 'find' }, { n: 1, how: 'show' }]);
  // A record for every project says so in its row.
  run(['memory', 'share', row.id]);
  assert.equal(run(['memory', 'find', 'gateway']).records[0].scope, 'common');
  // A record that is out of use can still be read, and it is not counted as given.
  const reads = (): number => readJournal(path.join(b.root, 'state', 'journal.jsonl')).filter((r) => r.kind === 'memory.read').length;
  const before = reads();
  run(['memory', 'veto', row.id]);
  assert.deepEqual([run(['memory', 'show', row.id]).record.state, reads()], ['vetoed', before]);
});

test('recall: reports that come at one time lose no count of a use', async () => {
  const b = box();
  const id = note(b, 'the gateway drops a request when the pool is full');
  // Each process is one report that cites the record: the counts are one file for all of them.
  const script = path.join(b.root, 'cite.ts');
  fs.writeFileSync(script, `
import { loadPacks } from ${JSON.stringify(fileURLToPath(new URL('../src/packs/packs.ts', import.meta.url)))};
import { openJournal } from ${JSON.stringify(fileURLToPath(new URL('../src/journal/writer.ts', import.meta.url)))};
import { countUses } from ${JSON.stringify(fileURLToPath(new URL('../src/memory/store.ts', import.meta.url)))};
const [packs, stateDir, id] = process.argv.slice(2);
const dirs = JSON.parse(packs ?? '{}');
const rt = { merged: loadPacks(dirs), stateDir: stateDir ?? '', journal: openJournal(stateDir ?? ''), project: 'p1a2b3c4' };
for (let i = 0; i < (process.argv[5] === 'once' ? 1 : 10); i += 1) countUses(rt, 'see ' + id);
`);
  const packs = JSON.stringify({ organization: path.join(b.root, 'packs/organization'), project: path.join(b.root, 'packs/project'), person: path.join(b.root, 'packs/person') });
  const { spawn } = await import('node:child_process');
  const runs = Array.from({ length: 6 }, () => new Promise<number | null>((resolve) => {
    spawn(process.execPath, [script, packs, b.rt.stateDir, id], { stdio: 'ignore' }).on('exit', (code) => resolve(code));
  }));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0]);
  assert.equal(listRecords(b.rt).find((r) => r.id === id)?.uses, 60);
  // A lock that another process holds and does not release: nothing is counted, and nothing says that it was.
  const lock = path.join(b.rt.stateDir, 'memory-state', 'uses.json.lock');
  fs.writeFileSync(lock, 'another-owner');
  const keep = setInterval(() => fs.utimesSync(lock, new Date(), new Date()), 500);
  const used = (): number => readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.record_used').length;
  const before = used();
  const waited = await new Promise<number | null>((resolve) => {
    spawn(process.execPath, [script, packs, b.rt.stateDir, id, 'once'], { stdio: 'ignore' }).on('exit', (code) => resolve(code));
  });
  clearInterval(keep);
  assert.deepEqual([waited, listRecords(b.rt).find((r) => r.id === id)?.uses, used()], [0, 60, before]);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another-owner', 'the lock of another owner is not removed');
});

test('recall: a search whose words no one record holds together gives the records with a part of the words, and says so', () => {
  const b = box();
  const both = note(b, 'the craft reads the manifest of a proposal', [], NOW - 3000);
  const one = note(b, 'the craft counts the questions of a week', [], NOW - 2000);
  note(b, 'a note about the gateway', [], NOW - 1000);
  const events = (kind: string) => readJournal(b.rt.journal.file).filter((r) => r.kind === kind).map((r) => r.data);
  // Every word in one record: the answer is as before, with no mark.
  assert.deepEqual(Object.keys(searchRecords(b.rt, ['craft', 'manifest'], 20, NOW)).sort(), ['more', 'records']);
  // Two variants of a term in one search: no record holds both, the records with one of them come.
  const found = searchRecords(b.rt, ['manifest', 'health'], 20, NOW);
  assert.deepEqual([found.records.map((r) => r.id), found.more, found.partial], [[both], 0, true]);
  assert.deepEqual(found.matched, { [both]: ['manifest'] });
  // A phrase is cut into its words. The record with more of the words is first.
  const phrase = searchRecords(b.rt, ['manifest craft proposal'], 20, NOW);
  assert.deepEqual([phrase.records.map((r) => r.id), phrase.partial], [[both, one], true]);
  assert.deepEqual(phrase.matched, { [both]: ['manifest', 'craft', 'proposal'], [one]: ['craft'] });
  // The records of a part are a read, not a miss: the agent got them.
  assert.deepEqual(events('memory.read'), [{ n: 1, how: 'find' }, { n: 1, how: 'find' }, { n: 2, how: 'find' }]);
  assert.deepEqual(events('memory.search_missed'), []);
  // The count of a part has its own, smaller limit, and the rest is counted.
  for (let i = 0; i < 7; i += 1) note(b, `queue note ${i}`, [], NOW - 500 + i);
  const many = searchRecords(b.rt, ['queue', 'absent'], 20, NOW);
  assert.deepEqual([many.records.length, many.more, many.partial], [5, 2, true]);
  // One word that no record holds is a miss, as before; so are words that no record holds at all,
  // and a word shorter than three letters finds no part.
  assert.deepEqual(searchRecords(b.rt, ['absent'], 20, NOW), { records: [], more: 0 });
  assert.deepEqual(searchRecords(b.rt, ['absent', 'missing'], 20, NOW), { records: [], more: 0 });
  assert.deepEqual(searchRecords(b.rt, ['absent', 'a'], 20, NOW), { records: [], more: 0 });
  assert.deepEqual(events('memory.search_missed'), [{ n: 1 }, { n: 2 }, { n: 2 }]);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

test('recall: a search that no record in use answers names the replaced decisions and the closed cases with these words', () => {
  const b = box();
  const add = (input: Omit<Parameters<typeof addRecord>[1], 'paths' | 'by'>, at: number): string => {
    const r = addRecord(b.rt, { paths: [], by: 'human', ...input }, at);
    assert.ok(r.ok, JSON.stringify(r));
    return r.record.id;
  };
  const first = add({ type: 'decision', text: 'the gateway keeps one cache', because: 'two caches went out of step' }, NOW - 5000);
  const second = add({ type: 'decision', text: 'the gateway keeps a cache for each tenant', because: 'the tenants must not see the data of each other', supersedes: first }, NOW - 4000);
  const done = add({ type: 'case', text: 'the migration of the queue waits for the board', next: 'ask the board on Monday' }, NOW - 3000);
  assert.deepEqual(closeCase(b.rt, done, { by: 'human' }, NOW - 2000), { ok: true });
  const gone = note(b, 'a wrong note about the migration of the queue', [], NOW - 1000);
  assert.equal(vetoRecord(b.rt, gone, NOW - 500), true);
  const old = (words: string[]) => searchRecords(b.rt, words, 20, NOW).old?.map((o) => [o.record.id, o.record.state, o.by]);
  // The decision that another one replaced holds the phrase: the answer names it and the decision that took its place.
  const found = searchRecords(b.rt, ['one cache'], 20, NOW);
  assert.deepEqual(found.old?.map((o) => [o.record.id, o.record.state, o.by]), [[first, 'replaced', second]]);
  assert.equal(found.records.some((r) => r.id === first), false, 'a replaced record is no record of the answer');
  // A closed case is named too. A record that the human removed is never named.
  assert.deepEqual(old(['migration', 'queue']), [[done, 'closed', undefined]]);
  // A search that a record in use answers names no old record.
  assert.deepEqual(Object.keys(searchRecords(b.rt, ['cache', 'tenant'], 20, NOW)).sort(), ['more', 'records']);
  // No old record holds the words: the answer has no such field.
  assert.deepEqual(searchRecords(b.rt, ['absent'], 20, NOW), { records: [], more: 0 });
  // An old record is no read: the search of the closed case stays a miss of the memory.
  const rows = readJournal(b.rt.journal.file);
  assert.deepEqual(rows.filter((r) => r.kind === 'memory.search_missed').map((r) => r.data), [{ n: 2 }, { n: 1 }]);
  for (const r of rows) assert.deepEqual(validateRow(r), []);
  // The command line gives a short row for each old record.
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const out = JSON.parse(spawnSync(process.execPath, [CLI, 'memory', 'find', 'one cache'], { encoding: 'utf8', cwd: b.cwd, env }).stdout);
  assert.deepEqual(out.old, [{ id: first, type: 'decision', state: 'replaced', text: 'the gateway keeps one cache', by: second }]);
});

test('recall: a search takes a hyphen, an underscore and a space as one divider of words', () => {
  const b = box();
  const shard = note(b, 'the job runs on the master shard only', [], NOW - 5000);
  const flag = note(b, 'the flag FEATURE_TOGGLE_MASTER is off on the test stand', [], NOW - 4000);
  const cache = note(b, 'the measure cache-write counts the first call\nof a session', [], NOW - 3000);
  const reason = addRecord(b.rt, { type: 'decision', text: 'the stand ends with alpha', because: 'beta is the reason', paths: [], by: 'human' }, NOW - 2000);
  assert.ok(reason.ok);
  const ids = (words: string[]) => searchRecords(b.rt, words, 20, NOW).records.map((r) => r.id);
  // The record has a space, the search has a hyphen or an underscore.
  assert.deepEqual([ids(['master-shard']), ids(['master_shard']), ids(['MASTER SHARD'])], [[shard], [shard], [shard]]);
  // The record has an underscore or a hyphen, the search has another divider.
  assert.deepEqual([ids(['feature toggle master']), ids(['feature-toggle']), ids(['cache_write']), ids(['cache write'])], [[flag], [flag], [cache], [cache]]);
  // A break of a line in the text is a divider too; the same word as it is written is found as before.
  assert.deepEqual([ids(['call of a session']), ids(['cache-write']), ids(['FEATURE_TOGGLE_MASTER'])], [[cache], [cache], [flag]]);
  // The dividers at the ends of a word say nothing: `--master` is `master`.
  assert.deepEqual(ids(['--master', 'shard']), [shard]);
  // The text and the reason are two fields: a phrase does not go from the end of one to the start of the other.
  assert.equal(searchRecords(b.rt, ['alpha beta'], 20, NOW).partial, true);
  // A name with an underscore is one word: no record holds it whole, and it is not cut into parts.
  assert.deepEqual(searchRecords(b.rt, ['master_absent'], 20, NOW), { records: [], more: 0 });
  // A word of dividers only is no word: no search, no row of the journal.
  const rows = () => readJournal(b.rt.journal.file).length;
  const before = rows();
  assert.deepEqual(searchRecords(b.rt, ['--', '_'], 20, NOW), { records: [], more: 0 });
  assert.equal(rows(), before);
});
