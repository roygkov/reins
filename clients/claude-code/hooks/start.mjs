// The first file of a Claude Code hook: it turns the cache of compiled code on and loads the
// entry. It holds no logic and no types: Node must load its compiler of types to read a file
// with types, and that costs more than the rest of the load. With the cache Node reads the
// entry and the harness without that compiler.
//   node start.mjs pre | post
// One call of a hook is one process, and most of its time is the load of the code. The cache is
// in the state of the harness: the policy refuses a write of the agent there, so the agent cannot
// change the code that the hook runs. No cache is not a failure: Node then compiles as before.

import fs from 'node:fs';
import { enableCompileCache } from 'node:module';
import os from 'node:os';
import path from 'node:path';

try {
  const file = process.env.REINS_CONFIG ?? path.join(os.homedir(), '.config', 'reins', 'config.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const named = value !== null && typeof value === 'object' ? value.state_dir : undefined;
  const state = named === undefined ? path.join(os.homedir(), '.local', 'state', 'reins') : named;
  if (typeof state === 'string' && path.isAbsolute(state)) enableCompileCache(path.join(state, 'compile-cache'));
} catch {
  // no config or no cache: the entry decides what a missing config means
}

await import('./hook.ts');
