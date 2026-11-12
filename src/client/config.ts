// The config of the harness on a machine: the directories of the packs and of the state.
// $REINS_CONFIG or ~/.config/reins/config.json. The gate reads its own keys from the same file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isObj } from '../contracts/shape.ts';
import type { Runtime } from '../core/runtime.ts';
import { openJournal } from '../journal/writer.ts';
import { findRoot } from '../gate/index.ts';
import { PACK_LEVELS, loadPacks, type PackLevel } from '../packs/packs.ts';

// The keys of the file: of the harness, and of the gate (src/gate/config.cjs).
// `source`: the directory of the source of the harness. A plugin that a client copied into its
// cache has no core beside it: its entry loads the adapter from this directory.
// `runner`: the command that starts a client without a window, as a list of words; `{task}` and
// `{prompt}` in a word are filled in, and `{model}` with the model of the level of the task. `runner_timeout_s`: the time limit of one run.
const KEYS = ['packs', 'source', 'state_dir', 'memory_dir', 'memory_commit', 'script_sandbox', 'repo_packs', 'runner', 'runner_timeout_s', 'runner_parallel', 'notify', 'markers', 'protected_branches', 'prod_hosts', 'prod_scripts', 'prod_fastlane_lanes', 'mcp_prod_servers', 'forms', 'ignore', 'rules', 'repos'];

export class ConfigError extends Error {
  code: 'no_config' | 'bad_config';
  file: string;
  constructor(code: 'no_config' | 'bad_config', file: string) {
    super(code);
    this.code = code;
    this.file = file;
  }
}

export function readConfig(): { file: string; packs: Partial<Record<PackLevel, string>>; stateDir: string; repoPacks: boolean; memoryDir?: string; memoryCommit?: boolean; scriptSandbox?: boolean; notify?: string[]; runner?: string[]; runnerTimeoutMs?: number; runnerParallel?: number } {
  const file = process.env.REINS_CONFIG ?? path.join(os.homedir(), '.config', 'reins', 'config.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError('no_config', file);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigError('bad_config', file);
  }
  const bad = new ConfigError('bad_config', file);
  if (!isObj(value) || !isObj(value.packs)) throw bad;
  // A key that nothing reads is a mistake: `state-dir` would silently mean the default directory.
  if (Object.keys(value).some((k) => !KEYS.includes(k))) throw bad;
  const packs: Partial<Record<PackLevel, string>> = {};
  for (const [level, dir] of Object.entries(value.packs)) {
    if (!(PACK_LEVELS as readonly string[]).includes(level) || typeof dir !== 'string' || !path.isAbsolute(dir)) throw bad;
    packs[level as PackLevel] = dir;
  }
  const stateDir = value.state_dir ?? path.join(os.homedir(), '.local', 'state', 'reins');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw bad;
  if (value.repo_packs !== undefined && typeof value.repo_packs !== 'boolean') throw bad;
  if (value.source !== undefined && (typeof value.source !== 'string' || !path.isAbsolute(value.source))) throw bad;
  // The memory records can live in a directory of the instance, for example a repository with history.
  if (value.memory_dir !== undefined && (typeof value.memory_dir !== 'string' || !path.isAbsolute(value.memory_dir))) throw bad;
  // The history of the records: the harness commits the directory itself when the config says so.
  if (value.memory_commit !== undefined && typeof value.memory_commit !== 'boolean') throw bad;
  // The scripts of the packs run in the sandbox of the system when the config says so.
  if (value.script_sandbox !== undefined && typeof value.script_sandbox !== 'boolean') throw bad;
  // The runner is a command that the harness starts: a list of words, never one line for a shell.
  if (value.runner !== undefined && (!Array.isArray(value.runner) || value.runner.length === 0 || value.runner.some((w) => typeof w !== 'string' || w === ''))) throw bad;
  // The notice is a command of the same form: a list of words, `{text}` is the text of the notice.
  if (value.notify !== undefined && (!Array.isArray(value.notify) || value.notify.length === 0 || value.notify.some((w) => typeof w !== 'string' || w === ''))) throw bad;
  if (value.runner_timeout_s !== undefined && (typeof value.runner_timeout_s !== 'number' || !Number.isInteger(value.runner_timeout_s) || value.runner_timeout_s <= 0)) throw bad;
  // How many clients the schedule or an event runs at one time, each in its own work tree.
  if (value.runner_parallel !== undefined && (typeof value.runner_parallel !== 'number' || !Number.isInteger(value.runner_parallel) || value.runner_parallel < 1 || value.runner_parallel > 8)) throw bad;
  const out: { file: string; packs: Partial<Record<PackLevel, string>>; stateDir: string; repoPacks: boolean; memoryDir?: string; memoryCommit?: boolean; scriptSandbox?: boolean; notify?: string[]; runner?: string[]; runnerTimeoutMs?: number; runnerParallel?: number } = { file, packs, stateDir, repoPacks: value.repo_packs === true };
  if (Array.isArray(value.runner)) out.runner = value.runner as string[];
  if (Array.isArray(value.notify)) out.notify = value.notify as string[];
  if (typeof value.runner_timeout_s === 'number') out.runnerTimeoutMs = value.runner_timeout_s * 1000;
  if (typeof value.runner_parallel === 'number') out.runnerParallel = value.runner_parallel;
  if (typeof value.memory_dir === 'string') out.memoryDir = value.memory_dir;
  if (value.memory_commit === true) out.memoryCommit = true;
  if (value.script_sandbox === true) out.scriptSandbox = true;
  return out;
}

// The runtime of one call of a client. `cwd` is the directory where the client works: its token
// is the project of the rows of the journal.
// The directory of the repository that a work tree belongs to. The common directory of git of a
// linked work tree is the `.git` of the repository.
function mainRoot(root: { root: string; gitDir?: string | null; commonDir?: string | null }): string {
  const common = root.commonDir;
  // The repository itself keeps the name that it always had: the path as the client gives it. A
  // project that the human reaches through a link keeps its memory. A linked work tree is named
  // by its repository as git names it (the real path): for a repository behind a link the two
  // names differ, and the work tree is then a project of its own.
  return typeof common === 'string' && common !== root.gitDir && path.basename(common) === '.git' ? path.dirname(common) : root.root;
}

export function loadRuntime(cwd: string = process.cwd()): Runtime {
  const config = readConfig();
  // The pack of the project lies with the project: `.reins` at the root of the repository where
  // the client works. A pack that the config names comes first.
  // A pack holds scripts that the harness runs, so a pack from a repository is trusted only when
  // the config says so (`repo_packs: true`): a checked-out branch of another author is not a pack.
  // The directory is protected from the agent in every case, also before it exists.
  const root = findRoot(cwd);
  const repoPack = root.isRepo ? path.join(root.root, '.reins') : undefined;
  if (config.packs.project === undefined && config.repoPacks && repoPack !== undefined && fs.existsSync(path.join(repoPack, 'pack.json'))) config.packs.project = repoPack;
  // The project is the repository where the client works, whatever directory of it the client
  // started in. Outside a repository it is the directory itself.
  // A linked work tree of a repository (`git worktree`) is the same project as the repository:
  // its memory, its cases and its state are those of the repository.
  // A client that the harness started in a work tree of its own making gets the project of the
  // run by name: the path of that work tree says nothing about a repository behind a link.
  const given = process.env.REINS_HEADLESS === '1' ? process.env.REINS_PROJECT : undefined;
  const project = given !== undefined && /^p[0-9a-f]{8}$/.test(given) ? given : `p${crypto.createHash('sha1').update(root.isRepo ? mainRoot(root) : cwd).digest('hex').slice(0, 8)}`;
  const rt: Runtime = { merged: loadPacks(config.packs), stateDir: config.stateDir, journal: openJournal(config.stateDir), project, configFile: config.file, workDir: cwd };
  if (repoPack !== undefined) rt.projectPackDir = repoPack;
  if (config.memoryDir !== undefined) rt.memoryDir = config.memoryDir;
  if (config.memoryCommit === true) rt.memoryCommit = true;
  if (config.scriptSandbox === true) rt.scriptSandbox = true;
  if (config.runner !== undefined) rt.runner = config.runner;
  if (config.notify !== undefined) rt.notify = config.notify;
  if (config.runnerTimeoutMs !== undefined) rt.runnerTimeoutMs = config.runnerTimeoutMs;
  if (config.runnerParallel !== undefined) rt.runnerParallel = config.runnerParallel;
  return rt;
}

// The runtime of the adapter of a client: every row that it writes to the journal names the
// client. A command of the harness itself (`reins ...`) names none.
export function clientRuntime(rt: Runtime, client: string): Runtime {
  const inner = rt.journal;
  return {
    ...rt,
    journal: {
      file: inner.file,
      get failures() { return inner.failures; },
      set failures(n: number) { inner.failures = n; },
      write: (row) => inner.write(row.client === undefined ? { ...row, client } : row),
    },
  };
}
