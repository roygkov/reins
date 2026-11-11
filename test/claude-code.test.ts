// The adapter of Claude Code: the hook input of the client becomes a call of the core, and the
// decision of the core becomes the hook output of the client.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJournal } from '../src/journal/writer.ts';
import { loadCases } from './cases.ts';

const HOOK = fileURLToPath(new URL('../clients/claude-code/hooks/hook.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));

const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const TOOLS = {
  'mcp__tracker__get_*': { kind: 'read' },
  'mcp__tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' },
  'mcp__tracker__editIssue': { kind: 'write', action: 'comment', target: 'issue/{issueIdOrKey}', env: 'work' },
};

type Box = { root: string; config: string; state: string; cwd: string };
let n = 0;
function box(): Box {
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
    else if (rel === 'organization/pack.json') fs.writeFileSync(file, JSON.stringify({ ...(value as object), tools: TOOLS }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const state = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  const packs = path.join(root, 'packs');
  fs.writeFileSync(config, JSON.stringify({ packs: { organization: path.join(packs, 'organization'), project: path.join(packs, 'project'), person: path.join(packs, 'person') }, state_dir: state }));
  return { root, config, state, cwd };
}

type Out = { code: number | null; stdout: string; json: any };
function run(file: string, b: Box | null, args: string[], input: string): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: b?.root ?? SB };
  if (b !== null) env.REINS_CONFIG = b.config;
  const p = spawnSync(process.execPath, [file, ...args], { env, input, encoding: 'utf8', cwd: b?.cwd ?? SB });
  let json: unknown = null;
  try {
    json = JSON.parse(p.stdout);
  } catch {
    json = null;
  }
  return { code: p.status, stdout: p.stdout, json };
}

const event = (b: Box | null, name: string, tool: string, input: unknown): string =>
  JSON.stringify({ session_id: 'abc', transcript_path: '/x', cwd: b?.cwd ?? SB, hook_event_name: name, tool_name: tool, tool_input: input });
const pre = (b: Box | null, tool: string, input: unknown): Out => run(HOOK, b, ['pre'], event(b, 'PreToolUse', tool, input));
const post = (b: Box | null, tool: string, input: unknown): Out => run(HOOK, b, ['post'], event(b, 'PostToolUse', tool, input));
const decision = (o: Out): string | undefined => o.json?.hookSpecificOutput?.permissionDecision;

test('claude-code: a read and a plain command give no output: the client decides as usual', () => {
  const b = box();
  for (const [tool, input] of [['Read', { file_path: '/x/a.ts' }], ['Grep', { pattern: 'x' }], ['Bash', { command: 'ls -la' }], ['Edit', { file_path: path.join(b.cwd, 'a.ts'), old_string: 'a', new_string: 'b' }], ['mcp__tracker__get_change', { change: '7' }]] as const) {
    const r = pre(b, tool, input);
    assert.deepEqual([r.code, r.stdout], [0, ''], tool);
  }
});

test('claude-code: a dangerous command asks the human in the form of the client', () => {
  const r = pre(box(), 'Bash', { command: 'git push --force origin main' });
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput']);
  assert.deepEqual([r.json.hookSpecificOutput.hookEventName, r.json.hookSpecificOutput.permissionDecision], ['PreToolUse', 'ask']);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /^reins: /);
});

test('claude-code: a write into the state of the harness is denied', () => {
  const b = box();
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
    const r = pre(b, tool, tool === 'NotebookEdit' ? { notebook_path: path.join(b.state, 'x.ipynb') } : { file_path: path.join(b.state, 'tasks', 'x.json') });
    assert.equal(decision(r), 'deny', tool);
  }
});

test('claude-code: a tool that nothing describes asks the human', () => {
  assert.equal(decision(pre(box(), 'mcp__rocket__launch', {})), 'ask');
  assert.equal(decision(pre(box(), 'BrandNewTool', {})), 'ask');
});

test('claude-code: one approval of the human covers the named write of a task', () => {
  const b = box();
  const opened = run(CLI, b, ['open', 'change-review', 'change_id=7'], '');
  assert.equal(opened.json.state, 'executing');
  const first = pre(b, 'mcp__tracker__add_comment', { change: '7', body: 'x' });
  assert.equal(decision(first), 'ask');
  assert.match(first.json.hookSpecificOutput.permissionDecisionReason, new RegExp(opened.json.task));
  assert.deepEqual([post(b, 'mcp__tracker__add_comment', { change: '7', body: 'x' }).stdout], ['']);
  const second = pre(b, 'mcp__tracker__add_comment', { change: '7', body: 'y' });
  assert.equal(decision(second), 'allow');
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', { change: '8', body: 'y' })), 'ask');
});

test('claude-code: an input that cannot be read asks the human and is written down', () => {
  const b = box();
  for (const raw of ['', 'not json', '[]', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 7, tool_input: {}, cwd: b.cwd })]) {
    const r = run(HOOK, b, ['pre'], raw);
    assert.deepEqual([r.code, decision(r)], [0, 'ask'], raw);
  }
  const kinds = readJournal(path.join(b.state, 'journal.jsonl')).map((r) => r.kind);
  assert.deepEqual([...new Set(kinds)], ['harness.client_shape_changed']);
});

test('claude-code: without a config a write asks and a read passes', () => {
  assert.deepEqual([pre(null, 'Read', { file_path: '/x' }).stdout], ['']);
  assert.equal(decision(pre(null, 'Bash', { command: 'ls' })), 'ask');
  assert.equal(decision(pre(null, 'mcp__tracker__add_comment', { change: '7' })), 'ask');
});

test('claude-code: "post" never blocks and prints nothing', () => {
  const b = box();
  for (const raw of ['', 'not json', event(b, 'PostToolUse', 'Read', { file_path: '/x' })]) {
    const r = run(HOOK, b, ['post'], raw);
    assert.deepEqual([r.code, r.stdout], [0, ''], raw);
  }
});

test('claude-code: the plugin registers the hook before every tool', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../clients/claude-code/hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
  assert.equal(hooks.PreToolUse[0].matcher, '.*');
  assert.equal(hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.match(hooks.PreToolUse[0].hooks[0].command, /hooks\/hook\.ts" pre$/);
});

test('claude-code: in the mode without permission questions a run of the tool approves nothing', () => {
  const b = box();
  run(CLI, b, ['open', 'change-review', 'change_id=7'], '');
  const input = { change: '7', body: 'x' };
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'ask');
  const bypass = JSON.stringify({ session_id: 'abc', cwd: b.cwd, hook_event_name: 'PostToolUse', permission_mode: 'bypassPermissions', tool_name: 'mcp__tracker__add_comment', tool_input: input });
  assert.equal(run(HOOK, b, ['post'], bypass).stdout, '');
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'ask', 'the grant is not confirmed');
});

test('claude-code: a config key that nothing reads is refused, a key of the gate is not', () => {
  const b = box();
  const good = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  fs.writeFileSync(b.config, JSON.stringify({ ...good, markers: ['prod'], rules: [] }));
  assert.equal(run(CLI, b, ['scenarios'], '').json.ok, true);
  fs.writeFileSync(b.config, JSON.stringify({ ...good, 'state-dir': '/x' }));
  assert.deepEqual([run(CLI, b, ['scenarios'], '').json.error, decision(pre(b, 'Bash', { command: 'ls' }))], ['bad_config', 'ask']);
});

test('claude-code: an adapter that cannot start asks the human before an action', () => {
  const copy = path.join(SB, 'broken-plugin');
  fs.cpSync(path.dirname(path.dirname(HOOK)), copy, { recursive: true });
  // The copy is outside the repository: its imports of the core do not resolve. The config of the
  // machine where the test runs is not read: it can name a source.
  const p = spawnSync(process.execPath, [path.join(copy, 'hooks/hook.ts'), 'pre'], { input: event(null, 'PreToolUse', 'Bash', { command: 'ls' }), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', REINS_CONFIG: path.join(SB, 'no-config.json') } });
  assert.equal(p.status, 0);
  assert.equal(JSON.parse(p.stdout).hookSpecificOutput.permissionDecision, 'ask');
  const q = spawnSync(process.execPath, [path.join(copy, 'hooks/hook.ts'), 'post'], { input: '', encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.deepEqual([q.status, q.stdout], [0, '']);
});

test('claude-code: an installed copy of the plugin finds the core through the key `source` of the config', () => {
  // A client copies only the directory of the plugin into its cache: the core is not in the copy.
  const copy = path.join(SB, 'installed-plugin');
  fs.cpSync(path.dirname(path.dirname(HOOK)), copy, { recursive: true });
  const hook = path.join(copy, 'hooks/hook.ts');
  const b = box();
  const good = JSON.parse(fs.readFileSync(b.config, 'utf8'));
  const source = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(b.config, JSON.stringify({ ...good, source }));
  const ls = event(b, 'PreToolUse', 'Bash', { command: 'ls' });
  assert.equal(run(hook, b, ['pre'], ls).stdout, run(HOOK, b, ['pre'], ls).stdout, 'the copy answers as the plugin in the repository');
  assert.ok(!run(hook, b, ['pre'], ls).stdout.includes('did not start'));
  const write = event(b, 'PreToolUse', 'Bash', { command: `echo x >> ${path.join(b.state, 'journal.jsonl')}` });
  assert.equal(run(hook, b, ['pre'], write).json.hookSpecificOutput.permissionDecision, 'deny');
  // The command line reads the same config: the key is a known one, and it is an absolute path.
  assert.equal(run(CLI, b, ['scenarios'], '').json.ok, true);
  fs.writeFileSync(b.config, JSON.stringify({ ...good, source: 'reins' }));
  assert.equal(run(CLI, b, ['scenarios'], '').json.error, 'bad_config');
  assert.equal(run(hook, b, ['pre'], ls).json.hookSpecificOutput.permissionDecision, 'ask', 'a source that is no absolute path loads nothing');
  // A core that is beside the entry and does not load is a failure: the source does not take its place.
  const half = path.join(SB, 'half', 'clients', 'claude-code');
  fs.cpSync(path.dirname(path.dirname(HOOK)), half, { recursive: true });
  fs.mkdirSync(path.join(SB, 'half', 'src', 'client'), { recursive: true });
  fs.writeFileSync(path.join(SB, 'half', 'src', 'client', 'before.ts'), 'export {};\n');
  fs.writeFileSync(b.config, JSON.stringify({ ...good, source }));
  assert.equal(run(path.join(half, 'hooks/hook.ts'), b, ['pre'], ls).json.hookSpecificOutput.permissionDecision, 'ask');
  // A source that has no adapter: the human decides.
  fs.writeFileSync(b.config, JSON.stringify({ ...good, source: path.join(SB, 'nothing-here') }));
  assert.equal(run(hook, b, ['pre'], ls).json.hookSpecificOutput.permissionDecision, 'ask');
});

test('claude-code: a target of a tool can name an input field in any letter case', () => {
  // Tools of connectors name their fields as they like: `issueIdOrKey` is a field as `change` is.
  const b = box();
  const r = pre(b, 'mcp__tracker__editIssue', { issueIdOrKey: 'ABC-1' });
  assert.equal(decision(r), 'ask');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /default\.write/, 'a known write, not an unknown tool');
  assert.match(pre(b, 'mcp__tracker__editIssue', {}).json.hookSpecificOutput.permissionDecisionReason, /unknown-tool/, 'without the field the target is not known');
});

test('claude-code: a pack with a mistake is named at the start of the session and by the command line', () => {
  const b = box();
  const file = path.join(b.root, 'packs', 'organization', 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...pack, tools: { ...pack.tools, 'mcp__x__y': { kind: 'write', action: 'comment', target: 'a b', env: 'work' } } }));
  const start = run(HOOK, b, ['session-start'], JSON.stringify({ session_id: 's-broken', cwd: b.cwd, hook_event_name: 'SessionStart' }));
  assert.match(start.json.hookSpecificOutput.additionalContext, /organization pack is NOT connected: 1 mistake\(s\), the first is bad_name at tools\.mcp__x__y\.target/);
  const listed = run(CLI, b, ['scenarios'], '').json;
  // The packs under a pack with a mistake are not connected either: all of them are named.
  assert.equal(listed.not_connected[0].level, 'organization');
  assert.equal(listed.not_connected[0].errors[0].path, 'tools.mcp__x__y.target');
  // Packs without a mistake are not named.
  const good = box();
  assert.equal(run(CLI, good, ['scenarios'], '').json.not_connected, undefined);
});

test('claude-code: a change of the adapter itself asks the human', () => {
  const b = box();
  const r = pre(b, 'Edit', { file_path: fileURLToPath(new URL('../clients/claude-code/tools.json', import.meta.url)), old_string: 'a', new_string: 'b' });
  assert.equal(decision(r), 'ask');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /protect\.harness/);
});

test('claude-code: in the mode `auto` the human answers a question, and a run of the tool is the approval', () => {
  const b = box();
  run(CLI, b, ['open', 'change-review', 'change_id=7'], '');
  const input = { change: '7', body: 'x' };
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'ask');
  const auto = JSON.stringify({ session_id: 'abc', cwd: b.cwd, hook_event_name: 'PostToolUse', permission_mode: 'auto', tool_name: 'mcp__tracker__add_comment', tool_input: input });
  assert.equal(run(HOOK, b, ['post'], auto).stdout, '');
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'allow', 'the grant is confirmed for the task');
});
