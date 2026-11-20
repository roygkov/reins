// The state of a work tree as one fingerprint: the commit, the list of changed and new files, and
// the changes themselves. Two equal fingerprints mean that nothing changed between them.
// Used for facts only: did a request of the human change the work.
// A directory that is no repository has a fingerprint too: the names of its files with their sizes
// and their times.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const MAX_UNTRACKED = 500; // new files whose content is a part of the fingerprint

function git(cwd: string, args: string[], timeout: number = 5000): string | null {
  if (timeout <= 0) return null;
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 && r.error === undefined ? r.stdout : null;
}

// One term for the read of a tree with its second fingerprint. A hook of the client has ten
// seconds for all its work, and the read of a tree is up to five calls of git. A call gets the
// time that is left of the term, at most five seconds; a read with no time left starts no call
// and gives no answer (contracts AD18).
export type Term = { until: number; now: () => number };
export const TREE_BUDGET_MS = 4000; // the tree with its second fingerprint
export const termOf = (budgetMs: number = TREE_BUDGET_MS, now: () => number = Date.now): Term => ({ until: now() + budgetMs, now });
// One call of git within a term. The time that is left is read once, and that value is the limit
// of the call: a second read could give zero, which for the call means "no limit", or less than
// zero, which the call refuses with an error. null: no time is left, and no call starts.
function call(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }, term: Term | undefined): SpawnSyncReturns<string> | null {
  const ms = leftOf(term);
  return ms <= 0 ? null : spawnSync('git', args, { ...options, encoding: 'utf8', timeout: ms });
}
const leftOf = (term: Term | undefined): number => (term === undefined ? 5000 : Math.min(5000, term.until - term.now()));

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

// What git says about the work of a directory, read in one pass: its fingerprint, the root of the
// repository (links resolved), the commit (null: the repository has no commit yet) and the files
// that git sees as changed or new.
export type WorkFacts = { state: string; top: string; head: string | null; dirty: string[] };

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

// 'none': git answered that the directory is no repository. null: no answer in time, or a refusal
// (a repository that git does not trust, a broken one): no fact.
function repoFacts(cwd: string, term?: Term): WorkFacts | 'none' | null {
  const top = call(['rev-parse', '--show-toplevel'], { cwd, env: ENV }, term);
  if (top === null || top.error !== undefined || top.status === null) return null;
  if (top.status !== 0) return /not a git repository/.test(top.stderr) ? 'none' : null;
  const root = top.stdout.trim();
  if (root === '') return null;
  // No commit is an answer of git (it ends with a code); no answer in time is no fact.
  const rev = call(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, env: ENV }, term);
  if (rev === null || rev.error !== undefined || rev.status === null) return null;
  const head = rev.status === 0 && rev.stdout.trim() !== '' ? rev.stdout.trim() : null;
  const status = git(root, ['status', '--porcelain=v1', '-uall', '-z'], leftOf(term));
  const diff = head === null ? '' : git(root, ['diff', 'HEAD'], leftOf(term));
  if (status === null || diff === null) return null;
  const entries = status.split('\0');
  // A file that git does not track has no diff: its content is hashed, so an edit of it is a change.
  const untracked = entries.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3)).slice(0, MAX_UNTRACKED);
  let contents = '';
  if (untracked.length > 0) {
    const hashed = call(['hash-object', '--stdin-paths'], { cwd: root, input: untracked.join('\n') }, term);
    if (hashed === null || hashed.status !== 0 || hashed.error !== undefined) return null;
    contents = hashed.stdout;
  }
  // A renamed file gives two entries: the new name with its two letters, then the old name alone.
  // The letter of the rename stands in the column of the index or in the column of the work tree.
  const dirty: string[] = [];
  for (let n = 0; n < entries.length; n += 1) {
    const entry = entries[n] ?? '';
    if (entry.length <= 3) continue;
    dirty.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') n += 1;
  }
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    return null;
  }
  return { state: crypto.createHash('sha256').update(`${head ?? 'none'}\n${status}\n${diff}\n${contents}`).digest('hex').slice(0, 32), top: real, head, dirty };
}

// The fingerprint of the work and, for a repository, the facts of git behind it: one pass.
export function workNow(cwd: string, term?: Term): { state: string | null; facts: WorkFacts | null } {
  const facts = repoFacts(cwd, term);
  if (facts === 'none') return { state: treeState(cwd), facts: null };
  return facts === null ? { state: null, facts: null } : { state: facts.state, facts };
}

// null: git did not answer in time, or the directory is no repository and has no state of its own.
export const workState = (cwd: string, term?: Term): string | null => workNow(cwd, term).state;

// The root of the repository of a directory, with links resolved: two directories of one work
// tree have one root. null: the directory is no repository, or git gave no answer.
export function workTop(cwd: string): string | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (top === undefined || top === '') return null;
  try {
    return fs.realpathSync(top);
  } catch {
    return null;
  }
}

// How many files of the work differ: the files that git sees as changed or new, and the files of
// the commits that came after `since` and were committed after the moment `after` (milliseconds).
// A commit that a pull, a checkout or a merge brought in was committed before the request: it is
// the work of other people and does not count. `since` null: the repository had no commit at that
// moment. `since` undefined: the moment is not known, only the files of now count. null as the
// answer: git gave no answer. A file that was changed before `since` and not committed counts
// too: the harness keeps no list of the files of an earlier moment.
export function changedFiles(facts: WorkFacts, since?: string | null, after?: number): number | null {
  const files = new Set(facts.dirty);
  if (since !== undefined && facts.head !== null && since !== facts.head) {
    const from = after === undefined ? [] : [`--since=${new Date(Math.floor(after / 1000) * 1000).toISOString()}`];
    const committed = git(facts.top, ['log', '--format=', '--name-only', '--no-renames', '-z', ...from, since === null ? 'HEAD' : `${since}..HEAD`]);
    if (committed === null) return null;
    for (const file of committed.split(/[\0\n]/)) if (file !== '') files.add(file);
  }
  return files.size;
}

// The tree of the content of a work: the name that git gives to the files as they are now, with
// the changes that are not committed and the new files. A commit of that content has the same
// tree, so a commit after a check is no new work (contracts AD12). The fingerprint of `workNow`
// holds the commit too and tells a commit from no change; this value does not. The read writes
// nothing into the repository: the index and the new objects go to a directory of their own.
// null: the directory is no repository, or git gave no answer in time.
export function workTree(cwd: string, term: Term = termOf()): string | null {
  const left = (): number => leftOf(term);
  const top = git(cwd, ['rev-parse', '--show-toplevel'], left())?.trim();
  if (top === undefined || top === '') return null;
  const status = git(top, ['status', '--porcelain=v1', '-uall', '-z'], left());
  if (status === null) return null;
  const name = (out: string | null): string | null => (out !== null && /^[0-9a-f]{40,64}$/.test(out.trim()) ? out.trim() : null);
  // A clean work: its content is the tree of its commit.
  if (status === '') return name(git(top, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], left()));
  const places = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'objects', '--git-path', 'index'], left())?.split('\n');
  const [objects, index] = places ?? [];
  if (objects === undefined || objects === '' || index === undefined || index === '') return null;
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-tree-'));
    // A copy of the index keeps what git knows about the files: only the changed ones are read.
    if (fs.existsSync(index)) fs.copyFileSync(index, path.join(dir, 'index'));
    fs.mkdirSync(path.join(dir, 'objects'));
    const env = { ...ENV, GIT_INDEX_FILE: path.join(dir, 'index'), GIT_OBJECT_DIRECTORY: path.join(dir, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    const added = call(['add', '-A'], { cwd: top, env }, term);
    if (added === null || added.status !== 0 || added.error !== undefined) return null;
    const tree = call(['write-tree'], { cwd: top, env }, term);
    return tree !== null && tree.status === 0 && tree.error === undefined ? name(tree.stdout) : null;
  } catch {
    return null;
  } finally {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The tree of the content of a work whose fingerprint is `state`. The fingerprint and the tree are
// two reads of the work: a change between them would give the tree of another content. So the
// fingerprint is read again after the tree, and a tree of a work that moved is no tree of `state`.
// null: no tree, or the work is not the one of `state` any more.
export function workTreeOf(cwd: string, state: string, read: (cwd: string, term: Term) => string | null = workTree, term: Term = termOf()): string | null {
  const tree = read(cwd, term);
  // The second fingerprint is read within the same term: no time left is no tree.
  return tree !== null && workState(cwd, term) === state ? tree : null;
}
