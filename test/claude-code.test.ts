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
  // One tool that reads and writes: the text of the query says which. The pattern is a sample for
  // the test, not for a pack: it takes `select nextval('s')` and `select * into t2 from t` for reads.
  'mcp__db__query': { kind: 'write', action: 'comment', target: 'db/main', env: 'work', read_when: { field: 'sql', pattern: '\\s*select\\b[^;]*;?\\s*' } },
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
function run(file: string, b: Box | null, args: string[], input: string, more: Record<string, string> = {}): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: b?.root ?? SB, ...more };
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
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
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
  const q = spawnSync(process.execPath, [path.join(copy, 'hooks/hook.ts'), 'post'], { input: '', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', REINS_CONFIG: path.join(SB, 'no-config.json') } });
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

test('claude-code: a tool that reads and writes is a read when its input says so', () => {
  const b = box();
  // The whole value must match: a read passes as any read, with no output.
  assert.equal(pre(b, 'mcp__db__query', { sql: 'SELECT id\nFROM t WHERE a = 1;' }).stdout, '');
  const ask = (input: unknown): string => pre(b, 'mcp__db__query', input).json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  assert.match(ask({ sql: 'delete from t' }), /default\.write/);
  assert.match(ask({ sql: 'select 1; drop table t' }), /default\.write/, 'a read at the start does not make the rest a read');
  assert.match(ask({ sql: 'x select 1' }), /default\.write/);
  assert.match(ask({ sql: ['select 1'] }), /default\.write/, 'a value that is no text is no read');
  assert.match(ask({}), /default\.write/);
  assert.match(ask({ sql: `select ${'a,'.repeat(20000)} 1` }), /default\.write/, 'a text that is too long is not judged');
  // A read of a tool that also writes keeps the environment of the tool.
  const rows = fs.readFileSync(path.join(b.state, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  assert.deepEqual(rows.find((r) => r.kind === 'policy.decision' && r.data.action_kind === 'read')?.data, { outcome: 'allow', action_kind: 'read', env: 'work', tool: 'mcp__db__query' });
});

test('claude-code: a condition of a read is checked when the pack is loaded', () => {
  for (const [bad, at] of [
    [{ field: 'sql', pattern: '(' }, 'read_when.pattern'],
    // A bracket without its pair: inside the group of the whole match it would compile and match any text.
    [{ field: 'sql', pattern: 'select 1)|(?:.*' }, 'read_when.pattern'],
    [{ field: 'sql', pattern: 'x'.repeat(501) }, 'read_when.pattern'],
    [{ field: 'a b', pattern: 'x' }, 'read_when.field'],
    [{ field: 'sql' }, 'read_when.pattern'],
    [{ field: 'sql', pattern: 'x', more: 1 }, 'read_when.more'],
    ['select', 'read_when'],
  ] as const) {
    const b = box();
    const file = path.join(b.root, 'packs', 'organization', 'pack.json');
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...pack, tools: { ...pack.tools, 'mcp__db__query': { kind: 'write', action: 'comment', target: 'db/main', env: 'work', read_when: bad } } }));
    assert.equal(run(CLI, b, ['scenarios'], '').json.not_connected?.[0]?.errors?.[0]?.path, `tools.mcp__db__query.${at}`, JSON.stringify(bad));
  }
  // A tool that only reads has no condition.
  const b = box();
  const file = path.join(b.root, 'packs', 'organization', 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...pack, tools: { ...pack.tools, 'mcp__db__get': { kind: 'read', read_when: { field: 'sql', pattern: 'x' } } } }));
  assert.equal(run(CLI, b, ['scenarios'], '').json.not_connected?.[0]?.errors?.[0]?.path, 'tools.mcp__db__get.read_when');
});

const decisions = (b: Box): { decision: string; session?: string }[] =>
  fs.readFileSync(path.join(b.state, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'task.human_decision').map((r) => ({ decision: r.data.decision, session: r.session }));
const hookEvent = (b: Box, name: string, more: Record<string, unknown> = {}, session = 'abc'): string =>
  JSON.stringify({ session_id: session, cwd: b.cwd, hook_event_name: name, permission_mode: 'default', ...more });

test('claude-code: a question that no run of the tool answered is the "no" of the human', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const input = { change: '7', body: 'x' };
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'ask');
  // The end of the turn of another session says nothing about this question.
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop', {}, 'other'));
  assert.deepEqual(decisions(b), []);
  // The turn ended and the tool did not run: the human refused.
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  assert.deepEqual(decisions(b), [{ decision: 'refused', session: 'abc' }]);
  assert.deepEqual(fs.readdirSync(path.join(b.state, 'pending')), []);
  // It is written once.
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  assert.equal(decisions(b).length, 1);
});

test('claude-code: actions with no hook before them: the human reads it at the stop, once', () => {
  const b = box();
  run(HOOK, b, ['session-start'], hookEvent(b, 'SessionStart'));
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  fs.writeFileSync(path.join(b.cwd, 'new.txt'), 'x');
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' } }));
  const said = run(HOOK, b, ['stop'], hookEvent(b, 'Stop')).json?.systemMessage ?? '';
  assert.match(said, /did not tell the harness before them/);
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  assert.doesNotMatch(run(HOOK, b, ['stop'], hookEvent(b, 'Stop')).json?.systemMessage ?? '', /did not tell the harness/);
});

test('claude-code: a run without a window that stops before the report of its task is told to go on', () => {
  const b = box();
  const env = { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config };
  const reins = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: b.cwd }).stdout);
  const id = reins('open', 'draft-message').task;
  // The session takes the task when it reads the input.
  run(HOOK, b, ['session-start'], hookEvent(b, 'SessionStart'), { REINS_HEADLESS: '1' });
  reins('input', id);
  const stop = run(HOOK, b, ['stop'], hookEvent(b, 'Stop'), { REINS_HEADLESS: '1' });
  assert.equal(stop.json?.decision, 'block');
  assert.match(stop.json?.reason ?? '', new RegExp(`the task ${id} .* is not finished.*reins report ${id}`));
  // With a window the same stop passes.
  assert.equal(run(HOOK, b, ['stop'], hookEvent(b, 'Stop')).json?.decision, undefined);
});

test('claude-code: a failed tool is written to the journal, a tool that the human broke off is not', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const failed = () => fs.readFileSync(path.join(b.state, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).filter((r) => r.kind === 'executor.tool_failed').map((r) => r.data);
  const input = { change: '7' };
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUseFailure', { tool_name: 'mcp__tracker__get_change', tool_input: input, error: 'no such change' }));
  assert.deepEqual(failed(), [{ tool: 'mcp__tracker__get_change' }]);
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUseFailure', { tool_name: 'mcp__tracker__get_change', tool_input: input, error: 'stopped', is_interrupt: true }));
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUse', { tool_name: 'mcp__tracker__get_change', tool_input: input }));
  // A tool of the client itself that failed is the work, not a fault of a tool.
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUseFailure', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' }, error: 'no such file' }));
  assert.equal(failed().length, 1);
});

test('claude-code: the next request also settles a question: a turn that the human broke has no end', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', { change: '7', body: 'x' })), 'ask');
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  assert.deepEqual(decisions(b), [{ decision: 'refused', session: 'abc' }]);
});

test('claude-code: a tool that ran and failed after a question is still the "yes" of the human', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const input = { change: '7', body: 'x' };
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'ask');
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUseFailure', { tool_name: 'mcp__tracker__add_comment', tool_input: input, error: 'boom' }));
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  assert.deepEqual(decisions(b), [{ decision: 'answered', session: 'abc' }]);
  // The client tells the harness about a failed tool.
  const hooks = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../clients/claude-code/hooks/hooks.json', import.meta.url)), 'utf8')).hooks;
  assert.match(hooks.PostToolUseFailure[0].hooks[0].command, /hook\.ts" post$/);
});

test('claude-code: a question of a subordinate ends with the subordinate, not with the turn', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const input = { change: '7', body: 'x' };
  const fromSub = (name: string, more: Record<string, unknown> = {}) => hookEvent(b, name, { tool_name: 'mcp__tracker__add_comment', tool_input: input, agent_id: 'agent-1', agent_type: 'reviewer', ...more });
  assert.equal(decision(run(HOOK, b, ['pre'], fromSub('PreToolUse'))), 'ask');
  // The turn of the session ends while the subordinate still waits for the human.
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  assert.deepEqual(decisions(b), []);
  // The human says "yes" later: the run of the tool is still the answer.
  run(HOOK, b, ['post'], fromSub('PostToolUse'));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['answered']);
  // Another question of the subordinate, and the subordinate ends without a run of the tool.
  assert.equal(decision(run(HOOK, b, ['pre'], fromSub('PreToolUse', { tool_input: { change: '8', body: 'y' } }))), 'ask');
  run(HOOK, b, ['subagent-stop'], hookEvent(b, 'SubagentStop', { agent_id: 'agent-2', agent_type: 'reviewer' }));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['answered'], 'the end of another subordinate says nothing');
  run(HOOK, b, ['subagent-stop'], hookEvent(b, 'SubagentStop', { agent_id: 'agent-1', agent_type: 'reviewer' }));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['answered', 'refused']);
});

test('claude-code: in a mode without permission questions no human refused anything', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const quiet = (name: string) => hookEvent(b, name, { permission_mode: 'dontAsk', tool_name: 'mcp__tracker__add_comment', tool_input: { change: '7', body: 'x' } });
  assert.equal(decision(run(HOOK, b, ['pre'], quiet('PreToolUse'))), 'ask');
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop', { permission_mode: 'dontAsk' }));
  assert.deepEqual(decisions(b), []);
  assert.deepEqual(fs.readdirSync(path.join(b.state, 'pending')), [], 'the question is gone all the same');
  // The journal says that no human saw the question: the share of "yes" does not count it.
  const rows = fs.readFileSync(path.join(b.state, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  assert.deepEqual(rows.filter((r) => r.kind === 'policy.decision' && r.data.outcome === 'ask').map((r) => r.data.unshown), [1]);
  // In a mode with questions the row has no such mark.
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', { change: '9', body: 'z' })), 'ask');
  const after = fs.readFileSync(path.join(b.state, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  assert.deepEqual(after.filter((r) => r.kind === 'policy.decision' && r.data.outcome === 'ask').map((r) => r.data.unshown), [1, undefined]);
});

test('claude-code: the one question of a task carries the same mark in a mode without questions', () => {
  const b = box();
  run(CLI, b, ['open', 'change-review', 'change_id=7'], '');
  const quiet = JSON.stringify({ session_id: 'abc', cwd: b.cwd, hook_event_name: 'PreToolUse', permission_mode: 'dontAsk', tool_name: 'mcp__tracker__add_comment', tool_input: { change: '7', body: 'x' } });
  // The envelope of the task names this write: the core asks once for the whole task.
  assert.equal(decision(run(HOOK, b, ['pre'], quiet)), 'ask');
  const rows = fs.readFileSync(path.join(b.state, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  const asks = rows.filter((r) => r.kind === 'policy.decision' && r.data.outcome === 'ask');
  assert.deepEqual(asks.map((r) => [r.scenario, r.data.unshown]), [['change-review', 1]]);
  // The end of the session does not count it among the questions to the human.
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit', { permission_mode: 'dontAsk' }));
  run(HOOK, b, ['session-end'], hookEvent(b, 'SessionEnd', { permission_mode: 'dontAsk' }));
  const handoff = fs.readdirSync(path.join(b.state, 'handoff')).map((f) => JSON.parse(fs.readFileSync(path.join(b.state, 'handoff', f), 'utf8')));
  assert.deepEqual(handoff.map((h) => h.questions), [0]);
});

test('claude-code: the end of the session ends the questions of its subordinates too', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  assert.equal(decision(run(HOOK, b, ['pre'], hookEvent(b, 'PreToolUse', { tool_name: 'mcp__tracker__add_comment', tool_input: { change: '7', body: 'x' }, agent_id: 'agent-1', agent_type: 'reviewer' }))), 'ask');
  run(HOOK, b, ['session-end'], hookEvent(b, 'SessionEnd'));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['refused']);
});

test('claude-code: the identifier of a call ties a question to its answer, whatever the input became', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const call = (name: string, more: Record<string, unknown>) => hookEvent(b, name, { tool_name: 'mcp__tracker__add_comment', ...more });
  assert.equal(decision(run(HOOK, b, ['pre'], call('PreToolUse', { tool_use_id: 'toolu_1', tool_input: { change: '7', body: 'x' } }))), 'ask');
  // Another hook rewrote the input before the run: the call is the same one.
  run(HOOK, b, ['post'], call('PostToolUse', { tool_use_id: 'toolu_1', tool_input: { change: '7', body: 'x', extra: true } }));
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['answered']);
  // The same input from the session and from its subordinate: two calls, two questions.
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const same = { change: '8', body: 'y' };
  assert.equal(decision(run(HOOK, b, ['pre'], call('PreToolUse', { tool_use_id: 'toolu_2', tool_input: same }))), 'ask');
  assert.equal(decision(run(HOOK, b, ['pre'], call('PreToolUse', { tool_use_id: 'toolu_3', tool_input: same, agent_id: 'agent-1', agent_type: 'reviewer' }))), 'ask');
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['answered', 'refused'], 'only the question of the session ended');
  run(HOOK, b, ['post'], call('PostToolUse', { tool_use_id: 'toolu_3', tool_input: same, agent_id: 'agent-1', agent_type: 'reviewer' }));
  assert.deepEqual(decisions(b).map((d) => d.decision), ['answered', 'refused', 'answered']);
});

test('claude-code: a tool that the human broke off is neither a "yes" nor a "no"', () => {
  const b = box();
  run(HOOK, b, ['prompt'], hookEvent(b, 'UserPromptSubmit'));
  const input = { change: '7', body: 'x' };
  assert.equal(decision(pre(b, 'mcp__tracker__add_comment', input)), 'ask');
  run(HOOK, b, ['post'], hookEvent(b, 'PostToolUseFailure', { tool_name: 'mcp__tracker__add_comment', tool_input: input, error: 'interrupted', is_interrupt: true }));
  run(HOOK, b, ['stop'], hookEvent(b, 'Stop'));
  assert.deepEqual(decisions(b), []);
  assert.deepEqual(fs.readdirSync(path.join(b.state, 'pending')), []);
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
