// The done check past its first cut: an answer holds only for the work that the check saw, and
// a script of a pack gets only what the manifest names and must not change the work.
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
import { validateManifest } from '../src/contracts/manifest.ts';
import { applyEvent, loadTask, openScenario, runCheck, submitReport, verifyWork, type Runtime } from '../src/core/runtime.ts';
import { dueChecks, sweep } from '../src/core/sweep.ts';
import { runCollect, sandboxProfile } from '../src/core/collect.ts';
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

// ---- The sandbox of the system for the scripts of the packs.

const MAC = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
const state = (b: Box) => {
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(opened.ok);
  return [opened.task.state, opened.task.label];
};

test('sandbox: with the key of the config a collect script cannot write outside the temporary directories', { skip: !MAC }, () => {
  // A place outside the temporary directories: beside this test. The test boxes lie in a temporary directory.
  const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), `sandbox-probe-${process.pid}.tmp`);
  // The write fails inside the script; a write into the temporary directory works.
  const script = `#!/bin/sh\ncat >/dev/null\necho x > "${probe}" 2>/dev/null\n[ -e "${probe}" ] && exit 6\necho x > "$TMPDIR/reins-sandbox-test.$$" || exit 5\nrm -f "$TMPDIR/reins-sandbox-test.$$"\nprintf '%s' '$OUT'\n`;
  try {
    const b = box({ collect: script });
    b.rt.scriptSandbox = true;
    assert.deepEqual(state(b), ['executing', undefined]);
    assert.equal(fs.existsSync(probe), false);
    // Without the key the same script writes the file.
    assert.deepEqual(state(box({ collect: script })), ['closed', 'not_verified']);
    assert.equal(fs.existsSync(probe), true);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('sandbox: a check script runs in the sandbox too, and can write only into the work that it checks', { skip: !MAC }, () => {
  const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), `sandbox-check-${process.pid}.tmp`);
  // The tests of a work write their output into the work: a place that git does not track. Any other place is closed.
  const check = `#!/bin/sh\ncat >/dev/null\necho x > "${probe}" 2>/dev/null\n[ -e "${probe}" ] && exit 6\necho built > $WORK/.git/reins-check-output || exit 7\nprintf '%s' '{"outputs":{"result":"PASS"}}'\n`;
  try {
    const b = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check });
    b.rt.scriptSandbox = true;
    const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, {});
    assert.ok(opened.ok);
    const r = submitReport(b.rt, opened.task.id, 'done');
    assert.ok('step' in r && r.answer !== undefined);
    assert.equal(r.answer.result, 'PASS');
    assert.equal(fs.existsSync(probe), false);
    // The code of the harness itself is no work that a check writes into, also when a collect script names it.
    // The work here is this repository (outside the temporary directories): with the guard the write fails, without it the file appears.
    const repoRoot = path.dirname(path.dirname(probe));
    const writes = `#!/bin/sh\ncat >/dev/null\necho x > "${probe}" 2>/dev/null\nprintf '%s' '{"outputs":{"result":"PASS"}}'\n`;
    const names = `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ outputs: { diff: 'd', task: 1, discussion: [], worktree: repoRoot }, flags: { has_new_commits: true } })}'\n`;
    for (const guard of [true, false]) {
      const own = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check: writes, collect: names });
      own.rt.scriptSandbox = true;
      if (guard) own.rt.harnessDirs = [repoRoot];
      const task = openScenario(own.rt, 'change-review', { change_id: '7' }, {});
      assert.ok(task.ok);
      submitReport(own.rt, task.task.id, 'done');
      assert.equal(fs.existsSync(probe), !guard, guard ? 'the code of the harness is closed' : 'a plain repository is the work of the check');
      fs.rmSync(probe, { force: true });
    }
    // A collect script that names the home directory as the work gives the check no place to write.
    const home = process.env.HOME;
    const wide = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check: `#!/bin/sh\ncat >/dev/null\necho x > "${probe}" 2>/dev/null\n[ -e "${probe}" ] && exit 6\nprintf '%s' '{"outputs":{"result":"PASS"}}'\n`, collect: `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ outputs: { diff: 'd', task: 1, discussion: [], worktree: path.dirname(path.dirname(probe)) }, flags: { has_new_commits: true } })}'\n` });
    wide.rt.scriptSandbox = true;
    process.env.HOME = path.dirname(probe);
    try {
      const task = openScenario(wide.rt, 'change-review', { change_id: '7' }, {});
      assert.ok(task.ok);
      const answer = submitReport(wide.rt, task.task.id, 'done');
      assert.ok('step' in answer && answer.answer !== undefined);
      assert.equal(answer.answer.result, 'PASS');
      assert.equal(fs.existsSync(probe), false, 'a directory above the home directory is no work');
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('sandbox: the network is for a script whose manifest names a connector that needs it', { skip: !MAC }, async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  try {
    const script = `#!/bin/sh\ncat >/dev/null\n/usr/bin/nc -z -G 2 127.0.0.1 ${port} || exit 3\nprintf '%s' '$OUT'\n`;
    const connectors = { read: ['code-host', 'tracker'], write: ['comment'] };
    // No connector of the pack needs the network: the script has none.
    const closed = box({ collect: script, organization: { connectors } });
    closed.rt.scriptSandbox = true;
    assert.deepEqual(state(closed), ['closed', 'not_verified']);
    // The manifest names a connector that needs the network.
    const open = box({ collect: script, organization: { connectors: { ...connectors, network: ['tracker'] } } });
    open.rt.scriptSandbox = true;
    assert.deepEqual(state(open), ['executing', undefined]);
    // Without the sandbox the network is as the system gives it.
    assert.deepEqual(state(box({ collect: script, organization: { connectors } })), ['executing', undefined]);
  } finally {
    server.close();
  }
});

test('sandbox: the files of a connector are for a script whose manifest names the connector', { skip: !MAC }, () => {
  const home = process.env.HOME;
  const script = "#!/bin/sh\ncat >/dev/null\ncat \"$HOME/.vault/token\" >/dev/null 2>&1 || exit 4\nprintf '%s' '$OUT'\n";
  const make = (files: Record<string, string[]>): Box => {
    const b = box({ collect: script, organization: { connectors: { read: ['code-host', 'tracker', 'vault'], write: ['comment'], files } } });
    fs.mkdirSync(path.join(b.root, '.vault'));
    fs.writeFileSync(path.join(b.root, '.vault', 'token'), 'secret');
    b.rt.scriptSandbox = true;
    process.env.HOME = b.root;
    return b;
  };
  try {
    // The manifest of the review names `code-host` and `tracker`, not `vault`.
    assert.deepEqual(state(make({ vault: ['~/.vault'] })), ['closed', 'not_verified']);
    assert.deepEqual(state(make({ tracker: ['~/.vault'] })), ['executing', undefined]);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

test('sandbox: a system with no sandbox tool runs no script, and the pack says what a connector needs', () => {
  const r = runCollect('/bin/echo', { inputs: {} }, { outputs: [], flags: [], timeoutMs: 1000, maxBytes: 1000, sandbox: { network: false, denyRead: [], writable: [], tool: '/nonexistent/sandbox' } });
  assert.deepEqual(r, { ok: false, reason: 'no_sandbox' });
  const profile = sandboxProfile({ network: false, denyRead: ['/Users/x/.config/a "b"'], writable: ['/work/tree'] });
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n\(allow file-write\* .*\(subpath "\/work\/tree"\)\)\n\(deny network\*\)\n\(deny file-read\* \(subpath "\/Users\/x\/\.config\/a \\"b\\""\)\)$/);
  assert.equal(sandboxProfile({ network: true, denyRead: [], writable: [] }).includes('network'), false);
  // A check reaches this machine and nothing farther.
  const local = sandboxProfile({ network: false, denyRead: [], writable: [], local: true });
  assert.match(local, /\(deny network\*\)\n\(allow network-outbound \(remote ip "localhost:\*"\) \(remote unix-socket\)\)/);
  assert.equal(sandboxProfile({ network: true, denyRead: [], writable: [], local: true }).includes('localhost'), false);
  const base = { pack: 1, level: 'organization', name: 'acme', connectors: { read: ['tracker'], write: ['comment'] } };
  const errors = (connectors: Record<string, unknown>, level = 'organization') => validateSettings({ ...base, level, connectors: { ...base.connectors, ...connectors } }, level as 'organization').errors.map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors({ network: ['tracker'], files: { tracker: ['~/.config/tool'] } }), []);
  assert.deepEqual(errors({ network: ['other'] }), ['not_in_list connectors.network[0]']);
  assert.deepEqual(errors({ files: { other: ['~/x'], tracker: ['/etc/passwd', '~/../x', '~/ok'] } }), ['not_in_list connectors.files.other', 'bad_name connectors.files.tracker[0]', 'bad_name connectors.files.tracker[1]']);
  assert.deepEqual(errors({ network: ['tracker'], files: {} }, 'person'), ['not_allowed connectors.network', 'not_allowed connectors.files']);
});

test('ready: a collect script that changes the work and then fails leaves the fact in the journal', () => {
  const b = box({ collect: '#!/bin/sh\ncat >/dev/null\necho changed >> $WORK/a.txt\nexit 3\n' });
  openScenario(b.rt, 'change-review', { change_id: '7' }, {});
  assert.ok(readJournal(b.rt.journal.file).some((x) => x.kind === 'harness.failure' && x.data?.reason === 'changed_work'));
});

// ---- After a red answer the files of the check are protected.

const GUARDED = { kind: 'command', check: 'tests', retries: 2, source: 'worktree', guards: ['test/**', '*.config.json', '**/*.rules.json'] };
const RED = "#!/bin/sh\ncat >/dev/null\nif [ -e $WORK/green ]; then printf '%s' '{\"outputs\":{\"result\":\"PASS\"}}'; else printf '%s' '{\"outputs\":{\"result\":\"FAIL\"}}'; fi\n";
const EDIT: ClientTools = { read_file: { kind: 'read' }, write_file: { kind: 'local', path: 'path' }, shell: { kind: 'shell', command: 'command' } };

test('ready: after a red answer a change of the files of the check asks the human', () => {
  const b = box({ done: GUARDED, check: RED });
  fs.mkdirSync(path.join(b.cwd, 'test/deep'), { recursive: true });
  const edit = (file: string) => beforeAction(b.rt, { cwd: b.cwd, tool: 'write_file', input: { path: file }, session: 's1' }, EDIT);
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  // Before an answer of the check the tests are the work of the agent.
  assert.equal(edit('test/a.test.ts').outcome, 'allow');
  const r = submitReport(b.rt, id, REPORT);
  assert.ok('step' in r);
  assert.equal(r.step.task.state, 'executing', JSON.stringify(r));
  assert.equal(loadTask(b.rt, id)?.red, true);
  for (const file of ['test/a.test.ts', 'test/deep/b.test.ts', path.join(b.cwd, 'test/a.test.ts'), 'jest.config.json', './test/../test/x']) {
    const reply = edit(file);
    assert.deepEqual([reply.outcome, reply.rule], ['ask', 'protect.check'], file);
  }
  // The work itself stays free, and so does a file of the same name in another place.
  assert.equal(edit('a.txt').outcome, 'allow');
  assert.equal(edit('src/jest.config.json').outcome, 'allow');
  assert.equal(edit('src/test/a.ts').outcome, 'allow');
  assert.equal(edit(path.join(b.root, 'other/test/a.test.ts')).outcome, 'allow');
  // A command of the shell that writes there asks too; a read does not.
  const shell = (command: string) => beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command }, session: 's1' }, EDIT);
  assert.deepEqual([shell('echo x > test/a.test.ts').outcome, shell('echo x > test/a.test.ts').rule], ['ask', 'protect.check']);
  assert.equal(shell('cat test/a.test.ts').outcome, 'allow');
  // The directory of the tests is a target too: its removal removes the tests.
  assert.deepEqual([shell('rm -r test/deep').rule, shell('mv test old').rule], ['protect.check', 'protect.check']);
  // So is the work as a whole, and a directory that holds a file of a pattern with `*`. A directory
  // above the work of this box holds the state of the harness too: the stronger rule answers.
  assert.deepEqual([shell('rm -r ..').rule, shell(`rm -r ${b.cwd}`).rule], ['protect.state', 'protect.check']);
  fs.mkdirSync(path.join(b.cwd, 'conf/x'), { recursive: true });
  fs.writeFileSync(path.join(b.cwd, 'conf/x/a.rules.json'), '{}');
  fs.mkdirSync(path.join(b.cwd, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(b.cwd, 'plain/a.txt'), '');
  assert.equal(shell('rm -r conf').rule, 'protect.check');
  assert.equal(shell('rm -r plain').outcome, 'allow');
  const rows = readJournal(b.rt.journal.file);
  assert.ok(rows.some((x) => x.kind === 'policy.protected_attempt' && x.data?.rule === 'protect.check' && x.data?.outcome === 'ask'));
  for (const row of rows) assert.deepEqual(validateRow(row), [], row.kind);
  // A green answer ends the protection.
  fs.writeFileSync(path.join(b.cwd, 'green'), '');
  const again = submitReport(b.rt, id, REPORT);
  assert.ok('step' in again);
  assert.equal(again.step.task.state, 'publishing', JSON.stringify(again));
  assert.equal(loadTask(b.rt, id)?.red, undefined);
  assert.equal(edit('test/a.test.ts').outcome, 'allow');
});

test('ready: a task without the list of the files of its check protects nothing after a red answer', () => {
  const b = box({ done: { kind: 'command', check: 'tests', retries: 2, source: 'worktree' }, check: RED });
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  submitReport(b.rt, opened.task.id, REPORT);
  assert.equal(loadTask(b.rt, opened.task.id)?.red, true);
  assert.equal(beforeAction(b.rt, { cwd: b.cwd, tool: 'write_file', input: { path: 'test/a.test.ts' }, session: 's1' }, EDIT).outcome, 'allow');
});

test('ready: the list of the files of a check is a list of patterns inside the work', () => {
  const errors = (done: Record<string, unknown>) => validateManifest({ ...manifests.get('review'), done }).map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, guards: ['test/**', 'a/*.json', 'pom.xml'] }), []);
  assert.deepEqual(errors({ kind: 'citations', source: 'worktree', retries: 1, guards: ['test/**'] }), ['not_allowed done.guards']);
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, guards: ['/etc/x', '../x', 'a/../b', '', 7, 'a\\b'] }), [0, 1, 2, 3, 4, 5].map((i) => `bad_name done.guards[${i}]`));
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, guards: 'test' }), ['not_array done.guards']);
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, guards: Array.from({ length: 21 }, (_, i) => `d${i}/**`) }), ['not_in_range done.guards']);
});

// ---- The answer holds for one version of the check, for a term, and after a soak.

const PASSING = "#!/bin/sh\ncat >/dev/null\nif [ -e $WORK/../red ]; then printf '%s' '{\"outputs\":{\"result\":\"FAIL\"}}'; else printf '%s' '{\"outputs\":{\"result\":\"PASS\"}}'; fi\n";
const MIN = 60_000;

test('ready: a check that changed after its answer ends the publication without a verified result', () => {
  const same = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check: PASSING });
  const kept = accepted(same);
  assert.match(loadTask(same.rt, kept)?.check ?? '', /^[0-9a-f]{32}$/);
  assert.equal(verifyWork(same.rt, kept), true);
  const b = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check: PASSING });
  const id = accepted(b);
  fs.appendFileSync(path.join(b.root, 'packs/project/check/tests.sh'), '# weaker\n');
  assert.equal(verifyWork(b.rt, id), false);
  const task = loadTask(b.rt, id);
  assert.deepEqual([task?.state, task?.label], ['closed', 'not_verified']);
  const rows = readJournal(b.rt.journal.file);
  assert.equal(rows.find((x) => x.kind === 'check.invalidated')?.data?.reason, 'check_changed');
  assert.equal(rows.find((x) => x.kind === 'task.closed')?.data?.reason, 'check_changed');
  for (const row of rows) assert.deepEqual(validateRow(row), [], row.kind);
  // A check that is not there any more is not the same check.
  const gone = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check: PASSING });
  const lost = accepted(gone);
  fs.rmSync(path.join(gone.root, 'packs/project/check/tests.sh'));
  assert.equal(verifyWork(gone.rt, lost), false);
});

test('ready: an answer holds for the term that the manifest names', () => {
  const b = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree', valid_minutes: 5 }, check: PASSING });
  const id = accepted(b);
  const at = loadTask(b.rt, id)?.checked ?? 0;
  assert.ok(Math.abs(Date.now() - at) < MIN);
  assert.equal(verifyWork(b.rt, id, at + 4 * MIN), true);
  assert.equal(verifyWork(b.rt, id, at + 6 * MIN), false);
  assert.equal(readJournal(b.rt.journal.file).find((x) => x.kind === 'check.invalidated')?.data?.reason, 'expired');
  // Without the term an answer has no end of its own.
  const free = box({ done: { kind: 'command', check: 'tests', retries: 0, source: 'worktree' }, check: PASSING });
  assert.equal(verifyWork(free.rt, accepted(free), Date.now() + 600 * MIN), true);
});

test('ready: with a soak the first PASS is not the result: the check answers a second time after the term', () => {
  const done = { kind: 'external', check: 'tests', retries: 0, source: 'worktree', soak_minutes: 10 };
  const b = box({ done, check: PASSING });
  const opened = openScenario(b.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(opened.ok);
  const id = opened.task.id;
  const first = submitReport(b.rt, id, REPORT);
  assert.ok('step' in first);
  assert.equal(first.step.task.state, 'checking', JSON.stringify(first));
  const until = loadTask(b.rt, id)?.soak ?? 0;
  assert.ok(Math.abs(until - Date.now() - 10 * MIN) < MIN);
  assert.equal(comment(b).task, undefined, 'nothing is published during the soak');
  // Before the term the check does not run again.
  assert.deepEqual(runCheck(b.rt, id), { error: 'soaking' });
  assert.deepEqual(runCheck(b.rt, id, until - 1), { error: 'soaking' });
  const second = runCheck(b.rt, id, until + 1);
  assert.ok('step' in second);
  assert.equal(second.step.task.state, 'publishing');
  assert.equal(loadTask(b.rt, id)?.soak, undefined);
  const rows = readJournal(b.rt.journal.file);
  assert.deepEqual(rows.filter((x) => x.kind === 'check.answered').map((x) => [x.data?.result, x.data?.soak]), [['PASS', 10], ['PASS', undefined]]);
  for (const row of rows) assert.deepEqual(validateRow(row), [], row.kind);

  // A red second answer is a red answer: the first PASS counts nothing.
  const r = box({ done, check: PASSING });
  const o = openScenario(r.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(o.ok);
  submitReport(r.rt, o.task.id, REPORT);
  fs.writeFileSync(path.join(r.root, 'red'), '');
  const red = runCheck(r.rt, o.task.id, Date.now() + 11 * MIN);
  assert.ok('step' in red);
  assert.deepEqual([red.step.task.state, red.step.task.waiting, red.step.task.soak], ['waiting_human', 'check', undefined]);

  // The sweep of the harness gives the second answer when the term is over.
  const s = box({ done, check: PASSING });
  const so = openScenario(s.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(so.ok);
  submitReport(s.rt, so.task.id, REPORT);
  assert.deepEqual(dueChecks(s.rt, Date.now() + 5 * MIN), []);
  // A session start runs no script of a check.
  sweep(s.rt, Date.now() + 11 * MIN);
  assert.equal(loadTask(s.rt, so.task.id)?.state, 'checking');
  assert.deepEqual(dueChecks(s.rt, Date.now() + 11 * MIN), [so.task.id]);
  assert.equal(loadTask(s.rt, so.task.id)?.state, 'publishing');

  // The soak is about one state of the work: a change of the work during the term gives no answer.
  const w = box({ done, check: PASSING });
  const wo = openScenario(w.rt, 'change-review', { change_id: '7' }, { session: 's1' });
  assert.ok(wo.ok);
  submitReport(w.rt, wo.task.id, REPORT);
  fs.appendFileSync(path.join(w.cwd, 'a.txt'), 'one more line\n');
  const moved = runCheck(w.rt, wo.task.id, Date.now() + 11 * MIN);
  assert.ok('step' in moved);
  assert.deepEqual([moved.answer.result, moved.answer.reason, moved.step.task.state], ['none', 'work_changed', 'waiting_human']);
});

test('ready: the term of an answer and the soak are numbers of minutes in the manifest', () => {
  const errors = (done: Record<string, unknown>) => validateManifest({ ...manifests.get('review'), done }).map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors({ kind: 'external', check: 'tests', retries: 1, valid_minutes: 30, soak_minutes: 10 }), []);
  assert.deepEqual(errors({ kind: 'citations', source: 'worktree', retries: 1, valid_minutes: 30 }), []);
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, soak_minutes: 10 }), ['not_allowed done.soak_minutes']);
  assert.deepEqual(errors({ kind: 'human', retries: 1, valid_minutes: 10 }), ['not_allowed done.valid_minutes']);
  assert.deepEqual(errors({ kind: 'external', check: 'tests', retries: 1, valid_minutes: 0, soak_minutes: 1441 }), ['not_in_range done.valid_minutes', 'not_in_range done.soak_minutes']);
  assert.deepEqual(errors({ kind: 'external', check: 'tests', retries: 1, valid_minutes: '5', soak_minutes: 1.5 }), ['not_integer done.valid_minutes', 'not_integer done.soak_minutes']);
});
