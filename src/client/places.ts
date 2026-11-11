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
