// The supervisor of one collect script. It runs as its own process so that the caller can stay
// synchronous. It starts the script as the leader of a new process group and, at the end or at a
// limit, kills the whole group: a child of the script cannot outlive the time limit.
// Arguments: <file> <timeout ms> <max bytes>. Exit codes: 0 done, 124 time limit, 125 output limit,
// 126 the script failed. At an exit code that is not 0 the last line of the error output is one JSON
// object: the exit code of the script (when it has one) and the end of its error text. At the exit
// code 0 that line is there only when the script wrote an error text: it carries the end of the text.

import { spawn } from 'node:child_process';

const [file, timeoutArg, bytesArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const maxBytes = Number(bytesArg);
if (file === undefined || !Number.isFinite(timeoutMs) || !Number.isFinite(maxBytes)) process.exit(126);

const child = spawn(file, [], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
// The end of the error text of the script: enough to say why it failed, never the whole text.
const TAIL = 2000;
let errors = Buffer.alloc(0);
let exit: number | null = null;
child.stderr.on('data', (chunk: Buffer) => {
  errors = Buffer.concat([errors, chunk]);
  if (errors.length > TAIL) errors = errors.subarray(errors.length - TAIL);
});
child.stderr.on('error', () => {});
const chunks: Buffer[] = [];
let size = 0;
let done = false;

function finish(code: number): void {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
  if (code !== 0) {
    const note = JSON.stringify({ ...(exit !== null ? { exit } : {}), stderr: errors.toString('utf8') });
    process.stderr.write(`\n${note}\n`, () => process.exit(code));
    return;
  }
  // A script that is done can still say something on its error output (why its result is red):
  // the same last line carries the end of that text.
  const out = (): boolean => process.stdout.write(Buffer.concat(chunks), () => process.exit(0));
  if (errors.length === 0) out();
  else process.stderr.write(`\n${JSON.stringify({ stderr: errors.toString('utf8') })}\n`, out);
}

const timer = setTimeout(() => finish(124), timeoutMs);
child.on('error', () => finish(126));
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.stdout.on('data', (chunk: Buffer) => {
  size += chunk.length;
  if (size > maxBytes) finish(125);
  else chunks.push(chunk);
});
child.on('exit', (code) => {
  if (code !== 0) {
    exit = code;
    // The error text of the script can still be on its way: its end is read first, with a short
    // grace for a child of the script that holds the pipe.
    child.stderr.once('end', () => finish(126));
    setTimeout(() => finish(126), 200);
    return;
  }
  // The script is done. Its output ends at once unless a child of it still holds the pipe:
  // a short grace, then the group is killed.
  child.stdout.once('end', () => finish(0));
  setTimeout(() => finish(0), 200);
});
