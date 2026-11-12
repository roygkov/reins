// Runs one command as the leader of its own group of processes, and stops the whole group when
// the time limit passes: the client, and every process that the client started and that stayed in
// its group. When the client ends by itself, what it left in its group stops too: a run without a
// window is over when its client is over. The harness waits for a run with a blocking call, and a blocking call can stop only
// the one process that it started; so this small program stands between the two.
// Input: the first argument is JSON {command, args, timeoutMs}. Output: one JSON line on stdout,
// {exit} or {error: 'timeout' | 'start_failed'}.
'use strict';
const { spawn } = require('node:child_process');

const { command, args, timeoutMs } = JSON.parse(process.argv[2]);
let said = false;
const say = (out) => {
  if (said) return;
  said = true;
  process.stdout.write(`${JSON.stringify(out)}\n`);
};
const child = spawn(command, args, { stdio: 'ignore', detached: true });
const stopGroup = () => {
  try {
    // A negative number names the group. Where the system has no groups, the client alone is stopped.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};
const timer = setTimeout(() => {
  say({ error: 'timeout' });
  stopGroup();
}, timeoutMs);
child.on('error', () => {
  clearTimeout(timer);
  clearInterval(watch);
  say({ error: 'start_failed' });
});
child.on('exit', (code) => {
  clearTimeout(timer);
  clearInterval(watch);
  say({ exit: code === null ? 1 : code });
  // What the client left behind in its group has no limit of time any more: it stops here.
  stopGroup();
});
// The harness itself is stopped: the client does not stay behind it. A signal can reach this
// program; a harness that died alone shows as another parent of this program.
const parent = process.ppid;
const watch = setInterval(() => {
  if (process.ppid === parent) return;
  stopGroup();
  process.exit(1);
}, 2000);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    stopGroup();
    process.exit(1);
  });
}
