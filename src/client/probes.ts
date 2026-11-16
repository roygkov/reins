// The measure of the barrier: commands with a known answer. A pack can hold a file
// `gate-probes.json`, a list of `{ "command": ..., "expect": "pass" | "ask" | "deny", "note": ... }`.
// The harness asks its barrier about each command, with no task and no journal, and names the
// commands whose answer is not the expected one:
//   a miss: the barrier is softer than expected (it lets pass where it must ask or refuse);
//   a noise: the barrier is stricter than expected (it asks where nothing is due).
// The human adds a command when the barrier was wrong about it: the set grows from real cases.
// In a command `{harness}` is the directory of the code of the harness, `{packs}` the directory
// of the pack of the file, `{state}` the state directory, `{home}` the home directory.
// A probe can name the state of the work tree that its command is asked in (`tree`): `changed`,
// a repository with a changed tracked file, or `clean`, a repository without a change. The
// barrier looks at the work tree for some commands (`git reset --hard` loses work only where a
// file is changed): without the state the answer follows the directory where the probes run.
// The harness makes the repository for the run and removes it; the command itself never runs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from '../core/runtime.ts';
import { probeCommand } from './before.ts';

export const PROBES_FILE = 'gate-probes.json';
const MAX_PROBES = 500;
const MAX_COMMAND = 2000;
const RANK = { pass: 0, allow: 0, ask: 1, deny: 2 } as const;

export type ProbeFault = { pack: string; n: number; expect: 'pass' | 'ask' | 'deny'; got: 'allow' | 'ask' | 'deny'; rule?: string; note?: string };
// `n`: the commands that were asked. `bad`: the files and the items that cannot be read as a probe.
export type ProbeResult = { n: number; bad: number; misses: ProbeFault[]; noise: ProbeFault[] };

const TREES = ['changed', 'clean'] as const;
type Tree = (typeof TREES)[number];

// A repository of one commit for the probes that name a state. null: git is not there or it failed.
function makeTree(tree: Tree): string | null {
  let dir: string | null = null;
  try {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-probe-')));
    const made = dir;
    const git = (...args: string[]): boolean => spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: made, stdio: 'ignore', timeout: 10_000 }).status === 0;
    fs.writeFileSync(path.join(made, 'work.txt'), 'first\n');
    if (!git('init', '-q') || !git('add', 'work.txt') || !git('commit', '-q', '--no-verify', '-m', 'probe')) throw new Error('git');
    if (tree === 'changed') fs.writeFileSync(path.join(made, 'work.txt'), 'first\nchanged\n');
    return made;
  } catch {
    if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

export function runProbes(rt: Runtime, cwd: string): ProbeResult {
  const out: ProbeResult = { n: 0, bad: 0, misses: [], noise: [] };
  // One repository of each state for the whole run, made at the first probe that names the state.
  const trees = new Map<Tree, string | null>();
  const treeOf = (tree: Tree): string | null => {
    if (!trees.has(tree)) trees.set(tree, makeTree(tree));
    return trees.get(tree) ?? null;
  };
  try {
    return askAll(rt, cwd, out, treeOf);
  } finally {
    for (const dir of trees.values()) if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function askAll(rt: Runtime, cwd: string, out: ProbeResult, treeOf: (tree: Tree) => string | null): ProbeResult {
  const harness = rt.harnessDirs?.[0] ?? '';
  for (const pack of rt.merged.packs) {
    const file = path.join(pack.dir, PROBES_FILE);
    if (!fs.existsSync(file)) continue;
    let items: unknown;
    try {
      items = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      items = null;
    }
    if (!Array.isArray(items) || items.length > MAX_PROBES) {
      out.bad += 1;
      continue;
    }
    items.forEach((item: unknown, i) => {
      const probe = item !== null && typeof item === 'object' ? (item as { command?: unknown; expect?: unknown; note?: unknown; tree?: unknown }) : {};
      const expect = probe.expect;
      if (typeof probe.command !== 'string' || probe.command === '' || probe.command.length > MAX_COMMAND || (expect !== 'pass' && expect !== 'ask' && expect !== 'deny')) {
        out.bad += 1;
        return;
      }
      // A state that the harness does not know, or a repository that could not be made: the probe cannot be asked.
      const where = probe.tree === undefined ? cwd : (TREES as readonly unknown[]).includes(probe.tree) ? treeOf(probe.tree as Tree) : null;
      if (where === null) {
        out.bad += 1;
        return;
      }
      const command = probe.command.replaceAll('{harness}', harness).replaceAll('{packs}', pack.dir).replaceAll('{state}', rt.stateDir).replaceAll('{home}', os.homedir());
      const got = probeCommand(rt, command, where);
      out.n += 1;
      if (RANK[got.outcome] === RANK[expect]) return;
      const fault: ProbeFault = { pack: pack.level, n: i + 1, expect, got: got.outcome, ...(got.rule !== undefined ? { rule: got.rule } : {}), ...(typeof probe.note === 'string' && probe.note.length <= 200 ? { note: probe.note } : {}) };
      (RANK[got.outcome] < RANK[expect] ? out.misses : out.noise).push(fault);
    });
  }
  return out;
}
