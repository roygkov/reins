// The journal file: one JSON row per line, rows are only added. A row is checked before it is
// written. A row that fails the check is not written; the failure is counted and noted.
// A write error never stops the work.
// Specification: docs/spec/harness-journal, pages 1 and 4.

import fs from 'node:fs';
import path from 'node:path';
import { JOURNAL_VERSION, validateRow, type JournalError, type JournalRow } from '../contracts/journal.ts';
import { isObj } from '../contracts/shape.ts';

export type RowInput = Omit<JournalRow, 'ts' | 'v'>;
export type WriteResult = { written: boolean; errors: JournalError[] };
export type Journal = { readonly file: string; failures: number; write(row: RowInput): WriteResult };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;

export function openJournal(dir: string, clock: () => Date = () => new Date()): Journal {
  const file = path.join(dir, 'journal.jsonl');
  const append = (row: object): boolean => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
      return true;
    } catch {
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
