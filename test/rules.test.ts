// The rules of the packs as layers of the policy, and the reading of the journal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, validateSettings } from '../src/packs/packs.ts';
import { openJournal, readJournal } from '../src/journal/writer.ts';
import { openScenario, submitReport, type Runtime } from '../src/core/runtime.ts';
import { beforeAction, type ClientTools } from '../src/client/before.ts';
import { summarize } from '../src/journal/metrics.ts';
import { loadCases } from './cases.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { read_file: { kind: 'read' }, shell: { kind: 'shell', command: 'command' } };
const TOOLS = {
  'tracker__get_*': { kind: 'read' },
  'tracker__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'work' },
  'live__add_comment': { kind: 'write', action: 'comment', target: 'change/{change}', env: 'live' },
};
const RULES = {
  organization: [{ id: 'no-live-comments', outcome: 'deny', action: 'comment', env: 'live' }, { id: 'ask-secrets', outcome: 'ask', tool: 'tracker__get_secret*' }],
  project: [{ id: 'no-deploy-script', outcome: 'deny', command: './deploy.sh' }],
  person: [{ id: 'careful-comments', outcome: 'ask', tool: 'tracker__add_comment' }],
};

type Box = { rt: Runtime; root: string; cwd: string; config: string };
let n = 0;
function box(rules: Record<string, unknown[]> = RULES): Box {
  n += 1;
  const root = path.join(SB, String(n));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'const limit = items.length;\n');
  const out = { outputs: { diff: 'd', task: 1, discussion: [], worktree: cwd }, flags: { has_new_commits: true } };
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const level = rel.split('/')[0] ?? '';
    if (rel.endsWith('.sh')) fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`, { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel.endsWith('pack.json')) fs.writeFileSync(file, JSON.stringify({ ...(value as object), ...(level === 'organization' ? { tools: TOOLS } : {}), ...(rules[level] !== undefined ? { rules: rules[level] } : {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const packs = { organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') };
  const merged = loadPacks(packs);
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ packs, state_dir: stateDir }));
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', collectTimeoutMs: 10_000 }, root, cwd, config };
}
const decide = (b: Box, tool: string, input: Record<string, unknown>) => beforeAction(b.rt, { cwd: b.cwd, tool, input }, CLIENT);

for (const [name, tool, input, outcome, layer, rule] of [
  ['a rule of the organization refuses a write in an environment', 'live__add_comment', { change: '7' }, 'deny', 'organization', 'no-live-comments'],
  ['a rule can make a read ask', 'tracker__get_secret_key', {}, 'ask', 'organization', 'ask-secrets'],
  ['a read that no rule names passes', 'tracker__get_change', {}, 'allow', 'core', 'default.read'],
  ['a rule of the project refuses a shell command by its text', 'shell', { command: 'cd x && ./deploy.sh prod' }, 'deny', 'project', 'no-deploy-script'],
  ['a shell command that no rule names passes', 'shell', { command: 'ls' }, 'allow', 'core', 'default.shell'],
] as const) {
  test(`rules: ${name}`, () => {
    const r = decide(box(), tool, input);
    assert.deepEqual([r.outcome, r.layer, r.rule], [outcome, layer, rule]);
  });
}

test('rules: a rule of the person keeps the question even when the envelope of a task names the write', () => {
  const b = box();
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' });
  assert.ok(opened.ok);
  const r = decide(b, 'tracker__add_comment', { change: '7' });
  assert.deepEqual([r.outcome, r.task], ['ask', opened.task.id]);
  const basis = readJournal(b.rt.journal.file).findLast((x) => x.kind === 'policy.basis')?.data;
  assert.ok(basis !== undefined, 'the basis of the decision is in the journal');
});

test('rules: the strictest rule of all levels wins', () => {
  const b = box({ organization: [{ id: 'org-ask', outcome: 'ask', tool: 'tracker__get_*' }], person: [{ id: 'me-deny', outcome: 'deny', tool: 'tracker__get_change' }] });
  const r = decide(b, 'tracker__get_change', {});
  assert.deepEqual([r.outcome, r.layer, r.rule], ['deny', 'person', 'me-deny']);
});

for (const [name, rules, errors] of [
  ['a rule cannot allow', [{ id: 'x', outcome: 'allow', tool: 'a' }], ['not_in_list rules[0].outcome']],
  ['a rule names what it matches', [{ id: 'x', outcome: 'ask' }], ['missing rules[0].match']],
  ['a rule has a plain id and known fields', [{ id: 'Bad Id', outcome: 'ask', tool: 'a', when: 'now' }], ['bad_name rules[0].id', 'unknown_field rules[0].when']],
  ['two rules of a pack cannot share an id', [{ id: 'x', outcome: 'ask', tool: 'a' }, { id: 'x', outcome: 'deny', tool: 'b' }], ['duplicate rules[1].id']],
  ['the rules are a list', { id: 'x' }, ['not_array rules']],
] as const) {
  test(`rules: pack: ${name}`, () => {
    const got = validateSettings({ pack: 1, level: 'person', name: 'me', rules }, 'person').errors.map((e) => `${e.code} ${e.path}`);
    assert.deepEqual(got, [...errors]);
  });
}

test('status: the journal is read into counts', () => {
  const b = box({});
  const one = openScenario(b.rt, 'change-review', { change_id: '7' });
  const two = openScenario(b.rt, 'change-review', { change_id: '8' });
  assert.ok(one.ok && two.ok);
  submitReport(b.rt, one.task.id, 'not json');
  submitReport(b.rt, one.task.id, JSON.stringify({ items: [] }));
  decide(b, 'tracker__add_comment', { change: '7' });
  decide(b, 'tracker__get_change', {});
  decide(b, 'launch_rocket', {});
  const m = summarize(readJournal(b.rt.journal.file));
  assert.deepEqual(m.tasks, { opened: 3, closed: 0, by_label: {} });
  assert.deepEqual(m.scenarios, { 'change-review': { opened: 2, accepted: 1, returns: 1 } });
  assert.deepEqual(m.checks, { PASS: 1, FAIL: 1, none: 0 });
  assert.deepEqual(m.decisions, { allow: 1, ask: 2, defer: 0, deny: 0 });
  assert.deepEqual([m.protected_attempts, m.failures, m.shape_changes], [0, 0, 0]);
});

test('status: only rows inside the period are counted', () => {
  const rows = [
    { ts: '2026-11-01T10:00:00.000Z', v: 1, kind: 'task.opened', project: 'p', task: 't1' },
    { ts: '2026-11-10T10:00:00.000Z', v: 1, kind: 'task.opened', project: 'p', task: 't2' },
    { ts: '2026-11-10T11:00:00.000Z', v: 1, kind: 'task.closed', project: 'p', task: 't2', data: { label: 'not_verified' } },
  ] as never[];
  const m = summarize(rows, Date.parse('2026-11-05T00:00:00Z'));
  assert.deepEqual(m.tasks, { opened: 1, closed: 1, by_label: { not_verified: 1 } });
});

test('status: the command line shows the counts, the open tasks and the packs', () => {
  const b = box({});
  openScenario(b.rt, 'change-review', { change_id: '7' });
  const p = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: b.root, REINS_CONFIG: b.config } });
  const out = JSON.parse(p.stdout);
  assert.deepEqual([p.status, out.ok, out.days, out.metrics.tasks.opened, out.open_tasks, out.rejected], [0, true, 7, 1, 1, []]);
  assert.deepEqual(out.packs.map((x: any) => [x.level, x.connected]), [['organization', true], ['project', true], ['person', true]]);
});
