// The supervisor of one collect script. It runs as its own process so that the caller can stay
// synchronous. It starts the script as the leader of a new process group and, at the end or at a
// limit, kills the whole group: a child of the script cannot outlive the time limit.
// Arguments: <file> <timeout ms> <max bytes>. Exit codes: 0 done, 124 time limit, 125 output limit,
// 126 the script failed.

import { spawn } from 'node:child_process';

const [file, timeoutArg, bytesArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const maxBytes = Number(bytesArg);
if (file === undefined || !Number.isFinite(timeoutMs) || !Number.isFinite(maxBytes)) process.exit(126);

const child = spawn(file, [], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
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
  if (code !== 0) process.exit(code);
  process.stdout.write(Buffer.concat(chunks), () => process.exit(0));
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
    finish(126);
    return;
  }
  // The script is done. Its output ends at once unless a child of it still holds the pipe:
  // a short grace, then the group is killed.
  child.stdout.once('end', () => finish(0));
  setTimeout(() => finish(0), 200);
});
