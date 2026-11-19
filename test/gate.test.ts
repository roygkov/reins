// Replays the decision corpus of the shell gate (ported from agentic v0.5.8) on fixture repositories.
// The corpus is data: test/data/gate-decisions.json, one case per command.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCases } from './cases.ts';

type Case = { repo: string; command: string; expect: string };

// A sandbox under the temp directory, outside any repository. Git stops at it and speaks only the file protocol.
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-corpus-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
{
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) delete env[k];
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: SB, env, encoding: 'utf8' });
  if (r.status === 0) throw new Error(`the test directory ${SB} is inside a git repository`);
}
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete process.env[k];
process.env.GIT_CEILING_DIRECTORIES = SB;
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.HOME = path.join(SB, 'home');
for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'AWS_PROFILE', 'KUBECONFIG', 'TF_WORKSPACE', 'CLOUDSDK_ACTIVE_CONFIG_NAME', 'DBT_TARGET']) delete process.env[k];
fs.mkdirSync(process.env.HOME, { recursive: true });

// The gate reads HOME when it loads: import it after the environment is set.
const { decideCommand, shellAction, setGitBudget } = await import('../src/gate/index.ts');
const { decide } = await import('../src/contracts/policy.ts');
// The decisions are about the command, not the machine: a wide budget for the read-only git calls.
setGitBudget({ perCall: 20000, total: 60000 });

function sh(dir: string, command: string): void {
  const r = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${command}: ${r.stderr}`);
}
function dirOf(name: string): string {
  const dir = path.join(SB, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const IDENTITY = 'git config user.email t@t && git config user.name t && git config commit.gpgsign false';

// A repository with branches, a pushed branch and two worktrees; `dirty` adds uncommitted work.
function workRepo(name: string, dirty: boolean): string {
  const dir = dirOf(name);
  sh(dir, `git init -q -b main && ${IDENTITY}`);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  sh(dir, 'git add -A && git commit -qm one && git branch merged');
  sh(dir, 'git checkout -q -b topic && echo t > t.txt && git add t.txt && git commit -qm topic && git checkout -q main');
  sh(dir, 'git checkout -q -b pushed && echo p > p.txt && git add p.txt && git commit -qm pushed && git update-ref refs/remotes/origin/pushed pushed && git checkout -q main');
  sh(dir, `git worktree add -q ../${name}-wt-clean merged`);
  sh(dir, `git worktree add -q -b wtdirty ../${name}-wt-dirty && echo x >> ../${name}-wt-dirty/a.txt`);
  if (dirty) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'u.txt'), 'untracked\n');
  }
  return dir;
}

// A repository with a network remote, on the given branch; `originHead` sets the default branch of the remote.
function hostedRepo(name: string, branch: string, originHead?: string): string {
  const dir = dirOf(name);
  sh(dir, `git init -q -b ${branch} && ${IDENTITY} && echo a > a.txt && git add -A && git commit -qm one`);
  sh(dir, 'git remote add origin https://example.invalid/o/r.git');
  if (originHead !== undefined) {
    sh(dir, `git update-ref refs/remotes/origin/${originHead} HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${originHead}`);
  }
  return dir;
}

const repos: Record<string, string> = {};
{
  // proj: not a real repository, only a HEAD on a feature branch and a package.json with scripts
  const proj = dirOf('proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js', 'deploy:prod': 'x', 'db:seed': 'x', build: 'x', release: 'x' } }));
  repos.proj = proj;
  repos.clean = workRepo('clean', false);
  repos.dirty = workRepo('dirty', true);
  repos.norepo = dirOf('norepo');
  repos.remotes = workRepo('remotes', false);
  sh(repos.remotes, `git remote add origin https://example.com/r.git && git remote add self . && git remote add up "file://${repos.clean}" && git config remotes.both "origin self"`);
  repos.localorigin = workRepo('localorigin', false);
  sh(repos.localorigin, `git remote add origin "${repos.clean}"`);
  repos.onmain = hostedRepo('onmain', 'main');
  repos.onfeature = hostedRepo('onfeature', 'feature/x');
  repos.ontrunk = hostedRepo('ontrunk', 'trunk', 'trunk');
  repos.crossfetch = hostedRepo('crossfetch', 'feature/x');
  sh(repos.crossfetch, 'git config --add remote.origin.fetch "+refs/heads/feature/x:refs/remotes/origin/main"');
  repos.prfetch = hostedRepo('prfetch', 'feature/x');
  sh(repos.prfetch, 'git config --add remote.origin.fetch "+refs/pull/*/head:refs/remotes/origin/pr/*"');
  sh(repos.prfetch, 'git config --add remote.origin.fetch "+refs/merge-requests/*/head:refs/remotes/origin/merge-requests/*"');
}

const cases = loadCases<Case>('gate-decisions');

for (const repo of [...new Set(cases.map((c) => c.repo))].sort()) {
  const mine = cases.filter((c) => c.repo === repo);
  test(`gate: ${mine.length} decisions in the repository "${repo}" match the corpus`, () => {
    const dir = repos[repo];
    assert.ok(dir !== undefined, `no fixture for the repository "${repo}"`);
    const drift: string[] = [];
    for (const c of mine) {
      const r = decideCommand(c.command.replaceAll('<tmp>', SB), dir);
      const got = r === null ? 'allow' : `${r.decision} ${r.id}`;
      if (got !== c.expect) drift.push(`${c.command}: ${c.expect} => ${got}`);
    }
    assert.deepEqual(drift, []);
  });
}

test('gate: the corpus is whole', () => {
  assert.equal(cases.length, 440);
  const count = (o: string): number => cases.filter((c) => c.expect.split(' ')[0] === o).length;
  assert.deepEqual({ allow: count('allow'), ask: count('ask'), deny: count('deny') }, { allow: 188, ask: 252, deny: 0 });
});

test('gate to policy: a command that no rule matches passes by the default of the core', () => {
  const { action, layers } = shellAction('ls -la', repos.proj ?? '');
  const d = decide({ action, layers });
  assert.deepEqual([d.outcome, d.basis.layer, d.basis.rule], ['allow', 'core', 'default.shell']);
});

test('gate to policy: a rule of a dangerous class is the basis of the question', () => {
  const { action, layers } = shellAction('git push --force origin main', repos.proj ?? '');
  const d = decide({ action, layers });
  assert.equal(d.outcome, 'ask');
  assert.equal(d.basis.layer, 'core');
  assert.match(d.basis.rule, /^git\./);
});

test('gate to policy: the envelope lifts the question for a named reversible command outside production', () => {
  const { action, layers, result } = shellAction('git commit --no-verify -m wip', repos.proj ?? '');
  assert.equal(result?.id, 'git.no-verify');
  assert.deepEqual([action.env.production, action.env.known], [false, true]);
  const d = decide({ action, layers, envelope: [{ action: action.name, target: '', env: 'local', limit: 1, confirm: 'none' }] });
  assert.deepEqual([d.outcome, d.envelope], ['allow', 'applied']);
});

// The classes that agentic approved one action at a time: no envelope covers them.
for (const [command, rule] of [
  ['psql -h prod-db.example -c "drop table users"', 'data.destructive-sql'],
  ['psql -h db-prod.internal -U app -c "select count(*) from users"', 'data.prod-db'],
  ['npm publish', 'publish.npm'],
  ['rm -rf ~/Documents', 'blast.rm-outside'],
  ['git push origin main', 'git.push-protected'],
  // A delete of a protected ref of the remote and a mirror push cannot be undone.
  ['git push origin --delete main', 'git.push-delete'],
  ['git push --mirror origin', 'git.push-mirror'],
] as const) {
  test(`gate to policy: the envelope does not lift the question of ${rule}`, () => {
    const { action, layers, result } = shellAction(command, repos.proj ?? '');
    assert.equal(result?.id, rule);
    for (const env of ['local', 'unknown', 'production']) {
      const d = decide({ action, layers, envelope: [{ action: action.name, target: '', env, limit: 1, confirm: 'none' }] });
      assert.deepEqual([d.outcome, d.envelope], ['ask', 'production']);
    }
  });
}

test('gate to policy: a write through the API of the hosting is a write that another human sees', () => {
  for (const command of ['gh api -X POST repos/o/r/issues/1/comments -f body=x', 'glab api -X POST projects/1/notes']) {
    const { action, layers, result } = shellAction(command, repos.proj ?? '');
    assert.deepEqual([result?.id, result?.cls], ['hosting.api-write', 'hosting']);
    assert.equal(action.kind === 'write' && action.outward, true);
    // The function of the policy asks for one confirmation, like for any outward write. The event
    // entry gives no envelope to a command of the shell: there the question stays a question.
    const d = decide({ action, layers, envelope: [{ action: action.name, target: '', env: 'local', limit: 1, confirm: 'none' }] });
    assert.deepEqual([d.outcome, d.envelope], ['ask', 'confirm']);
  }
  // A local command of the class git stays a plain local write.
  const local = shellAction('git commit --no-verify -m wip', repos.proj ?? '').action;
  assert.equal(local.kind === 'write' && local.outward, undefined);
});

test('gate to policy: a git discard is approved one action at a time', () => {
  const { action, layers, result } = shellAction('git reset --hard', repos.dirty ?? '');
  assert.equal(result?.id, 'git.discard.reset');
  const d = decide({ action, layers, envelope: [{ action: action.name, target: '', env: 'unknown', limit: 1, confirm: 'none' }] });
  assert.deepEqual([d.outcome, d.envelope], ['ask', 'production']);
});

test('gate to policy: the envelope does not lift the question for a production command', () => {
  const { action, layers } = shellAction('kubectl delete pod x --context prod-eu', repos.proj ?? '');
  assert.equal(action.env.production, true);
  const d = decide({ action, layers, envelope: [{ action: action.name, target: '', env: 'production', limit: 1, confirm: 'none' }] });
  assert.deepEqual([d.outcome, d.envelope], ['ask', 'production']);
});
