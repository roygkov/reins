// The done check past its first cut: an answer holds only for the work that the check saw, and
// a script of a pack gets only what the manifest names and must not change the work.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, loadTask, openScenario, submitReport, verifyWork, type Runtime } from '../src/core/runtime.ts';
import { beforeAction, type ClientTools } from '../src/client/before.ts';
import { loadCases } from './cases.ts';

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: Record<string, unknown> }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { read_file: { kind: 'read' } };
const TOOLS = { 'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' } };
const REPORT = JSON.stringify({ items: [{ file: 'a.txt', line: 1, quote: 'the first line of the file', text: 'x' }] });

type Box = { rt: Runtime; root: string; cwd: string };
type Opts = { collect?: string; check?: string; done?: Record<string, unknown>; organization?: Record<string, unknown> };
let n = 0;
function box(o: Opts = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'the first line of the file\nthe second line\n');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const out = JSON.stringify({ outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } });
  const collect = o.collect ?? `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${out}'\n`;
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, collect.replaceAll('$OUT', out).replaceAll('$WORK', cwd), { mode: 0o755 });
    else if (value === '$manifest:review') fs.writeFileSync(file, JSON.stringify({ ...manifests.get('review'), ...(o.done !== undefined ? { done: o.done } : {}) }));
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), tools: TOOLS, ...(o.organization ?? {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  if (o.check !== undefined) {
    fs.mkdirSync(path.join(root, 'packs/project/check'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packs/project/check/tests.sh'), o.check.replaceAll('$WORK', cwd), { mode: 0o755 });
  }
  const merged = loadPacks({ organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') });
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  assert.deepEqual(merged.rejected, []);
  const stateDir = path.join(root, 'state');
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000, workDir: cwd }, root, cwd };
}
function accepted(b: Box): string {
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'executing');
  const r = submitReport(b.rt, opened.task.id, REPORT);
  assert.ok('step' in r);
  assert.equal(r.step.task.state, 'publishing', JSON.stringify(r));
  return opened.task.id;
}
const comment = (b: Box) => beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__add_comment', input: { change: '7' }, session: 's1' }, CLIENT);

// ---- The answer holds for the work that the check saw.

test('ready: an accepted result keeps the fingerprint of the work, and the work as it was keeps the answer', () => {
  const b = box();
  const id = accepted(b);
  assert.match(loadTask(b.rt, id)?.work ?? '', /^[0-9a-f]{32}$/);
  assert.equal(verifyWork(b.rt, id), true);
  assert.equal(comment(b).task, id, 'the envelope of the publication answers');
  const r = applyEvent(b.rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in r);
  assert.deepEqual([r.task.state, r.task.label], ['closed', 'verified_form']);
});

test('ready: after a change of the work the answer does not hold: the publication ends as not verified', () => {
  const b = box();
  const id = accepted(b);
  fs.appendFileSync(path.join(b.cwd, 'a.txt'), 'a line after the check\n');
  const r = comment(b);
  assert.deepEqual([r.task, r.envelope], [undefined, 'none'], 'the envelope does not answer');
  const task = loadTask(b.rt, id);
  assert.deepEqual([task?.state, task?.label], ['closed', 'not_verified']);
  const rows = readJournal(b.rt.journal.file);
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  assert.ok(rows.some((x) => x.kind === 'check.invalidated' && x.task === id));
  assert.ok(rows.some((x) => x.kind === 'task.closed' && x.data?.reason === 'work_changed'));
});

test('ready: the end of a publication after a change of the work is not a verified result', () => {
  const b = box();
  const id = accepted(b);
  fs.writeFileSync(path.join(b.cwd, 'new.txt'), 'a new file\n');
  assert.equal(verifyWork(b.rt, id), false);
  assert.deepEqual([loadTask(b.rt, id)?.state, loadTask(b.rt, id)?.label], ['closed', 'not_verified']);
});

test('ready: a check that changes the work gives no answer', () => {
  const b = box({
    done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' },
    check: "#!/bin/sh\ncat >/dev/null\necho changed >> $WORK/a.txt\nprintf '%s' '{\"outputs\":{\"result\":\"PASS\"}}'\n",
  });
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(opened.ok);
  const r = submitReport(b.rt, opened.task.id, 'done');
  assert.ok('step' in r && r.answer !== undefined);
  assert.deepEqual([r.answer.result, r.answer.reason, r.step.task.state], ['none', 'work_changed', 'waiting_human']);
});

// ---- A script of a pack.

test('ready: a collect script that changes a work that is no repository fails the preparation too', () => {
  const b = box({ collect: "#!/bin/sh\ncat >/dev/null\necho changed >> $WORK/a.txt\nprintf '%s' '$OUT'\n" });
  assert.ok(b.rt.workDir !== undefined);
  fs.rmSync(path.join(b.rt.workDir, '.git'), { recursive: true });
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(opened.ok);
  assert.deepEqual([opened.task.state, opened.task.label], ['closed', 'not_verified']);
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'harness.failure' && x.data?.reason === 'changed_work'));
});

test('ready: a collect script that changes the work of the client fails the preparation', () => {
  const b = box({ collect: "#!/bin/sh\ncat >/dev/null\necho changed >> $WORK/a.txt\nprintf '%s' '$OUT'\n" });
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(opened.ok);
  assert.deepEqual([opened.task.state, opened.task.label], ['closed', 'not_verified']);
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'harness.failure' && x.data?.reason === 'changed_work'));
});

test('ready: a script gets the variables of the read connectors that its manifest names, and no other', () => {
  const b = box({
    organization: { connectors: { read: ['code-host', 'tracker', 'chat'], write: ['comment'], env: { 'code-host': ['HOST_TOKEN'], chat: ['CHAT_TOKEN'] } } },
    collect: "#!/bin/sh\ncat >/dev/null\nprintf '{\"outputs\":{\"diff\":\"%s|%s|%s\",\"task\":1,\"discussion\":[],\"worktree\":\"$WORK\"},\"flags\":{\"has_new_commits\":true}}' \"$HOST_TOKEN\" \"$CHAT_TOKEN\" \"$OTHER_TOKEN\"\n",
  });
  Object.assign(process.env, { HOST_TOKEN: 'h', CHAT_TOKEN: 'c', OTHER_TOKEN: 'o' });
  try {
    const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, {});
    assert.ok(opened.ok);
    assert.equal(opened.collected?.diff, 'h||');
  } finally {
    for (const k of ['HOST_TOKEN', 'CHAT_TOKEN', 'OTHER_TOKEN']) delete process.env[k];
  }
});

for (const [name, level, env, errors] of [
  ['only the organization names the variables of a connector', 'person', { 'code-host': ['X_TOKEN'] }, ['not_allowed connectors.env']],
  ['the connector is a read connector of the pack', 'organization', { other: ['X_TOKEN'] }, ['not_in_list connectors.env.other']],
  ['a variable has the name of an environment variable', 'organization', { 'code-host': ['X_TOKEN', 'bad name', 'PATH'] }, ['bad_name connectors.env.code-host[1]', 'bad_name connectors.env.code-host[2]']],
] as const) {
  test(`ready: pack: ${name}`, () => {
    const pack = { pack: 1, level, name: 'acme', connectors: { ...(level === 'organization' ? { read: ['code-host'] } : {}), env } };
    assert.deepEqual(validateSettings(pack, level).errors.map((e) => `${e.code} ${e.path}`), [...errors]);
  });
}

// ---- Cases of the review.

test('ready: a publication that expires or that the human stops after a change of the work is not verified', () => {
  for (const event of [{ type: 'expire' }, { type: 'human', decision: 'stop' }] as const) {
    const b = box();
    const id = accepted(b);
    fs.appendFileSync(path.join(b.cwd, 'a.txt'), 'a line after the check\n');
    applyEvent(b.rt, id, event, event.type === 'expire' ? 'harness' : 'human');
    assert.deepEqual([loadTask(b.rt, id)?.state, loadTask(b.rt, id)?.label], ['closed', 'not_verified'], event.type);
  }
  const b = box();
  const id = accepted(b);
  applyEvent(b.rt, id, { type: 'expire' }, 'harness');
  assert.equal(loadTask(b.rt, id)?.label, 'verified_form', 'the work as it was keeps the label');
});

test('ready: a work that had a fingerprint and has none now does not keep the answer', () => {
  const b = box();
  const id = accepted(b);
  fs.rmSync(path.join(b.cwd, '.git'), { recursive: true, force: true });
  assert.equal(verifyWork(b.rt, id), false);
});

test('ready: a collect script that changes the work and then fails leaves the fact in the journal', () => {
  const b = box({ collect: '#!/bin/sh\ncat >/dev/null\necho changed >> $WORK/a.txt\nexit 3\n' });
  openScenario(b.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'harness.failure' && x.data?.reason === 'changed_work'));
});
