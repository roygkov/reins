// The state of a work tree as one fingerprint: the commit, the list of changed and new files, and
// the changes themselves. Two equal fingerprints mean that nothing changed between them.
// Used for facts only: did a request of the human change the work.
// A directory that is no repository has a fingerprint too: the names of its files with their sizes
// and their times.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_UNTRACKED = 500; // new files whose content is a part of the fingerprint

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 && r.error === undefined ? r.stdout : null;
}

const MAX_ENTRIES = 2000; // the files and directories of a work that is no repository

// The state of a directory that is no repository. The content is not read: a file that changed
// has another size or another time. The time of the change of the file record is a part of it: a
// tool can set the time of the content back, not this one. The names of the system are not
// counted. A link is not followed. null: the directory cannot be read, or it holds more than the
// limit (the home directory, a directory of many repositories).
const SKIP: readonly string[] = ['.DS_Store', '.git'];
function treeState(dir: string): string | null {
  const hash = crypto.createHash('sha256').update('tree\n');
  const todo = [''];
  let seen = 0;
  try {
    for (let rel = todo.pop(); rel !== undefined; rel = todo.pop()) {
      // The directory is read one name at a time: a directory of very many names stops the walk early.
      const names: fs.Dirent[] = [];
      const opened = fs.opendirSync(path.join(dir, rel));
      try {
        for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
          if (SKIP.includes(entry.name)) continue;
          seen += 1;
          if (seen > MAX_ENTRIES) return null;
          names.push(entry);
        }
      } finally {
        opened.closeSync();
      }
      names.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of names) {
        const name = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          hash.update(`d ${name}\n`);
          todo.push(name);
        } else {
          const stat = fs.lstatSync(path.join(dir, name), { bigint: true });
          hash.update(`${entry.isSymbolicLink() ? 'l' : 'f'} ${name} ${stat.size} ${stat.mtimeNs} ${stat.ctimeNs}\n`);
        }
      }
    }
  } catch {
    return null;
  }
  return hash.digest('hex').slice(0, 32);
}

// null: git did not answer in time, or the directory is no repository and has no state of its own.
export function workState(cwd: string): string | null {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
  // No answer is no fact. git answered that this is no repository: the directory itself is the
  // work. Another refusal (a repository that git does not trust, a broken one) is no fact too.
  if (top.error !== undefined || top.status === null) return null;
  if (top.status !== 0) return /not a git repository/.test(top.stderr) ? treeState(cwd) : null;
  const root = top.stdout.trim();
  if (root === '') return null;
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
