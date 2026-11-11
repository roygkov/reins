// The policy past its first cut: a shell command is parsed for the places that it touches, the
// packs carry rule data of the gate, and an action that a rule defers waits in a queue.
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
import { collectedDir, type Runtime } from '../src/core/runtime.ts';
import { sweep } from '../src/core/sweep.ts';
import { beforeAction, type ClientTools } from '../src/client/before.ts';
import { commandPlaces } from '../src/client/places.ts';
import { listQueue, resolveQueued } from '../src/core/queue.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const HOOK = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { shell: { kind: 'shell', command: 'command' }, write_file: { kind: 'local', path: 'path' } };
const TOOLS = { 'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' }, 'tracker__close': { kind: 'write', action: 'comment', target: 'close/{change}', env: 'work' } };

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(extra: Record<string, object> = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const level = rel.split('/')[0] ?? '';
    if (rel.endsWith('.sh')) fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel.endsWith('pack.json')) fs.writeFileSync(file, JSON.stringify({ ...(value as object), ...(level === 'organization' ? { tools: TOOLS } : {}), ...(extra[level] ?? {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'tasks'), { recursive: true });
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', configFile: config }, root, cwd, config };
}
const shell = (b: Box, command: string, cwd = b.cwd) => beforeAction(b.rt, { cwd, tool: 'shell', input: { command }, session: 's1' }, CLIENT);

// ---- The places of a shell command.

test('places: the words of a command become paths, from the directory where each part runs', () => {
  const places = commandPlaces('cd /a/b && echo x > out.txt; rm -rf ./c ../d | tee -a "e f.log"; cat g', '/start', '/home/u');
  assert.deepEqual(places, [
    { path: '/a/b/out.txt', write: true },
    { path: '/a/b/c', write: true }, { path: '/a/d', write: true },
    { path: '/a/b/e f.log', write: true },
    { path: '/a/b/g', write: false },
  ]);
});

test('places: the home directory, an option value and a command inside a shell are read', () => {
  assert.deepEqual(commandPlaces('cp a ~/x && dd if=in of=$HOME/y', '/w', '/home/u'), [
    { path: '/w/a', write: false }, { path: '/home/u/x', write: true }, { path: '/w/in', write: false }, { path: '/home/u/y', write: true },
  ]);
  assert.deepEqual(commandPlaces("bash -c 'cd sub && touch f'", '/w', '/home/u'), [{ path: '/w/sub/f', write: true }]);
  assert.deepEqual(commandPlaces('sed -n 1p f; sed -i s/a/b/ g', '/w', '/home/u'), [{ path: '/w/f', write: false }, { path: '/w/g', write: true }]);
});

test('shell: a write into the state of the harness is refused, however the path is written', () => {
  const b = box();
  const state = b.rt.stateDir;
  for (const [command, cwd] of [
    [`echo x > ${state}/tasks/t000000000000.json`, b.cwd],
    ['echo x > tasks/t000000000000.json', state],
    [`cd ${state} && rm -rf tasks`, b.cwd],
    [`cd ${b.root} && cd state && touch pause.json`, b.cwd],
    ['cp /tmp/x ../state/pause.json', b.cwd],
    [`bash -c 'cd ${state}; echo x >> journal.jsonl'`, b.cwd],
  ] as const) {
    const r = shell(b, command, cwd);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.state'], command);
  }
});

test('shell: a write into the config is refused, a write into a pack asks, a read of the state asks', () => {
  const b = box();
  assert.deepEqual([shell(b, 'cd .. && echo {} > config.json').outcome, shell(b, 'cd .. && echo {} > config.json').rule], ['deny', 'protect.config']);
  assert.deepEqual([shell(b, 'cd ../packs/person && rm pack.json').outcome, shell(b, 'cd ../packs/person && rm pack.json').rule], ['ask', 'protect.packs']);
  assert.deepEqual([shell(b, 'cd ../state && cat journal.jsonl').outcome, shell(b, 'cd ../state && cat journal.jsonl').rule], ['ask', 'protect.state']);
  assert.equal(shell(b, 'cd src && echo x > a.ts && cat a.ts').outcome, 'allow', 'a plain command in the work tree passes');
});

// ---- Rule data of the gate in the packs.

test('gate: a pack adds rule data of the gate, and a lower pack can only add', () => {
  const b = box({
    organization: { gate: { protected_branches: ['release-*'], forms: [{ id: 'no-wipe', pattern: 'wipe-everything', decision: 'deny' }] } },
    person: { gate: { protected_branches: ['my-branch'], markers: ['prod'] } },
  });
  assert.deepEqual(b.rt.merged.gate, { protected_branches: ['release-*', 'my-branch'], forms: [{ id: 'no-wipe', pattern: 'wipe-everything', decision: 'deny' }], markers: ['prod'] });
  const r = shell(b, 'wipe-everything now');
  assert.deepEqual([r.outcome, r.rule], ['deny', 'user.no-wipe']);
});

for (const [name, gate, errors] of [
  ['the rule data is an object of known lists', { hosts: ['x'] }, ['unknown_field gate.hosts']],
  ['a list holds plain one-line strings', { prod_hosts: ['ok', 7, 'two\nlines'] }, ['bad_name gate.prod_hosts[1]', 'bad_name gate.prod_hosts[2]']],
  ['a form has a pattern and a known decision', { forms: [{ id: 'x', decision: 'deny' }, { pattern: 'p', decision: 'allow' }] }, ['missing gate.forms[0].pattern', 'not_in_list gate.forms[1].decision']],
] as const) {
  test(`gate: pack: ${name}`, () => {
    assert.deepEqual(validateSettings({ pack: 1, level: 'person', name: 'me', gate }, 'person').errors.map((e) => `${e.code} ${e.path}`), [...errors]);
  });
}

// ---- The queue of deferred actions.

const DEFER = { person: { rules: [{ id: 'later', outcome: 'defer', tool: 'tracker__close' }] } };
const close = (b: Box, change = '7') => beforeAction(b.rt, { cwd: b.cwd, tool: 'tracker__close', input: { change }, session: 's1' }, CLIENT);

test('queue: an action that a rule defers is not done and waits in the queue', () => {
  const b = box(DEFER);
  const r = close(b);
  assert.deepEqual([r.outcome, r.rule], ['defer', 'later']);
  assert.match(r.queued ?? '', /^q[0-9a-f]{10}$/);
  const again = close(b);
  assert.equal(again.queued, r.queued, 'the same action waits once');
  assert.deepEqual(listQueue(b.rt).map((q) => [q.id, q.tool, q.state, q.rule]), [[r.queued, 'tracker__close', 'waiting', 'later']]);
  const rows = readJournal(b.rt.journal.file);
  for (const row of rows) assert.deepEqual(validateRow(row), []);
  assert.equal(rows.filter((x) => x.kind === 'policy.action_deferred').length, 1);
});

test('queue: the human approves a deferred action: the same call passes once', () => {
  const b = box(DEFER);
  const id = close(b).queued ?? '';
  assert.equal(resolveQueued(b.rt, id, 'approved'), true);
  const r = close(b);
  assert.deepEqual([r.outcome, r.rule], ['allow', 'queue.approved']);
  assert.equal(close(b).outcome, 'defer', 'the approval was for one call');
  assert.equal(close(b, '8').outcome, 'defer', 'another input is another action');
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'policy.deferred_resolved' && x.data?.state === 'approved'));
});

test('queue: the human rejects a deferred action: it leaves the queue and the call is deferred again', () => {
  const b = box(DEFER);
  const id = close(b).queued ?? '';
  assert.equal(resolveQueued(b.rt, id, 'rejected'), true);
  assert.deepEqual(listQueue(b.rt).filter((q) => q.state === 'waiting'), []);
  assert.equal(resolveQueued(b.rt, id, 'approved'), false);
  assert.notEqual(close(b).queued, id);
});

test('queue: the command line shows the queue, and its answers are commands of the human', () => {
  const b = box(DEFER);
  const id = close(b).queued ?? '';
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  assert.deepEqual(run(['queue']).queue.map((q: any) => [q.id, q.state]), [[id, 'waiting']]);
  assert.deepEqual(run(['queue', 'approve', id]), { ok: true, queued: id, state: 'approved' });
  assert.deepEqual(run(['queue', 'reject', 'q0000000000']).error, 'unknown_queued');
  const asked = shell(b, `reins queue approve ${id}`);
  assert.deepEqual([asked.outcome, asked.rule], ['ask', 'protect.human-command']);
});

test('queue: the Claude Code adapter refuses a deferred action and names its place in the queue', () => {
  const b = box(DEFER);
  const p = spawnSync(process.execPath, [HOOK, 'pre'], {
    input: JSON.stringify({ session_id: 's1', cwd: b.cwd, hook_event_name: 'PreToolUse', tool_name: 'tracker__close', tool_input: { change: '7' } }),
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config },
  });
  const out = JSON.parse(p.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /reins queue approve q[0-9a-f]{10}/);
});

test('shell: a removal of a directory above the state is refused, also through a pattern', () => {
  const b = box();
  for (const command of ['rm -rf ..', `rm -rf ${b.root}`, 'cd .. && rm -rf st*', `mv ${b.root}/state /tmp/gone`, `rm -rf ${b.root}/**`]) {
    const r = shell(b, command);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.state'], command);
  }
  assert.deepEqual([shell(b, 'cd .. && rm -rf st*').outcome, shell(b, 'cd .. && rm -rf st*').rule], ['deny', 'protect.state']);
  assert.deepEqual([shell(b, `mv ${b.root}/state /tmp/gone`).outcome, shell(b, `mv ${b.root}/state /tmp/gone`).rule], ['deny', 'protect.state']);
  assert.equal(shell(b, 'mv src/a.ts ..').outcome, 'allow', 'the last place of mv is where the files go');
});

// ---- Cases of the review.

test('places: a word with braces stands for every one of its forms, and `~name` is a home directory', () => {
  assert.deepEqual(commandPlaces('tee /r/{state,zz}/t.json', '/w', '/home/u'), [{ path: '/r/state/t.json', write: true }, { path: '/r/zz/t.json', write: true }]);
  assert.deepEqual(commandPlaces('touch ~u/x ~other/y', '/w', '/home/u'), [{ path: '/home/u/x', write: true }, { path: '/home/other/y', write: true }]);
});

test('places: a copy reads its sources and writes its target', () => {
  assert.deepEqual(commandPlaces('cp -r a b c', '/w', '/home/u'), [{ path: '/w/a', write: false }, { path: '/w/b', write: false }, { path: '/w/c', write: true }]);
  assert.deepEqual(commandPlaces('cp -t out a b', '/w', '/home/u'), [{ path: '/w/out', write: true }, { path: '/w/a', write: false }, { path: '/w/b', write: false }]);
  assert.deepEqual(commandPlaces('tar czf /tmp/m.tgz notes', '/w', '/home/u'), [{ path: '/tmp/m.tgz', write: true }, { path: '/w/notes', write: false }]);
  assert.deepEqual(commandPlaces('tar -xf a.tar -C out', '/w', '/home/u'), [{ path: '/w/a.tar', write: false }, { path: '/w/out', write: true }]);
  assert.deepEqual(commandPlaces("find ../state -name '*.json' -delete", '/w', '/home/u'), [{ path: '/state', write: true }]);
  assert.deepEqual(commandPlaces("find . -name '*.json'", '/w', '/home/u'), [{ path: '/w', write: false }]);
});

test('shell: braces and a removal by find do not get past the protection of the state, and a copy out of it asks', () => {
  const b = box();
  for (const command of [`tee ${b.root}/{state,zz}/tasks/t000000000000.json`, "find ../state -name '*.json' -delete", `find ${b.root} -exec rm {} +`]) {
    const r = shell(b, command);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.state'], command);
  }
  const copy = shell(b, `cp ${b.rt.stateDir}/journal.jsonl /tmp/bak`);
  assert.deepEqual([copy.outcome, copy.rule], ['ask', 'protect.state']);
});

test('queue: an approval is taken by one call only', () => {
  const b = box(DEFER);
  const id = close(b).queued ?? '';
  resolveQueued(b.rt, id, 'approved');
  assert.deepEqual([close(b).outcome, close(b).outcome], ['allow', 'defer']);
  assert.deepEqual(fs.readdirSync(path.join(b.rt.stateDir, 'queue')).filter((f) => f.endsWith('.taken')), []);
});

// ---- Cases of the second review.

test('shell: a copy of a directory onto the state is refused, an archive opened above the state asks', () => {
  const b = box();
  for (const command of [`cp -r /tmp/fake/state ${b.root}`, 'rsync -a /tmp/fake/state ..', `mv /tmp/fake/state ${b.root}`, 'chmod u+w .. && rm -rf ..']) {
    const r = shell(b, command);
    assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.state'], command);
  }
  for (const command of ['tar -xf evil.tar -C ..', 'rsync -a /tmp/fake/ ..', 'unzip evil.zip -d ..', 'cd .. && tar xf evil.tar']) {
    const r = shell(b, command);
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.state'], command);
  }
  assert.equal(shell(b, 'cp src/a.ts ..').outcome, 'allow');
});

test('shell: on a file system that ignores the case of letters, another case of the path is the same place', (t) => {
  const b = box();
  if (!fs.existsSync(b.rt.stateDir.toUpperCase())) return t.skip('the file system keeps the case of letters apart');
  const r = shell(b, 'echo x > ../STATE/pause.json');
  assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.state']);
});

// ---- Found in a live client.

test('shell: the copies of collected results lie outside the state: a read of them asks nothing, the state still asks', () => {
  const b = box();
  const dir = path.join(collectedDir(b.rt), 't0123456789ab');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diff.json'), '{}');
  assert.equal(path.relative(b.rt.stateDir, dir).startsWith('..'), true);
  for (const command of [`cat ${dir}/diff.json`, `sed -n 1,40p ${dir}/diff.json | head`, `python3 -c "print(len(open('${dir}/diff.json').read()))"`, `ls ${dir}`, `jq . ${dir}/diff.json > /dev/null`]) {
    assert.equal(shell(b, command).outcome, 'allow', command);
  }
  // Every way to name a place of the state asks or is refused, as before the copies moved.
  const task = path.join(b.rt.stateDir, 'tasks', 't000000000000.json');
  for (const command of [
    `cat ${task}`,
    `python3 -c "open('${task}','w').write('x')"`,
    `f=${task}; echo x > $f`,
    `mytool ${task}`,
    `grep -e. ${b.rt.stateDir}/tasks/'..'/journal.jsonl`,
    `xargs -a ${b.rt.stateDir}/journal.jsonl ls`,
    `find ${b.rt.stateDir}/tasks -maxdepth 0 -exec cp /tmp/x {}/t000000000000.json \\;`,
    `sort -o ${task} ${task}`,
    `cat ${dir}/../../state/journal.jsonl`,
  ]) {
    const r = shell(b, command);
    assert.deepEqual([r.outcome === 'allow', r.rule], [false, 'protect.state'], command);
  }
  assert.deepEqual([shell(b, `echo x > ${task}`).outcome, shell(b, `echo x > ${task}`).rule], ['deny', 'protect.state']);
});

test('shell: the sweep removes the copies of collected results that are a week old', () => {
  const b = box();
  const dir = path.join(collectedDir(b.rt), 't0123456789ab');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diff.json'), '{}');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  fs.mkdirSync(path.join(collectedDir(b.rt), 't0123456789ac'), { recursive: true });
  sweep(b.rt);
  assert.deepEqual(fs.readdirSync(collectedDir(b.rt)), ['t0123456789ac']);
});

test('shell: an answer of the command line about a proposal, a record or a queued action is a success', () => {
  const b = box({ person: { rules: [{ id: 'later', outcome: 'defer', tool: 'tracker__close' }] } });
  const id = close(b).queued ?? '';
  const p = spawnSync(process.execPath, [CLI, 'queue', 'approve', id], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  assert.deepEqual([JSON.parse(p.stdout).state, p.status], ['approved', 0]);
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: b.cwd, env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  run(['memory', 'add', 'pitfall', 'a note', 'task=t000000000000']);
  run(['memory', 'decide', 'we keep one cache', 'because=two caches went out of step']);
  const record = JSON.parse(run(['memory']).stdout).records[0].id;
  assert.deepEqual([JSON.parse(run(['memory', 'veto', record]).stdout).state, run(['memory', 'restore', record]).status], ['vetoed', 0]);
  assert.equal(run(['memory', 'veto', record]).status, 0);
});
