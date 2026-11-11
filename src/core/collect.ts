// Runs the collect script of a scenario: a file of a pack, without the model.
// The script gets the task inputs as JSON on its standard input and prints one JSON object:
// { "outputs": { <name>: <any> }, "flags": { <name>: <boolean> } } with exactly the names of the manifest.
// The script gets a small fixed environment, a time limit and an output limit.
// Not enforced here: "read connectors only". That needs the client or a sandbox.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObj } from '../contracts/shape.ts';

export type CollectReason = 'exit' | 'timeout' | 'too_large' | 'bad_json' | 'bad_shape' | 'missing_output' | 'missing_flag';
export type CollectResult =
  | { ok: true; outputs: Record<string, unknown>; flags: Record<string, boolean>; bytes: number }
  | { ok: false; reason: CollectReason };

export type CollectOptions = { outputs: string[]; flags: string[]; timeoutMs: number; maxBytes: number };

const PASSED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const;
const SUPERVISOR = fileURLToPath(new URL('./collect-child.ts', import.meta.url));
const BACKSTOP_MS = 5000; // the supervisor enforces the limits; this is for a supervisor that hangs

export function runCollect(file: string, input: { inputs: Record<string, string | number> } & Record<string, unknown>, opts: CollectOptions): CollectResult {
  const env: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The file runs directly, without a shell: the inputs never become a part of a command line.
  // A supervisor process starts it in its own process group and kills the group at a limit,
  // so the limits hold for the children of the script too.
  const r = spawnSync(process.execPath, [SUPERVISOR, file, String(opts.timeoutMs), String(opts.maxBytes)], {
    input: JSON.stringify(input),
    cwd: path.dirname(file),
    env,
    encoding: 'utf8',
    timeout: opts.timeoutMs + BACKSTOP_MS,
    maxBuffer: opts.maxBytes + 64 * 1024,
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
    if (code === 'ENOBUFS') return { ok: false, reason: 'too_large' };
    return { ok: false, reason: 'exit' };
  }
  if (r.status === 124) return { ok: false, reason: 'timeout' };
  if (r.status === 125) return { ok: false, reason: 'too_large' };
  if (r.status !== 0) return { ok: false, reason: 'exit' };

  let value: unknown;
  try {
    value = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  if (!isObj(value) || Object.keys(value).some((k) => k !== 'outputs' && k !== 'flags')) return { ok: false, reason: 'bad_shape' };
  const outputs = value.outputs;
  const flags = value.flags ?? {};
  if (!isObj(outputs) || !isObj(flags)) return { ok: false, reason: 'bad_shape' };

  for (const name of opts.outputs) if (!Object.hasOwn(outputs, name)) return { ok: false, reason: 'missing_output' };
  if (Object.keys(outputs).some((k) => !opts.outputs.includes(k))) return { ok: false, reason: 'bad_shape' };

  const checked: Record<string, boolean> = {};
  for (const name of opts.flags) {
    if (!Object.hasOwn(flags, name)) return { ok: false, reason: 'missing_flag' };
    const flag = flags[name];
    if (typeof flag !== 'boolean') return { ok: false, reason: 'bad_shape' };
    checked[name] = flag;
  }
  if (Object.keys(flags).some((k) => !opts.flags.includes(k))) return { ok: false, reason: 'bad_shape' };

  return { ok: true, outputs: { ...outputs }, flags: checked, bytes: Buffer.byteLength(r.stdout) };
}
