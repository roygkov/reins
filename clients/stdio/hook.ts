// A second client of the harness: a codec without forms of its own. A client whose hooks can run
// a command passes one event as a JSON object on the standard input and reads the answer of the
// core as a JSON object from the standard output:
//   echo '{"event":"before","cwd":"/work","session":"s1","tool":"run_command","input":{"command":"ls"}}' | node hook.ts
// The events: session_start, request, before, after, executor_start, executor_report, stop,
// before_compaction, session_end. `tools.json` says what the tools of the client do.
// Rule of a failure: a doubt about a write goes to the human. This file never exits with an error.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clientRuntime, loadRuntime } from '../../src/client/config.ts';
import type { ClientTools } from '../../src/client/before.ts';
import { handleEvent, readEvent, UNREADABLE, type EventReply } from '../../src/client/events.ts';

const HARNESS_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// A fact about the adapter itself: a row of the journal, when the journal can be reached.
function noted(kind: 'harness.client_shape_changed' | 'harness.failure', data: Record<string, string>, cwd?: string): void {
  try {
    const rt = clientRuntime(loadRuntime(cwd), 'stdio');
    rt.journal.write({ kind, project: rt.project, data });
  } catch {
    // no configuration, or the journal cannot be reached
  }
}

function run(): EventReply {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    noted('harness.client_shape_changed', { client: 'stdio', event: 'unknown' });
    return UNREADABLE;
  }
  const head = readEvent(value);
  if (head === null) {
    // The form of the input is not the form of an event: the client changed, or it is another client.
    noted('harness.client_shape_changed', { client: 'stdio', event: 'unknown' });
    return UNREADABLE;
  }
  try {
    const tools = JSON.parse(fs.readFileSync(new URL('./tools.json', import.meta.url), 'utf8')) as ClientTools;
    const rt = clientRuntime({ ...loadRuntime(head.cwd), harnessDirs: [HARNESS_ROOT] }, 'stdio');
    const reply = handleEvent(rt, value, tools, 'stdio');
    // An event whose parts have an unknown form (no tool, no input): the same fact, with the name of the event.
    if (reply === UNREADABLE || reply.rule === 'adapter.shape') noted('harness.client_shape_changed', { client: 'stdio', event: head.event }, head.cwd);
    return reply;
  } catch {
    noted('harness.failure', { where: 'adapter', event: head.event }, head.cwd);
    // Only the event before an action is a barrier: its failure is a question.
    return head.event === 'before' ? { outcome: 'ask', rule: 'adapter.failure' } : {};
  }
}

const reply = run();
if (Object.keys(reply).length > 0) process.stdout.write(JSON.stringify(reply));
process.exitCode = 0;
