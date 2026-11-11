// The state of a work tree as one fingerprint: the commit, the list of changed and new files, and
// the changes themselves. Two equal fingerprints mean that nothing changed between them.
// Used for facts only: did a request of the human change the work.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MAX_UNTRACKED = 500; // new files whose content is a part of the fingerprint

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 && r.error === undefined ? r.stdout : null;
}

// null: the directory is not in a repository, or git did not answer in time.
export function workState(cwd: string): string | null {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (root === undefined || root === '') return null;
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? 'none';
  const status = git(root, ['status', '--porcelain=v1', '-uall', '-z']);
  const diff = head === 'none' ? '' : git(root, ['diff', 'HEAD']);
  if (status === null || diff === null) return null;
  // A file that git does not track has no diff: its content is hashed, so an edit of it is a change.
  const untracked = status.split('\0').filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3)).slice(0, MAX_UNTRACKED);
  let contents = '';
  if (untracked.length > 0) {
    const hashed = spawnSync('git', ['hash-object', '--stdin-paths'], { cwd: root, input: untracked.join('\n'), encoding: 'utf8', timeout: 5000 });
    if (hashed.status !== 0 || hashed.error !== undefined) return null;
    contents = hashed.stdout;
  }
  return crypto.createHash('sha256').update(`${head}\n${status}\n${diff}\n${contents}`).digest('hex').slice(0, 32);
}
