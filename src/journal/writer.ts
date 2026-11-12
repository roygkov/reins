// The journal file: one JSON row per line, rows are only added. A row is checked before it is
// written. A row that fails the check is not written; the failure is counted and noted.
// A write error never stops the work.
// Specification: docs/spec/harness-journal, pages 1 and 4.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOURNAL_VERSION, validateRow, type JournalError, type JournalRow } from '../contracts/journal.ts';
import { isObj } from '../contracts/shape.ts';

export type RowInput = Omit<JournalRow, 'ts' | 'v'>;
export type WriteResult = { written: boolean; errors: JournalError[] };
export type Journal = { readonly file: string; failures: number; write(row: RowInput): WriteResult };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const archiveDir = (dir: string): string => path.join(dir, 'journal-archive');

// The journal grows to a size limit; then the file moves to the archive and a new file starts.
// The name of an archive file is the time of the move: the names sort in the order of time.
export function openJournal(dir: string, clock: () => Date = () => new Date(), opts: { maxBytes?: number; lostDir?: string } = {}): Journal {
  const file = path.join(dir, 'journal.jsonl');
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const rotate = (): void => {
    try {
      if (fs.statSync(file).size < maxBytes) return;
      fs.mkdirSync(archiveDir(dir), { recursive: true });
      fs.renameSync(file, path.join(archiveDir(dir), `${clock().toISOString().replace(/[-:.]/g, '')}-${process.pid}.jsonl`));
    } catch {
      // no file yet, or another process moved it: the row is written all the same
    }
  };
  // A row that could not be written is lost, but the loss is a fact: a count on the disk, beside
  // the journal when that place can be written, else in a directory of this user (never in the
  // shared temporary directory, where another user could put a file of that name first).
  // The next row that is written, by this process or by another, is preceded by the fact.
  const spare = opts.lostDir ?? path.join(os.homedir(), '.cache', 'reins');
  const lostFiles = [path.join(dir, 'journal.lost'), path.join(spare, `journal-lost-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12)}`)];
  const readLost = (name: string): number => {
    try {
      const n = Number(fs.readFileSync(name, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const noteLost = (n: number): void => {
    for (const name of lostFiles) {
      try {
        fs.mkdirSync(path.dirname(name), { recursive: true });
        fs.writeFileSync(name, String(readLost(name) + n));
        return;
      } catch {
        // this place cannot be written either: the next one
      }
    }
  };
  let looked = false;
  const sayLost = (project: string): void => {
    if (looked) return;
    looked = true;
    // The count is taken by a move: of two processes that look at one time, one gets it.
    let lost = 0;
    for (const name of lostFiles) {
      const mine = `${name}.${process.pid}`;
      try {
        fs.renameSync(name, mine);
        lost += readLost(mine);
        fs.rmSync(mine, { force: true });
      } catch {
        // no count in this place, or another process took it
      }
    }
    if (lost === 0) return;
    try {
      fs.appendFileSync(file, `${JSON.stringify({ ts: clock().toISOString(), v: JOURNAL_VERSION, kind: 'harness.failure', project, data: { where: 'journal', lost } })}\n`);
    } catch (e) {
      // The fact did not reach the journal: the count goes back to the disk.
      noteLost(lost);
      throw e;
    }
  };
  const append = (row: object): boolean => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotate();
      const project = (row as { project?: unknown }).project;
      sayLost(typeof project === 'string' && TOKEN.test(project) ? project : 'unknown');
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
      return true;
    } catch {
      // The next row that this process writes looks for the count again.
      looked = false;
      noteLost(1);
      return false;
    }
  };
  const journal: Journal = {
    file,
    failures: 0,
    write(input) {
      const ts = clock().toISOString();
      const row = { ts, v: JOURNAL_VERSION, ...input };
      const errors = validateRow(row);
      if (errors.length > 0) {
        journal.failures += 1;
        const project = typeof input.project === 'string' && TOKEN.test(input.project) ? input.project : 'unknown';
        append({ ts, v: JOURNAL_VERSION, kind: 'harness.failure', project, data: { where: 'journal' } });
        return { written: false, errors };
      }
      if (!append(row)) {
        journal.failures += 1;
        return { written: false, errors: [] };
      }
      return { written: true, errors: [] };
    },
  };
  return journal;
}

// A reader is tolerant: it skips a line that is not a row and keeps fields that it does not know.
export function readJournal(file: string): JournalRow[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: JournalRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObj(value) && typeof value.kind === 'string') rows.push(value as JournalRow);
    } catch {
      // a broken line does not hide the others
    }
  }
  return rows;
}

// The rows of a period: the archive files that were written to after `since` (milliseconds), then
// the journal file. The rows are in the order of time.
export function readJournalSince(dir: string, since = 0): JournalRow[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(archiveDir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    // no archive
  }
  const rows: JournalRow[] = [];
  for (const name of names) {
    const file = path.join(archiveDir(dir), name);
    try {
      if (fs.statSync(file).mtimeMs < since) continue;
    } catch {
      continue;
    }
    rows.push(...readJournal(file));
  }
  rows.push(...readJournal(path.join(dir, 'journal.jsonl')));
  return rows;
}

// Removes the archive files that are older than the term. Without a term nothing is removed.
export function pruneArchive(dir: string, keepDays: number | undefined, now: number = Date.now()): number {
  if (keepDays === undefined) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(archiveDir(dir));
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(archiveDir(dir), name);
    try {
      if (!name.endsWith('.jsonl') || now - fs.statSync(file).mtimeMs <= keepDays * 24 * 60 * 60 * 1000) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {
      // the file went away
    }
  }
  return removed;
}
