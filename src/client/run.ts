// A task without a window. The harness has no model of its own: the config of the machine names
// the command that starts a client (`runner`), and the harness starts it for one task. The words
// `{task}`, `{prompt}` and `{model}` of the command are filled in. The client
// runs with REINS_HEADLESS=1: nobody answers a question there, so a question becomes a place in
// the queue of the human.
// Specification: docs/spec/harness-client, page 5.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTask, type Runtime } from '../core/runtime.ts';
import { MODEL_NAME } from '../packs/packs.ts';

export type RunReply = { ran: boolean; exit?: number; error?: 'no_runner' | 'nested_run' | 'no_model' | 'timeout' | 'start_failed' };

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// The program that runs the client as the leader of a group of processes: the time limit stops the group.
const GROUP = fileURLToPath(new URL('./group.cjs', import.meta.url));

// The words for the client: where the task is and how to work on it. Nothing of the task itself:
// the client reads the input of the task from the harness.
export const runPrompt = (id: string): string =>
  `Work on the task ${id} of the harness. Read its input with \`reins input ${id}\`, do what the input says, and submit the report with \`reins report ${id} <file>\`. Nobody answers questions in this run.`;

// The command of the client for one task, or the reason why it cannot start.
function commandFor(rt: Runtime, id: string): { command: string; args: string[] } | { error: NonNullable<RunReply['error']> } {
  // A client that runs without a window does not start another client.
  if (process.env.REINS_HEADLESS === '1') return { error: 'nested_run' };
  const runner = rt.runner;
  if (runner === undefined || runner.length === 0) return { error: 'no_runner' };
  // `{model}`: the name of the model of the client for the level of the task, as the packs name it.
  // A runner that asks for a model and gets no name does not start: a wrong model is worse than none.
  let model = '';
  if (runner.some((part) => part.includes('{model}'))) {
    const task = loadTask(rt, id);
    const level = task?.level ?? task?.manifest?.model.level ?? 'medium';
    const name = rt.merged.models[level];
    // The packs are checked when they load; the check here holds for any other way a name comes in.
    if (name === undefined || !MODEL_NAME.test(name)) return { error: 'no_model' };
    model = name;
  }
  const [command, ...args] = runner.map((part) => part.replaceAll('{task}', id).replaceAll('{prompt}', runPrompt(id)).replaceAll('{model}', model));
  if (command === undefined) return { error: 'no_runner' };
  return { command, args };
}

// A timer of the runtime takes no more than this (about 24 days): a longer limit would end the run at once.
const limitOf = (rt: Runtime): number => Math.min(rt.runnerTimeoutMs ?? DEFAULT_TIMEOUT_MS, 2_000_000_000);

// The answer of the program between: one JSON line.
function replyOf(text: string): RunReply {
  let reply: { exit?: unknown; error?: unknown } = {};
  try {
    reply = JSON.parse(text.split('\n')[0] ?? '');
  } catch {
    // no answer: the program between did not run to its end
  }
  if (reply.error === 'timeout') return { ran: false, error: 'timeout' };
  if (typeof reply.exit !== 'number') return { ran: false, error: 'start_failed' };
  return { ran: true, exit: reply.exit };
}

export function runTask(rt: Runtime, id: string): RunReply {
  const made = commandFor(rt, id);
  if ('error' in made) return { ran: false, error: made.error };
  // The command runs directly, without a shell: the words of the prompt never become a command line.
  // The client runs in its own group of processes: at the time limit the whole group stops, so a
  // process that the client started does not stay. A process that left the group on purpose is
  // out of reach.
  const timeoutMs = limitOf(rt);
  const r = spawnSync(process.execPath, [GROUP, JSON.stringify({ command: made.command, args: made.args, timeoutMs })], {
    cwd: rt.workDir ?? process.cwd(),
    env: { ...process.env, REINS_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    // The program between stops the group itself; this limit holds only when it does not.
    timeout: timeoutMs + 10_000,
    killSignal: 'SIGKILL',
  });
  if (r.error !== undefined) return { ran: false, error: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'start_failed' };
  return replyOf(r.stdout);
}

// ---- Several tasks at one time. Two clients in one work tree would change the work of each
// other, and the check of one would see the change of the other. So each client gets a work tree
// of its own: a linked work tree of the repository (`git worktree`), at the commit where the
// repository is now. A work that is no repository has no such copy: its tasks run one by one.

export type ManyReply = RunReply & { worktree?: string };

// The directory of the work trees: beside the state, not in it (the agent writes into its work).
export const worktreesDir = (rt: Runtime): string => path.join(path.dirname(rt.stateDir), `worktrees-${path.basename(rt.stateDir)}`);

const git = (cwd: string, args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: typeof r.stdout === 'string' ? r.stdout.trim() : '' };
};

// Runs the client for each task, `parallel` at one time. One task, or one at a time, is the plain run.
export function runTasks(rt: Runtime, ids: string[], parallel: number = rt.runnerParallel ?? 1): ManyReply[] {
  const base = rt.workDir ?? process.cwd();
  const top = git(base, ['rev-parse', '--show-toplevel']);
  // The work is the top of a repository with a commit: only then can each task get a copy.
  const head = top.ok && fs.realpathSync(top.out) === fs.realpathSync(base) ? git(base, ['rev-parse', '--verify', '-q', 'HEAD']) : { ok: false, out: '' };
  // A copy is made at the commit. A work with a change that is not committed would give the
  // client another work than the plain run gives: such tasks run one by one, in the work itself.
  const dirty = head.ok ? git(base, ['status', '--porcelain']) : { ok: false, out: '' };
  if (parallel <= 1 || ids.length <= 1 || !head.ok || !dirty.ok || dirty.out !== '') return ids.map((id) => runTask(rt, id));
  const out = new Map<string, ManyReply>();
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const timeoutMs = limitOf(rt);
  type Running = { id: string; file: string; tree: string; child: ReturnType<typeof spawn>; until: number };
  const running: Running[] = [];
  const queue = [...ids];
  const answered = (file: string): boolean => fs.readFileSync(file, 'utf8').includes('\n');
  const start = (id: string): void => {
    const made = commandFor(rt, id);
    if ('error' in made) {
      out.set(id, { ran: false, error: made.error });
      return;
    }
    const tree = path.join(worktreesDir(rt), id);
    fs.mkdirSync(worktreesDir(rt), { recursive: true });
    if (!git(base, ['worktree', 'add', '--detach', tree, head.out]).ok) {
      out.set(id, { ran: false, error: 'start_failed' });
      return;
    }
    // The answer of the program between goes to a file: this process does not read pipes while it waits.
    const file = path.join(worktreesDir(rt), `${id}.out`);
    const fd = fs.openSync(file, 'w');
    try {
      const child = spawn(process.execPath, [GROUP, JSON.stringify({ command: made.command, args: made.args, timeoutMs })], { cwd: tree, env: { ...process.env, REINS_HEADLESS: '1' }, stdio: ['ignore', fd, 'ignore'] });
      // A start that failed comes as an event, after the wait: it must not end this process.
      child.on('error', () => {});
      child.unref();
      // The time limit of the client, and a little more for the program between.
      running.push({ id, file, tree, child, until: Date.now() + timeoutMs + 15_000 });
    } catch {
      git(base, ['worktree', 'remove', '--force', tree]);
      fs.rmSync(file, { force: true });
      out.set(id, { ran: false, error: 'start_failed' });
    } finally {
      fs.closeSync(fd);
    }
  };
  const end = (r: Running): void => {
    const text = fs.readFileSync(r.file, 'utf8');
    const silent = !text.includes('\n');
    // No answer in time: the program between hangs or died. It is stopped, and its work tree stays.
    if (silent) {
      try {
        r.child.kill('SIGKILL');
      } catch {
        // it is gone already
      }
    }
    const reply: ManyReply = silent ? { ran: false, error: 'timeout' } : replyOf(text);
    fs.rmSync(r.file, { force: true });
    // A work tree that the client left as it was goes away. One with a change or with a new
    // commit stays: the human finds the work of the task there.
    const clean = git(r.tree, ['status', '--porcelain']);
    const now = git(r.tree, ['rev-parse', 'HEAD']);
    if (!silent && clean.ok && clean.out === '' && now.ok && now.out === head.out && git(base, ['worktree', 'remove', r.tree]).ok) out.set(r.id, reply);
    else out.set(r.id, { ...reply, worktree: r.tree });
  };
  // A pool, not batches: the next task starts as soon as a client ends.
  while (queue.length > 0 || running.length > 0) {
    while (running.length < parallel && queue.length > 0) start(queue.shift() as string);
    if (running.length === 0) continue;
    Atomics.wait(wait, 0, 0, 200);
    for (const r of [...running]) {
      if (!answered(r.file) && Date.now() < r.until) continue;
      running.splice(running.indexOf(r), 1);
      end(r);
    }
  }
  return ids.map((id) => out.get(id) ?? { ran: false, error: 'start_failed' });
}
