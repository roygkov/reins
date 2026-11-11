// The decision before an action: a tool call of a client becomes an action, and the policy decides.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, openScenario, submitReport, loadTask, type Runtime } from '../src/core/runtime.ts';
import { afterAction, beforeAction, type ClientTools, type ToolCall } from '../src/client/before.ts';
import { findRoot, loadConfig } from '../src/gate/index.ts';
import { grantsOf } from '../src/core/task.ts';
import type { Manifest } from '../src/contracts/manifest.ts';
import { loadCases } from './cases.ts';

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'before-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};

// The tools of a client: what the adapter of the client knows about its own tools.
const CLIENT: ClientTools = {
  read_file: { kind: 'read' },
  write_file: { kind: 'local', path: 'path' },
  shell: { kind: 'shell', command: 'command' },
};
// The tools of the connectors: the organization pack describes them.
const TOOLS = {
  'tracker__get_*': { kind: 'read' },
  'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' },
  'tracker__*': { kind: 'write', action: 'comment', target: 'any/{id}', env: 'work' },
  'live__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'live' },
};

type Box = { rt: Runtime; root: string; cwd: string };
let n = 0;
function box(limit = 20): Box {
  n += 1;
  const root = path.join(SB, String(n));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'const limit = items.length;\n');
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) {
      const m = structuredClone(manifests.get(value.slice(10))) as any;
      if (value === '$manifest:review') m.permissions.write[0].limit = limit;
      fs.writeFileSync(file, JSON.stringify(m));
    } else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), tools: TOOLS }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = path.join(root, 'packs');
  const merged = loadPacks({ organization: path.join(packs, 'organization'), project: path.join(packs, 'project'), person: path.join(packs, 'person') });
  assert.deepEqual(merged.rejected, []);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd };
}

const fill = (b: Box, value: unknown): unknown =>
  typeof value === 'string' ? value.replaceAll('$CWD', b.cwd).replaceAll('$STATE', b.rt.stateDir).replaceAll('$PACKS', path.join(b.root, 'packs')) : value;
const call = (b: Box, tool: string, input: Record<string, unknown>): ToolCall => ({ cwd: b.cwd, tool, input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fill(b, v)])) });

function open(b: Box): string {
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  assert.equal(opened.task.state, 'executing');
  return opened.task.id;
}

type Case = {
  name: string; task?: boolean; approved?: { tool: string; input: Record<string, unknown> }[]; tool: string; input: Record<string, unknown>;
  expect: { outcome: string; rule?: string; envelope?: string; scope?: string; layer?: string; task?: boolean; gate?: boolean };
};

for (const c of loadCases<Case>('before-cases')) {
  test(`before: ${c.name}`, () => {
    const b = box();
    const id = c.task === true ? open(b) : undefined;
    for (const prior of c.approved ?? []) {
      assert.equal(beforeAction(b.rt, call(b, prior.tool, prior.input), CLIENT).outcome, 'ask');
      assert.deepEqual(afterAction(b.rt, call(b, prior.tool, prior.input), CLIENT), { confirmed: true });
    }
    const r = beforeAction(b.rt, call(b, c.tool, c.input), CLIENT);
    assert.equal(r.outcome, c.expect.outcome);
    if (c.expect.rule !== undefined) assert.equal(r.rule, c.expect.rule);
    if (c.expect.envelope !== undefined) assert.equal(r.envelope, c.expect.envelope);
    if (c.expect.scope !== undefined) assert.equal(r.scope, c.expect.scope);
    if (c.expect.layer !== undefined) assert.equal(r.layer, c.expect.layer);
    if (c.expect.gate === true) assert.ok(!r.rule.startsWith('default.'), `a rule of the gate, not ${r.rule}`);
    assert.equal(r.task, c.expect.task === true ? id : undefined);
    const rows = readJournal(b.rt.journal.file);
    for (const row of rows) assert.deepEqual(validateRow(row), [], `the row ${row.kind} is valid`);
    assert.equal(b.rt.journal.failures, 0);
    assert.ok(rows.some((x) => x.kind === 'policy.decision' || x.kind === 'policy.protected_attempt'), 'the decision is in the journal');
  });
}

test('before: the write limit of a grant holds across calls', () => {
  const b = box(2);
  const id = open(b);
  const comment = call(b, 'tracker__add_comment', { change: '7' });
  assert.equal(beforeAction(b.rt, comment, CLIENT).envelope, 'confirm');
  afterAction(b.rt, comment, CLIENT);
  assert.equal(loadTask(b.rt, id)?.use.used['comment change/7 work'], 1, 'the approved call is counted');
  assert.deepEqual([beforeAction(b.rt, comment, CLIENT).outcome, loadTask(b.rt, id)?.use.used['comment change/7 work']], ['allow', 2]);
  const third = beforeAction(b.rt, comment, CLIENT);
  assert.deepEqual([third.outcome, third.envelope], ['ask', 'limit']);
});

test('before: a call that the human did not approve confirms nothing', () => {
  const b = box();
  const id = open(b);
  const comment = call(b, 'tracker__add_comment', { change: '7' });
  beforeAction(b.rt, comment, CLIENT);
  // No "after": the human refused, the tool did not run.
  assert.equal(beforeAction(b.rt, comment, CLIENT).envelope, 'confirm');
  assert.deepEqual(loadTask(b.rt, id)?.use, { confirmed: [], used: {} });
});

test('before: "after" without a question before it confirms nothing', () => {
  const b = box();
  const id = open(b);
  assert.deepEqual(afterAction(b.rt, call(b, 'tracker__add_comment', { change: '7' }), CLIENT), { confirmed: false });
  assert.deepEqual(afterAction(b.rt, call(b, 'read_file', { path: 'a' }), CLIENT), { confirmed: false });
  assert.deepEqual(loadTask(b.rt, id)?.use, { confirmed: [], used: {} });
});

test('before: a closed task has no envelope for a tool call', () => {
  const b = box();
  const id = open(b);
  const done = submitReport(b.rt, id, JSON.stringify({ items: [] }));
  assert.ok('step' in done && done.step.task.state === 'publishing');
  const finished = applyEvent(b.rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in finished && finished.task.state === 'closed');
  const r = beforeAction(b.rt, call(b, 'tracker__add_comment', { change: '7' }), CLIENT);
  assert.deepEqual([r.outcome, r.envelope, r.task], ['ask', 'none', undefined]);
});

test('before: a protected attempt is written to the journal', () => {
  const b = box();
  beforeAction(b.rt, call(b, 'write_file', { path: '$STATE/journal.jsonl' }), CLIENT);
  const rows = readJournal(b.rt.journal.file);
  // The action is outside a scenario: it belongs to the free task of the session.
  assert.deepEqual(rows.map((r) => r.kind), ['task.opened', 'task.kind_decided', 'policy.protected_attempt']);
  assert.ok(rows.every((r) => r.task === rows[0]?.task));
  beforeAction(b.rt, call(b, 'read_file', { path: 'a' }), CLIENT);
  const all = readJournal(b.rt.journal.file);
  assert.equal(all.filter((r) => r.kind === 'task.opened').length, 1, 'one free task for one session');
  assert.ok(all.every((r) => r.task === rows[0]?.task));
});

for (const [name, tools, level, errors] of [
  ['only the organization describes tools', { 'x__get': { kind: 'read' } }, 'person', ['not_allowed tools']],
  ['a tool has a known kind', { 'x__get': { kind: 'local' } }, 'organization', ['not_in_list tools.x__get.kind']],
  ['a write tool names an action of the pack, a target and a known environment', { 'x__put': { kind: 'write', action: 'delete', env: 'moon' } }, 'organization', ['not_in_list tools.x__put.action', 'missing tools.x__put.target', 'not_in_list tools.x__put.env']],
  ['a read tool has no action', { 'x__get': { kind: 'read', action: 'comment' } }, 'organization', ['unknown_field tools.x__get.action']],
  ['a tool name is plain text with an optional star at the end', { 'x *': { kind: 'read' }, 'a*b': { kind: 'read' }, '*': { kind: 'read' } }, 'organization', ['bad_name tools.x *', 'bad_name tools.a*b', 'bad_name tools.*']],
  ['a target has only plain placeholders', { 'x__put': { kind: 'write', action: 'comment', target: 'c/{a.b}', env: 'work' } }, 'organization', ['bad_name tools.x__put.target']],
  ['the tools are an object', ['x'], 'organization', ['not_object tools']],
] as const) {
  test(`before: pack tools: ${name}`, () => {
    const pack = { pack: 1, level, name: 'acme', ...(level === 'organization' ? { connectors: { read: ['tracker'], write: ['comment'] }, envs: { known: ['work', 'live'], production: ['live'] } } : {}), tools };
    assert.deepEqual(validateSettings(pack, level).errors.map((e) => `${e.code} ${e.path}`), [...errors]);
  });
}

test('before: a shell command that names the state, the config or a pack in any spelling asks', () => {
  const b = box();
  b.rt.configFile = path.join(b.root, 'config.json');
  const home = process.env.HOME;
  process.env.HOME = b.root;
  try {
    for (const [command, rule] of [
      ['echo x > $HOME/state/tasks/t000000000000.json', 'protect.state'],
      ['echo x > ~/state/journal.jsonl', 'protect.state'],
      ['echo x > "${HOME}/state/journal.jsonl"', 'protect.state'],
      [`echo x > ${b.root}/config.json`, 'protect.config'],
      ['echo x > ~/config.json', 'protect.config'],
      ['echo x >> $HOME/packs/organization/pack.json', 'protect.packs'],
      [`sed -i x ${b.root}/packs/person/pack.json`, 'protect.packs'],
    ] as const) {
      const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
      assert.deepEqual([r.outcome, r.rule], ['ask', rule], command);
    }
    assert.equal(beforeAction(b.rt, call(b, 'shell', { command: 'echo x > ~/notes.txt' }), CLIENT).outcome, 'allow');
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

test('before: a run of the tool that the human did not see as a question is no approval', () => {
  const b = box();
  const id = open(b);
  const comment = call(b, 'tracker__add_comment', { change: '7' });
  beforeAction(b.rt, comment, CLIENT);
  assert.deepEqual(afterAction(b.rt, comment, CLIENT, false), { confirmed: false });
  assert.deepEqual(afterAction(b.rt, comment, CLIENT), { confirmed: false }, 'the question is gone with the run');
  assert.deepEqual(loadTask(b.rt, id)?.use, { confirmed: [], used: {} });
});

test('before: a refusal of the gate is not softened by the question about a path of the harness', () => {
  const b = box();
  // A rule of the human that refuses a command.
  b.rt.gateConfig = { ...loadConfig(findRoot(b.cwd)), forms: [{ id: 'no-wipe', pattern: 'wipe-everything', decision: 'deny' }] };
  const plain = beforeAction(b.rt, call(b, 'shell', { command: 'wipe-everything now' }), CLIENT);
  assert.deepEqual([plain.outcome, plain.rule], ['deny', 'user.no-wipe']);
  const named = beforeAction(b.rt, call(b, 'shell', { command: `cat ${b.rt.stateDir}/journal.jsonl; wipe-everything now` }), CLIENT);
  assert.deepEqual([named.outcome, named.rule], ['deny', 'user.no-wipe']);
  const asked = beforeAction(b.rt, call(b, 'shell', { command: `cat ${b.rt.stateDir}/journal.jsonl` }), CLIENT);
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'protect.state']);
});

test('before: a change of the code of the harness asks the human', () => {
  const b = box();
  b.rt.harnessDirs = [path.join(b.root, 'harness')];
  const edit = beforeAction(b.rt, call(b, 'write_file', { path: path.join(b.root, 'harness/clients/tools.json') }), CLIENT);
  assert.deepEqual([edit.outcome, edit.rule], ['ask', 'protect.harness']);
  const shell = beforeAction(b.rt, call(b, 'shell', { command: `echo x > ${b.root}/harness/src/a.ts` }), CLIENT);
  assert.deepEqual([shell.outcome, shell.rule], ['ask', 'protect.harness']);
});

test('before: the answer to a question belongs to the session that asked', () => {
  const b = box();
  const id = open(b);
  const one = { ...call(b, 'tracker__add_comment', { change: '7' }), session: 'one' };
  const two = { ...one, session: 'two' };
  assert.equal(beforeAction(b.rt, one, CLIENT).envelope, 'confirm');
  assert.deepEqual(afterAction(b.rt, two, CLIENT), { confirmed: false });
  assert.deepEqual(loadTask(b.rt, id)?.use, { confirmed: [], used: {} });
  assert.deepEqual(afterAction(b.rt, one, CLIENT), { confirmed: true });
});

test('before: after the check the named writes of the task are published under one approval', () => {
  const b = box();
  const id = open(b);
  const comment = call(b, 'tracker__add_comment', { change: '7' });
  const done = submitReport(b.rt, id, JSON.stringify({ items: [] }));
  assert.ok('step' in done && done.step.task.state === 'publishing');
  const first = beforeAction(b.rt, comment, CLIENT);
  assert.deepEqual([first.outcome, first.envelope, first.scope, first.task], ['ask', 'confirm', 'task', id]);
  assert.deepEqual(afterAction(b.rt, comment, CLIENT), { confirmed: true });
  const second = beforeAction(b.rt, comment, CLIENT);
  assert.deepEqual([second.outcome, second.envelope], ['allow', 'applied']);
  assert.equal(loadTask(b.rt, id)?.use.used['comment change/7 work'], 2);
});

test('before: a project path written with percent signs names the same target', () => {
  const b = box();
  const id = open(b);
  const r = beforeAction(b.rt, call(b, 'tracker__add_comment', { change: '%37' }), CLIENT);
  assert.deepEqual([r.envelope, r.task, r.grant], ['confirm', id, 'comment change/7 work']);
  const odd = beforeAction(b.rt, call(b, 'tracker__add_comment', { change: '7%0Ax' }), CLIENT);
  assert.deepEqual([odd.outcome, odd.task, odd.grant], ['ask', undefined, undefined], 'a percent form of a line break is not opened and names no target of the task');
});

test('before: a percent form in the input of the task and in the tool call is one target', () => {
  const manifest = structuredClone(manifests.get('review')) as Manifest;
  // The grant of the task and the key of a tool call are filled the same way.
  assert.equal(grantsOf(manifest, { change_id: 'a%2Fb' })[0]?.target, 'change/a/b');
  assert.equal(grantsOf(manifest, { change_id: 'a/b' })[0]?.target, 'change/a/b');
  assert.equal(grantsOf(manifest, { change_id: '100%' })[0]?.target, 'change/100%', 'a value that is no percent form stays as it is');
  const b = box();
  const id = open(b);
  for (const change of ['7', '%37']) {
    const r = beforeAction(b.rt, call(b, 'tracker__add_comment', { change }), CLIENT);
    assert.deepEqual([r.envelope, r.task], ['confirm', id], change);
  }
});

test('before: the envelope of a publication that nobody ended stops to answer', () => {
  const b = box();
  const id = open(b);
  const comment = call(b, 'tracker__add_comment', { change: '7' });
  submitReport(b.rt, id, JSON.stringify({ items: [] }));
  beforeAction(b.rt, comment, CLIENT);
  afterAction(b.rt, comment, CLIENT);
  assert.equal(beforeAction(b.rt, comment, CLIENT).envelope, 'applied');
  const file = path.join(b.rt.stateDir, 'tasks', `${id}.json`);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const late = beforeAction(b.rt, comment, CLIENT);
  assert.deepEqual([late.outcome, late.envelope, late.task], ['ask', 'none', undefined]);
  // A task that executes has no such term: the term of a task is the business of the task loop.
  const other = open(b);
  fs.utimesSync(path.join(b.rt.stateDir, 'tasks', `${other}.json`), old, old);
  assert.equal(beforeAction(b.rt, comment, CLIENT).task, other);
});

test('before: a percent form of a space stays as it is on both sides', () => {
  const manifest = structuredClone(manifests.get('review')) as Manifest;
  assert.equal(grantsOf(manifest, { change_id: 'a%20b' })[0]?.target, 'change/a%20b');
  assert.equal(grantsOf(manifest, { change_id: 'a%7Bb' })[0]?.target, 'change/a%7Bb');
  const b = box();
  const r = beforeAction(b.rt, call(b, 'tracker__add_comment', { change: 'a%20b' }), CLIENT);
  assert.deepEqual([r.outcome, r.rule], ['ask', 'default.write'], 'the value is a plain target, not an unknown one');
});

test('before: a command that stops a task is the word of the human: the client asks', () => {
  const b = box();
  for (const command of ['reins stop t000000000000', 'cd /tmp && reins  stop t000000000000', 'node /x/src/cli.ts stop t000000000000', "reins 'stop' t000000000000", 'reins "stop" t000000000000', '\\reins stop t000000000000', "'reins' stop t000000000000"]) {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
  for (const command of ['reins finish t000000000000', 'reins tasks', 'git stash; echo stop']) {
    assert.equal(beforeAction(b.rt, call(b, 'shell', { command }), CLIENT).outcome, 'allow', command);
  }
});

test('before: the stop command inside a command substitution or an ANSI quote asks too', () => {
  const b = box();
  for (const command of ['echo `reins stop t000000000000`', 'echo $(reins stop t000000000000)', "reins $'stop' t000000000000"]) {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
});
