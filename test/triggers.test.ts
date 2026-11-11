// Triggers past the command: a schedule and an event open a task without a human. And the level
// of the model that a pack gives when a manifest names none.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../src/contracts/manifest.ts';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { loadTask, openScenario, type Runtime } from '../src/core/runtime.ts';
import { fire, nextRun, parseSchedule, tick } from '../src/core/triggers.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: Record<string, any> }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const at = (d: number, h: number, m: number): Date => new Date(2026, 10, d, h, m, 0); // November 2026, local time; the 16th is a Monday

type Box = { rt: Runtime; root: string; cwd: string; config: string };
type Opts = { review?: Record<string, unknown>; minimal?: Record<string, unknown>; packs?: Record<string, object>; work?: boolean };
let n = 0;
function box(o: Opts = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const out = JSON.stringify({ outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: o.work !== false } });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const level = rel.split('/')[0] ?? '';
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${out}'\n`, { mode: 0o755 });
    else if (value === '$manifest:review') fs.writeFileSync(file, JSON.stringify({ ...manifests.get('review'), ...(o.review ?? {}) }));
    else if (value === '$manifest:minimal') fs.writeFileSync(file, JSON.stringify({ ...manifests.get('minimal'), ...(o.minimal ?? {}) }));
    else if (rel.endsWith('pack.json')) fs.writeFileSync(file, JSON.stringify({ ...(value as object), ...(o.packs?.[level] ?? {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
const SCHEDULED = { trigger: { kind: 'schedule', value: 'daily 09:00' } };

// ---- The form of a trigger.

for (const [value, ok] of [
  ['every 30m', true], ['every 2h', true], ['every 1d', true], ['daily 09:00', true], ['weekdays 18:30', true], ['weekly mon 08:00', true],
  ['every 0m', false], ['every 5s', false], ['daily 25:00', false], ['daily 9:00', false], ['weekly someday 08:00', false], ['0 9 * * *', false], ['weekdays-09-00', false],
] as const) {
  test(`triggers: the schedule "${value}" is ${ok ? 'a known form' : 'refused'}`, () => {
    assert.equal(parseSchedule(value) !== null, ok);
    const errors = validateManifest({ ...manifests.get('minimal'), trigger: { kind: 'schedule', value } }).map((e) => `${e.code} ${e.path}`);
    assert.deepEqual(errors, ok ? [] : ['bad_form trigger.value']);
  });
}

test('triggers: a schedule has no inputs, and an event has a name', () => {
  const check = (trigger: unknown) => validateManifest({ ...manifests.get('minimal'), trigger }).map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(check({ kind: 'schedule', value: 'daily 09:00', inputs: [{ name: 'x', type: 'id' }] }), ['not_allowed trigger.inputs']);
  assert.deepEqual(check({ kind: 'event', value: 'change-opened', inputs: [{ name: 'change_id', type: 'id' }] }), []);
  assert.deepEqual(check({ kind: 'event', value: 'Change Opened' }), ['bad_form trigger.value']);
});

test('triggers: the next run of a schedule', () => {
  const next = (value: string, after: Date) => nextRun(parseSchedule(value)!, after);
  assert.deepEqual(next('every 30m', at(16, 10, 0)), at(16, 10, 30));
  assert.deepEqual(next('daily 09:00', at(16, 8, 0)), at(16, 9, 0));
  assert.deepEqual(next('daily 09:00', at(16, 9, 0)), at(17, 9, 0));
  assert.deepEqual(next('weekdays 09:00', at(20, 10, 0)), at(23, 9, 0), 'after Friday comes Monday');
  assert.deepEqual(next('weekly wed 08:00', at(16, 10, 0)), at(18, 8, 0));
});

// ---- A schedule opens a task.

test('triggers: a scenario with a schedule runs when its time came, once', () => {
  const b = box({ minimal: SCHEDULED });
  assert.deepEqual(tick(b.rt, at(16, 8, 0).getTime()).opened, [], 'the first look only notes the time');
  assert.deepEqual(tick(b.rt, at(16, 8, 59).getTime()).opened, []);
  const run = tick(b.rt, at(16, 9, 1).getTime());
  assert.deepEqual(run.opened.map((t) => [t.scenario, t.state]), [['draft-message', 'executing']]);
  assert.deepEqual(tick(b.rt, at(16, 9, 2).getTime()).opened, [], 'the same time does not run twice');
  assert.equal(tick(b.rt, at(17, 9, 0).getTime()).opened.length, 1, 'the next day runs again');
  assert.equal(loadTask(b.rt, run.opened[0]?.task ?? '')?.session, undefined, 'no session holds the task');
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

test('triggers: a scheduled scenario without work ends without the model', () => {
  const collect = { script: 'collect/change', outputs: ['diff', 'task', 'discussion', 'worktree'], flags: ['has_new_commits'] };
  const b = box({ minimal: { trigger: { kind: 'schedule', value: 'every 1h' }, collect, run_if: 'has_new_commits' }, work: false });
  assert.deepEqual(b.rt.merged.rejected, []);
  tick(b.rt, at(16, 8, 0).getTime());
  const run = tick(b.rt, at(16, 9, 0).getTime());
  assert.deepEqual([run.opened, run.skipped.map((t) => t.scenario)], [[], ['draft-message']]);
});

test('triggers: a scenario with a command trigger does not run by time', () => {
  const b = box();
  tick(b.rt, at(16, 8, 0).getTime());
  const run = tick(b.rt, at(18, 8, 0).getTime());
  assert.deepEqual([run.opened, run.skipped], [[], []]);
});

// ---- An event opens a task.

test('triggers: an event opens a task of every scenario that waits for it, with the inputs of the event', () => {
  const b = box({ review: { trigger: { kind: 'event', value: 'change-opened', inputs: [{ name: 'change_id', type: 'id' }] } } });
  const r = fire(b.rt, 'change-opened', { change_id: '7' });
  assert.deepEqual(r.opened.map((t) => [t.scenario, t.state]), [['change-review', 'executing']]);
  assert.deepEqual(loadTask(b.rt, r.opened[0]?.task ?? '')?.inputs, { change_id: '7' });
  assert.deepEqual(fire(b.rt, 'other-event', {}), { opened: [], skipped: [], refused: [] });
  assert.deepEqual(fire(b.rt, 'change-opened', {}).refused.map((x) => x.scenario), ['change-review'], 'inputs that do not fit open nothing');
});

test('triggers: the command line runs the schedule and takes an event', () => {
  const b = box({ review: { trigger: { kind: 'event', value: 'change-opened', inputs: [{ name: 'change_id', type: 'id' }] } } });
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  assert.deepEqual(run(['tick']), { ok: true, opened: [], skipped: [] });
  const fired = run(['fire', 'change-opened', 'change_id=7']);
  assert.deepEqual([fired.ok, fired.opened.length, fired.opened[0].scenario], [true, 1, 'change-review']);
  assert.deepEqual(run(['scenarios']).scenarios.find((s: any) => s.name === 'change-review').trigger, { kind: 'event', value: 'change-opened' });
});

// ---- The level of the model from the packs.

test('triggers: a manifest without a level takes the level that the lowest pack gives', () => {
  const noLevel = { model: {} };
  const person = box({ minimal: noLevel, packs: { organization: { defaults: { level: 'medium' } }, person: { defaults: { level: 'weak' } } } });
  assert.deepEqual(person.rt.merged.packs.map((p) => p.errors), [[], [], []]);
  const a = openScenario(person.rt, 'draft-message', {}, {});
  assert.ok(a.ok);
  assert.equal(a.task.level, 'weak');
  const none = box({ minimal: noLevel });
  const c = openScenario(none.rt, 'draft-message', {}, {});
  assert.ok(c.ok);
  assert.equal(c.task.level, 'medium', 'no pack names a level');
  const named = openScenario(person.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(named.ok);
  assert.equal(named.task.level, 'medium', 'the level of the manifest holds');
});

test('triggers: a pack cannot give a level above the limit of the level above it', () => {
  const b = box({ packs: { organization: { limits: { level: 'medium', tokens: 200000, writes: 20, executors: 2 } }, person: { limits: {}, defaults: { level: 'strong' } } } });
  assert.deepEqual(b.rt.merged.packs.find((p) => p.level === 'person')?.errors.map((e) => `${e.code} ${e.path}`), ['widens defaults.level']);
});

// ---- Cases of the review.

test('triggers: a level that a pack gives is cut to the limit of a lower pack', () => {
  const b = box({ minimal: { model: {} }, packs: { organization: { defaults: { level: 'strong' } }, person: { limits: { level: 'medium' } } } });
  assert.deepEqual(b.rt.merged.packs.map((p) => p.errors), [[], [], []]);
  const r = openScenario(b.rt, 'draft-message', {}, {});
  assert.ok(r.ok);
  assert.equal(r.task.level, 'medium');
});

test('triggers: a contract without a level takes the level of the packs, and a raise only goes up', async () => {
  const { proposeContract, approveContract, raiseLevel } = await import('../src/core/runtime.ts');
  const b = box({ packs: { organization: { limits: { level: 'weak', tokens: 200000, writes: 20, executors: 2 } }, person: { limits: {} } } });
  const contract = { manifest: 1, name: 'one-task', title: 'One task', package: 'person', trigger: { kind: 'command' }, model: { token_limit: 1000 }, permissions: { read: [] }, done: { kind: 'human', retries: 0 }, output: { format: 'text', max_bytes: 1000 } };
  const r = proposeContract(b.rt, contract, {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.task.level, 'weak', 'the limit of the packs holds for a contract');
  const free = box({ minimal: { model: { raise_to: 'weak' } } });
  const opened = openScenario(free.rt, 'draft-message', {}, {});
  assert.ok(opened.ok);
  assert.equal(opened.task.level, 'medium');
  assert.deepEqual(raiseLevel(free.rt, opened.task.id), { error: 'not_allowed' }, 'a level below is no raise');
  void approveContract;
});

test('triggers: a look that another look holds does not run the scenario', () => {
  const b = box({ minimal: SCHEDULED });
  tick(b.rt, at(16, 8, 0).getTime());
  fs.writeFileSync(path.join(b.rt.stateDir, 'triggers', 'draft-message.json.lock'), '');
  assert.deepEqual(tick(b.rt, at(16, 9, 1).getTime()).opened, []);
  fs.rmSync(path.join(b.rt.stateDir, 'triggers', 'draft-message.json.lock'));
  assert.equal(tick(b.rt, at(16, 9, 2).getTime()).opened.length, 1);
});
