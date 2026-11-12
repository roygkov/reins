// Runs the collect script of a scenario: a file of a pack, without the model.
// The script gets the task inputs as JSON on its standard input and prints one JSON object:
// { "outputs": { <name>: <any> }, "flags": { <name>: <boolean> } } with exactly the names of the manifest.
// The script gets a small fixed environment, a time limit and an output limit.
// Of the variables of the connectors it gets only those of the read connectors of its manifest.
// The network and the files outside the work are closed only in the sandbox of the system: with
// the key `script_sandbox` of the config, on macOS. Without it they are not enforced here.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObj } from '../contracts/shape.ts';

export type CollectReason = 'exit' | 'timeout' | 'too_large' | 'bad_json' | 'bad_shape' | 'missing_output' | 'missing_flag' | 'no_sandbox';
export type CollectResult =
  | { ok: true; outputs: Record<string, unknown>; flags: Record<string, boolean>; bytes: number }
  | { ok: false; reason: CollectReason };

// The sandbox of the system for a script. `network`: the script reaches the network. `denyRead`:
// paths that the script cannot read (the files of the connectors that its manifest does not
// name). `writable`: directories where the script can write, besides the temporary ones.
// `local`: without the network the script still reaches this machine (a local server of the
// tests, the socket of a container engine). `tool`: the program of the system that makes the sandbox.
export type Sandbox = { network: boolean; denyRead: string[]; writable: string[]; local?: boolean; tool?: string };
// `env`: the names of more variables that the script gets: those of its read connectors.
export type CollectOptions = { outputs: string[]; flags: string[]; timeoutMs: number; maxBytes: number; env?: string[]; sandbox?: Sandbox };

const SANDBOX_TOOL = '/usr/bin/sandbox-exec';
// A path as the system has it: the sandbox compares real paths.
const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const lit = (p: string): string => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The profile of the sandbox: all is allowed but a write outside the temporary directories and the
// named ones, the network when the script has no connector that needs it, and a read of the named files.
export function sandboxProfile(s: Sandbox): string {
  const writable = [os.tmpdir(), '/private/tmp', '/private/var/folders', '/dev', ...s.writable].map(real);
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${lit(p)})`).join(' ')})`,
    ...(s.network ? [] : ['(deny network*)']),
    // The far end must be this machine: a rule about the near end would match every connection.
    ...(!s.network && s.local === true ? ['(allow network-outbound (remote ip "localhost:*") (remote unix-socket))', '(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))'] : []),
    ...s.denyRead.map((p) => `(deny file-read* (subpath ${lit(real(p))}))`),
  ].join('\n');
}


// `REINS_CONFIG`: a script that calls the command line of the harness reaches the same config.
const PASSED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'REINS_CONFIG'] as const;
const SUPERVISOR = fileURLToPath(new URL('./collect-child.ts', import.meta.url));
const BACKSTOP_MS = 5000; // the supervisor enforces the limits; this is for a supervisor that hangs

export function runCollect(file: string, input: { inputs: Record<string, string | number> } & Record<string, unknown>, opts: CollectOptions): CollectResult {
  const env: Record<string, string> = {};
  for (const key of [...PASSED_ENV, ...(opts.env ?? [])]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The file runs directly, without a shell: the inputs never become a part of a command line.
  // A supervisor process starts it in its own process group and kills the group at a limit,
  // so the limits hold for the children of the script too.
  // With the sandbox the supervisor and the script run inside it. A system that has no sandbox
  // tool runs no script: a sandbox that the config asks for is not skipped in silence.
  const tool = opts.sandbox?.tool ?? SANDBOX_TOOL;
  if (opts.sandbox !== undefined && (process.platform !== 'darwin' || !fs.existsSync(tool))) return { ok: false, reason: 'no_sandbox' };
  const command = opts.sandbox === undefined ? process.execPath : tool;
  const head = opts.sandbox === undefined ? [] : ['-p', sandboxProfile(opts.sandbox), process.execPath];
  const r = spawnSync(command, [...head, SUPERVISOR, file, String(opts.timeoutMs), String(opts.maxBytes)], {
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
