// The memory of the harness: records that are written without a command of the human, with a
// veto window. A decision is written only on the word of the human.
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
import { openFreeTask, openScenario, type Runtime } from '../src/core/runtime.ts';
import { addRecord, findRecords, listRecords, vetoRecord } from '../src/memory/store.ts';
import { sessionStart } from '../src/client/session.ts';
import { beforeAction } from '../src/client/before.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-11T10:00:00Z');

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(): Box {
  n += 1;
  const root = path.join(SB, String(n));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged: loadPacks(packs), stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
function scenario(b: Box): string {
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  return opened.task.id;
}
const TEXT = 'The limit counts from one: check the upper bound.';

test('memory: a pitfall of a scenario task is written at once and waits for a veto', () => {
  const b = box();
  const task = scenario(b);
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], task, by: 'agent' }, T0);
  assert.ok(r.ok);
  assert.match(r.record.id, /^m[0-9a-f]{10}$/);
  assert.deepEqual([r.record.state, r.record.veto_until], ['pending', new Date(T0 + 7 * DAY).toISOString()]);
  assert.deepEqual(listRecords(b.rt, T0).map((x) => [x.id, x.state]), [[r.record.id, 'pending']]);
  assert.deepEqual(findRecords(b.rt, { paths: ['src/Limit.java'] }, T0), [], 'a record in its veto window is not used yet');
});

test('memory: after the veto window the record is active and is found by the path', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], task: scenario(b), by: 'agent' }, T0);
  assert.ok(r.ok);
  const later = T0 + 7 * DAY + 1;
  assert.equal(listRecords(b.rt, later)[0]?.state, 'active');
  assert.deepEqual(findRecords(b.rt, { paths: ['a/b/src/Limit.java'] }, later).map((x) => x.text), [TEXT], 'a longer path that ends with the path of the record');
  assert.deepEqual(findRecords(b.rt, { paths: ['src/Other.java'] }, later), []);
  const dir = addRecord(b.rt, { type: 'pitfall', text: 'A note about a directory.', paths: ['src/limits'], by: 'human' }, T0);
  assert.ok(dir.ok);
  assert.deepEqual(findRecords(b.rt, { paths: ['src/limits/Limit.java'] }, later).map((x) => x.id), [dir.record.id], 'a record about a directory covers the files under it');
  assert.deepEqual(findRecords(b.rt, { paths: ['other/src/limits2/x.java'] }, later), []);
  assert.deepEqual(findRecords(b.rt, { paths: ['a/b/src/limits/Limit.java'] }, later).map((x) => x.id), [dir.record.id], 'also when the place has a longer path');
  assert.deepEqual(findRecords(b.rt, { paths: ['src/Limit.java'], project: 'pffffffff' }, later), [], 'a record belongs to its project');
});

test('memory: a veto removes the record from use for ever', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], task: scenario(b), by: 'agent' }, T0);
  assert.ok(r.ok);
  assert.equal(vetoRecord(b.rt, r.record.id), true);
  assert.equal(listRecords(b.rt, T0 + 30 * DAY)[0]?.state, 'vetoed');
  assert.deepEqual(findRecords(b.rt, { paths: ['src/Limit.java'] }, T0 + 30 * DAY), []);
  assert.equal(vetoRecord(b.rt, r.record.id), false);
  assert.equal(vetoRecord(b.rt, 'mffffffffff'), false);
});

test('memory: a pitfall that somebody hit again names the record of the first time', () => {
  const b = box();
  const task = scenario(b);
  const first = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: [], task, by: 'agent' }, T0);
  assert.ok(first.ok);
  const again = addRecord(b.rt, { type: 'pitfall', text: `${TEXT} Hit again.`, paths: [], task, by: 'agent', repeats: first.record.id }, T0 + 1000);
  assert.ok(again.ok);
  assert.equal(again.record.repeats, first.record.id);
  // The record keeps the name on the disk, and the row of the journal carries it.
  assert.equal(listRecords(b.rt, T0 + 2000).find((r) => r.id === again.record.id)?.repeats, first.record.id);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.record_changed');
  assert.deepEqual(rows.map((r) => r.data?.repeats), [undefined, first.record.id]);
  // Only a pitfall repeats, and only a pitfall that is in the memory.
  assert.deepEqual(addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: [], task, by: 'agent', repeats: 'mffffffffff' }, T0), { ok: false, error: 'unknown_record' });
  assert.deepEqual(addRecord(b.rt, { type: 'decision', text: TEXT, paths: [], by: 'human', because: 'a reason', repeats: first.record.id }, T0), { ok: false, error: 'bad_type' });
});

test('memory: the agent writes only what the manifest of its task allows', () => {
  const b = box();
  const task = scenario(b);
  const free = openFreeTask(b.rt).id;
  for (const [input, error] of [
    [{ type: 'decision', text: TEXT, paths: [], task, by: 'agent' }, 'human_only'],
    [{ type: 'case', text: TEXT, paths: [], task, by: 'agent' }, 'not_allowed'],
    [{ type: 'pitfall', text: TEXT, paths: [], task: free, by: 'agent' }, 'not_allowed'],
    [{ type: 'pitfall', text: TEXT, paths: [], by: 'agent' }, 'not_allowed'],
    [{ type: 'pitfall', text: TEXT, paths: [], task: 'tffffffffffff', by: 'agent' }, 'not_allowed'],
    [{ type: 'rumour', text: TEXT, paths: [], task, by: 'agent' }, 'bad_type'],
    [{ type: 'pitfall', text: '', paths: [], task, by: 'agent' }, 'bad_text'],
    [{ type: 'pitfall', text: 'x'.repeat(2001), paths: [], task, by: 'agent' }, 'bad_text'],
    [{ type: 'pitfall', text: TEXT, paths: ['../x', ''], task, by: 'agent' }, 'bad_path'],
  ] as const) {
    const refused = addRecord(b.rt, input as never, T0);
    assert.deepEqual([refused.ok, refused.ok ? null : refused.error], [false, error], JSON.stringify(input).slice(0, 80));
  }
  // A text that is not taken says which field, why, and the limit with the length.
  assert.deepEqual(addRecord(b.rt, { type: 'pitfall', text: 'x'.repeat(2001), paths: [], task, by: 'agent' }, T0), { ok: false, error: 'bad_text', field: 'text', cause: 'too_long', max: 2000, length: 2001 });
  assert.deepEqual(addRecord(b.rt, { type: 'pitfall', text: '', paths: [], task, by: 'agent' }, T0), { ok: false, error: 'bad_text', field: 'text', cause: 'empty' });
  assert.deepEqual(listRecords(b.rt, T0), []);
});

test('memory: the human writes a record of any type, and it is active at once', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'decision', text: 'The report is data, not prose.', because: 'One format for every client.', paths: [], by: 'human' }, T0);
  assert.ok(r.ok);
  assert.deepEqual([r.record.state, r.record.veto_until], ['active', undefined]);
});

test('memory: the text of a record is kept in the store, never in the journal', () => {
  const b = box();
  addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], task: scenario(b), by: 'agent' }, T0);
  findRecords(b.rt, { paths: ['src/Limit.java'] }, T0 + 8 * DAY);
  const rows = readJournal(b.rt.journal.file);
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  assert.ok(rows.some((r) => r.kind === 'memory.record_changed') && rows.some((r) => r.kind === 'memory.read'));
  assert.ok(!rows.map((r) => JSON.stringify(r)).join('').includes('upper bound'));
  assert.equal(b.rt.journal.failures, 0);
});

test('memory: the start of a session names the records that wait for a veto', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], task: scenario(b), by: 'agent' });
  assert.ok(r.ok);
  const text = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.join('\n');
  assert.match(text, new RegExp(r.record.id));
  assert.match(text, /reins memory veto/);
});

function reins(b: Box, args: string[]): { code: number | null; json: any } {
  // The command runs in the directory of the box, never in this repository.
  const p = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  return { code: p.status, json: JSON.parse(p.stdout) };
}

test('memory: the command line adds, lists and vetoes records', () => {
  const b = box();
  const task = scenario(b);
  const added = reins(b, ['memory', 'add', 'pitfall', TEXT, `task=${task}`, 'path=src/Limit.java']);
  assert.deepEqual([added.code, added.json.ok, added.json.record.state], [0, true, 'pending']);
  assert.deepEqual(reins(b, ['memory', 'add', 'decision', TEXT, `task=${task}`]).json, { ok: false, error: 'human_only' });
  assert.deepEqual(reins(b, ['memory', 'decide', 'The report is data.']).json, { ok: false, error: 'no_reason' });
  const decided = reins(b, ['memory', 'decide', 'The report is data.', 'because=One format for every client.']);
  assert.deepEqual([decided.json.record.type, decided.json.record.state], ['decision', 'active']);
  const listed = reins(b, ['memory']);
  assert.deepEqual(listed.json.records.map((r: any) => [r.type, r.state]), [['pitfall', 'pending'], ['decision', 'active']]);
  assert.deepEqual(reins(b, ['memory', 'veto', added.json.record.id]).json, { ok: true, record: added.json.record.id, state: 'vetoed' });
  assert.deepEqual(reins(b, ['memory', 'veto', added.json.record.id]).json, { ok: false, error: 'unknown_record' });
});

// ---- The memory by the specification: the place of a record, its use, its age, its history.
import { countUses, importRecords, memoryDir, recordsForInput, restoreRecord, scrub } from '../src/memory/store.ts';

function repo(b: Box): string {
  fs.mkdirSync(path.join(b.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(b.cwd, 'src/Limit.java'), 'int limit = items.length;\n');
  return b.cwd;
}

test('memory: a record is a file that a human can read, in the directory that the runtime names', () => {
  const b = box();
  b.rt.memoryDir = path.join(b.root, 'notes');
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], by: 'human' }, T0);
  assert.ok(r.ok);
  const file = path.join(b.root, 'notes', 'pitfall', `${r.record.id}.md`);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^---\nid: m[0-9a-f]{10}\ntype: pitfall\n/);
  assert.ok(text.endsWith(`---\n${TEXT}\n`));
  assert.deepEqual(listRecords(b.rt, T0).map((x) => x.text), [TEXT], 'the file is read back as it was written');
  // A human edits the file by hand: the store reads the new text.
  fs.writeFileSync(file, text.replace(TEXT, 'Edited by hand.'));
  assert.deepEqual(listRecords(b.rt, T0).map((x) => x.text), ['Edited by hand.']);
});

test('memory: a decision needs its reason, and it can replace an older decision', () => {
  const b = box();
  assert.deepEqual(addRecord(b.rt, { type: 'decision', text: 'Reports are data.', paths: [], by: 'human' }, T0), { ok: false, error: 'no_reason' });
  const first = addRecord(b.rt, { type: 'decision', text: 'Reports are prose.', because: 'It is easy to write.', paths: [], by: 'human' }, T0);
  assert.ok(first.ok);
  const second = addRecord(b.rt, { type: 'decision', text: 'Reports are data.', because: 'A format of one reviewer must not live in the core.', rejected: 'prose with a parser', supersedes: first.record.id, paths: [], by: 'human' }, T0 + 1000);
  assert.ok(second.ok);
  assert.deepEqual(listRecords(b.rt, T0 + 2000).map((x) => [x.id, x.state]), [[first.record.id, 'replaced'], [second.record.id, 'active']]);
  assert.deepEqual(findRecords(b.rt, { paths: [] }, T0 + 2000).map((x) => x.id), [second.record.id]);
  assert.deepEqual(addRecord(b.rt, { type: 'decision', text: 'x', because: 'y', supersedes: 'mffffffffff', paths: [], by: 'human' }, T0), { ok: false, error: 'unknown_record' });
});

test('memory: a record about a place goes stale when the place changes', () => {
  const b = box();
  const root = repo(b);
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], root, by: 'human' }, T0);
  assert.ok(r.ok);
  assert.match(r.record.anchor?.fp ?? '', /^[0-9a-f]{12}$/);
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'active');
  fs.writeFileSync(path.join(root, 'src/Limit.java'), 'int limit = items.length + 1;\n');
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale');
  assert.deepEqual(findRecords(b.rt, { paths: ['src/Limit.java'] }, T0), [], 'a stale record does not reach a task');
  // The human looks at it and says that it still holds: the record gets the new fingerprint.
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  // The row of a restore says that the record came back: it is not a new record.
  assert.equal(readJournal(b.rt.journal.file).filter((x) => x.kind === 'memory.record_changed').at(-1)?.data?.restored, 1);
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'active');
  fs.rmSync(path.join(root, 'src/Limit.java'));
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale', 'a place that is gone makes the record stale');
});

test('memory: every place of a record has a fingerprint, not only the first', () => {
  const b = box();
  const root = repo(b);
  fs.writeFileSync(path.join(root, 'src/Page.java'), 'int page = 0;\n');
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java', 'src/Page.java', 'src/Gone.java'], root, by: 'human' }, T0);
  assert.ok(r.ok);
  assert.deepEqual([r.record.anchor?.path, r.record.anchors?.map((a) => a.path)], ['src/Limit.java', ['src/Page.java']], 'a place that is no file has no fingerprint');
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'active');
  fs.writeFileSync(path.join(root, 'src/Page.java'), 'int page = 1;\n');
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale', 'the second place changed');
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'active');
  // The second place is gone: the record is stale, and a restore unties it from that place only.
  fs.rmSync(path.join(root, 'src/Page.java'));
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale');
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  const now = listRecords(b.rt, T0)[0];
  assert.deepEqual([now?.state, now?.anchor?.path, now?.anchors], ['active', 'src/Limit.java', undefined]);
  // A place that was not there at the start and is there at the restore gets its tie.
  fs.writeFileSync(path.join(root, 'src/Gone.java'), '');
  fs.writeFileSync(path.join(root, 'src/Limit.java'), 'int limit = items.length - 1;\n');
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  assert.deepEqual(listRecords(b.rt, T0)[0]?.anchors?.map((a) => a.path), ['src/Gone.java']);
  fs.rmSync(path.join(root, 'src/Gone.java'));
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  // A list of fingerprints that a human broke is dropped: the record stays.
  const file = path.join(b.rt.stateDir, 'memory', 'pitfall', `${r.record.id}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^anchor: /m, 'anchors: {}\nanchor: '));
  assert.deepEqual([listRecords(b.rt, T0)[0]?.state, listRecords(b.rt, T0)[0]?.anchors], ['active', undefined]);
  // The first place is no file: the record is tied to the first place that is one.
  const late = addRecord(b.rt, { type: 'pitfall', text: 'Pages count from zero.', paths: ['src/Gone.java', 'src/Limit.java'], root, by: 'human' }, T0);
  assert.ok(late.ok);
  assert.deepEqual([late.record.anchor?.path, late.record.anchors], ['src/Limit.java', undefined]);
  // The first place is gone and the second holds: a restore moves the tie to the second.
  fs.writeFileSync(path.join(root, 'src/Page.java'), 'int page = 2;\n');
  const two = addRecord(b.rt, { type: 'pitfall', text: 'Two places.', paths: ['src/Page.java', 'src/Limit.java'], root, by: 'human' }, T0);
  assert.ok(two.ok);
  fs.rmSync(path.join(root, 'src/Page.java'));
  assert.equal(restoreRecord(b.rt, two.record.id, T0), true);
  const moved = listRecords(b.rt, T0).find((x) => x.id === two.record.id);
  assert.deepEqual([moved?.state, moved?.anchor?.path, moved?.anchors], ['active', 'src/Limit.java', undefined]);
});

test('memory: a place that is a directory has the fingerprint of its list of names', () => {
  const b = box();
  const root = repo(b);
  fs.mkdirSync(path.join(root, 'src/api'));
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src'], root, by: 'human' }, T0);
  assert.ok(r.ok);
  assert.match(r.record.anchor?.fp ?? '', /^[0-9a-f]{12}$/);
  // The content of a file of the directory is not the business of the record.
  fs.writeFileSync(path.join(root, 'src/Limit.java'), 'int limit = items.length + 1;\n');
  fs.writeFileSync(path.join(root, 'src/api/Deep.java'), '');
  // A name that starts with a dot is the work of the system or of a tool.
  fs.writeFileSync(path.join(root, 'src/.DS_Store'), '');
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'active');
  fs.writeFileSync(path.join(root, 'src/Page.java'), '');
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale', 'a new name in the directory');
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  // A file that takes the place of a directory of the same name is a change.
  fs.rmSync(path.join(root, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/api'), '');
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale');
});

test('memory: a record that no report cited for its term goes stale, a cited one stays', () => {
  const b = box();
  const used = addRecord(b.rt, { type: 'pitfall', text: 'Used.', paths: [], by: 'human' }, T0);
  const idle = addRecord(b.rt, { type: 'pitfall', text: 'Idle.', paths: [], by: 'human' }, T0 + 1000);
  assert.ok(used.ok && idle.ok);
  const cited = countUses(b.rt, `I followed ${used.record.id} here, and ${used.record.id} again. Not a record: m123.`, T0 + 100 * DAY);
  assert.deepEqual(cited, [used.record.id], 'an id is counted once for one report');
  const later = T0 + 190 * DAY;
  assert.deepEqual(listRecords(b.rt, later).map((x) => [x.text, x.state, x.uses]), [['Used.', 'active', 1], ['Idle.', 'stale', 0]]);
  assert.ok(readJournal(b.rt.journal.file).some((r) => r.kind === 'memory.record_used' && r.data?.record === used.record.id));
});

test('memory: a decision does not go stale by age', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'decision', text: 'Reports are data.', because: 'One format for every client.', paths: [], by: 'human' }, T0);
  assert.ok(r.ok);
  assert.equal(listRecords(b.rt, T0 + 400 * DAY)[0]?.state, 'active');
});

test('memory: a veto can be taken back by the human, with the history of the record kept', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: [], task: scenario(b), by: 'agent' }, T0);
  assert.ok(r.ok);
  vetoRecord(b.rt, r.record.id, T0 + 1000);
  assert.equal(restoreRecord(b.rt, r.record.id, T0 + 2000), true);
  const now = listRecords(b.rt, T0 + 3000)[0];
  assert.equal(now?.state, 'active');
  assert.deepEqual(now?.history.map((h) => h.state), ['pending', 'vetoed', 'active']);
  assert.equal(restoreRecord(b.rt, 'mffffffffff', T0), false);
});

test('memory: secrets are cleaned from a record before it is written', () => {
  // The sample token is put together here: a scanner of secrets must not read a made-up value as a real one.
  assert.equal(scrub(`token ${['glpat', 'AbCdEf0123456789xyzQ'].join('-')} in the config`), 'token [redacted] in the config');
  assert.equal(scrub('AWS key AKIAIOSFODNN7EXAMPLE leaked'), 'AWS key [redacted] leaked');
  assert.equal(scrub('password=hunter2secret and api_key: "abcDEF123456789012"'), 'password=[redacted] and api_key: [redacted]');
  assert.equal(scrub('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'), 'Bearer [redacted]');
  assert.equal(scrub(TEXT), TEXT);
  const b = box();
  const r = addRecord(b.rt, { type: 'pitfall', text: 'The job needs password=hunter2secret to start.', paths: [], by: 'human' }, T0);
  assert.ok(r.ok);
  assert.equal(r.record.text, 'The job needs password=[redacted] to start.');
});

test('memory: the records for a task come with their ids, the record about the place first, inside a size limit', () => {
  const b = box();
  const ids: string[] = [];
  for (const [text, paths] of [['About the limit file.', ['src/Limit.java']], ['About the whole project.', []], ['About another file.', ['src/Other.java']], ['Long. '.repeat(200), []]] as const) {
    const r = addRecord(b.rt, { type: 'pitfall', text, paths: [...paths], by: 'human' }, T0);
    assert.ok(r.ok);
    ids.push(r.record.id);
  }
  countUses(b.rt, `see ${ids[1]}`, T0);
  const got = recordsForInput(b.rt, { paths: ['a/src/Limit.java'], maxBytes: 600 }, T0);
  assert.deepEqual(got.map((x) => x.id), [ids[0], ids[1]], 'the record about the place first, then the used one; the other file and the record over the limit are left out');
  assert.deepEqual(Object.keys(got[0] ?? {}).sort(), ['id', 'text', 'type']);
});

test('memory: records of another store are imported as records of the human', () => {
  const b = box();
  const file = path.join(b.root, 'import.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'decision', text: 'Reports are data.', because: 'One format.', created: '2026-10-01T10:00:00.000Z', source: 'D-2026-10-01-reports-data' }),
    JSON.stringify({ type: 'pitfall', text: 'The limit counts from one.', paths: ['src/Limit.java'] }),
    'not json',
    JSON.stringify({ type: 'decision', text: 'No reason given.' }),
  ].join('\n'));
  const r = importRecords(b.rt, file, T0);
  assert.deepEqual([r.added, r.skipped], [2, [{ line: 3, error: 'bad_json' }, { line: 4, error: 'no_reason' }]]);
  const all = listRecords(b.rt, T0);
  assert.deepEqual(all.map((x) => [x.type, x.state, x.by, x.created, x.source]), [
    ['decision', 'active', 'human', '2026-10-01T10:00:00.000Z', 'D-2026-10-01-reports-data'],
    ['pitfall', 'active', 'human', new Date(T0).toISOString(), undefined],
  ]);
  assert.deepEqual(importRecords(b.rt, file, T0).added, 0, 'a second import of the same file adds nothing');
});

test('memory: the veto window comes from the packs', () => {
  const b = box();
  b.rt.merged.vetoDays = 3;
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: [], task: scenario(b), by: 'agent' }, T0);
  assert.ok(r.ok);
  assert.equal(r.record.veto_until, new Date(T0 + 3 * DAY).toISOString());
});

test('memory: the input of a scenario task carries the records, and a report that cites one counts as its use', () => {
  const b = box();
  // The record is written through the command line: it belongs to the project of that client.
  const r = reins(b, ['memory', 'decide', 'About the whole project.', 'because=It holds for every task.']).json;
  assert.equal(r.ok, true);
  const opened = reins(b, ['open', 'change-review', 'change_id=7']);
  assert.deepEqual(opened.json.input.memory, [{ id: r.record.id, type: 'decision', text: 'About the whole project.' }]);
  assert.ok(opened.json.input.protocol.some((line: string) => line.includes('memory')));
  fs.mkdirSync(path.join(b.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(b.cwd, 'src/a.ts'), 'const limit = items.length;\n');
  const file = path.join(b.root, 'report.json');
  const item = { file: 'src/a.ts', line: 1, quote: 'const limit = items.length;', text: `By ${r.record.id}.` };
  // A report that comes back counts nothing: only the accepted report is a use.
  fs.writeFileSync(file, JSON.stringify({ items: [{ ...item, quote: 'no such quote at all' }] }));
  assert.equal(reins(b, ['report', opened.json.task, file]).json.answer.result, 'FAIL');
  assert.equal(reins(b, ['memory']).json.records[0].uses, 0);
  fs.writeFileSync(file, JSON.stringify({ items: [item] }));
  assert.equal(reins(b, ['report', opened.json.task, file]).json.answer.result, 'PASS');
  assert.equal(reins(b, ['memory']).json.records[0].uses, 1);
});

test('memory: the directory of the records is closed for a direct write of the agent', () => {
  const b = box();
  b.rt.memoryDir = path.join(b.root, 'notes');
  const r = beforeAction(b.rt, { cwd: b.cwd, tool: 'write_file', input: { path: path.join(b.root, 'notes/pitfall/m0123456789.md') } }, { write_file: { kind: 'local', path: 'path' } });
  assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.memory']);
});

test('memory: the agent cannot replace a record, and only a decision replaces a decision', () => {
  const b = box();
  const decision = addRecord(b.rt, { type: 'decision', text: 'Reports are data.', because: 'One format.', paths: [], by: 'human' }, T0);
  assert.ok(decision.ok);
  const task = scenario(b);
  assert.deepEqual(addRecord(b.rt, { type: 'pitfall', text: 'x', paths: [], task, supersedes: decision.record.id, by: 'agent' }, T0), { ok: false, error: 'human_only' });
  assert.deepEqual(addRecord(b.rt, { type: 'pitfall', text: 'x', paths: [], supersedes: decision.record.id, by: 'human' }, T0), { ok: false, error: 'bad_type' });
  const pitfall = addRecord(b.rt, { type: 'pitfall', text: 'A pitfall.', paths: [], by: 'human' }, T0);
  assert.ok(pitfall.ok);
  assert.deepEqual(addRecord(b.rt, { type: 'decision', text: 'y', because: 'z', paths: [], supersedes: pitfall.record.id, by: 'human' }, T0), { ok: false, error: 'unknown_record' });
  assert.deepEqual(listRecords(b.rt, T0).map((x) => x.state), ['active', 'active'], 'nothing was replaced');
});

test('memory: an old record of another store starts its term at the import', () => {
  const b = box();
  const file = path.join(b.root, 'old.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'pitfall', text: 'An old pitfall.', created: '2026-01-01T00:00:00.000Z' }));
  assert.equal(importRecords(b.rt, file, T0).added, 1);
  assert.deepEqual(listRecords(b.rt, T0).map((x) => [x.created, x.state]), [['2026-01-01T00:00:00.000Z', 'active']]);
  assert.equal(listRecords(b.rt, T0 + 181 * DAY)[0]?.state, 'stale');
});

test('memory: only a record that is out of use is restored', () => {
  const b = box();
  const first = addRecord(b.rt, { type: 'decision', text: 'Old.', because: 'a', paths: [], by: 'human' }, T0);
  assert.ok(first.ok);
  const second = addRecord(b.rt, { type: 'decision', text: 'New.', because: 'b', supersedes: first.record.id, paths: [], by: 'human' }, T0);
  const draft = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: [], task: scenario(b), by: 'agent' }, T0);
  assert.ok(second.ok && draft.ok);
  assert.equal(restoreRecord(b.rt, first.record.id, T0), false, 'a replaced decision stays replaced');
  assert.equal(restoreRecord(b.rt, draft.record.id, T0), false, 'a draft keeps its veto window');
  assert.equal(restoreRecord(b.rt, second.record.id, T0), false, 'an active record needs no restore');
});

test('memory: a restored record whose place is gone is no longer tied to the place', () => {
  const b = box();
  const root = repo(b);
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: ['src/Limit.java'], root, by: 'human' }, T0);
  assert.ok(r.ok);
  fs.rmSync(path.join(root, 'src/Limit.java'));
  assert.equal(listRecords(b.rt, T0)[0]?.state, 'stale');
  assert.equal(restoreRecord(b.rt, r.record.id, T0), true);
  const now = listRecords(b.rt, T0)[0];
  assert.deepEqual([now?.state, now?.anchor], ['active', undefined]);
});

test('memory: a replaced decision cannot come back through a veto and a restore', () => {
  const b = box();
  const first = addRecord(b.rt, { type: 'decision', text: 'Old.', because: 'a', paths: [], by: 'human' }, T0);
  assert.ok(first.ok);
  assert.ok(addRecord(b.rt, { type: 'decision', text: 'New.', because: 'b', supersedes: first.record.id, paths: [], by: 'human' }, T0 + 1000).ok);
  assert.equal(vetoRecord(b.rt, first.record.id, T0), false);
  assert.equal(restoreRecord(b.rt, first.record.id, T0), false);
  assert.deepEqual(listRecords(b.rt, T0).map((x) => x.state), ['replaced', 'active']);
});

test('memory: a shell command that writes into the memory directory is refused, and one that restores or imports records asks the human', () => {
  const b = box();
  b.rt.memoryDir = path.join(b.root, 'notes');
  const tools = { shell: { kind: 'shell' as const, command: 'command' } };
  for (const [command, rule] of [
    [`echo x > ${b.root}/notes/pitfall/m0123456789.md`, 'protect.memory'],
    ['reins memory restore m0123456789', 'protect.human-command'],
    ['reins memory import /tmp/records.jsonl', 'protect.human-command'],
  ] as const) {
    const r = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command } }, tools);
    assert.deepEqual([r.outcome, r.rule], [rule === 'protect.memory' ? 'deny' : 'ask', rule], command);
  }
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: 'reins memory add pitfall text task=t000000000000' } }, tools).outcome, 'allow');
});

test('memory: a record file that a human broke is shown, not skipped in silence', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'pitfall', text: TEXT, paths: [], by: 'human' }, T0);
  assert.ok(r.ok);
  const dir = path.join(b.rt.stateDir, 'memory', 'pitfall');
  fs.writeFileSync(path.join(dir, 'm0000000001.md'), '---\nid:m0000000001\n---\ntext\n');
  fs.writeFileSync(path.join(dir, 'm0000000002.md'), fs.readFileSync(path.join(dir, `${r.record.id}.md`), 'utf8').replace(r.record.id, 'm0000000002').replace('state: active', 'state: alive'));
  const out = reins(b, ['memory']).json;
  assert.deepEqual(out.broken, ['pitfall/m0000000001.md', 'pitfall/m0000000002.md']);
});

test('memory: the records for a task are chosen by the place, by the scenario and by the terms of the task', () => {
  const b = box();
  const add = (text: string, paths: string[] = [], scenario?: string): string => {
    const r = addRecord(b.rt, { type: 'pitfall', text, paths, by: 'human' }, T0);
    assert.ok(r.ok);
    // The scenario of the task that wrote a record is kept with the record.
    if (scenario !== undefined) {
      const file = path.join(memoryDir(b.rt), 'pitfall', `${r.record.id}.md`);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /^id: /m);
      fs.writeFileSync(file, text.replace(/^id: (.*)$/m, `id: $1\nscenario: ${scenario}`));
    }
    return r.record.id;
  };
  const place = add('About the limit file.', ['src/Limit.java']);
  const general = add('About the whole project.');
  const ofScenario = add('The release card moves by hand.', ['docs/release.md'], 'solr-release');
  const term = add('The ticket MPD-123583 needs a Production Change.', ['docs/other.md']);
  const far = add('About another file.', ['src/Other.java']);
  const ids = (query: Record<string, unknown>) => recordsForInput(b.rt, { paths: [], maxBytes: 4000, ...query }, T0).map((x) => x.id);
  // As before: the place and the records about the whole project.
  assert.deepEqual(ids({ paths: ['a/src/Limit.java'] }), [place, general]);
  // The scenario of the task brings the records that its earlier tasks wrote, whatever their place.
  assert.deepEqual(ids({ paths: ['a/src/Limit.java'], scenario: 'solr-release' }), [place, ofScenario, general]);
  // A term of the task brings a record that names it. The case of the letters does not matter; a short word is no term.
  assert.deepEqual(ids({ terms: ['mpd-123583'] }), [term, general]);
  assert.deepEqual(ids({ terms: ['the'] }), [general]);
  assert.deepEqual(ids({ paths: ['a/src/Limit.java'], scenario: 'solr-release', terms: ['MPD-123583'] }), [place, ofScenario, term, general]);
  assert.equal(ids({ paths: ['a/src/Limit.java'], scenario: 'solr-release', terms: ['MPD-123583'] }).includes(far), false);
  // A term is a whole word: the name inside a longer word is no match.
  assert.deepEqual(ids({ terms: ['release'] }), [ofScenario, general]);
  assert.deepEqual(ids({ terms: ['releas'] }), [general]);
  // The journal counts what the agent got, after the limit of the size.
  const reads = () => readJournal(b.rt.journal.file).filter((x) => x.kind === 'memory.read').map((x) => x.data?.n);
  const before = reads().length;
  recordsForInput(b.rt, { paths: ['a/src/Limit.java'], scenario: 'solr-release', terms: ['MPD-123583'], maxBytes: 60 }, T0);
  assert.deepEqual(reads().slice(before), [2]);
  // The scenario of a record is the scenario of the task that wrote it.
  const task = scenario(b);
  const own = addRecord(b.rt, { type: 'pitfall', text: 'A note of a review task.', paths: ['docs/review.md'], task, by: 'agent' }, T0 - 30 * DAY);
  assert.ok(own.ok);
  assert.equal(own.record.scenario, 'change-review');
  assert.equal(listRecords(b.rt, T0).find((x) => x.id === own.record.id)?.scenario, 'change-review');
  assert.equal(ids({ scenario: 'change-review' }).includes(own.record.id), true);
  // The limit of the size keeps the closest records.
  assert.deepEqual(recordsForInput(b.rt, { paths: ['a/src/Limit.java'], scenario: 'solr-release', terms: ['MPD-123583'], maxBytes: 60 }, T0).map((x) => x.id), [place, ofScenario]);
});
