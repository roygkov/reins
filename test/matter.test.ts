// The record "case": what is not finished. It has a next step, an outer status and a count of
// the days it was carried without a step. Specification: docs/spec/harness-memory, page 2.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { openScenario, type Runtime } from '../src/core/runtime.ts';
import { sessionStart } from '../src/client/session.ts';
import { beforeAction } from '../src/client/before.ts';
import { addRecord, casesForStart, closeCase, importRecords, listRecords, recordsForStart, restoreRecord, searchRecords, stateForStart, stepCase, vetoRecord } from '../src/memory/store.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'matter-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: Record<string, unknown> }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-12T10:00:00Z');

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
// `memory`: what the manifest of the scenario "change-review" lets the agent write.
function box(memory: unknown = { write: ['case'], class: 'auto' }): Box {
  n += 1;
  const root = path.join(SB, String(n));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (value === '$manifest:review') fs.writeFileSync(file, JSON.stringify({ ...manifests.get('review'), memory }));
    // The organization of the test knows the state among the types of its memory.
    else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), memory: { types: ['pitfall', 'case', 'state'] } }));
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged: loadPacks(packs), stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
function scenario(b: Box, name = 'change-review'): string {
  const opened = openScenario(b.rt, name, name === 'change-review' ? { change_id: '7' } : {});
  assert.ok(opened.ok, JSON.stringify(opened));
  return opened.task.id;
}
const open = (b: Box, text: string, next: string, at = T0, more: Record<string, string> = {}): string => {
  const r = addRecord(b.rt, { type: 'case', text, paths: [], by: 'human', next, ...more }, at);
  assert.ok(r.ok, JSON.stringify(r));
  return r.record.id;
};
const of = (b: Box, id: string, now = T0) => listRecords(b.rt, now).find((r) => r.id === id);

test('case: a case keeps its next step and its outer status, and a human can read its file', () => {
  const b = box();
  const task = scenario(b);
  const r = addRecord(b.rt, { type: 'case', text: 'The release of the indexer waits for the board.', paths: [], by: 'agent', task, next: 'ask the release manager on Monday', status: 'card: Planned' }, T0);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.record.state, r.record.next, r.record.status, r.record.carried], ['active', 'ask the release manager on Monday', 'card: Planned', undefined]);
  const file = fs.readFileSync(path.join(b.rt.stateDir, 'memory', 'case', `${r.record.id}.md`), 'utf8');
  assert.match(file, /^next: "ask the release manager on Monday"$/m);
  assert.match(file, /^status: "card: Planned"$/m);
  // A next step is a thing of a case only.
  assert.deepEqual(addRecord(b.rt, { type: 'pitfall', text: 'x is slow', paths: [], by: 'human', next: 'y' }, T0), { ok: false, error: 'bad_type' });
  assert.deepEqual(addRecord(b.rt, { type: 'case', text: 'a case', paths: [], by: 'human', next: 'n'.repeat(501) }, T0), { ok: false, error: 'bad_text', field: 'next', cause: 'too_long', max: 500, length: 501 });
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('case: a step with an outer status that the packs name as an end closes the case', () => {
  const b = box();
  b.rt.merged.caseEnd = ['done', 'Released'];
  const id = open(b, 'The release card waits for the window.', 'look at the card on Monday');
  // A status that is no end: the case stays open.
  const kept = stepCase(b.rt, id, { next: 'the window is on Friday', status: 'card: Planned', by: 'human' }, T0 + DAY);
  assert.ok(kept.ok);
  assert.equal(kept.record.state, 'active');
  // The words of the list in the middle of a status are no end: the whole status, or its part after the last colon.
  assert.equal((stepCase(b.rt, id, { next: 'x', status: 'not done yet', by: 'human' }, T0 + DAY) as { record: { state: string } }).record.state, 'active');
  const ended = stepCase(b.rt, id, { next: 'nothing: the card is released', status: 'card: RELEASED', by: 'human' }, T0 + 2 * DAY);
  assert.ok(ended.ok);
  assert.deepEqual([ended.record.state, ended.record.status, ended.record.next], ['closed', 'card: RELEASED', 'nothing: the card is released']);
  assert.deepEqual(listRecords(b.rt, T0 + 2 * DAY).find((r) => r.id === id)?.history.at(-1), { at: new Date(T0 + 2 * DAY).toISOString(), state: 'closed' });
  assert.deepEqual(casesForStart(b.rt, 4000, T0 + 3 * DAY).lines, []);
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.record_changed' && r.data?.record === id);
  assert.deepEqual(rows.at(-1)?.data, { record: id, type: 'case', state: 'closed', status: 1 });
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  assert.deepEqual(stepCase(b.rt, id, { next: 'x', by: 'human' }, T0 + 3 * DAY), { ok: false, error: 'unknown_record' }, 'a closed case takes no step');
  // The whole status as one word, and the command shows the end.
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd }).stdout);
  const packFile = path.join(b.root, 'packs/person/pack.json');
  fs.writeFileSync(packFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(packFile, 'utf8')), memory: { case_end: ['Done', 'In Prod'] } }));
  // The command line of the test runs in the project of the directory: the case is opened there.
  const lines = path.join(b.root, 'two.jsonl');
  fs.writeFileSync(lines, `${JSON.stringify({ type: 'case', text: 'The MR waits for a review.', next: 'ping the reviewer' })}\n`);
  assert.equal(reins('memory', 'import', lines).added, 1);
  const second = reins('memory').records.find((r: any) => r.text === 'The MR waits for a review.').id;
  const out = reins('memory', 'step', second, 'merged and released', 'status=in prod');
  assert.deepEqual(out, { ok: true, record: second, next: 'merged and released', status: 'in prod', state: 'closed' });
  // The packs: the lists add up; a word is one plain line.
  assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', memory: { case_end: ['Done', '', 7, 'a\nb', 'Done'] } }, 'person').errors.map((e) => `${e.code} ${e.path}`), ['bad_name memory.case_end[1]', 'bad_name memory.case_end[2]', 'bad_name memory.case_end[3]', 'duplicate memory.case_end[4]']);
});

test('case: the agent changes a case only in a task whose manifest lets it write cases', () => {
  const b = box();
  const id = open(b, 'The alert rule looks at the old cluster.', 'ask the team to change the rule');
  const task = scenario(b);
  const stepped = stepCase(b.rt, id, { next: 'the team answered: check the rule on Friday', status: 'thread: answered', by: 'agent', task }, T0 + DAY);
  assert.ok(stepped.ok, JSON.stringify(stepped));
  assert.deepEqual([of(b, id)?.next, of(b, id)?.status, of(b, id)?.text], ['the team answered: check the rule on Friday', 'thread: answered', 'The alert rule looks at the old cluster.']);
  // Without a task, with a task that is closed, with a task that cannot write cases: no change.
  assert.deepEqual(stepCase(b.rt, id, { next: 'x', by: 'agent' }, T0), { ok: false, error: 'not_allowed' });
  assert.deepEqual(stepCase(b.rt, id, { next: 'x', by: 'agent', task: scenario(b, 'draft-message') }, T0), { ok: false, error: 'not_allowed' });
  const other = box({ write: ['pitfall'], class: 'veto' });
  const there = open(other, 'a case', 'a step');
  assert.deepEqual(stepCase(other.rt, there, { next: 'x', by: 'agent', task: scenario(other) }, T0), { ok: false, error: 'not_allowed' });
  assert.deepEqual(closeCase(other.rt, there, { by: 'agent', task: scenario(other) }, T0), { ok: false, error: 'not_allowed' });
  // The human needs no task.
  assert.ok(stepCase(b.rt, id, { next: 'done on Friday', by: 'human' }, T0).ok);
  // Only a case has a step, and only a case in use.
  const note = addRecord(b.rt, { type: 'pitfall', text: 'x is slow', paths: [], by: 'human' }, T0);
  assert.ok(note.ok);
  assert.deepEqual(stepCase(b.rt, note.record.id, { next: 'x', by: 'human' }, T0), { ok: false, error: 'bad_type' });
  assert.deepEqual(stepCase(b.rt, 'm0000000000', { next: 'x', by: 'human' }, T0), { ok: false, error: 'unknown_record' });
  assert.deepEqual(stepCase(b.rt, id, { next: '  ', by: 'human' }, T0), { ok: false, error: 'bad_text', field: 'next', cause: 'empty' });
});

test('case: a closed case is out of use, and its file stays', () => {
  const b = box();
  const id = open(b, 'The MR waits for a review.', 'ping the reviewer');
  const closed = closeCase(b.rt, id, { by: 'agent', task: scenario(b) }, T0 + DAY);
  assert.deepEqual(closed, { ok: true });
  assert.equal(of(b, id)?.state, 'closed');
  assert.deepEqual(casesForStart(b.rt, 2000, T0 + DAY).lines, []);
  assert.deepEqual(searchRecords(b.rt, ['review'], 20, T0 + DAY).records, []);
  // A case that is closed takes no step and is not closed twice.
  assert.deepEqual(stepCase(b.rt, id, { next: 'x', by: 'human' }, T0 + DAY), { ok: false, error: 'unknown_record' });
  assert.deepEqual(closeCase(b.rt, id, { by: 'human' }, T0 + DAY), { ok: false, error: 'unknown_record' });
  assert.equal(fs.existsSync(path.join(b.rt.stateDir, 'memory', 'case', `${id}.md`)), true);
  // A closed case does not come back through a veto and a restore.
  assert.equal(vetoRecord(b.rt, id, T0 + DAY), false);
  assert.equal(restoreRecord(b.rt, id, T0 + DAY), false);
  assert.equal(of(b, id, T0 + DAY)?.state, 'closed');
  const rows = readJournal(b.rt.journal.file).filter((r) => r.kind === 'memory.record_changed');
  assert.deepEqual(rows.at(-1)?.data, { record: id, type: 'case', state: 'closed' });
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('case: the start of a session names the open cases with their next steps, and counts the days they were carried', () => {
  const b = box();
  const old = open(b, 'The alert rule looks at the old cluster.', 'ask the team', T0 - 3 * DAY);
  const fresh = open(b, 'The release waits for the board.', 'ask on Monday', T0);
  const first = casesForStart(b.rt, 2000, T0);
  assert.equal(first.lines.length, 2);
  assert.match(first.lines.join('\n'), new RegExp(`${old}.*alert rule.*next: ask the team`));
  // A case that was shown is carried: once for a day, however many sessions start.
  casesForStart(b.rt, 2000, T0 + 1000);
  assert.deepEqual([of(b, old)?.carried, of(b, fresh)?.carried], [1, 1]);
  casesForStart(b.rt, 2000, T0 + DAY);
  casesForStart(b.rt, 2000, T0 + 2 * DAY);
  assert.equal(of(b, old)?.carried, 3);
  // The case that was carried most is the first, and the line says so.
  assert.ok(stepCase(b.rt, fresh, { next: 'the board answered', by: 'human' }, T0 + 2 * DAY).ok);
  assert.equal(of(b, fresh)?.carried, 0, 'a step starts the count again');
  const later = casesForStart(b.rt, 2000, T0 + 3 * DAY);
  assert.match(later.lines[0] ?? '', new RegExp(`^- ${old} .*carried 4`));
  assert.match(later.lines[1] ?? '', new RegExp(`^- ${fresh} `));
  // The size has a limit, and the rest is counted.
  const small = casesForStart(b.rt, 150, T0 + 3 * DAY);
  assert.deepEqual([small.lines.length, small.more], [1, 1]);
  // A case that did not fit was not shown: this start does not carry it.
  const tight = casesForStart(b.rt, 150, T0 + 4 * DAY);
  assert.deepEqual([tight.lines.length, of(b, old)?.carried, of(b, fresh)?.carried], [1, 5, 1]);
  // The cases have their own place in the start of a session: they are not among the other records.
  assert.deepEqual(recordsForStart(b.rt, 2000, T0 + 3 * DAY).lines, []);
  const text = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.join('\n');
  assert.match(text, /Open cases of this project/);
  assert.match(text, new RegExp(old));
});

test('case: the command line opens a case, gives it a step and closes it', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (args: string[]) => {
    const p = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd });
    return { code: p.status, json: JSON.parse(p.stdout) };
  };
  const task = scenario(b);
  const added = reins(['memory', 'add', 'case', 'The MR waits for a review.', `task=${task}`, 'next=ping the reviewer', 'status=MR open']);
  assert.deepEqual([added.code, added.json.record.state, added.json.record.next, added.json.record.status], [0, 'active', 'ping the reviewer', 'MR open']);
  const id = added.json.record.id;
  const stepped = reins(['memory', 'next', id, 'the reviewer answered: fix the test', `task=${task}`, 'status=MR has comments']);
  assert.deepEqual([stepped.code, stepped.json], [0, { ok: true, record: id, next: 'the reviewer answered: fix the test', status: 'MR has comments' }]);
  // The agent names its task: without one the command changes nothing.
  assert.deepEqual(reins(['memory', 'next', id, 'x']).json, { ok: false, error: 'not_allowed' });
  assert.deepEqual(reins(['memory', 'close', id]).json, { ok: false, error: 'not_allowed' });
  assert.deepEqual(reins(['memory', 'close', id, `task=${task}`]).json, { ok: true, record: id, state: 'closed' });
  assert.deepEqual(reins(['memory', 'close', id, `task=${task}`]).json, { ok: false, error: 'unknown_record' });
});

test('case: an import brings the next step and the status of a case', () => {
  const b = box();
  const file = path.join(b.root, 'cases.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'case', text: 'The release waits.', next: 'ask on Monday', status: 'card: Planned', source: 'T-2026-11-04-release', created: '2026-11-04' })}\n`);
  assert.deepEqual(importRecords(b.rt, file, T0), { added: 1, skipped: [] });
  const [r] = listRecords(b.rt, T0);
  assert.deepEqual([r?.type, r?.state, r?.next, r?.status, r?.source], ['case', 'active', 'ask on Monday', 'card: Planned', 'T-2026-11-04-release']);
});

test('case: a case of another project is not a case of this one', () => {
  const b = box();
  const id = open(b, 'The MR waits for a review.', 'ping the reviewer');
  const there: Runtime = { ...b.rt, project: 'p9z8y7x6' };
  // The answer says why: the case is there, in another project. The command runs from the directory of that project.
  assert.deepEqual(stepCase(there, id, { next: 'x', by: 'human' }, T0), { ok: false, error: 'other_project' });
  assert.deepEqual(closeCase(there, id, { by: 'human' }, T0), { ok: false, error: 'other_project' });
  assert.equal(of(b, id)?.next, 'ping the reviewer');
});

test('case: the agent goes on with a case that it opened, while the case waits for a veto', () => {
  const b = box({ write: ['case'], class: 'veto' });
  const task = scenario(b);
  const r = addRecord(b.rt, { type: 'case', text: 'The index is rebuilt by hand.', paths: [], by: 'agent', task, next: 'ask why' }, T0);
  assert.ok(r.ok);
  assert.equal(r.record.state, 'pending');
  assert.ok(stepCase(b.rt, r.record.id, { next: 'the owner answered', by: 'agent', task }, T0 + DAY).ok);
  assert.deepEqual([of(b, r.record.id, T0 + DAY)?.state, of(b, r.record.id, T0 + DAY)?.next], ['pending', 'the owner answered']);
  // A draft is not shown at a start: the human has not let it pass yet.
  assert.deepEqual(casesForStart(b.rt, 2000, T0 + DAY).lines, []);
});

// ---- The record "state": where the work of a project is now. One for a project, written anew each time.

test('state: a new state of a project takes the place of the one before it', () => {
  const b = box({ write: ['state'], class: 'auto' });
  const task = scenario(b);
  const first = addRecord(b.rt, { type: 'state', text: 'The release is requested; the card is in Pre-check.', paths: [], by: 'agent', task, next: '1. check the approval\n2. post to the channel', unverified: 'the image on UAT was not opened by hand' }, T0);
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual([first.record.state, first.record.next, first.record.unverified], ['active', '1. check the approval\n2. post to the channel', 'the image on UAT was not opened by hand']);
  const second = addRecord(b.rt, { type: 'state', text: 'The release is on production.', paths: [], by: 'agent', task, next: 'move the card to Accepted' }, T0 + DAY);
  assert.ok(second.ok);
  assert.deepEqual(listRecords(b.rt, T0 + DAY).map((r) => [r.id, r.state]).sort(), [[first.record.id, 'replaced'], [second.record.id, 'active']].sort());
  // The state of another project stays.
  const there: Runtime = { ...b.rt, project: 'p9z8y7x6' };
  const other = addRecord(there, { type: 'state', text: 'Another project is quiet.', paths: [], by: 'human' }, T0 + DAY);
  assert.ok(other.ok);
  assert.equal(of(b, second.record.id, T0 + DAY)?.state, 'active');
  // The file of a state is a text that a human reads.
  const file = fs.readFileSync(path.join(b.rt.stateDir, 'memory', 'state', `${second.record.id}.md`), 'utf8');
  assert.match(file, /^next: "move the card to Accepted"$/m);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
});

test('state: what is not verified is a thing of a state, and an outer status is a thing of a case', () => {
  const b = box();
  assert.deepEqual(addRecord(b.rt, { type: 'case', text: 'a case', paths: [], by: 'human', unverified: 'x' }, T0), { ok: false, error: 'bad_type' });
  assert.deepEqual(addRecord(b.rt, { type: 'state', text: 'a state', paths: [], by: 'human', status: 'x' }, T0), { ok: false, error: 'bad_type' });
  assert.deepEqual(addRecord(b.rt, { type: 'state', text: 'a state', paths: [], by: 'human', next: 'n'.repeat(1001) }, T0), { ok: false, error: 'bad_text', field: 'next', cause: 'too_long', max: 1000, length: 1001 });
  // The next steps of a state are a short list: lines are kept. The next step of a case is one line.
  assert.ok(addRecord(b.rt, { type: 'state', text: 'a state', paths: [], by: 'human', next: 'one\ntwo' }, T0).ok);
  assert.deepEqual(addRecord(b.rt, { type: 'case', text: 'a case', paths: [], by: 'human', next: 'one\ntwo' }, T0), { ok: false, error: 'bad_text', field: 'next', cause: 'line_break' });
});

test('state: the start of a session gives the state of the project, whole', () => {
  const b = box();
  assert.deepEqual(stateForStart(b.rt, 3000, T0), []);
  const old = addRecord(b.rt, { type: 'state', text: 'An old state.', paths: [], by: 'human' }, T0 - DAY);
  const now = addRecord(b.rt, { type: 'state', text: 'The harness runs the daily work.', paths: [], by: 'human', next: '1. the first real firecheck', unverified: 'the answer "no" in a window' }, T0);
  assert.ok(old.ok && now.ok);
  const lines = stateForStart(b.rt, 3000, T0 + DAY);
  assert.match(lines[0] ?? '', new RegExp(`^State of this project \\(${now.record.id}, written 2026-11-12\\):$`));
  assert.deepEqual(lines.slice(1), ['The harness runs the daily work.', 'Next:', '1. the first real firecheck', 'Not verified:', 'the answer "no" in a window']);
  // The state is not among the other records, and a state that is too long is cut with a mark.
  assert.deepEqual(recordsForStart(b.rt, 2000, T0 + DAY).lines, []);
  const long = addRecord(b.rt, { type: 'state', text: 'я'.repeat(900), paths: [], by: 'human', next: 'a step' }, T0 + DAY);
  assert.ok(long.ok);
  const cut = stateForStart(b.rt, 300, T0 + 2 * DAY).join('\n');
  assert.equal(Buffer.byteLength(cut) <= 300, true, String(Buffer.byteLength(cut)));
  assert.match(cut, new RegExp(`я{50,}\\n… cut: \`reins memory show ${long.record.id}\` gives the rest\\.$`));
  assert.ok(addRecord(b.rt, { type: 'state', text: 'The harness runs the daily work.', paths: [], by: 'human', next: '1. the first real firecheck' }, T0 + 2 * DAY).ok);
  const text = sessionStart(b.rt, { session: 's1', cwd: b.cwd }).context.join('\n');
  assert.match(text, /State of this project/);
  assert.match(text, /the first real firecheck/);
});

test('state: the command line writes a state with its next steps and with what is not verified', () => {
  const b = box({ write: ['state'], class: 'auto' });
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd }).stdout);
  const task = scenario(b);
  const added = reins(['memory', 'add', 'state', 'The release is requested.', `task=${task}`, 'next=check the approval', 'unverified=the image on UAT']);
  assert.deepEqual([added.ok, added.record.type, added.record.state, added.record.next, added.record.unverified], [true, 'state', 'active', 'check the approval', 'the image on UAT']);
  assert.deepEqual(reins(['memory', 'add', 'state', 'x']), { ok: false, error: 'not_allowed' });
});

test('state: a state of the agent is in use at once, also where other records wait for a veto', () => {
  const b = box({ write: ['state', 'pitfall'], class: 'veto' });
  const task = scenario(b);
  const before = addRecord(b.rt, { type: 'state', text: 'The first wrap-up.', paths: [], by: 'agent', task }, T0);
  const note = addRecord(b.rt, { type: 'pitfall', text: 'x is slow', paths: [], by: 'agent', task }, T0);
  const now = addRecord(b.rt, { type: 'state', text: 'The second wrap-up.', paths: [], by: 'agent', task }, T0 + DAY);
  assert.ok(before.ok && note.ok && now.ok);
  assert.deepEqual([of(b, before.record.id, T0 + DAY)?.state, of(b, note.record.id, T0 + DAY)?.state, of(b, now.record.id, T0 + DAY)?.state], ['replaced', 'pending', 'active']);
  assert.deepEqual(stateForStart(b.rt, 3000, T0 + DAY).slice(1), ['The second wrap-up.']);
});

test('case: the human gives a step to a case and ends it with words of his own', () => {
  const b = box();
  const id = open(b, 'The MR waits for a review.', 'ping the reviewer');
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (args: string[]) => {
    const p = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd });
    return { code: p.status, json: JSON.parse(p.stdout) };
  };
  // The command line of the test runs in the project of the directory: the case is opened there.
  const made = reins(['memory', 'import', (() => {
    const file = path.join(b.root, 'one.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'case', text: 'The card waits for an approval.', next: 'ask the owner of the service' })}\n`);
    return file;
  })()]);
  assert.equal(made.json.added, 1);
  const mine = reins(['memory']).json.records.find((r: any) => r.text === 'The card waits for an approval.').id;
  // No task: these are the words of the human.
  const stepped = reins(['memory', 'step', mine, 'the owner approved: wait for the window', 'status=card: Approved']);
  assert.deepEqual([stepped.code, stepped.json], [0, { ok: true, record: mine, next: 'the owner approved: wait for the window', status: 'card: Approved' }]);
  // A step without quotes is a mistake of the command, for the human and for the agent.
  assert.equal(reins(['memory', 'step', mine, 'ping', 'the', 'reviewer']).json.error, 'usage');
  assert.equal(reins(['memory', 'next', mine, 'ping', 'the', 'reviewer', 'task=t0123456789ab']).json.error, 'usage');
  assert.deepEqual(reins(['memory', 'end', mine]).json, { ok: true, record: mine, state: 'closed' });
  assert.deepEqual(reins(['memory', 'end', mine]).json, { ok: false, error: 'unknown_record' });
  assert.deepEqual(reins(['memory', 'step', id, 'x']).json, { ok: false, error: 'other_project' }, 'a case of another project');
  // The agent can type these commands, so a client with the hook asks the human first.
  for (const command of [`reins memory step ${mine} 'a step'`, `reins memory end ${mine}`, `cd /x && reins memory end ${mine}`]) {
    const r = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command } }, { shell: { kind: 'shell', command: 'command' } });
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
  // The commands of the agent name a task: the harness checks the task, the client does not ask.
  const own = beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command: `reins memory next ${mine} 'a step' task=t0123456789ab` } }, { shell: { kind: 'shell', command: 'command' } });
  assert.notEqual(own.rule, 'protect.human-command');
});

// ---- The history of the memory: the harness commits the directory of the records when the config says so.

test('history: with `memory_commit` the harness commits every change of the memory, and nothing else', () => {
  const b = box();
  const dir = path.join(b.root, 'records');
  fs.mkdirSync(dir);
  const git = (...args: string[]): string => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'a note of the human that is not committed yet\n');
  // A file that a run left in the middle of a write, and a hook of the repository that refuses every commit.
  fs.mkdirSync(path.join(dir, 'decision'));
  fs.writeFileSync(path.join(dir, 'decision', 'm0000000000.md.123.tmp'), 'half a record\n');
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd }).stdout);
  // Without the key the history is the business of the human.
  fs.writeFileSync(b.config, JSON.stringify({ ...config, memory_dir: dir }));
  assert.equal(reins(['memory', 'decide', 'we keep one cache', 'because=two caches went out of step']).ok, true);
  assert.equal(git('log', '--oneline'), '');
  // With the key every change is one commit of the files of the records.
  fs.writeFileSync(b.config, JSON.stringify({ ...config, memory_dir: dir, memory_commit: true }));
  const made = reins(['memory', 'decide', 'we log in UTC', 'because=the servers are in three zones']);
  assert.equal(made.ok, true);
  assert.equal(git('log', '--oneline').split('\n').length, 1);
  assert.match(git('log', '-1', '--format=%s'), /^reins memory: /);
  // The record before the key and the new one are in the commit; the file of the human is not.
  assert.deepEqual(git('status', '--short', '-uall').split('\n').sort(), ['?? decision/m0000000000.md.123.tmp', '?? notes.txt']);
  // A command that changes nothing makes no commit.
  reins(['memory', 'find', 'cache']);
  assert.equal(git('log', '--oneline').split('\n').length, 1);
  assert.equal(reins(['memory', 'veto', made.record.id]).ok, true);
  assert.equal(git('log', '--oneline').split('\n').length, 2);
  // A key that is no boolean is a bad config.
  fs.writeFileSync(b.config, JSON.stringify({ ...config, memory_dir: dir, memory_commit: 'yes' }));
  assert.equal(reins(['memory']).error, 'bad_config');
});

test('history: a directory of the records that is no repository works as before', () => {
  const b = box();
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  fs.writeFileSync(b.config, JSON.stringify({ ...config, memory_commit: true }));
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config, GIT_CEILING_DIRECTORIES: b.root };
  const p = spawnSync(process.execPath, [CLI, 'memory', 'decide', 'we keep one cache', 'because=two caches went out of step'], { encoding: 'utf8', env, cwd: b.cwd });
  assert.deepEqual([p.status, JSON.parse(p.stdout).ok, p.stderr], [0, true, '']);
});
