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

test('sweep: a task inside its term stays open', () => {
  const rt = runtime();
  const free = openFreeTask(rt).id;
  const executing = scenario(rt);
  age(rt, free, 11 * HOUR);
  age(rt, executing, 23 * HOUR);
  assert.deepEqual(sweep(rt), []);
  assert.equal(openTasks(rt).length, 2);
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
