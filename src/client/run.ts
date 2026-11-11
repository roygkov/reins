// A task without a window. The harness has no model of its own: the config of the machine names
// the command that starts a client (`runner`), and the harness starts it for one task. The client
// runs with REINS_HEADLESS=1: nobody answers a question there, so a question becomes a place in
// the queue of the human.
// Specification: docs/spec/harness-client, page 5.

import { spawnSync } from 'node:child_process';
import type { Runtime } from '../core/runtime.ts';

export type RunReply = { ran: boolean; exit?: number; error?: 'no_runner' | 'nested_run' | 'timeout' | 'start_failed' };

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// The words for the client: where the task is and how to work on it. Nothing of the task itself:
// the client reads the input of the task from the harness.
export const runPrompt = (id: string): string =>
  `Work on the task ${id} of the harness. Read its input with \`reins input ${id}\`, do what the input says, and submit the report with \`reins report ${id} <file>\`. Nobody answers questions in this run.`;

export function runTask(rt: Runtime, id: string): RunReply {
  // A client that runs without a window does not start another client.
  if (process.env.REINS_HEADLESS === '1') return { ran: false, error: 'nested_run' };
  const runner = rt.runner;
  if (runner === undefined || runner.length === 0) return { ran: false, error: 'no_runner' };
  const [command, ...args] = runner.map((part) => part.replaceAll('{task}', id).replaceAll('{prompt}', runPrompt(id)));
  if (command === undefined) return { ran: false, error: 'no_runner' };
  // The command runs directly, without a shell: the words of the prompt never become a command line.
  const r = spawnSync(command, args, {
    cwd: rt.workDir ?? process.cwd(),
    env: { ...process.env, REINS_HEADLESS: '1' },
    stdio: 'ignore',
    timeout: rt.runnerTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (r.error !== undefined) return { ran: false, error: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'start_failed' };
  return { ran: true, exit: r.status ?? 1 };
}
