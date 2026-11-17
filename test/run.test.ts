// A scenario without a window: one command opens the task and starts a client for it, and the
// schedule does the same for the tasks that it opens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal } from '../src/journal/writer.ts';
import { beforeAction } from '../src/client/before.ts';
import { loadRuntime } from '../src/client/config.ts';
import { runTasks, worktreesDir } from '../src/client/run.ts';
import type { Runtime } from '../src/core/runtime.ts';
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
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: path.join(root, 'state'), human_channel: 'any', ...(runner !== null ? { runner: [process.execPath, script, '{task}', '{prompt}'] } : {}) }));
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

test('run: an event starts the client for the tasks that it opens', () => {
  const b = box('', { trigger: { kind: 'event', value: 'change-opened' } });
  const r = b.run(['fire', 'run', 'change-opened']);
  assert.deepEqual(r.json.opened.map((t: any) => [t.scenario, t.ran, t.exit]), [['draft-message', true, 0]]);
  assert.equal(calls(b).length, 1);
  // The client ended and the task still executes: not a success for the system that saw the event.
  assert.deepEqual([r.json.failed, r.code], [true, 2]);
  // A plain event starts nothing; an event that no scenario waits for opens nothing.
  assert.equal(b.run(['fire', 'change-opened']).json.opened[0].ran, undefined);
  assert.deepEqual(b.run(['fire', 'run', 'other-event']).json.opened, []);
  assert.equal(calls(b).length, 1);
  // A client without a window starts no client, and no task is opened for it.
  const nested = b.run(['fire', 'run', 'change-opened'], { REINS_HEADLESS: '1' });
  assert.equal(nested.json.error, 'nested_run');
  assert.equal(b.run(['tasks']).json.tasks.length, 2);
  // The word "run" with no event after it is the event with that name: its task opens, no client starts.
  const named = box('', { trigger: { kind: 'event', value: 'run' } });
  const plain = named.run(['fire', 'run']);
  assert.deepEqual([plain.json.opened.length, plain.json.opened[0]?.ran], [1, undefined]);
  assert.equal(fs.existsSync(named.log), false);
  // Inputs that a waiting scenario does not take: nothing opens, and that is not a success.
  const typed = box('', { trigger: { kind: 'event', value: 'change-opened', inputs: [{ name: 'change_id', type: 'id' }] } });
  const refused = typed.run(['fire', 'run', 'change-opened']);
  assert.deepEqual([refused.json.opened.length, refused.json.refused.length, refused.json.failed, refused.code], [0, 1, true, 2]);
});

test('run: the harness has no process of its own: `reins timer` gives the human the text of a timer of the system', () => {
  const b = box('');
  const r = b.run(['timer', '10']);
  assert.deepEqual([r.json.ok, r.json.minutes, r.code], [true, 10, 0]);
  const command: string[] = r.json.command;
  assert.deepEqual(command.slice(-2), ['tick', 'run']);
  assert.equal(command[0], process.execPath);
  assert.equal(command[1], CLI);
  // launchd: the command word for word, the period in seconds, the directory and the config of this call.
  const plist: string = r.json.launchd.text;
  assert.match(r.json.launchd.file, /Library\/LaunchAgents\/io\.reins\.tick\.plist$/);
  for (const word of command) assert.ok(plist.includes(`<string>${word}</string>`), word);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
  assert.ok(plist.includes(`<key>WorkingDirectory</key>\n  <string>${b.cwd}</string>`));
  assert.ok(plist.includes(`<key>REINS_CONFIG</key>\n    <string>${b.config}</string>`));
  // systemd and cron say the same.
  assert.match(r.json.systemd.timer, /OnUnitActiveSec=10min/);
  assert.ok(r.json.systemd.service.includes(`WorkingDirectory=${b.cwd}`));
  assert.ok(r.json.cron.startsWith('*/10 * * * * '));
  // The command writes nothing and starts nothing.
  assert.equal(fs.existsSync(b.log), false);
  assert.equal(fs.existsSync(path.join(b.root, 'Library')), false);
  // The period: whole minutes, a day at most; five by default; a period that cron cannot say has no cron line.
  assert.equal(b.run(['timer']).json.minutes, 5);
  assert.equal(b.run(['timer', '0']).json.error, 'usage');
  assert.equal(b.run(['timer', '1441']).json.error, 'usage');
  assert.equal(b.run(['timer', '90']).json.cron, undefined);
  assert.equal(b.run(['timer', '45']).json.cron, undefined, 'a period that does not divide the hour');
  assert.equal(b.run(['timer', '300']).json.cron, undefined, 'hours that do not divide the day');
  assert.ok(b.run(['timer', '120']).json.cron.startsWith('0 */2 * * * '));
  assert.ok(b.run(['timer', '60']).json.cron.startsWith('0 * * * * '));
  // A percent sign in a path: cron and systemd read it in their own way.
  const odd = b.run(['timer'], { PATH: '/opt/50%/bin' });
  assert.ok(odd.json.cron.includes('PATH=/opt/50\\%/bin '));
  assert.ok(odd.json.systemd.service.includes('Environment=PATH=/opt/50%%/bin'));
  assert.ok(odd.json.launchd.text.includes('<string>/opt/50%/bin</string>'));
});

// ---- Several clients at one time.

// The runtime of a box, as the command line makes it.
function runtimeOf(b: Box): Runtime {
  const before = process.env.REINS_CONFIG;
  process.env.REINS_CONFIG = b.config;
  try {
    return loadRuntime(b.cwd);
  } finally {
    if (before === undefined) delete process.env.REINS_CONFIG;
    else process.env.REINS_CONFIG = before;
  }
}
const repoIn = (dir: string): void => {
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
};

test('run: with the key of the config the clients of two tasks run at one time, each in a work tree of its own', () => {
  const b = box('');
  repoIn(b.cwd);
  const script = JSON.parse(fs.readFileSync(b.config, 'utf8')).runner[1];
  // The client says when it starts and when it ends; the second one writes a file into its work.
  fs.appendFileSync(script, `const mark = (m) => fs.appendFileSync(${JSON.stringify(b.log)}, JSON.stringify({ mark: m, t: Date.now() }) + '\\n');\nmark('start');\nif (fs.existsSync(${JSON.stringify(path.join(b.root, 'write'))})) fs.writeFileSync('made-by-the-task.txt', 'x');\nsetTimeout(() => mark('end'), 1500);\n`);
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_parallel: 2 }));
  const ids = [b.run(['open', 'draft-message']).json.task, b.run(['open', 'draft-message']).json.task];
  const rt = runtimeOf(b);
  const replies = runTasks(rt, ids);
  assert.deepEqual(replies, [{ ran: true, exit: 0 }, { ran: true, exit: 0 }]);
  const lines = calls(b);
  const marks = lines.filter((l) => l.mark !== undefined);
  assert.ok(Math.max(...marks.filter((l) => l.mark === 'start').map((l) => l.t)) < Math.min(...marks.filter((l) => l.mark === 'end').map((l) => l.t)), 'the second client started before the first one ended');
  const dirs = lines.filter((l) => l.cwd !== undefined).map((l) => l.cwd).sort();
  assert.deepEqual(dirs, ids.map((id) => path.join(worktreesDir(rt), id)).sort(), 'each client worked in its own work tree');
  // A work tree that the client left as it was is gone.
  assert.deepEqual(fs.readdirSync(worktreesDir(rt)), []);
  assert.equal(spawnSync('git', ['worktree', 'list'], { cwd: b.cwd, encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
  // A work tree with the work of the task stays, and the reply names it.
  fs.writeFileSync(path.join(b.root, 'write'), '');
  const more = [b.run(['open', 'draft-message']).json.task, b.run(['open', 'draft-message']).json.task];
  const kept = runTasks(rt, more);
  assert.deepEqual(kept.map((r) => r.worktree), more.map((id) => path.join(worktreesDir(rt), id)));
  assert.equal(fs.existsSync(path.join(kept[0]?.worktree ?? '', 'made-by-the-task.txt')), true);
  assert.equal(fs.existsSync(path.join(b.cwd, 'made-by-the-task.txt')), false, 'the work of the human is as it was');
  // A linked work tree is the same project as its repository: the memory of the project reaches the client there.
  assert.equal(runtimeOf({ ...b, cwd: kept[0]?.worktree ?? '' }).project, rt.project);
  // The repository itself keeps the name that the client gives it: a project that the human reaches through a link keeps its memory.
  const link = path.join(b.root, 'link-to-work');
  fs.symlinkSync(b.cwd, link);
  assert.equal(runtimeOf({ ...b, cwd: link }).project, `p${crypto.createHash('sha1').update(link).digest('hex').slice(0, 8)}`);
  // A client of a parallel run gets the project of the run by name, whatever the path of its work tree says.
  process.env.REINS_HEADLESS = '1';
  process.env.REINS_PROJECT = 'p0a1b2c3d';
  try {
    assert.equal(runtimeOf(b).project, 'p0a1b2c3d');
    process.env.REINS_PROJECT = 'not-a-project';
    assert.equal(runtimeOf(b).project, rt.project);
  } finally {
    delete process.env.REINS_HEADLESS;
    delete process.env.REINS_PROJECT;
  }
  assert.equal(runtimeOf(b).project, rt.project, 'the name is taken only in a run without a window');
  // A change of the human that is not committed: a copy at the commit would not hold it, so the tasks run one by one in the work itself.
  fs.rmSync(path.join(b.root, 'write'));
  fs.writeFileSync(path.join(b.cwd, 'a.txt'), 'one, not committed\n');
  const before = calls(b).length;
  const plain = runTasks(rt, [b.run(['open', 'draft-message']).json.task, b.run(['open', 'draft-message']).json.task]);
  assert.deepEqual(plain, [{ ran: true, exit: 0 }, { ran: true, exit: 0 }]);
  assert.deepEqual(calls(b).slice(before).filter((l) => l.cwd !== undefined).map((l) => l.cwd), [b.cwd, b.cwd]);
  for (const r of kept) spawnSync('git', ['worktree', 'remove', '--force', r.worktree ?? ''], { cwd: b.cwd });
});

test('run: the clients run as a pool: the next task starts as soon as one client ends', () => {
  const b = box('');
  repoIn(b.cwd);
  const script = JSON.parse(fs.readFileSync(b.config, 'utf8')).runner[1];
  // The first task is slow, the others are quick: the third must not wait for the first.
  fs.appendFileSync(script, `const mark = (m) => fs.appendFileSync(${JSON.stringify(b.log)}, JSON.stringify({ mark: m, task: process.argv[2], t: Date.now() }) + '\\n');\nmark('start');\nsetTimeout(() => mark('end'), fs.readFileSync(${JSON.stringify(path.join(b.root, 'slow'))}, 'utf8') === process.argv[2] ? 3000 : 300);\n`);
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_parallel: 2 }));
  const ids = [1, 2, 3].map(() => b.run(['open', 'draft-message']).json.task as string);
  fs.writeFileSync(path.join(b.root, 'slow'), ids[0] ?? '');
  const rt = runtimeOf(b);
  assert.deepEqual(runTasks(rt, ids).map((r) => r.exit), [0, 0, 0]);
  const at = (task: string | undefined, m: string): number => calls(b).find((l) => l.mark === m && l.task === task)?.t ?? 0;
  assert.ok(at(ids[2], 'start') < at(ids[0], 'end'), 'the third task started while the slow first one still ran');
  assert.deepEqual(fs.readdirSync(worktreesDir(rt)), []);
});

test('run: a task whose check is a command runs in the work itself: a copy at the commit has no installed packages', () => {
  const b = box('', { done: { kind: 'command', check: 'tests', retries: 0 } });
  repoIn(b.cwd);
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_parallel: 2 }));
  const ids = [b.run(['open', 'draft-message']).json.task, b.run(['open', 'draft-message']).json.task];
  const rt = runtimeOf(b);
  assert.deepEqual(runTasks(rt, ids).map((r) => [r.ran, r.worktree]), [[true, undefined], [true, undefined]]);
  assert.deepEqual(calls(b).map((l) => l.cwd), [b.cwd, b.cwd]);
});

test('run: a work that is no repository has no copy: its tasks run one by one, and the key takes a small number', () => {
  const b = box('');
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_parallel: 2 }));
  const ids = [b.run(['open', 'draft-message']).json.task, b.run(['open', 'draft-message']).json.task];
  const rt = runtimeOf(b);
  assert.deepEqual(runTasks(rt, ids), [{ ran: true, exit: 0 }, { ran: true, exit: 0 }]);
  assert.deepEqual(calls(b).map((l) => l.cwd), [b.cwd, b.cwd]);
  assert.equal(fs.existsSync(worktreesDir(rt)), false);
  for (const bad of [0, 9, 'two', 1.5]) {
    fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner_parallel: bad }));
    assert.equal(b.run(['scenarios']).json.error, 'bad_config', String(bad));
  }
});

test('run: a bad runner in the config is a bad config, and the agent asks before it starts a client', () => {
  const b = box('');
  fs.writeFileSync(b.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(b.config, 'utf8')), runner: 'claude -p' }));
  assert.equal(b.run(['scenarios']).json.error, 'bad_config');
  const rt = { merged: loadPacks({}), stateDir: path.join(b.root, 'state'), journal: openJournal(path.join(b.root, 'state')), project: 'p1a2b3c4' };
  for (const command of ['reins run draft-message', 'reins tick run', 'reins fire run change-opened']) {
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
  // One run of the schedule at a time: a lock of a process that lives stops a second run, a lock of a process that is gone does not.
  const lock = path.join(b.root, 'state', 'tick-run.lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.deepEqual([b.run(['tick', 'run']).json.busy, fs.readFileSync(state, 'utf8')], [true, due]);
  fs.writeFileSync(lock, '999999');
  const r = b.run(['tick', 'run']);
  assert.deepEqual([r.json.failed, r.code], [true, 2], 'the client ended, the task still executes');
  assert.equal(fs.existsSync(lock), false);
});
