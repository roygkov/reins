// A lock file for a short read, change and write of one file of the state.

import crypto from 'node:crypto';
import fs from 'node:fs';

// Runs `work` while this process holds the lock file; false when the lock did not come in three
// seconds. The lock holds a mark of its owner: a process removes only its own lock. A lock that
// is older than two seconds has a dead holder (the work under it takes milliseconds) and is removed.
export function locked(lock: string, work: () => void): boolean {
  const mark = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let owned = false;
  for (let attempt = 0; attempt < 300 && !owned; attempt += 1) {
    try {
      fs.writeFileSync(lock, mark, { flag: 'wx' });
      owned = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.rmSync(lock, { force: true });
      } catch {
        // the lock went away: try again
      }
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (!owned) return false;
  try {
    work();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8') === mark) fs.rmSync(lock, { force: true });
    } catch {
      // the lock is gone already
    }
  }
  return true;
}
