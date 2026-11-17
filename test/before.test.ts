// The decision before an action: a tool call of a client becomes an action, and the policy decides.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveQueued } from '../src/core/queue.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { applyEvent, frozenRuntime, openScenario, submitReport, loadTask, type Runtime } from '../src/core/runtime.ts';
import { tokenLimit } from '../src/client/cost.ts';
import { humanRequest } from '../src/client/session.ts';
import { afterAction, beforeAction, type ClientTools, type ToolCall } from '../src/client/before.ts';
import { findRoot, loadConfig } from '../src/gate/index.ts';
import { grantsOf } from '../src/core/task.ts';
import { validateManifest, type Manifest } from '../src/contracts/manifest.ts';
import { executorStarted } from '../src/client/executors.ts';
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
  'wiki__get_*': { kind: 'read', connector: 'tracker' },
  'live__get_*': { kind: 'read', env: 'live' },
  'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' },
  'tracker__*': { kind: 'write', action: 'comment', target: 'any/{id}', env: 'work' },
  'live__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'live' },
  'chat__send': { kind: 'write', action: 'comment', target: 'channel/{channel}', env: 'work', outward: true },
};

type Box = { rt: Runtime; root: string; cwd: string };
let n = 0;
function box(limit = 20, executors?: Record<string, unknown>[]): Box {
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
      if (value === '$manifest:review' && executors !== undefined) m.model.executors = executors;
      fs.writeFileSync(file, JSON.stringify(m));
    } else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), tools: TOOLS, ...(executors !== undefined ? { roles: executors.map((e) => e.role) } : {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = path.join(root, 'packs');
  const merged = loadPacks({ organization: path.join(packs, 'organization'), project: path.join(packs, 'project'), person: path.join(packs, 'person') });
  assert.deepEqual(merged.rejected, []);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000, ...(executors !== undefined ? { workDir: cwd } : {}) }, root, cwd };
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
  ['a read tool names a known environment or none', { 'x__get': { kind: 'read', env: 'moon' }, 'y__get': { kind: 'read', env: 'live' } }, 'organization', ['not_in_list tools.x__get.env']],
  ['a tool name is plain text with an optional star at the end', { 'x *': { kind: 'read' }, 'a*b': { kind: 'read' }, '*': { kind: 'read' } }, 'organization', ['bad_name tools.x *', 'bad_name tools.a*b', 'bad_name tools.*']],
  ['a target has only plain placeholders', { 'x__put': { kind: 'write', action: 'comment', target: 'c/{a.b}', env: 'work' } }, 'organization', ['bad_name tools.x__put.target']],
  ['the tools are an object', ['x'], 'organization', ['not_object tools']],
] as const) {
  test(`before: pack tools: ${name}`, () => {
    const pack = { pack: 1, level, name: 'acme', ...(level === 'organization' ? { connectors: { read: ['tracker'], write: ['comment'] }, envs: { known: ['work', 'live'], production: ['live'] } } : {}), tools };
    assert.deepEqual(validateSettings(pack, level).errors.map((e) => `${e.code} ${e.path}`), [...errors]);
  });
}

test('before: a shell command that writes into the state or the config in any spelling is refused, into a pack asks', () => {
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
      assert.deepEqual([r.outcome, r.rule], [rule === 'protect.packs' ? 'ask' : 'deny', rule], command);
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

test('before: a command that only reads the code of the harness or a pack gets no question', () => {
  const b = box();
  const h = path.join(b.root, 'harness');
  b.rt.harnessDirs = [h];
  const asks = (command: string): [string, string | undefined] => {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    return [r.outcome, r.rule];
  };
  // Every part is a program that only reads, with no variable, no substitution and no output file.
  for (const command of [
    `cat ${h}/src/a.ts`,
    `git -C ${h} log --oneline | head -5`,
    `cd ${h} && git status --short && git diff --stat`,
    `grep -rn "x" ${h}/src | wc -l`,
    `sed -n 1,20p ${h}/README.md`,
    `ls -la ${h} 2>/dev/null`,
    `find ${h} -name "*.ts" | sort | tail -3`,
    `jq -c .version ${h}/package.json; echo done`,
  ]) assert.notEqual(asks(command)[0], 'ask', command);
  // Anything else that names the harness asks as before.
  for (const command of [
    `echo x > ${h}/a.ts`,
    `cat ${h}/a.ts > ${b.root}/copy.ts`,
    `python3 ${h}/x.py`,
    `node ${h}/src/cli.ts status`,
    `git -C ${h} commit -m x`,
    `git -C ${h} diff --output=${b.root}/x.patch`,
    `sed -i s/a/b/ ${h}/a.ts`,
    `sed -n 'w ${b.root}/out' ${h}/a.ts`,
    `find ${h} -name "*.ts" -delete`,
    `find ${h} -exec touch {} +`,
    `cat $(echo ${h}/a.ts)`,
    `cat ${h}/a.ts | xargs rm`,
    `rg --pre cat x ${h}`,
    `sort -o ${h}/a.ts ${h}/b.ts`,
    `FOO=1 cat ${h}/a.ts`,
    `cat ${h}/a.ts; rm -rf "$HOME/x"`,
    `npx cat ${h}/a.ts`,
    `sudo cat ${h}/a.ts`,
    `cat ${h}/list.txt | xargs cat`,
    `git -C ${h} -c core.pager=less log`,
  ]) assert.deepEqual(asks(command), ['ask', 'protect.harness'], command);
  // A pack of the harness: the same rule.
  const pack = b.rt.merged.packs[0]?.dir;
  assert.ok(pack !== undefined);
  assert.notEqual(asks(`cat ${pack}/pack.json`)[0], 'ask');
  assert.deepEqual(asks(`touch ${pack}/pack.json`), ['ask', 'protect.packs']);
  assert.deepEqual(asks(`bash ${pack}/check/x.sh`), ['ask', 'protect.packs']);
  // The state, the memory and the config keep their question for a read.
  assert.deepEqual(asks(`cat ${h}/a.ts ${b.rt.stateDir}/journal.jsonl`), ['ask', 'protect.state']);
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

test('before: a scenario that only the human opens: the command that opens it asks, the others pass', () => {
  const b = box();
  const run = (command: string) => beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
  // The manifest does not say who opens the scenario: the agent opens it, as before.
  assert.equal(run('reins open change-review change_id=7').outcome, 'allow');
  const scenario = b.rt.merged.scenarios.find((s) => s.name === 'change-review');
  assert.ok(scenario !== undefined);
  scenario.manifest.trigger.open = 'human';
  for (const command of ['reins open change-review change_id=7', 'cd /tmp && reins  open change-review', "node /x/src/cli.ts open 'change-review'", 'reins "open" change-review']) {
    const r = run(command);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
  // Another scenario, a name that is no scenario, and a command that only reads: no question.
  for (const command of ['reins open other-name', 'reins input t000000000000', 'reins scenarios', 'echo reins open change-review-2']) assert.equal(run(command).outcome, 'allow', command);
  // A refusal holds: the open of the scenario joined with a write into the state is refused, not asked.
  const joined = run(`reins open change-review && echo x > ${b.rt.stateDir}/pause.json`);
  assert.deepEqual([joined.outcome, joined.rule], ['deny', 'protect.state']);
  // The form of the input opens the same scenario without its name: the same question.
  scenario.manifest.trigger.inputs = [{ name: 'change_id', type: 'string', pattern: 'CH-[0-9]+' }];
  assert.deepEqual([run('reins match CH-7').outcome, run('reins match CH-7').rule], ['ask', 'protect.human-command']);
  assert.equal(run('reins match other').outcome, 'allow');
  scenario.manifest.trigger.open = 'agent';
  assert.equal(run('reins match CH-7').outcome, 'allow');
});

test('before: a command that stops a task is the word of the human: the client refuses it', () => {
  const b = box();
  for (const command of ['reins stop t000000000000', 'cd /tmp && reins  stop t000000000000', 'node /x/src/cli.ts stop t000000000000', "reins 'stop' t000000000000", 'reins "stop" t000000000000', '\\reins stop t000000000000', "'reins' stop t000000000000"]) {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.human-command'], command);
  }
  for (const command of ['reins finish t000000000000', 'reins tasks', 'git stash; echo stop']) {
    assert.equal(beforeAction(b.rt, call(b, 'shell', { command }), CLIENT).outcome, 'allow', command);
  }
});

test('before: a decision of the human in a shell of the agent is refused, a start of a client asks', () => {
  const b = box();
  const run = (command: string) => beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
  // The command line refuses a decision that does not come from a terminal: a question would lead to that refusal.
  for (const command of ['reins stop t000000000000', 'reins approve t000000000000', 'reins retry t000000000000', 'reins pause 5', 'reins queue approve q000000000000', 'reins craft accept c00000000000', 'reins memory decide text because=cause', 'echo $(reins stop t000000000000)', 'reins stop t000000000000; reins run change-review change_id=7', 'bash -c "reins approve t000000000000"']) {
    const r = run(command);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.human-command'], command);
  }
  // A start of a client is no decision: the human says "yes" to the question, as before.
  for (const command of ['reins run change-review change_id=7', 'reins tick run', 'reins fire change-opened change_id=7']) {
    const r = run(command);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
  // The word is in a variable: nobody can say that it is a decision, so the question stays.
  const hidden = run('reins $WORD t000000000000');
  assert.deepEqual([hidden.outcome, hidden.rule], ['ask', 'protect.human-command']);
});

test('before: a command that fires an event opens tasks of scenarios: it is the word of the human, with a client and without one', () => {
  const b = box();
  for (const command of ['reins fire change-opened change_id=7', 'reins fire run change-opened change_id=7', 'node /x/src/cli.ts fire change-opened']) {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
  // A look at the schedule opens only what is due: it stays a command of the agent.
  assert.equal(beforeAction(b.rt, call(b, 'shell', { command: 'reins tick' }), CLIENT).outcome, 'allow');
});

test('before: the stop command inside a command substitution or an ANSI quote is refused too', () => {
  const b = box();
  for (const command of ['echo `reins stop t000000000000`', 'echo $(reins stop t000000000000)', "reins $'stop' t000000000000"]) {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.human-command'], command);
  }
});

test('before: the pack directory of a repository is protected before it exists', () => {
  const b = box();
  b.rt.projectPackDir = path.join(b.cwd, '.reins');
  const edit = beforeAction(b.rt, call(b, 'write_file', { path: '$CWD/.reins/check/tests.sh' }), CLIENT);
  assert.deepEqual([edit.outcome, edit.rule], ['ask', 'protect.packs']);
  const shell = beforeAction(b.rt, call(b, 'shell', { command: `mkdir -p ${b.cwd}/.reins && echo x > ${b.cwd}/.reins/pack.json` }), CLIENT);
  assert.deepEqual([shell.outcome, shell.rule], ['ask', 'protect.packs']);
});

test('before: a pack directory of any repository is protected', () => {
  const b = box();
  const edit = beforeAction(b.rt, call(b, 'write_file', { path: '/tmp/other-repo/.reins/check/tests.sh' }), CLIENT);
  assert.deepEqual([edit.outcome, edit.rule], ['ask', 'protect.packs']);
  for (const command of ['echo x > /tmp/other-repo/.reins/pack.json', 'mkdir .reins', 'cd repo && cp -r x .reins/check']) {
    const r = beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.packs'], command);
  }
  assert.equal(beforeAction(b.rt, call(b, 'write_file', { path: '$CWD/src/reins.ts' }), CLIENT).outcome, 'allow');
});

// ---- The role of a subordinate executor bounds its rights.

function roles(executors: Record<string, unknown>[]): { b: Box; id: string; as: (role: string | undefined, tool: string, input: Record<string, unknown>) => string } {
  const b = box(20, executors);
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  for (const e of executors) assert.equal(executorStarted(b.rt, { session: 's1', cwd: b.cwd, role: String(e.role) }).outcome, 'allow');
  const as = (role: string | undefined, tool: string, input: Record<string, unknown>): string => {
    const r = beforeAction(b.rt, { ...call(b, tool, input), session: 's1', ...(role !== undefined ? { sub: role } : {}) }, CLIENT);
    return `${r.outcome} ${r.rule}`;
  };
  return { b, id: opened.task.id, as };
}

test('before: a subordinate executor with the right to read changes nothing', () => {
  const { b, as } = roles([{ role: 'reviewer', count: 1, rights: 'read' }]);
  assert.equal(as('reviewer', 'read_file', { path: 'src/a.ts' }), 'allow default.read');
  assert.equal(as('reviewer', 'shell', { command: 'cat src/a.ts' }).split(' ')[0], 'allow');
  assert.equal(as('reviewer', 'write_file', { path: 'src/a.ts' }), 'deny executor.read-only');
  assert.equal(as('reviewer', 'shell', { command: 'echo x > src/a.ts' }), 'deny executor.read-only');
  // A command of git that changes the tree or the history names no path: it is a change too.
  for (const command of ['git commit -am x', 'git add -A', 'git stash', 'cd src && git -C . checkout -- a.ts']) assert.equal(as('reviewer', 'shell', { command }), 'deny executor.read-only', command);
  for (const command of ['git diff HEAD', 'git log --oneline -3', 'git status --short']) assert.equal(as('reviewer', 'shell', { command }).split(' ')[0], 'allow', command);
  // The envelope of the parent task is not its envelope, and a question to the human is not its way to a change.
  assert.equal(as('reviewer', 'tracker__add_comment', { change: '7' }), 'deny executor.read-only');
  assert.equal(as('reviewer', 'unknown__tool', {}), 'deny executor.read-only');
  assert.equal(as('reviewer', 'write_file', { path: '$PACKS/person/pack.json' }), 'deny executor.read-only');
  // The main executor keeps its rights.
  assert.equal(as(undefined, 'write_file', { path: 'src/a.ts' }), 'allow default.local');
  const rows = readJournal(b.rt.journal.file);
  const denied = rows.filter((r) => r.kind === 'policy.basis' && r.data?.rule === 'executor.read-only');
  assert.equal(denied.length, 9);
  assert.ok(denied.every((r) => r.executor === 'sub' && r.role === 'reviewer'));
  for (const r of rows) assert.deepEqual(validateRow(r), [], r.kind);
});

test('before: a subordinate executor with an area writes only there, and reads everywhere', () => {
  const { b, as } = roles([{ role: 'part-a', count: 1, rights: 'write', area: ['src/a/**', 'docs/a.md'] }, { role: 'part-b', count: 1, rights: 'write', area: ['src/b/**'] }]);
  fs.mkdirSync(path.join(b.cwd, 'src/a'), { recursive: true });
  fs.mkdirSync(path.join(b.cwd, 'src/b'), { recursive: true });
  assert.equal(as('part-a', 'write_file', { path: 'src/a/x.ts' }), 'allow default.local');
  assert.equal(as('part-a', 'write_file', { path: 'docs/a.md' }), 'allow default.local');
  assert.equal(as('part-a', 'write_file', { path: 'src/b/x.ts' }), 'deny executor.area');
  assert.equal(as('part-a', 'write_file', { path: 'src/a/../b/x.ts' }), 'deny executor.area');
  assert.equal(as('part-a', 'write_file', { path: '$CWD/../x.ts' }), 'deny executor.area');
  assert.equal(as('part-b', 'write_file', { path: 'src/b/x.ts' }), 'allow default.local');
  assert.equal(as('part-b', 'write_file', { path: 'src/a/x.ts' }), 'deny executor.area');
  assert.equal(as('part-a', 'shell', { command: 'echo x > src/a/y.ts' }).split(' ')[0], 'allow');
  assert.equal(as('part-a', 'shell', { command: 'echo x > src/b/y.ts' }), 'deny executor.area');
  assert.equal(as('part-a', 'shell', { command: 'rm -r src' }), 'deny executor.area');
  // What all executors share is not an area of one: the tree and the history of git.
  for (const command of ['git stash', 'git checkout -- src/b', 'git commit -am x']) assert.equal(as('part-a', 'shell', { command }), 'deny executor.area', command);
  assert.equal(as('part-a', 'shell', { command: 'git diff' }).split(' ')[0], 'allow');
  // A write of a connector is not a file: the policy and the envelope of the parent task decide it, as before.
  assert.equal(as('part-a', 'tracker__add_comment', { change: '7' }), 'ask default.write');
  assert.equal(as('part-b', 'read_file', { path: 'src/a/x.ts' }), 'allow default.read');
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), [], r.kind);
});

test('before: a role without rights in the manifest works as before, in the envelope of its parent', () => {
  const { as } = roles([{ role: 'reviewer', count: 1 }]);
  assert.equal(as('reviewer', 'write_file', { path: 'src/a.ts' }), 'allow default.local');
});

test('before: the rights of a role are a word of the list, and the areas of two roles do not meet', () => {
  const errors = (executors: unknown[]) => validateManifest({ ...(manifests.get('review') as object), model: { level: 'medium', executors } }).map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'read' }, { role: 'b', count: 1, rights: 'write', area: ['src/b/**'] }, { role: 'c', count: 1, rights: 'write' }]), []);
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'all' }]), ['not_in_list model.executors[0].rights']);
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'read', area: ['src/**'] }, { role: 'b', count: 1, area: ['src/**'] }]), ['not_allowed model.executors[0].area', 'not_allowed model.executors[1].area']);
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'write', area: ['/x', '../y', 7] }]), ['bad_name model.executors[0].area[0]', 'bad_name model.executors[0].area[1]', 'bad_name model.executors[0].area[2]']);
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'write', area: [] }]), ['empty model.executors[0].area']);
  // Two areas meet when one lies in the other, or when a pattern has no fixed start.
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'write', area: ['src/**'] }, { role: 'b', count: 1, rights: 'write', area: ['src/b/**'] }]), ['duplicate model.executors[1].area']);
  assert.deepEqual(errors([{ role: 'a', count: 1, rights: 'write', area: ['**/*.ts'] }, { role: 'b', count: 1, rights: 'write', area: ['docs/**'] }]), ['duplicate model.executors[1].area']);
  // One role with a count of two shares its area: its executors can meet.
  assert.deepEqual(errors([{ role: 'a', count: 2, rights: 'write', area: ['src/**'] }]), ['not_allowed model.executors[0].count']);
});

// ---- A write that another human sees, outside a task.

test('before: a write that another human sees, outside the envelope of a task, asks under its own rule', () => {
  const b = box();
  const r = beforeAction(b.rt, { ...call(b, 'chat__send', { channel: 'ops' }), session: 's1' }, CLIENT);
  assert.deepEqual([r.outcome, r.rule], ['ask', 'default.outward-write']);
  const plain = beforeAction(b.rt, { ...call(b, 'tracker__add_comment', { change: '7' }), session: 's1' }, CLIENT);
  assert.deepEqual([plain.outcome, plain.rule], ['ask', 'default.write']);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

// ---- A task works with the merge of the packs that it started with.

test('before: a change of a pack during a task does not reach the task', () => {
  const b = box();
  const old = { id: 'org.old', outcome: 'deny' as const, command: 'old-word', level: 'organization' as const };
  const added = { id: 'org.new', outcome: 'deny' as const, command: 'new-word', level: 'organization' as const };
  const start: Runtime = { ...b.rt, merged: { ...b.rt.merged, rules: [old], gate: { ...b.rt.merged.gate, markers: ['kept-marker'] } } };
  const opened = openScenario(start, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  // The packs changed: the table of the tools is empty, the old rule is gone, a new rule refuses, the limit is lower.
  const changed: Runtime = { ...b.rt, merged: { ...b.rt.merged, tools: {}, rules: [added], gate: { ...b.rt.merged.gate, markers: ['new-marker'] }, context: { ...b.rt.merged.context, envs: [], maxTokens: 1 } } };
  const as = (session: string, tool: string, input: Record<string, unknown> = { id: '1', change: '7' }) => {
    const r = beforeAction(changed, { ...call(b, tool, input), session }, CLIENT);
    return `${r.outcome} ${r.rule}`;
  };
  // The session of the task decides with the table that the task started with.
  assert.equal(as('s1', 'tracker__get_item'), 'allow default.read');
  // A session without the task works with the packs as they are now.
  assert.equal(as('s2', 'tracker__get_item'), 'ask default.unknown-tool');
  // A rule that the task started with stays for it; a rule that came later acts at once: a barrier only grows.
  assert.equal(as('s1', 'shell', { command: 'echo old-word' }), 'deny org.old');
  assert.equal(as('s1', 'shell', { command: 'echo new-word' }), 'deny org.new');
  assert.equal(as('s2', 'shell', { command: 'echo old-word' }), 'allow default.shell');
  const seen = frozenRuntime(changed, opened.task.id).merged;
  assert.deepEqual(seen.gate.markers, ['kept-marker', 'new-marker']);
  assert.deepEqual(seen.context.envs, b.rt.merged.context.envs);
  // The limit of tokens of the packs is the one of the start.
  assert.equal(tokenLimit(changed, opened.task.id), b.rt.merged.context.maxTokens);
  assert.notEqual(b.rt.merged.context.maxTokens, 1);
  // The end of the task ends its merge.
  const stopped = applyEvent(changed, opened.task.id, { type: 'human', decision: 'stop' }, 'human');
  assert.ok('task' in stopped);
  assert.equal(as('s1', 'tracker__get_item'), 'ask default.unknown-tool');
  assert.equal(as('s1', 'shell', { command: 'echo old-word' }), 'allow default.shell');
});

// ---- A read through a connector: the limit of a task, and the source of the output.

test('before: the reads of a task through connectors have a limit of the packs; past it the human decides', () => {
  const b = box();
  const rt: Runtime = { ...b.rt, merged: { ...b.rt.merged, context: { ...b.rt.merged.context, maxReads: 2 } } };
  const read = (tool: string, session = 's1') => {
    const r = beforeAction(rt, { ...call(b, tool, { id: '1', path: 'src/a.ts' }), session }, CLIENT);
    return `${r.outcome} ${r.rule}`;
  };
  const opened = openScenario(rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  assert.deepEqual([read('wiki__get_page'), read('wiki__get_page')], ['allow default.read', 'allow default.read']);
  // A read of the client itself and a read that names no connector are not counted.
  assert.deepEqual([read('read_file'), read('tracker__get_item')], ['allow default.read', 'allow default.read']);
  assert.deepEqual([read('wiki__get_page'), read('wiki__get_page')], ['ask default.read-limit', 'ask default.read-limit']);
  assert.equal(loadTask(rt, opened.task.id)?.reads, 2);
  // The limit is of one task: another session has its own count.
  assert.equal(read('wiki__get_page', 's2'), 'allow default.read');
  // Without the limit nothing is counted.
  const free = box();
  for (let i = 0; i < 5; i += 1) assert.equal(beforeAction(free.rt, { ...call(free, 'wiki__get_page', {}), session: 's1' }, CLIENT).outcome, 'allow');
  for (const row of readJournal(rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

test('before: after a read through a connector the client learns the source of the output', () => {
  const b = box();
  const after = (tool: string, failed = false) => afterAction(b.rt, { ...call(b, tool, { id: '1' }), session: 's1' }, CLIENT, true, failed).source;
  assert.equal(after('wiki__get_page'), 'tracker');
  assert.equal(after('tracker__get_item'), undefined, 'a read that names no connector');
  assert.equal(after('read_file'), undefined);
  assert.equal(after('tracker__add_comment'), undefined, 'a write');
  assert.equal(after('wiki__get_page', true), undefined, 'a tool that failed gave no output of the source');
});

test('before: the limit of reads is a positive number of a pack', () => {
  const settings = (reads: unknown) => validateSettings({ pack: 1, level: 'organization', name: 'acme', limits: { reads } }, 'organization');
  assert.deepEqual(settings(50).errors, []);
  assert.equal(settings(50).settings?.limits?.reads, 50);
  assert.deepEqual(settings(0).errors.map((e) => `${e.code} ${e.path}`), ['not_positive limits.reads']);
});

// ---- A free task grows by facts: past a number of changes the harness offers a contract.

test('before: a free task that made the number of changes of the packs gets one offer of a contract', () => {
  const b = box();
  const rt: Runtime = { ...b.rt, merged: { ...b.rt.merged, context: { ...b.rt.merged.context, maxFreeChanges: 3 } } };
  const after = (tool: string, input: Record<string, unknown>, session = 's1', failed = false) => afterAction(rt, { ...call(b, tool, input), session }, CLIENT, true, failed).offer;
  const id = humanRequest(rt, { session: 's1', cwd: b.cwd }).task;
  // A read, a command that changes nothing and a change that failed are not changes.
  assert.deepEqual([after('read_file', { path: 'src/a.ts' }), after('shell', { command: 'cat src/a.ts' }), after('write_file', { path: 'src/a.ts' }, 's1', true)], [undefined, undefined, undefined]);
  assert.deepEqual([after('write_file', { path: 'src/a.ts' }), after('shell', { command: 'echo x > src/b.ts' })], [undefined, undefined]);
  // The third change reaches the number: the offer comes once, and the work goes on.
  assert.equal(after('tracker__add_comment', { change: '7' }), 'contract');
  assert.equal(after('write_file', { path: 'src/a.ts' }), undefined);
  assert.deepEqual([loadTask(rt, id)?.changes, loadTask(rt, id)?.offered, loadTask(rt, id)?.state], [4, true, 'executing']);
  // The offer is a fact of the journal, written once.
  const offers = readJournal(rt.journal.file).filter((x) => x.kind === 'task.kind_decided' && x.data?.offer === 'contract');
  assert.deepEqual(offers.map((x) => [x.task, x.data?.kind, x.data?.reason, x.data?.changes]), [[id, 'free', 'facts', 3]]);
  for (const row of readJournal(rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
  // A command that names no file but changes the history or an outer system is a change too.
  const other = box();
  const ort: Runtime = { ...other.rt, merged: { ...other.rt.merged, context: { ...other.rt.merged.context, maxFreeChanges: 2 } } };
  humanRequest(ort, { session: 's1', cwd: other.cwd });
  const run = (command: string) => afterAction(ort, { ...call(other, 'shell', { command }), session: 's1' }, CLIENT).offer;
  assert.deepEqual([run('git status'), run('git commit -am x'), run('git push origin main')], [undefined, undefined, 'contract']);
  // A task of a scenario gets no offer: it has its manifest.
  const opened = openScenario(rt, 'change-review', { change_id: '7' }, { session: 's2' });
  assert.ok(opened.ok);
  for (let i = 0; i < 5; i += 1) assert.equal(after('write_file', { path: 'src/a.ts' }, 's2'), undefined);
  // Without the number of the packs nothing is counted.
  const plain = box();
  humanRequest(plain.rt, { session: 's1', cwd: plain.cwd });
  for (let i = 0; i < 5; i += 1) assert.equal(afterAction(plain.rt, { ...call(plain, 'write_file', { path: 'src/a.ts' }), session: 's1' }, CLIENT).offer, undefined);
});

// ---- A marker of the production environment in the input of a tool.

test('before: a write of a tool whose input names a production marker is a production write, whatever its row says', () => {
  const b = box();
  const rt: Runtime = { ...b.rt, gateConfig: { markers: ['prod', 'live'] } };
  open({ ...b, rt });
  const write = (input: Record<string, unknown>, runtime: Runtime = rt) => {
    const r = beforeAction(runtime, call(b, 'tracker__add_comment', input), CLIENT);
    return [r.outcome, r.rule, r.envelope];
  };
  // The row of the tool says "work": the envelope of the task covers the write after one confirmation.
  assert.deepEqual(write({ change: '7' }), ['ask', 'default.write', 'confirm']);
  // A name in the input is a marker: the write goes to production, and the envelope does not cover it.
  assert.deepEqual(write({ change: '7', cluster: 'prod-eu' }), ['ask', 'default.write', 'production']);
  assert.deepEqual(write({ change: '7', where: { hosts: ['db.live.example.com'] } }), ['ask', 'default.write', 'production']);
  // A text of the human is not a name: the word in a sentence marks nothing.
  assert.deepEqual(write({ change: '7', body: 'the fix goes to prod next week' }), ['ask', 'default.write', 'confirm']);
  assert.deepEqual(write({ change: '7', cluster: 'product-eu' }), ['ask', 'default.write', 'confirm']);
  // A space at the edge of a name hides nothing; an input too large or too deep to read counts as production.
  assert.deepEqual(write({ change: '7', cluster: 'prod-eu\n' }), ['ask', 'default.write', 'production']);
  assert.deepEqual(write({ change: '7', pad: Array.from({ length: 300 }, (_, i) => `v${i}`), cluster: 'prod-eu' }), ['ask', 'default.write', 'production']);
  assert.deepEqual(write({ change: '7', a: { b: { c: { d: { e: { cluster: 'prod-eu' } } } } } }), ['ask', 'default.write', 'production']);
  // Without markers nothing changes.
  assert.deepEqual(write({ change: '7', cluster: 'prod-eu' }, { ...b.rt, gateConfig: { markers: [] } }), ['ask', 'default.write', 'confirm']);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

// ---- The reads of a scenario are the reads that its manifest names.

test('before: a task of a scenario that reads through a connector outside its manifest asks the human', () => {
  const b = box();
  const narrow: Runtime = { ...b.rt, merged: { ...b.rt.merged, scenarios: b.rt.merged.scenarios.map((s) => (s.name === 'change-review' ? { ...s, manifest: { ...s.manifest, permissions: { ...s.manifest.permissions, read: ['code-host'] } } } : s)) } };
  const read = (tool: string, session: string, rt: Runtime = narrow) => {
    const r = beforeAction(rt, { ...call(b, tool, { id: '1', path: 'src/a.ts' }), session }, CLIENT);
    return `${r.outcome} ${r.rule}`;
  };
  const opened = openScenario(narrow, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  // The manifest names "code-host"; the tool reads through "tracker".
  assert.equal(read('wiki__get_page', 's1'), 'ask scenario.read-scope');
  // A read of the client itself and a read that names no connector are not a matter of the manifest.
  assert.deepEqual([read('read_file', 's1'), read('tracker__get_item', 's1')], ['allow default.read', 'allow default.read']);
  // A session without the task reads as before; the task does not stop, as a contract does.
  assert.equal(read('wiki__get_page', 's2'), 'allow default.read');
  assert.equal(loadTask(narrow, opened.task.id)?.state, 'executing');
  // A manifest that names the connector lets the read pass.
  const wide = box();
  const ok = openScenario(wide.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(ok.ok);
  const passed = beforeAction(wide.rt, { ...call(wide, 'wiki__get_page', {}), session: 's1' }, CLIENT);
  assert.deepEqual([passed.outcome, passed.rule], ['allow', 'default.read']);
  // The "yes" of the human holds for the task and the connector: the next read of that kind does not ask.
  afterAction(narrow, { ...call(b, 'wiki__get_page', { id: '1', path: 'src/a.ts' }), session: 's1' }, CLIENT);
  assert.deepEqual(loadTask(narrow, opened.task.id)?.extraReads, ['tracker']);
  assert.equal(read('wiki__get_page', 's1'), 'allow default.read');
  // A question that the human did not see (a mode of the client without questions) is no "yes".
  const unseen = box();
  const un: Runtime = { ...unseen.rt, merged: { ...unseen.rt.merged, scenarios: narrow.merged.scenarios } };
  const second = openScenario(un, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(second.ok);
  const again = { ...call(unseen, 'wiki__get_page', {}), session: 's1' };
  assert.equal(beforeAction(un, again, CLIENT).rule, 'scenario.read-scope');
  afterAction(un, again, CLIENT, false);
  assert.equal(loadTask(un, second.task.id)?.extraReads, undefined);
  for (const rt of [b.rt, wide.rt, unseen.rt]) for (const row of readJournal(rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

test('before: an approval from the queue lets the task of a scenario read through that connector, as the "yes" in a window does', () => {
  const b = box();
  const narrow: Runtime = { ...b.rt, merged: { ...b.rt.merged, scenarios: b.rt.merged.scenarios.map((s) => (s.name === 'change-review' ? { ...s, manifest: { ...s.manifest, permissions: { ...s.manifest.permissions, read: ['code-host'] } } } : s)) } };
  const opened = openScenario(narrow, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  // A client without a window: the question waits in the queue of the human.
  const read = (id: string) => beforeAction(narrow, { ...call(b, 'wiki__get_page', { id }), session: 's1', headless: true }, CLIENT);
  const first = read('1');
  assert.deepEqual([first.outcome, first.rule], ['defer', 'scenario.read-scope']);
  resolveQueued(narrow, first.queued ?? '', 'approved');
  assert.equal(read('1').rule, 'queue.approved');
  // The answer holds for the task and the connector: a read of another page does not wait again.
  assert.deepEqual(loadTask(narrow, opened.task.id)?.extraReads, ['tracker']);
  const next = read('2');
  assert.deepEqual([next.outcome, next.rule], ['allow', 'default.read']);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

test('before: the basis of a decision that a pack gave names the level of the pack', () => {
  const b = box();
  const rule = { id: 'org.no-word', outcome: 'deny' as const, command: 'forbidden-word', level: 'organization' as const };
  const rt: Runtime = { ...b.rt, merged: { ...b.rt.merged, rules: [rule] } };
  assert.equal(beforeAction(rt, call(b, 'shell', { command: 'echo forbidden-word' }), CLIENT).rule, 'org.no-word');
  beforeAction(rt, call(b, 'shell', { command: 'ls' }), CLIENT);
  const bases = readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.basis');
  assert.deepEqual(bases.map((r) => [r.data?.rule, r.pack]), [['org.no-word', 'organization'], ['default.shell', undefined]]);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});

test('before: a read tool with an environment in its row is written with that environment, and a rule of a pack about the environment sees it', () => {
  const b = box();
  const envOf = (tool: string): unknown => {
    const out = beforeAction(b.rt, { ...call(b, tool, {}), session: 's1' }, CLIENT);
    assert.equal(out.outcome, 'allow');
    return readJournal(b.rt.journal.file).filter((r) => r.kind === 'policy.decision').at(-1)?.data?.env;
  };
  assert.equal(envOf('live__get_note'), 'live');
  // A row without the field reads as before.
  assert.equal(envOf('tracker__get_note'), 'local');
  b.rt.merged.rules.push({ id: 'live-read', outcome: 'ask', env: 'live', level: 'organization' });
  const asked = beforeAction(b.rt, { ...call(b, 'live__get_note', {}), session: 's1' }, CLIENT);
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'live-read']);
  assert.equal(beforeAction(b.rt, { ...call(b, 'tracker__get_note', {}), session: 's1' }, CLIENT).outcome, 'allow');
});

test('before: a command of the human asks where it runs, not where a text names it', () => {
  const b = box();
  const run = (command: string) => beforeAction(b.rt, call(b, 'shell', { command }), CLIENT);
  // The text names the command and does not run it: a search, a document, a message, an argument of another command.
  for (const command of [
    'grep -n "reins stop" docs/contracts.md',
    'rg -n \'reins memory decide|reins craft accept\' docs | head',
    'echo "the human runs reins stop t000000000000"',
    'cat > /tmp/note.md <<EOF\nThe owner writes the decision with `reins memory decide`.\nreins stop t000000000000\nEOF',
    'python3 - <<\'EOF\'\ns = open("/tmp/a.md").read()\nopen("/tmp/a.md", "w").write(s.replace("x", "run `reins tick run` by a timer"))\nEOF',
    'git commit -qm "the summary names reins dispute and reins pause"',
    'reins memory add pitfall \'reins memory wrong takes no decision\' task=t000000000000',
    'printf "%s\\n" "reins queue approve q1"',
  ]) assert.equal(run(command).outcome, 'allow', command);
  // A decision of the human that the parse shows is refused. A start of a client asks. So does a
  // guess: a word in a variable, a text inside a heredoc, a pipe, a program that runs its words, code of an interpreter.
  const want = (command: string): string => (/reins run |tick run|\$verb|<<EOF|\| sh|find \.|python3 -c|node -e/.test(command) ? 'ask' : 'deny');
  // The command runs: at the start, after an operator, in a group, in a loop, behind a wrapper, with a path, with a setting before it.
  for (const command of [
    'cd /tmp && (time REINS_CONFIG=/tmp/c.json reins run change-review repo=/tmp/r) 2>&1 | cut -c1-200',
    'for t in t000000000001 t000000000002; do reins stop $t; done',
    'if true; then reins craft accept c0123456789; fi',
    'echo t000000000000 | xargs reins stop',
    'x=$(reins memory decide "one cache" because="two went out of step")',
    '/usr/local/bin/reins queue approve q0123456789',
    'node --experimental-strip-types /x/src/cli.ts tick run',
    'env A=1 reins memory   veto m0123456789',
    'echo "done: `reins pause 5`"',
  ]) {
    const r = run(command);
    assert.deepEqual([r.outcome, r.rule], [want(command), 'protect.human-command'], command);
  }
  // The client cannot see what runs: a name of the program or of the command in a variable, a shell that
  // reads its commands, a program that runs its words as a command, code that starts a process.
  for (const command of [
    'R=reins; $R stop t000000000000',
    'reins $verb t000000000000',
    'reins memory $verb m0123456789',
    'bash <<EOF\nreins stop t000000000000\nEOF',
    'echo "reins stop t000000000000" | sh',
    'bash -c "reins stop t000000000000"',
    'eval "reins stop t000000000000"',
    'find . -name x -exec reins stop t000000000000 \;',
    'watch -n 5 reins tick run',
    'python3 -c "import subprocess; subprocess.run(\'reins stop t000000000000\', shell=True)"',
    'node -e "require(\'child_process\').execSync(\'reins memory end m0123456789\')"',
  ]) {
    const r = run(command);
    assert.deepEqual([r.outcome, r.rule], [want(command), 'protect.human-command'], command);
  }
  // A command of the agent stays one: the word after the program decides, not a word further in the line.
  for (const command of ['reins memory find stop', 'reins input t000000000000; echo run', 'reins check t000000000000 - < /tmp/report.txt']) assert.equal(run(command).outcome, 'allow', command);
});

test('before: a manifest with `permissions.harness` lets the task change the code of the harness without a question, but not the code of the barrier', () => {
  const b = box();
  const h = path.join(b.root, 'harness');
  const far = path.join(b.root, 'far');
  for (const d of ['src/memory', 'src/client', 'src/gate', 'src/contracts', 'src/core', 'test', 'docs', 'clients/x/hooks', 'tools']) fs.mkdirSync(path.join(h, d), { recursive: true });
  fs.mkdirSync(far);
  b.rt.harnessDirs = [h];
  const scenario = b.rt.merged.scenarios.find((s) => s.name === 'change-review');
  assert.ok(scenario !== undefined);
  // The scenario gets one more input: the directory of the work.
  scenario.manifest.trigger.inputs = [...(scenario.manifest.trigger.inputs ?? []), { name: 'repo', type: 'string' }];
  // Whether the answer is the question about the code of the harness.
  const asks = (r: { outcome: string; rule?: string }): boolean => r.outcome === 'ask' && r.rule === 'protect.harness';
  const edit = (session: string, rel: string): boolean => asks(beforeAction(b.rt, { ...call(b, 'write_file', { path: path.join(h, rel) }), session }, CLIENT));
  const shell = (session: string, command: string, cwd = b.cwd): boolean => asks(beforeAction(b.rt, { ...call(b, 'shell', { command }), cwd, session }, CLIENT));
  const OPEN = ['src/memory/store.ts', 'src/cli.ts', 'test/a.test.ts', 'docs/contracts.md'];
  const CLOSED = ['src/client/before.ts', 'src/gate/gate.cjs', 'src/contracts/policy.ts', 'src/core/task.ts', 'clients/x/hooks/run.ts', 'package.json', 'tools/x.py', 'src', 'README.md'];

  // The manifest has no key: a task with the directory of the harness in its input changes nothing.
  const plain = openScenario(b.rt, 'change-review', { change_id: '7', repo: h }, { session: 's0' });
  assert.ok(plain.ok);
  for (const rel of [...OPEN, ...CLOSED]) assert.equal(edit('s0', rel), true, rel);
  assert.ok('task' in applyEvent(b.rt, plain.task.id, { type: 'human', decision: 'stop' }, 'human'));

  // The key names the input that holds the directory. The command that opens such a task for the
  // harness is the one question of the human; for another directory it is none.
  scenario.manifest.permissions.harness = 'repo';
  for (const command of [`reins open change-review change_id=7 repo=${h}`, `cd /tmp && node /x/src/cli.ts open change-review "repo=${h}/" change_id=7`, 'reins open change-review change_id=7 repo=$R', 'reins open change-review change_id=7 repo=harness', `reins open $name repo=${far}/../harness`, `reins match ${h}`, 'reins match $R']) {
    assert.equal(shell('s9', command), true, command);
  }
  for (const command of [`reins open change-review change_id=7 repo=${far}`, 'reins open change-review change_id=7', 'reins open other-name change_id=7', 'reins input t000000000000', `reins match ${far}`]) assert.equal(shell('s9', command), false, command);

  // The task is open: the session that holds it changes the tests, the documents and the code, but not the code of the barrier.
  const opened = openScenario(b.rt, 'change-review', { change_id: '7', repo: h }, { session: 's1' });
  assert.ok(opened.ok);
  for (const rel of OPEN) assert.equal(edit('s1', rel), false, rel);
  for (const rel of CLOSED) assert.equal(edit('s1', rel), true, rel);
  // The same holds for a command: a place that the parse sees, and a place that only the text names.
  for (const command of [`echo x > ${h}/src/memory/a.ts`, `rm -rf ${h}/docs/old`, `cd ${h} && npm test 2>&1 | tail -5`, `cd ${h} && python3 - <<'EOF'\nopen('src/memory/store.ts', 'w').write('x')\nEOF`]) assert.equal(shell('s1', command), false, command);
  for (const command of [
    `echo x > ${h}/src/client/a.ts`, `rm -rf ${h}/src`, `rm -rf ${h}`, `echo x > ${h}/package.json`,
    `cd ${h} && python3 - <<'EOF'\nopen('src/client/before.ts', 'w').write('x')\nEOF`,
    `cd ${h} && sed -i '' 's/a/b/' clients/x/hooks/run.ts`,
    `cd ${h} && git add -A && git commit -qm x`,
    `cd ${h} && python3 - <<'EOF'\nopen('.hidden/settings.json', 'w').write('{}')\nEOF`,
    `cd ${h} && node -e "require('fs').writeFileSync('package.json', '{}')"`,
  ]) assert.equal(shell('s1', command), true, command);
  // The open of one more such task is a question again, also for the session that holds one.
  assert.equal(shell('s1', `reins open change-review change_id=7 repo=${h}`), true);
  // Another session holds no such task: every change asks.
  for (const rel of OPEN) assert.equal(edit('s2', rel), true, rel);
  // A task for another directory lets nothing of the harness pass.
  const other = openScenario(b.rt, 'change-review', { change_id: '7', repo: far }, { session: 's3' });
  assert.ok(other.ok);
  for (const rel of OPEN) assert.equal(edit('s3', rel), true, rel);
  // The state, the memory and the packs keep their own answers inside the task.
  const state = beforeAction(b.rt, { ...call(b, 'write_file', { path: '$STATE/pause.json' }), session: 's1' }, CLIENT);
  assert.deepEqual([state.outcome, state.rule], ['deny', 'protect.state']);
  const pack = beforeAction(b.rt, { ...call(b, 'write_file', { path: '$PACKS/person/pack.json' }), session: 's1' }, CLIENT);
  assert.deepEqual([pack.outcome, pack.rule], ['ask', 'protect.packs']);
  // The task is closed: the question is back.
  assert.ok('task' in applyEvent(b.rt, opened.task.id, { type: 'human', decision: 'stop' }, 'human'));
  for (const rel of OPEN) assert.equal(edit('s1', rel), true, rel);
});

test('before: the question about a write that another human sees says whether a check of the claims of a text passed in the session', () => {
  const b = box();
  const send = (session: string) => beforeAction(b.rt, { ...call(b, 'chat__send', { channel: 'ops' }), session }, CLIENT);
  // No task of a scenario in the session: nothing was checked.
  const none = send('s1');
  assert.deepEqual([none.outcome, none.rule, none.checked], ['ask', 'default.outward-write', undefined]);
  // A task whose done check is the check of citations is open: it has not passed yet.
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  assert.equal(send('s1').checked, undefined);
  // The check passed and the task is closed: the question names the task and its scenario.
  const done = submitReport(b.rt, id, JSON.stringify({ items: [] }));
  assert.ok('step' in done && done.step.task.state === 'publishing');
  const finished = applyEvent(b.rt, id, { type: 'finish' }, 'agent');
  assert.ok('task' in finished && finished.task.state === 'closed' && finished.task.label !== 'not_verified');
  const after = send('s1');
  assert.deepEqual([after.outcome, after.rule, after.checked], ['ask', 'default.outward-write', { task: id, scenario: 'change-review' }]);
  // The question of another rule carries no such mark.
  assert.equal(beforeAction(b.rt, { ...call(b, 'tracker__add_comment', { change: '9' }), session: 's1' }, CLIENT).checked, undefined);
  // Another session checked nothing.
  assert.equal(send('s2').checked, undefined);
  // A task that the human stopped passed no check.
  const stopped = openScenario(b.rt, 'change-review', { change_id: '8' }, { session: 's3' });
  assert.ok(stopped.ok);
  assert.ok('task' in applyEvent(b.rt, stopped.task.id, { type: 'human', decision: 'stop' }, 'human'));
  assert.equal(send('s3').checked, undefined);
  // A scenario whose done check is not the check of citations checks no claims of a text.
  const scenario = b.rt.merged.scenarios.find((x) => x.name === 'change-review');
  assert.ok(scenario !== undefined);
  scenario.manifest.done = { kind: 'human', retries: 0 };
  assert.equal(send('s1').checked, undefined);
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), [], row.kind);
});
