// The term of a task and the craft: tasks that nobody ended are closed by a sweep, and repeated
// patterns of the journal become proposals for the human.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { loadTask, openFreeTask, openScenario, openTasks, submitReport, type Runtime } from '../src/core/runtime.ts';
import { sweep } from '../src/core/sweep.ts';
import { detect, listProposals, propose, resolveProposal } from '../src/craft/craft.ts';
import { sessionStart } from '../src/client/session.ts';
import { loadCases } from './cases.ts';

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const HOUR = 60 * 60 * 1000;

let n = 0;
function runtime(): Runtime {
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
  const stateDir = path.join(root, 'state');
  const merged = loadPacks({ organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') });
  return { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 };
}
const age = (rt: Runtime, id: string, ms: number): void => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(path.join(rt.stateDir, 'tasks', `${id}.json`), t, t);
};
function scenario(rt: Runtime, change = '7'): string {
  const opened = openScenario(rt, 'change-review', { change_id: change });
  assert.ok(opened.ok);
  return opened.task.id;
}

test('sweep: a task that nobody touched past its term is closed', () => {
  const rt = runtime();
  const free = openFreeTask(rt).id;
  const fresh = openFreeTask(rt).id;
  const executing = scenario(rt, '7');
  const publishing = scenario(rt, '8');
  submitReport(rt, publishing, JSON.stringify({ items: [] }));
  age(rt, free, 13 * HOUR);
  age(rt, executing, 25 * HOUR);
  age(rt, publishing, 2 * HOUR);
  assert.deepEqual(sweep(rt).sort(), [free, executing, publishing].sort());
  assert.deepEqual([loadTask(rt, free)?.label, loadTask(rt, executing)?.label, loadTask(rt, publishing)?.label], ['not_verified', 'not_verified', 'verified_form']);
  assert.deepEqual(openTasks(rt).map((t) => t.id), [fresh]);
  assert.deepEqual(sweep(rt), []);
});

test('sweep: the files of a task that ended a week ago go away, an open task and a fresh end stay', () => {
  const rt = runtime();
  const old = scenario(rt, '7');
  const fresh = scenario(rt, '8');
  const open = scenario(rt, '9');
  age(rt, old, 25 * HOUR);
  age(rt, fresh, 25 * HOUR);
  assert.deepEqual(sweep(rt).sort(), [old, fresh].sort());
  const dir = path.join(rt.stateDir, 'tasks');
  fs.writeFileSync(path.join(dir, `${old}.report.txt`), 'a report');
  age(rt, old, 8 * 24 * HOUR);
  age(rt, fresh, 6 * 24 * HOUR);
  sweep(rt);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(old)), []);
  assert.equal(loadTask(rt, fresh)?.state, 'closed');
  assert.deepEqual(openTasks(rt).map((t) => t.id), [open]);
  // An open task past the week is ended by its term, not removed: its end is a fact of this sweep.
  age(rt, open, 8 * 24 * HOUR);
  assert.deepEqual(sweep(rt), [open]);
  assert.equal(loadTask(rt, open)?.state, 'closed');
});

test('sweep: a task inside its term stays open', () => {
  const rt = runtime();
  const free = openFreeTask(rt).id;
  const executing = scenario(rt);
  age(rt, free, 11 * HOUR);
  age(rt, executing, 23 * HOUR);
  assert.deepEqual(sweep(rt), []);
  assert.equal(openTasks(rt).length, 2);
});

test('sweep: a directory of compiled code that Node wrote nothing to for 30 days goes away', () => {
  const rt = runtime();
  const cache = path.join(rt.stateDir, 'compile-cache');
  const DAY = 24 * HOUR;
  const make = (name: string, days: number, file = 'a1b2c3d4'): string => {
    const dir = path.join(cache, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'code');
    const t = new Date(Date.now() - days * DAY);
    fs.utimesSync(path.join(dir, file), t, t);
    fs.utimesSync(dir, t, t);
    return dir;
  };
  // The directory of an older Node: no call writes there any more.
  const old = make('v24.0.0-arm64-00000000-501', 31);
  // The directory in use: one file is old, one is new. Node reads both, so both stay.
  const used = make('v25.8.1-arm64-392347a2-501', 31);
  fs.writeFileSync(path.join(used, 'ffffffff'), 'code');
  const fresh = make('v25.9.0-arm64-11111111-501', 29);
  // A file beside the directories and a link are not of Node: the sweep does not touch them.
  fs.writeFileSync(path.join(cache, 'note'), '');
  const t = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(path.join(cache, 'note'), t, t);
  const outside = path.join(rt.stateDir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), '');
  fs.utimesSync(path.join(outside, 'keep'), t, t);
  fs.symlinkSync(outside, path.join(cache, 'link'));
  sweep(rt);
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(fs.readdirSync(used).sort(), ['a1b2c3d4', 'ffffffff']);
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(path.join(cache, 'note')));
  assert.ok(fs.existsSync(path.join(outside, 'keep')));
  // No cache at all is not a failure of the sweep.
  fs.rmSync(cache, { recursive: true, force: true });
  assert.deepEqual(sweep(rt), []);
});

test('sweep: the start of a session runs the sweep', () => {
  const rt = runtime();
  const free = openFreeTask(rt).id;
  age(rt, free, 13 * HOUR);
  sessionStart(rt, { session: 's1', cwd: '/x' });
  assert.equal(loadTask(rt, free)?.state, 'closed');
});

const row = (kind: string, more: Record<string, unknown> = {}): never => ({ ts: '2026-11-11T10:00:00.000Z', v: 1, kind, project: 'p1a2b3c4', task: 't000000000000', ...more }) as never;

test('craft: a question about the same rule that repeats is a pattern', () => {
  const rows: never[] = [];
  for (let i = 0; i < 5; i += 1) rows.push(row('policy.decision', { data: { outcome: 'ask', action_kind: 'unknown', env: 'unknown' } }), row('policy.basis', { data: { layer: 'core', rule: 'default.unknown-tool' } }));
  for (let i = 0; i < 4; i += 1) rows.push(row('policy.decision', { data: { outcome: 'ask', action_kind: 'write', env: 'work' } }), row('policy.basis', { data: { layer: 'core', rule: 'default.write' } }));
  rows.push(row('policy.decision', { data: { outcome: 'allow', action_kind: 'read', env: 'local' } }), row('policy.basis', { data: { layer: 'core', rule: 'default.read' } }));
  assert.deepEqual(detect(rows), [{ pattern: 'repeated_question', key: 'default.unknown-tool', n: 5 }]);
});

test('craft: a scenario whose check fails often is a pattern', () => {
  const rows: never[] = [];
  for (const result of ['FAIL', 'FAIL', 'FAIL', 'PASS']) rows.push(row('check.answered', { scenario: 'change-review', scenario_v: 1, data: { result, check_kind: 'citations' } }));
  for (const result of ['FAIL', 'PASS', 'PASS', 'PASS']) rows.push(row('check.answered', { scenario: 'other', scenario_v: 1, data: { result, check_kind: 'citations' } }));
  assert.deepEqual(detect(rows), [{ pattern: 'check_fails_often', key: 'change-review', n: 3 }]);
});

test('craft: a pattern becomes one proposal, and the human resolves it', () => {
  const rt = runtime();
  const id = scenario(rt);
  for (let i = 0; i < 3; i += 1) submitReport(rt, id, 'not json');
  const other = scenario(rt, '8');
  submitReport(rt, other, 'not json');
  const made = propose(rt);
  assert.deepEqual(made.map((p) => [p.pattern, p.key, p.n, p.state]), [['check_fails_often', 'change-review', 4, 'open']]);
  assert.deepEqual(propose(rt), [], 'the same pattern makes no second proposal');
  assert.match(sessionStart(rt, { session: 's1', cwd: '/x' }).context.join('\n'), new RegExp(made[0]?.id ?? 'x'));
  assert.equal(resolveProposal(rt, made[0]?.id ?? '', 'rejected'), true);
  assert.deepEqual(listProposals(rt).map((p) => p.state), ['rejected']);
  assert.deepEqual(propose(rt), [], 'a rejected pattern is not proposed again');
  assert.equal(resolveProposal(rt, made[0]?.id ?? '', 'accepted'), false);
  const rows = readJournal(rt.journal.file);
  for (const r of rows) assert.deepEqual(validateRow(r), []);
  assert.deepEqual(rows.filter((r) => r.kind.startsWith('craft.')).map((r) => r.kind), ['craft.pattern_found', 'craft.proposal_created', 'craft.proposal_resolved']);
  assert.equal(rt.journal.failures, 0);
});
