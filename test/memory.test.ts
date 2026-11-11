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
    assert.deepEqual(addRecord(b.rt, input as never, T0), { ok: false, error }, JSON.stringify(input).slice(0, 80));
  }
  assert.deepEqual(listRecords(b.rt, T0), []);
});

test('memory: the human writes a record of any type, and it is active at once', () => {
  const b = box();
  const r = addRecord(b.rt, { type: 'decision', text: 'The report is data, not prose.', paths: [], by: 'human' }, T0);
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
  const p = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  return { code: p.status, json: JSON.parse(p.stdout) };
}

test('memory: the command line adds, lists and vetoes records', () => {
  const b = box();
  const task = scenario(b);
  const added = reins(b, ['memory', 'add', 'pitfall', TEXT, `task=${task}`, 'path=src/Limit.java']);
  assert.deepEqual([added.code, added.json.ok, added.json.record.state], [0, true, 'pending']);
  assert.deepEqual(reins(b, ['memory', 'add', 'decision', TEXT, `task=${task}`]).json, { ok: false, error: 'human_only' });
  const decided = reins(b, ['memory', 'decide', 'The report is data.']);
  assert.deepEqual([decided.json.record.type, decided.json.record.state], ['decision', 'active']);
  const listed = reins(b, ['memory']);
  assert.deepEqual(listed.json.records.map((r: any) => [r.type, r.state]), [['pitfall', 'pending'], ['decision', 'active']]);
  assert.deepEqual(reins(b, ['memory', 'veto', added.json.record.id]).json, { ok: true, record: added.json.record.id, state: 'vetoed' });
  assert.deepEqual(reins(b, ['memory', 'veto', added.json.record.id]).json, { ok: false, error: 'unknown_record' });
});
