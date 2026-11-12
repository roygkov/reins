// A task without a window. The harness has no model of its own: the config of the machine names
// the command that starts a client (`runner`), and the harness starts it for one task. The words
// `{task}`, `{prompt}` and `{model}` of the command are filled in. The client
// runs with REINS_HEADLESS=1: nobody answers a question there, so a question becomes a place in
// the queue of the human.
// Specification: docs/spec/harness-client, page 5.

import { spawnSync } from 'node:child_process';
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

export function runTask(rt: Runtime, id: string): RunReply {
  // A client that runs without a window does not start another client.
  if (process.env.REINS_HEADLESS === '1') return { ran: false, error: 'nested_run' };
  const runner = rt.runner;
  if (runner === undefined || runner.length === 0) return { ran: false, error: 'no_runner' };
  // `{model}`: the name of the model of the client for the level of the task, as the packs name it.
  // A runner that asks for a model and gets no name does not start: a wrong model is worse than none.
  let model = '';
  if (runner.some((part) => part.includes('{model}'))) {
    const task = loadTask(rt, id);
    const level = task?.level ?? task?.manifest?.model.level ?? 'medium';
    const name = rt.merged.models[level];
    // The packs are checked when they load; the check here holds for any other way a name comes in.
    if (name === undefined || !MODEL_NAME.test(name)) return { ran: false, error: 'no_model' };
    model = name;
  }
  const [command, ...args] = runner.map((part) => part.replaceAll('{task}', id).replaceAll('{prompt}', runPrompt(id)).replaceAll('{model}', model));
  if (command === undefined) return { ran: false, error: 'no_runner' };
  // The command runs directly, without a shell: the words of the prompt never become a command line.
  // The client runs in its own group of processes: at the time limit the whole group stops, so a
  // process that the client started does not stay. A process that left the group on purpose is
  // out of reach.
  // A timer of the runtime takes no more than this (about 24 days): a longer limit would end the run at once.
  const timeoutMs = Math.min(rt.runnerTimeoutMs ?? DEFAULT_TIMEOUT_MS, 2_000_000_000);
  const r = spawnSync(process.execPath, [GROUP, JSON.stringify({ command, args, timeoutMs })], {
    cwd: rt.workDir ?? process.cwd(),
    env: { ...process.env, REINS_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    // The program between stops the group itself; this limit holds only when it does not.
    timeout: timeoutMs + 10_000,
    killSignal: 'SIGKILL',
  });
  if (r.error !== undefined) return { ran: false, error: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'start_failed' };
  let reply: { exit?: unknown; error?: unknown } = {};
  try {
    reply = JSON.parse(r.stdout.split('\n')[0] ?? '');
  } catch {
    // no answer: the program between did not run to its end
  }
  if (reply.error === 'timeout') return { ran: false, error: 'timeout' };
  if (typeof reply.exit !== 'number') return { ran: false, error: 'start_failed' };
  return { ran: true, exit: reply.exit };
}
