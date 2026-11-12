// A scenario without a window: one command opens the task and starts a client for it, and the
// schedule does the same for the tasks that it opens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal } from '../src/journal/writer.ts';
import { beforeAction } from '../src/client/before.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: Record<string, any> }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};

type Box = { root: string; cwd: string; config: string; log: string; run: (args: string[], env?: Record<string, string>) => { code: number | null; json: any } };
let n = 0;
// `runner`: the body of a script that stands for a client; null: the config names no runner.
function box(runner: string | null, minimal: Record<string, unknown> = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    else if (value === '$manifest:minimal') fs.writeFileSync(file, JSON.stringify({ ...manifests.get('minimal'), ...minimal }));
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const log = path.join(root, 'runner.log');
  const script = path.join(root, 'client.cjs');
  if (runner !== null) fs.writeFileSync(script, `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), headless: process.env.REINS_HEADLESS, cwd: process.cwd() }) + '\\n');\n${runner}\n`);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: path.join(root, 'state'), ...(runner !== null ? { runner: [process.execPath, script, '{task}', '{prompt}'] } : {}) }));
  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH ?? '', HOME: root, REINS_CONFIG: config, ...env } });
    return { code: p.status, json: JSON.parse(p.stdout) };
  };
  return { root, cwd, config, log, run };
}
const calls = (b: Box) => fs.readFileSync(b.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('run: one command opens a task and starts the client of the machine for it, without a window', () => {
  const b = box('');
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ok, r.json.ran, r.json.exit, r.json.state], [true, true, 0, 'executing']);
  const [call] = calls(b);
  assert.equal(call.headless, '1');
  assert.equal(call.cwd, b.cwd);
  assert.equal(call.args[0], r.json.task);
  assert.match(call.args[1], new RegExp(`reins input ${r.json.task}`));
});

test('run: the answer says how the client ended and where the task is', () => {
  const failed = box('process.exit(3);');
  const r = failed.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ran, r.json.exit], [true, 3]);
  assert.equal(r.code, 2, 'a task that is not closed as verified');
});

test('run: the runner gets the model of the level of the task', () => {
  const b = box('');
  const config = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  const [node, script] = config.runner;
  fs.writeFileSync(b.config, JSON.stringify({ ...config, runner: [node, script, '{task}', '--model', '{model}', 'x-{model}-y'] }));
  // No pack names a model for the level "weak" of this scenario: nothing starts with a wrong model.
  const none = b.run(['run', 'draft-message']);
  assert.deepEqual([none.json.ok, none.json.ran, none.json.error, none.code], [true, false, 'no_model', 2]);
  assert.equal(fs.existsSync(b.log), false);
  // The organization pack names the models of the client for the levels.
  const file = path.join(b.root, 'packs', 'organization', 'pack.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), models: { weak: 'small-model', strong: 'big-model' } }));
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ran, r.json.exit], [true, 0]);
  assert.deepEqual(calls(b)[0].args, [r.json.task, '--model', 'small-model', 'x-small-model-y']);
  // A name of a model is a name: a pack cannot put a flag into the command line of the client.
  for (const bad of ['--dangerously-skip-permissions', '-x', 'a b', '']) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), models: { weak: bad } }));
    const refused = b.run(['scenarios']).json;
    assert.equal(refused.not_connected?.[0]?.errors?.[0]?.path, 'models.weak', bad);
  }
  assert.equal(calls(b).length, 1, 'nothing more started');
});

test('run: without a runner in the config the task opens and nothing starts', () => {
  const b = box(null);
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ok, r.json.ran, r.json.error, typeof r.json.task], [true, false, 'no_runner', 'string']);
});

test('run: a client that runs without a window does not start another client', () => {
  const b = box('');
  const r = b.run(['run', 'draft-message'], { REINS_HEADLESS: '1' });
  assert.equal(r.json.error, 'nested_run');
  assert.equal(fs.existsSync(b.log), false);
});

test('run: the schedule starts the client for the tasks that it opens', () => {
  const b = box('', { trigger: { kind: 'schedule', value: 'every 1m' } });
  assert.deepEqual(b.run(['tick', 'run']).json.opened, [], 'the first look only notes the time');
  const state = path.join(b.root, 'state', 'triggers', 'draft-message.json');
  fs.writeFileSync(state, JSON.stringify({ last: new Date(Date.now() - 5 * 60_000).toISOString() }));
  const r = b.run(['tick', 'run']);
  assert.deepEqual(r.json.opened.map((t: any) => [t.scenario, t.ran, t.exit]), [['draft-message', true, 0]]);
  assert.equal(calls(b).length, 1);
  fs.writeFileSync(state, JSON.stringify({ last: new Date(Date.now() - 5 * 60_000).toISOString() }));
  assert.equal(b.run(['tick']).json.opened[0].ran, undefined, 'a plain tick starts nothing');
});

test('run: a bad runner in the config is a bad config, and the agent asks before it starts a client', () => {
  const b = box('');
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner: 'claude -p' }));
  assert.equal(b.run(['scenarios']).json.error, 'bad_config');
  const rt = { merged: loadPacks({}), stateDir: path.join(b.root, 'state'), journal: openJournal(path.join(b.root, 'state')), project: 'p1a2b3c4' };
  for (const command of ['reins run draft-message', 'reins tick run']) {
    const r = beforeAction(rt, { cwd: b.cwd, tool: 'shell', input: { command } }, { shell: { kind: 'shell', command: 'command' } });
    assert.deepEqual([r.outcome, r.rule], ['ask', 'protect.human-command'], command);
  }
  assert.equal(beforeAction(rt, { cwd: b.cwd, tool: 'shell', input: { command: 'reins tick' } }, { shell: { kind: 'shell', command: 'command' } }).outcome, 'allow');
});

// ---- Cases of the review.

test('run: a client that did not start is not a success of the command', () => {
  const none = box(null);
  assert.equal(none.run(['run', 'draft-message']).code, 2);
  const b = box('');
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner: ['/nonexistent/client'] }));
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ran, r.json.error, r.code], [false, 'start_failed', 2]);
});

test('run: a client that runs past its time limit is stopped', () => {
  const b = box('setTimeout(() => {}, 60000);');
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_timeout_s: 1 }));
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ran, r.json.error, r.code], [false, 'timeout', 2]);
});

test('run: the time limit stops the processes that the client started, too', () => {
  const b = box('');
  const pidFile = path.join(b.root, 'child.pid');
  // The client starts a process of its own and waits: both run past the limit.
  const script = JSON.parse(fs.readFileSync(b.config, 'utf8')).runner[1];
  fs.appendFileSync(script, `const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\nsetTimeout(() => {}, 60000);\n`);
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_timeout_s: 2 }));
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ran, r.json.error, r.code], [false, 'timeout', 2]);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      spawnSync('sleep', ['0.1']);
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(pid, 'SIGKILL');
  assert.equal(alive, false, 'the process of the client is gone');
});

test('run: a client that ends by itself leaves no process behind, and a very long limit is no limit of zero', () => {
  const b = box('');
  const pidFile = path.join(b.root, 'child.pid');
  const script = JSON.parse(fs.readFileSync(b.config, 'utf8')).runner[1];
  fs.appendFileSync(script, `const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nchild.unref();\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n`);
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_timeout_s: 9_000_000 }));
  const r = b.run(['run', 'draft-message']);
  assert.deepEqual([r.json.ran, r.json.exit], [true, 0]);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      spawnSync('sleep', ['0.1']);
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(pid, 'SIGKILL');
  assert.equal(alive, false, 'the process of the client is gone');
});

test('run: the client does not stay behind a harness that was stopped or that died', () => {
  const GROUP = fileURLToPath(new URL('../src/client/group.cjs', import.meta.url));
  const gone = (pid: number): boolean => {
    for (let i = 0; i < 80; i += 1) {
      try {
        process.kill(pid, 0);
        spawnSync('sleep', ['0.1']);
      } catch {
        return true;
      }
    }
    process.kill(pid, 'SIGKILL');
    return false;
  };
  const started = (file: string): number => {
    for (let i = 0; i < 80 && !fs.existsSync(file); i += 1) spawnSync('sleep', ['0.1']);
    return Number(fs.readFileSync(file, 'utf8'));
  };
  const b = box('');
  const client = (file: string): string => JSON.stringify({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setTimeout(() => {}, 60000);`], timeoutMs: 60000 });
  // A signal to the program between: it stops the group of the client.
  const one = path.join(b.root, 'one.pid');
  const between = spawn(process.execPath, [GROUP, client(one)], { stdio: 'ignore' });
  const first = started(one);
  between.kill('SIGTERM');
  assert.equal(gone(first), true, 'the client is gone after a signal');
  // The harness dies with no signal to the program between: the program sees another parent.
  const two = path.join(b.root, 'two.pid');
  const harness = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, [${JSON.stringify(GROUP)}, ${JSON.stringify(client(two))}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`], { stdio: 'ignore' });
  const second = started(two);
  harness.kill('SIGKILL');
  assert.equal(gone(second), true, 'the client is gone after the death of the harness');
});

test('run: the schedule without a window opens nothing, and a task that did not end as verified is not a success', () => {
  const b = box('', { trigger: { kind: 'schedule', value: 'every 1m' } });
  b.run(['tick']);
  const state = path.join(b.root, 'state', 'triggers', 'draft-message.json');
  const due = JSON.stringify({ last: new Date(Date.now() - 5 * 60_000).toISOString() });
  fs.writeFileSync(state, due);
  assert.equal(b.run(['tick', 'run'], { REINS_HEADLESS: '1' }).json.error, 'nested_run');
  assert.equal(fs.readFileSync(state, 'utf8'), due, 'the time of the schedule stays');
  const r = b.run(['tick', 'run']);
  assert.deepEqual([r.json.failed, r.code], [true, 2], 'the client ended, the task still executes');
});
