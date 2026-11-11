// The entry of the Claude Code hooks. It holds no logic: it loads the adapter and, when the load
// or the run fails before an action, asks the human. A failure must not be a silent pass.
//   node hook.ts pre | post
// A crash of Node itself, or a time limit of the client, is outside this file: then the client
// decides alone (see docs/contracts.md, B10).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2];

// A client that installs the plugin copies only this directory into its cache: the core is not
// beside the copy. Then the adapter is loaded from the source of the harness, which the config of
// the machine names (`source`). The agent cannot write the config: the policy refuses that.
function fromSource(): string {
  const file = process.env.REINS_CONFIG ?? path.join(os.homedir(), '.config', 'reins', 'config.json');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const source = value !== null && typeof value === 'object' ? (value as { source?: unknown }).source : undefined;
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('no source');
  return pathToFileURL(path.join(source, 'clients', 'claude-code', 'hooks', 'run.ts')).href;
}

try {
  let adapter: { main: (mode: string | undefined) => void };
  try {
    adapter = await import('./run.ts');
  } catch (e) {
    // Only a copy without a core beside it goes to the source. A core that is there and does not
    // load is a failure: another source must not take its place without a word.
    if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND' || fs.existsSync(new URL('../../../src/client/before.ts', import.meta.url))) throw e;
    adapter = await import(fromSource());
  }
  adapter.main(mode);
} catch {
  if (mode === 'pre') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'reins: the adapter did not start: the human decides' } }));
  }
}
process.exitCode = 0;
