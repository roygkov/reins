// The places that a shell command touches: the words of the command read as paths, each from the
// directory where its part of the command runs. Nothing is executed and nothing is expanded but
// the home directory and the patterns of file names.
//
// This is a reading of the command, not a proof. A path that a variable or a script builds is not
// seen here: the match of the text in `before.ts` stays as the second barrier.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
type Segment = { argv: string[]; redirects: string[]; inputs: string[] };
const { parse, base } = require('../gate/tokenize.cjs') as { parse(command: string): Segment[]; base(command: string): string };

// `write`: the command can change the place. A command that this file does not know only names
// its places: nothing says that it writes.
export type Place = { path: string; write: boolean };
// `tree`: the command removes the place with all that lies under it.
// `into`: the command can write under the place, and nothing says where: an archive is opened there.
// `derived`: the command does not name the place, it follows from the names: the target of a copy
// with the name of the source.
export type TouchedPlace = Place & { tree: boolean; into: boolean; derived: boolean };

// Commands that remove a place with all that lies under it. `mv` removes every place but the last.
const REMOVERS = new Set(['rm', 'rmdir', 'shred', 'unlink', 'mv']);

// Commands whose plain words are all places that they change.
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'touch', 'tee', 'mkdir', 'chmod', 'chown', 'chgrp', 'truncate', 'shred', 'unlink', 'patch', 'gzip', 'gunzip']);
// Commands that read their first places and change only the last one.
const LAST_IS_WRITE = new Set(['cp', 'rsync', 'ln', 'install']);
// Options whose value is a place that the command changes.
const WRITE_OPTIONS: Record<string, readonly string[]> = {
  cp: ['-t', '--target-directory'], mv: ['-t', '--target-directory'], install: ['-t', '--target-directory'],
  unzip: ['-d'], curl: ['-o', '--output'], wget: ['-O', '--output-document'],
};
// Commands whose words are not places.
const NO_PLACES = new Set(['echo', 'printf', 'export', 'set', 'unset', 'true', 'false', 'test', '[', 'sleep', 'exit', 'return', 'read', 'local', 'declare', 'alias', 'kill', 'wait', 'date', 'whoami', 'pwd', 'which', 'type', 'command', 'popd']);
// Commands whose first plain word is a program or a pattern, not a place, unless an option gives it.
const PROGRAM_FIRST = new Set(['sed', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'perl', 'jq']);
const MAX_MATCHES = 200;
const MAX_BRACES = 64;

// `a/{b,c}/d` stands for `a/b/d` and `a/c/d`, whether or not they exist: the shell writes the
// words out before it runs the command.
function braces(word: string): string[] {
  let words = [word];
  for (let round = 0; round < 8; round += 1) {
    const next: string[] = [];
    let changed = false;
    for (const w of words) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(w);
      if (m === null) next.push(w);
      else {
        changed = true;
        for (const part of (m[1] ?? '').split(',')) next.push(w.slice(0, m.index) + part + w.slice(m.index + m[0].length));
      }
    }
    words = next.slice(0, MAX_BRACES);
    if (!changed) break;
  }
  return words;
}

// A word as a path, or null when the word is not a path that can be known: a variable, a command
// substitution, an address.
function expand(word: string, dir: string, home: string): string | null {
  let text = word;
  const user = /^~([A-Za-z0-9_.-]+)(\/|$)/.exec(text);
  if (text === '~') text = home;
  else if (text.startsWith('~/')) text = path.join(home, text.slice(2));
  // `~name`: the home directory of a user. The own name is the own home; another lies beside it.
  else if (user !== null) text = path.join(user[1] === path.basename(home) ? home : path.join(path.dirname(home), user[1] ?? ''), text.slice(user[0].length));
  else if (text === '$HOME' || text === '${HOME}') text = home;
  else if (text.startsWith('$HOME/')) text = path.join(home, text.slice(6));
  else if (text.startsWith('${HOME}/')) text = path.join(home, text.slice(8));
  if (text === '' || /[$`]/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  return path.resolve(dir, text);
}

// A pattern of file names stands for the files that it matches now, as the shell would read it.
function matches(file: string): string[] {
  if (!/[*?[]/.test(file)) return [file];
  // A pattern that goes through every directory is not expanded: it stands for the directory before it.
  if (file.includes('**')) return [path.dirname(file.slice(0, file.indexOf('**') + 1))];
  try {
    const found = fs.globSync(file).slice(0, MAX_MATCHES);
    return found.length > 0 ? found.map((f) => path.resolve(f)) : [file];
  } catch {
    return [file];
  }
}

// A command that only reads. The list is closed: a program that is not here, or a form of a
// program that can write a file or start another program, is not a read. A variable, a
// substitution, an assignment before the command or an output into a file is not a read either:
// what such a command does is not known from its text. The answer is used only to drop the
// question about a text that names the code of the harness or a pack: the state, the memory and
// the config keep their question.
const READERS = new Set(['cat', 'head', 'tail', 'ls', 'wc', 'stat', 'diff', 'cmp', 'cut', 'tr', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'cd', 'echo', 'printf', 'true', 'false', 'test', '[', 'which', 'du', 'column', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'sort', 'uniq', 'find', 'sed', 'git']);
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'cat-file', 'merge-base']);
const FIND_ACTS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
type FullSegment = Segment & { vars?: boolean[]; env?: Record<string, string>; text?: string };

function readerSegment(seg: FullSegment): boolean {
  if (seg.argv.length === 0) return false;
  if ((seg.vars ?? []).some(Boolean) || Object.keys(seg.env ?? {}).length > 0) return false;
  if (seg.redirects.some((target) => target !== '/dev/null')) return false;
  const name = base(seg.argv[0] ?? '');
  if (!READERS.has(name)) return false;
  // The parse drops a wrapper (`npx`, `sudo`, `xargs`, `uv run`): the program that the shell
  // starts is the wrapper, and `npx cat` runs a package, not `cat`. The first word of the text
  // of the part must be the reader itself.
  if (base((seg.text ?? '').trim().split(/\s+/)[0] ?? '') !== name) return false;
  let args = seg.argv.slice(1);
  if (name === 'git') {
    // `-C <dir>` and `--no-pager` only: `-c` sets a config value, and a config value can name a program.
    for (;;) {
      if (args[0] === '-C' && args[1] !== undefined) args = args.slice(2);
      else if (args[0] === '--no-pager') args = args.slice(1);
      else break;
    }
    const sub = args[0] ?? '';
    const rest = args.slice(1);
    if (rest.some((a) => a.startsWith('--output') || a === '--ext-diff')) return false;
    if (GIT_READS.has(sub)) return true;
    if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || (rest.length === 2 && rest[0] === 'get-url');
    if (sub === 'branch') return rest.every((a) => ['--show-current', '-a', '-r', '-v', '-vv', '--list'].includes(a));
    return false;
  }
  if (name === 'find') return !args.some((a) => FIND_ACTS.has(a));
  // `sed` only prints a range of lines: any other program of `sed` can write a file or run a command.
  if (name === 'sed') return args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1] ?? '') && args.slice(2).every((a) => !a.startsWith('-'));
  if (name === 'sort') return !args.some((a) => /^-[A-Za-z]*o/.test(a) || a.startsWith('--o') || a.startsWith('--compress-program') || a.startsWith('--files0-from'));
  // `uniq <in> <out>` writes its second place.
  if (name === 'uniq') return args.every((a) => a.startsWith('-'));
  if (name === 'rg') return !args.some((a) => a.startsWith('--pre') || a.startsWith('--hostname-bin'));
  return true;
}

// Every part of the command stands in its text at the place of a command: at the start, or after
// `;`, `&`, `|`, `(`, `{` or a new line. The parse opens the text that another shell gets
// (`sh -c "..."`, `eval "..."`, with `sudo` before it or not): a part of such a text stands
// after a quote, and the program that starts is that shell, not the part.
function plain(command: string, segments: FullSegment[]): boolean {
  let from = 0;
  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
    const at = text === '' ? -1 : command.indexOf(text, from);
    if (at < 0) return false;
    const before = command.slice(0, at).replace(/[ \t]+$/, '');
    if (before !== '' && !/[;&|({\n]$/.test(before)) return false;
    from = at + text.length;
  }
  return true;
}

export function readsOnly(command: string): boolean {
  if (/[$`]|[<>]\(/.test(command)) return false;
  let segments: FullSegment[];
  try {
    segments = parse(command) as FullSegment[];
  } catch {
    return false;
  }
  return segments.length > 0 && segments.every(readerSegment) && plain(command, segments);
}

// A run of the tests of a project, in a closed list of forms: `npm test`, `npm run typecheck`,
// `npx tsc --noEmit`, and `node --test` with test files of the directory `test` (and a pattern of
// the names of the tests). No variable, no assignment before the command, no output into a file,
// no other flag: a flag of `node` can load a file, and a script of `npm` can be any program.
const TEST_FILE = /^test\/[A-Za-z0-9_*-]+\.test\.ts$/;
function testSegment(seg: FullSegment): boolean {
  if (seg.argv.length === 0) return false;
  if ((seg.vars ?? []).some(Boolean) || Object.keys(seg.env ?? {}).length > 0) return false;
  if (seg.redirects.some((target) => target !== '/dev/null')) return false;
  const words = (seg.text ?? '').trim().split(/\s+/);
  const a = seg.argv;
  if (words[0] === 'npm') return a[0] === 'npm' && ((a.length === 2 && a[1] === 'test') || (a.length === 3 && a[1] === 'run' && a[2] === 'typecheck'));
  // The parse drops the wrapper `npx`: the words of the text name it.
  if (words[0] === 'npx') return words[1] === 'tsc' && words[2] === '--noEmit' && a.length === 2 && a[0] === 'tsc' && a[1] === '--noEmit';
  if (words[0] !== 'node' || a[0] !== 'node' || a[1] !== '--test') return false;
  let rest = a.slice(2);
  if (rest[0] === '--test-name-pattern' && rest[1] !== undefined) rest = rest.slice(2);
  else if ((rest[0] ?? '').startsWith('--test-name-pattern=')) rest = rest.slice(1);
  return rest.length > 0 && rest.every((file) => TEST_FILE.test(file));
}

// The directory that a command enters to run the tests there, or null. The first part is `cd` with
// one directory, written whole; no other part moves; every other part is a form of a run of the
// tests or a program that only reads, and one of them runs the tests.
export function runsTests(command: string): string | null {
  // The text itself starts with `cd`: the parse opens a wrapper (`sudo sh -c "..."`), and a command
  // inside a wrapper runs as somebody else or somewhere else.
  if (/[$`]|[<>]\(/.test(command) || !/^\(?\s*cd\s/.test(command.trim())) return null;
  let segments: FullSegment[];
  try {
    segments = parse(command) as FullSegment[];
  } catch {
    return null;
  }
  if (!plain(command, segments)) return null;
  const [first, ...rest] = segments;
  if (first === undefined || rest.length === 0 || !readerSegment(first) || first.argv.length !== 2 || first.argv[0] !== 'cd') return null;
  const dir = first.argv[1] ?? '';
  if (!path.isAbsolute(dir) || rest.some((seg) => seg.argv[0] === 'cd')) return null;
  if (!rest.every((seg) => testSegment(seg) || readerSegment(seg)) || !rest.some(testSegment)) return null;
  return dir;
}

// The places of a command. `every`: a relative path is read from every directory that the command
// was in, not only from the last one: a `cd` inside a subshell does not move the parts after it.
export function commandPlaces(command: string, cwd: string, home: string, every = false): Place[] {
  return touchedPlaces(command, cwd, home, every).filter((p) => !p.derived).map((p) => ({ path: p.path, write: p.write }));
}

export function touchedPlaces(command: string, cwd: string, home: string, every = false): TouchedPlace[] {
  const out: TouchedPlace[] = [];
  const seen = new Set<string>();
  let dir = path.resolve(cwd);
  const dirs = [dir];
  const add = (word: string, write: boolean, tree = false, into = false, derived = false): void => {
    for (const from of every ? dirs : [dir]) for (const one of braces(word)) {
      const file = expand(one, from, home);
      if (file === null) continue;
      for (const found of matches(file)) {
        const key = `${found}\n${write}\n${tree}\n${into}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: found, write, tree, into, derived });
      }
    }
  };
  let segments: Segment[];
  try {
    segments = parse(command);
  } catch {
    return out;
  }
  for (const seg of segments) {
    const name = base(seg.argv[0] ?? '');
    const args = seg.argv.slice(1);
    if (name === 'cd' || name === 'pushd') {
      const to = args.find((a) => !a.startsWith('-')) ?? (name === 'cd' ? home : undefined);
      const next = to === undefined ? null : expand(to, dir, home);
      if (next !== null) {
        dir = next;
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    } else if (name === 'find') {
      // The places of `find` come before its first test. With `-delete` or a run of `rm` it removes them.
      const at = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
      const removes = args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir' || a === '-ok') && ['rm', 'rmdir', 'shred', 'unlink', 'mv'].includes(base(args[i + 1] ?? '')));
      for (const word of at < 0 ? args : args.slice(0, at)) add(word, removes, removes);
    } else if (name === 'dd') {
      // `if=` is read, `of=` is written.
      for (const word of args) {
        if (word.startsWith('of=')) add(word.slice(3), true);
        else if (word.startsWith('if=')) add(word.slice(3), false);
      }
    } else if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
      // The archive is written when `tar` creates it. Else `tar` writes into the directory of `-C`, or into its own directory.
      const creates = args.some((a) => a === '--create' || (/^-?[A-Za-z]+$/.test(a) && !a.startsWith('--') && /[cru]/.test(a) && (a.startsWith('-') || a === args[0])));
      let extractsHere = !creates;
      for (let i = 0; i < args.length; i += 1) {
        const word = args[i] ?? '';
        const cluster = !word.startsWith('--') && (word.startsWith('-') || i === 0) && /^-?[A-Za-z]+$/.test(word);
        if (word === '-C' || word === '--directory') {
          add(args[i + 1] ?? '', !creates, false, !creates);
          if (!creates) extractsHere = false;
          i += 1;
        } else if (word.startsWith('--file=')) add(word.slice(7), creates);
        else if (word === '--file' || (cluster && word.endsWith('f'))) {
          add(args[i + 1] ?? '', creates);
          i += 1;
        } else if (!word.startsWith('-') && !cluster) add(word, false);
      }
      if (extractsHere) add('.', true, false, true);
    } else if (seg.argv.length > 0 && !NO_PLACES.has(name)) {
      // A change in place: `sed -i`, `perl -i`, `sed --in-place`.
      const inPlace = (name === 'sed' || name === 'perl') && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'));
      const all = WRITERS.has(name) || inPlace;
      const valueOptions = WRITE_OPTIONS[name] ?? [];
      const targetGiven = args.some((a) => valueOptions.includes(a) || valueOptions.some((o) => o.startsWith('--') && a.startsWith(`${o}=`)));
      let program = PROGRAM_FIRST.has(name) && !args.some((a) => /^-[A-Za-z]*[ef]$/.test(a) || a === '--expression' || a === '--file');
      let afterOptions = false;
      // `zip` writes its first place, the archive.
      let first = name === 'zip';
      const sources: string[] = [];
      let target: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const word = args[i] ?? '';
        if (!afterOptions && word === '--') {
          afterOptions = true;
          continue;
        }
        if (!afterOptions && word.startsWith('-')) {
          const at = word.indexOf('=');
          // `--output=file`: the value is a place.
          if (at > 0) add(word.slice(at + 1), all || valueOptions.includes(word.slice(0, at)));
          else if (valueOptions.includes(word)) {
            add(args[i + 1] ?? '', true, false, name === 'unzip');
            target = args[i + 1];
            i += 1;
          }
          // The program of `-e` follows the option.
          else if (PROGRAM_FIRST.has(name) && /^-[A-Za-z]*e$/.test(word)) i += 1;
          continue;
        }
        if (program) {
          program = false;
          continue;
        }
        const last = !args.slice(i + 1).some((a, k) => !a.startsWith('-') && !valueOptions.includes(args[i + k] ?? ''));
        const write = all || first || (LAST_IS_WRITE.has(name) && last && !targetGiven);
        first = false;
        add(word, write, REMOVERS.has(name) && !(name === 'mv' && last && !targetGiven));
        if (LAST_IS_WRITE.has(name) || name === 'mv') {
          if (last && !targetGiven) target = word;
          else sources.push(word);
        }
      }
      // A copy into a directory writes the name of each source there. A source of `rsync` that ends
      // with `/` gives its content: nothing says which names.
      if (target !== undefined) {
        for (const source of sources) {
          if (name === 'rsync' && source.endsWith('/')) add(target, true, false, true, true);
          else add(`${target}/${path.basename(source)}`, true, false, false, true);
        }
      }
    }
    for (const word of seg.redirects) add(word, true);
    for (const word of seg.inputs) add(word, false);
  }
  return out;
}

// ---- A command that is the word of the human (`reins stop`, `reins memory decide`, ...).
// The client asks where such a command runs, not where a text names it: a search for the words,
// a document in a heredoc, a message of a commit and an argument of another command run nothing.
// The parse gives the program of each part of the line: after an operator, in a group, in a loop,
// in `$(...)` and backticks, behind a wrapper (`env`, `time`, `xargs`), in `bash -c` and `eval`.
// Where the parse cannot see what runs, the old match of the text decides, so the question stays:
// a variable in the place of the program or of the command, a shell that reads its commands from
// a heredoc or a pipe, a program that runs its words as a command (`find -exec`, `watch`, `ssh`),
// and code of an interpreter that names the command and starts a process.
const HUMAN_WORDS = /^(stop|pause|enable|approve|dispute|memory (veto|decide|restore|import|share|wrong|step|end)|craft (accept|reject)|queue (approve|reject)|retry|run|tick run|fire)( |$)/;
const HUMAN_HEADS = new Set(['memory', 'craft', 'queue', 'tick']);
const HUMAN_TEXT = /(^|[\s;&|(/`])(reins|cli\.ts)\s+(stop|pause|enable|approve|dispute|memory\s+(veto|decide|restore|import|share|wrong|step|end)|craft\s+(accept|reject)|queue\s+(approve|reject)|retry|run|tick\s+run|fire)(\s|$|[`)])/;
// A decision of the human: the list without the starts of a client (`run`, `tick run`, `fire`).
// The command line refuses a decision outside a terminal, so the barrier refuses it too.
export const DECISION_WORDS = /^(stop|pause|enable|approve|dispute|memory (veto|decide|restore|import|share|wrong|step|end)|craft (accept|reject)|queue (approve|reject)|retry)( |$)/;
const namesIn = (pattern: RegExp, text: string): boolean => pattern.test(text.replace(/\$?['"\\]/g, ''));
const READS_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'source', '.', 'eval']);
const RUNS_WORDS = new Set(['find', 'watch', 'parallel', 'ssh', 'script', 'entr', 'flock', 'tmux', 'screen', 'osascript', 'at', 'make', 'just', 'docker', 'kubectl', 'su', 'runuser', 'chroot', 'expect']);
const INTERPRETER = /^(python[0-9.]*|node|nodejs|deno|bun|tsx|ruby|perl|php|lua|awk|gawk)$/;
// A call that starts a process, by its name: a word of a text such as "execution" is none.
const STARTS_PROCESS = /subprocess|popen|child_process|\bos\.system|\bsystem\s*\(|\bexec\w*\s*\(|\bspawn\w*\s*\(|\bfork\s*\(|Deno\.(run|Command)|Bun\.spawn/;
// In these languages a text in backticks runs as a command.
const BACKTICK_RUNS = /^(ruby|perl|php)$/;
// `decision`: only a decision of the human counts, and a word in a variable is none: nobody can
// say what it is, so the wider question of the first form answers for it.
export function humanCommand(command: string, decision = false): boolean {
  const WORDS = decision ? DECISION_WORDS : HUMAN_WORDS;
  // A decision counts only where the parse shows the program with its word. A text that names
  // the command inside a heredoc, a pipe or code of an interpreter is a guess: it stays a
  // question of the first form, never a refusal.
  const namesHuman = (text: string): boolean => !decision && namesIn(HUMAN_TEXT, text);
  let segments: (FullSegment & { heredoc?: string })[];
  try {
    segments = parse(command) as (FullSegment & { heredoc?: string })[];
  } catch {
    return namesHuman(command);
  }
  for (const seg of segments) {
    // `$'stop'` comes from the parse as `$stop` with no mark of a variable.
    const isVar = (i: number): boolean => seg.vars?.[i] === true;
    const argv = seg.argv.map((w, i) => (isVar(i) ? w : w.replace(/^\$/, '')));
    const [first] = argv;
    if (first === undefined) continue;
    const program = base(first);
    const cli = argv.findIndex((w) => base(w) === 'cli.ts');
    const at = program === 'reins' ? 0 : cli > 0 ? cli : -1;
    if (at >= 0) {
      const words = argv.slice(at + 1);
      if (WORDS.test(words.join(' '))) return true;
      // The command itself is in a variable: nobody can say that it is not a word of the human.
      if (!decision && (isVar(at + 1) || (HUMAN_HEADS.has(words[0] ?? '') && isVar(at + 2)))) return true;
      continue;
    }
    // The program is in a variable: the words after it decide.
    if (isVar(0) && WORDS.test(argv.slice(1).join(' '))) return true;
    const heredoc = typeof seg.heredoc === 'string' ? seg.heredoc : '';
    // A shell without `-c` reads its commands from a heredoc, a file or a pipe: the text of the whole line decides.
    if (READS_COMMANDS.has(program) && namesHuman(command)) return true;
    if (RUNS_WORDS.has(program) && namesHuman(argv.slice(1).join(' '))) return true;
    if (INTERPRETER.test(program)) {
      const code = `${argv.slice(1).join(' ')}\n${heredoc}`;
      if (namesHuman(code) && (STARTS_PROCESS.test(code) || (BACKTICK_RUNS.test(program) && code.includes('`')))) return true;
    }
  }
  return false;
}

// The calls of the harness in a command line: for each one the words after the program, as the
// parse gives them. null: the parse did not read the line.
export function reinsCalls(command: string): string[][] | null {
  let segments: FullSegment[];
  try {
    segments = parse(command) as FullSegment[];
  } catch {
    return null;
  }
  const out: string[][] = [];
  for (const seg of segments) {
    const argv = seg.argv.map((w, i) => (seg.vars?.[i] === true ? w : w.replace(/^\$/, '')));
    const [first] = argv;
    if (first === undefined) continue;
    const cli = argv.findIndex((w) => base(w) === 'cli.ts');
    const at = base(first) === 'reins' ? 0 : cli > 0 ? cli : seg.vars?.[0] === true ? 0 : -1;
    if (at >= 0) out.push(argv.slice(at + 1));
  }
  return out;
}
