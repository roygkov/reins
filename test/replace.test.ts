// What a client needs from the harness every day, without another plugin: the result of a request
// by the facts of the work tree, a handoff between sessions, a pause of the barriers, and the
// protection of the settings of the client.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { validateRow } from '../src/contracts/journal.ts';
import { openScenario, type Runtime } from '../src/core/runtime.ts';
import { beforeAction, type ClientTools } from '../src/client/before.ts';
import { agentStopped, humanRequest, sessionEnd, sessionStart } from '../src/client/session.ts';
import { MAX_PAUSE_MINUTES, pause, pausedUntil } from '../src/core/pause.ts';
import { workState } from '../src/core/work.ts';
import { loadCases } from './cases.ts';

const HOOK = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { read_file: { kind: 'read' }, write_file: { kind: 'local', path: 'path' }, shell: { kind: 'shell', command: 'command' } };

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function git(cwd: string, ...args: string[]): void {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(p.status, 0, p.stderr);
}
function box(): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'const limit = items.length;\n');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir, human_channel: 'any' }));
  return { rt: { merged: loadPacks(packs), stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
const e = (b: Box, session = 's1') => ({ session, cwd: b.cwd });

test('work: the state of a work tree changes with an edit, a new file and a commit', () => {
  const b = box();
  const base = workState(b.cwd);
  assert.match(base ?? '', /^[0-9a-f]{16,}$/);
  assert.equal(workState(b.cwd), base, 'no change: the same state');
  fs.writeFileSync(path.join(b.cwd, 'src/a.ts'), 'const limit = items.length + 1;\n');
  const edited = workState(b.cwd);
  assert.notEqual(edited, base);
  fs.writeFileSync(path.join(b.cwd, 'src/a.ts'), 'const limit = items.length + 2;\n');
  assert.notEqual(workState(b.cwd), edited, 'a second edit of a changed file is a change too');
  fs.writeFileSync(path.join(b.cwd, 'new.txt'), 'x');
  const added = workState(b.cwd);
  git(b.cwd, 'add', '-A');
  git(b.cwd, 'commit', '-q', '-m', 'more');
  assert.notEqual(workState(b.cwd), added);
});

test('work: a directory that is no repository has a state too: the names, the sizes and the times of its files', () => {
  const b = box();
  const dir = path.join(b.root, 'plain');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes/a.md'), 'one\n');
  const base = workState(dir);
  assert.match(base ?? '', /^[0-9a-f]{16,}$/);
  assert.equal(workState(dir), base, 'no change: the same state');
  fs.writeFileSync(path.join(dir, 'notes/a.md'), 'one and two\n');
  let edited = workState(dir);
  assert.notEqual(edited, base, 'an edit');
  fs.writeFileSync(path.join(dir, 'b.md'), '');
  const added = workState(dir);
  assert.notEqual(added, edited, 'a new file');
  fs.rmSync(path.join(dir, 'b.md'));
  assert.equal(workState(dir), edited, 'the file is gone again: the state before it');
  // A file of the system is not the work. A file whose name starts with a dot is: `.env`, a config of a tool.
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  assert.equal(workState(dir), edited);
  fs.writeFileSync(path.join(dir, '.env'), 'x');
  assert.notEqual(workState(dir), edited);
  fs.rmSync(path.join(dir, '.env'));
  // The time of the content can be set back: the change is seen all the same.
  const stat = fs.statSync(path.join(dir, 'notes/a.md'));
  fs.writeFileSync(path.join(dir, 'notes/a.md'), 'one and 2wo\n');
  fs.utimesSync(path.join(dir, 'notes/a.md'), stat.atime, stat.mtime);
  assert.notEqual(workState(dir), edited);
  edited = workState(dir);
  // A link is not followed: its target is not a part of the work.
  fs.symlinkSync(b.cwd, path.join(dir, 'link'));
  const linked = workState(dir);
  assert.notEqual(linked, edited);
  fs.writeFileSync(path.join(b.cwd, 'far.txt'), 'x');
  assert.equal(workState(dir), linked);
  // A directory with more files than the limit has no state: a walk of it costs too much.
  for (let i = 0; i < 2001; i += 1) fs.writeFileSync(path.join(dir, 'notes', `f${i}`), '');
  assert.equal(workState(dir), null);
  assert.equal(workState(path.join(b.root, 'no-such-directory')), null);
});

test('stop: a request that changed the work tree ends as "not verified", and the client is told', () => {
  const b = box();
  humanRequest(b.rt, e(b));
  fs.writeFileSync(path.join(b.cwd, 'src/a.ts'), 'const limit = 1;\n');
  const stopped = agentStopped(b.rt, e(b));
  assert.deepEqual([stopped.label, stopped.changed], ['not_verified', true]);
  // The journal keeps the fact: this result was a change of the work that nothing verified.
  const closed = readJournal(b.rt.journal.file).filter((r) => r.kind === 'task.closed');
  assert.deepEqual(closed.map((r) => r.data), [{ label: 'not_verified', changed: 1 }]);
  for (const r of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(r), []);
});

test('stop: a request that changed nothing says nothing about a result', () => {
  const b = box();
  humanRequest(b.rt, e(b));
  assert.equal(agentStopped(b.rt, e(b)).changed, false);
  // A question leaves no mark of a change in the journal.
  assert.deepEqual(readJournal(b.rt.journal.file).filter((r) => r.kind === 'task.closed').map((r) => r.data), [{ label: 'not_verified' }]);
  // A change that was there before the request is not a change of the request.
  fs.writeFileSync(path.join(b.cwd, 'src/a.ts'), 'const limit = 1;\n');
  humanRequest(b.rt, e(b));
  assert.equal(agentStopped(b.rt, e(b)).changed, false);
});

function hook(b: Box, mode: string, event: Record<string, unknown>): { code: number | null; stdout: string } {
  const p = spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify({ session_id: 'live', cwd: b.cwd, ...event }), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  return { code: p.status, stdout: p.stdout };
}

test('stop: the Claude Code adapter shows the label to the human only after a change', () => {
  const b = box();
  hook(b, 'prompt', { hook_event_name: 'UserPromptSubmit' });
  assert.deepEqual(hook(b, 'stop', { hook_event_name: 'Stop' }), { code: 0, stdout: '' });
  hook(b, 'prompt', { hook_event_name: 'UserPromptSubmit' });
  fs.writeFileSync(path.join(b.cwd, 'src/a.ts'), 'const limit = 1;\n');
  const out = JSON.parse(hook(b, 'stop', { hook_event_name: 'Stop' }).stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.match(out.systemMessage, /^reins: .*not verified/);
});

test('handoff: the end of a session leaves a state record, and the next session starts with it', () => {
  const b = box();
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  humanRequest(b.rt, e(b));
  beforeAction(b.rt, { ...e(b), tool: 'launch_rocket', input: {} }, CLIENT);
  humanRequest(b.rt, e(b));
  sessionEnd(b.rt, e(b));
  const text = sessionStart(b.rt, e(b, 's2')).context.join('\n');
  assert.match(text, /Last session/);
  assert.match(text, /2 requests/);
  assert.match(text, /1 question/);
  assert.match(text, new RegExp(opened.task.id));
  for (const row of readJournal(b.rt.journal.file)) assert.deepEqual(validateRow(row), []);
  assert.equal(b.rt.journal.failures, 0);
});

test('handoff: a session without a request leaves no record', () => {
  const b = box();
  sessionStart(b.rt, e(b));
  sessionEnd(b.rt, e(b));
  assert.doesNotMatch(sessionStart(b.rt, e(b, 's2')).context.join('\n'), /Last session/);
});

// A write of a tool into a known environment of work that is not production.
const workTool = (b: Box, more: Record<string, unknown> = {}): void => {
  b.rt.merged.context.envs = [...(b.rt.merged.context.envs ?? []), 'bench'];
  b.rt.merged.tools.post_note = { kind: 'write', action: 'comment', target: 'note', env: 'bench', ...more } as (typeof b.rt.merged.tools)[string];
};

test('pause: while the barriers are paused a question passes, a protected path does not', () => {
  const b = box();
  workTool(b);
  const ask = () => beforeAction(b.rt, { ...e(b), tool: 'post_note', input: {} }, CLIENT);
  assert.equal(ask().outcome, 'ask');
  const until = pause(b.rt, 30);
  assert.equal(pausedUntil(b.rt), until);
  assert.deepEqual([ask().outcome, ask().rule], ['allow', 'paused']);
  const guarded = beforeAction(b.rt, { ...e(b), tool: 'write_file', input: { path: path.join(b.rt.stateDir, 'pause.json') } }, CLIENT);
  assert.deepEqual([guarded.outcome, guarded.rule], ['deny', 'protect.state']);
  assert.equal(pausedUntil(b.rt, Date.now() + 31 * 60_000), null, 'the pause ends by itself');
  pause(b.rt, 0);
  assert.equal(ask().outcome, 'ask');
  assert.ok(readJournal(b.rt.journal.file).some((r) => r.kind === 'harness.barriers_off'));
});

test('pause: a pause file that the command did not write is no pause', () => {
  const b = box();
  workTool(b);
  const ask = () => beforeAction(b.rt, { ...e(b), tool: 'post_note', input: {} }, CLIENT);
  const file = path.join(b.rt.stateDir, 'pause.json');
  fs.mkdirSync(b.rt.stateDir, { recursive: true });
  const now = Date.now();
  const put = (value: unknown): void => fs.writeFileSync(file, JSON.stringify(value));
  // The command never pauses for longer than its limit: a time past the limit is not its work.
  for (const until of ['2099-01-01T00:00:00Z', new Date(now + (MAX_PAUSE_MINUTES + 1) * 60_000).toISOString()]) {
    put({ until });
    assert.equal(pausedUntil(b.rt, now), null, until);
    assert.equal(ask().outcome, 'ask', until);
  }
  // A time in another form, a number, a list: no pause.
  for (const value of [{ until: '2026' }, { until: 'tomorrow' }, { until: now + 60_000 }, [new Date(now + 60_000).toISOString()], { until: new Date(now + 60_000).toISOString(), more: 1 }]) {
    put(value);
    assert.equal(pausedUntil(b.rt, now), null, JSON.stringify(value));
  }
  // The limit itself is a pause of the command.
  const edge = new Date(now + MAX_PAUSE_MINUTES * 60_000).toISOString();
  put({ until: edge });
  assert.equal(pausedUntil(b.rt, now), edge);
});

test('pause: a write into production or into an unknown environment and a write that cannot be undone still ask', () => {
  const b = box();
  workTool(b);
  pause(b.rt, 30);
  const call = (tool: string) => beforeAction(b.rt, { ...e(b), tool, input: {} }, CLIENT);
  assert.deepEqual([call('post_note').outcome, call('post_note').rule], ['allow', 'paused']);
  // A tool that nothing describes: its environment is not known, and that counts as production.
  assert.equal(call('launch_rocket').outcome, 'ask');
  // The same tool in an environment of production.
  b.rt.merged.context.productionEnvs = ['bench'];
  assert.equal(call('post_note').outcome, 'ask');
  b.rt.merged.context.productionEnvs = [];
  // A write that cannot be undone, in any environment.
  workTool(b, { irreversible: true });
  assert.equal(call('post_note').outcome, 'ask');
  // A command of the shell that the gate reads as a production one.
  const shell = beforeAction(b.rt, { ...e(b), tool: 'shell', input: { command: 'git push --force origin main' } }, CLIENT);
  assert.equal(shell.outcome, 'ask');
});

test('pause: a write that another human sees still asks, in a known environment too', () => {
  const b = box();
  workTool(b, { outward: true });
  pause(b.rt, 30);
  const out = beforeAction(b.rt, { ...e(b), tool: 'post_note', input: {} }, CLIENT);
  assert.deepEqual([out.outcome, out.rule], ['ask', 'default.outward-write']);
  // The same write without the mark passes during the pause.
  workTool(b);
  assert.deepEqual(beforeAction(b.rt, { ...e(b), tool: 'post_note', input: {} }, CLIENT).rule, 'paused');
});

test('pause: a rule that refuses holds during a pause', () => {
  const b = box();
  b.rt.merged.rules.push({ id: 'never', outcome: 'deny', tool: 'launch_rocket', level: 'person' });
  pause(b.rt, 30);
  assert.equal(beforeAction(b.rt, { ...e(b), tool: 'launch_rocket', input: {} }, CLIENT).outcome, 'deny');
});

test('pause: the command line pauses for minutes, and the hook asks the human for that command', () => {
  const b = box();
  const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } }).stdout);
  const on = run(['pause', '15']);
  assert.deepEqual([on.ok, typeof on.until], [true, 'string']);
  assert.deepEqual(run(['pause', '0']), { ok: true, until: null });
  assert.deepEqual(run(['pause', 'x']).error, 'usage');
  assert.deepEqual(run(['pause', '999']).error, 'usage');
  const r = beforeAction(b.rt, { ...e(b), tool: 'shell', input: { command: 'reins pause 60' } }, CLIENT);
  assert.deepEqual([r.outcome, r.rule], ['deny', 'protect.human-command']);
});

test('protect: the settings of the client are protected by the adapter', () => {
  const b = box();
  for (const [tool, input] of [
    ['Write', { file_path: path.join(b.root, '.claude/settings.json') }],
    ['Edit', { file_path: path.join(b.cwd, '.claude/settings.local.json') }],
    ['Bash', { command: 'echo {} > ~/.claude/settings.json' }],
    ['Bash', { command: 'rm -rf ~/.claude/plugins/cache/reins' }],
    ['Bash', { command: 'echo \'{"hooks":{}}\' > .claude/settings.local.json' }],
    ['Bash', { command: 'cd repo && rm -rf .claude/plugins' }],
  ] as const) {
    const out = JSON.parse(hook(b, 'pre', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(input));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /protect\.client/);
  }
  assert.equal(hook(b, 'pre', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(b.cwd, 'src/settings.json') } }).stdout, '');
});

test('work: an edit of a file that git does not track is a change', () => {
  const b = box();
  fs.writeFileSync(path.join(b.cwd, 'notes.md'), 'first');
  const before = workState(b.cwd);
  fs.writeFileSync(path.join(b.cwd, 'notes.md'), 'second');
  assert.notEqual(workState(b.cwd), before);
});

test('handoff: an attempt on the harness itself is counted as a question or a refusal', () => {
  const b = box();
  humanRequest(b.rt, e(b));
  beforeAction(b.rt, { ...e(b), tool: 'write_file', input: { path: path.join(b.rt.stateDir, 'pause.json') } }, CLIENT);
  beforeAction(b.rt, { ...e(b), tool: 'shell', input: { command: 'reins tick run' } }, CLIENT);
  sessionEnd(b.rt, e(b));
  const text = sessionStart(b.rt, e(b, 's2')).context.join('\n');
  assert.match(text, /1 question to the human, 1 refusal\./);
});
