// A notice for the human outside the client: an action that waits in the queue, the summary of
// the week. The config names the command of the machine that shows a notice; without it there is
// none. The words of a notice are words of the harness: an id, a rule, a path. The text of an
// action never goes into a notice: it can hold what only the queue may show.
// Specification: docs/spec/harness-spec.md, section П1 (the ways of work: the notice by the key `notify`).

import { spawn } from 'node:child_process';
import type { Runtime } from './runtime.ts';

const MAX_TEXT = 200;

export function notify(rt: Runtime, text: string): boolean {
  const words = rt.notify;
  if (words === undefined || words.length === 0) return false;
  const line = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const [command, ...args] = words.map((word) => word.replaceAll('{text}', line));
  if (command === undefined) return false;
  try {
    // The command runs directly, without a shell, and apart from the harness: a notice never holds
    // the work, also when its program waits for a click of the human. True: the command was started.
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // a command that is not there shows no notice
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
