// The citation check, a kind of the done check: every item of a report names a file and a line
// and quotes the source, and the quote is found there. It proves that a claim rests on the source.
// It does not prove that the claim is true: the label of the result is "form verified".
// Specification: docs/spec/harness-manifest, page 4, rules 4, 6 and 7.
//
// The report is data, not prose: one JSON object `{"items": [...]}`. The core knows these fields of
// an item: `file`, `line` (and `end` for a range), `quote`, a free `text`, and `source`: the name
// of a collected text (a ticket, a log, the output of a command) that the item quotes in place of
// a file. A text is the value of the collect output itself, not a file that the output points to.
// The manifest can name values of a field that fail an item (`done.reject`) and values that free
// an item from its quote (`done.unquoted`): "nothing was verified" said openly. Every other field
// and its values come from the manifest of the scenario (`output.fields`): what a finding is, and
// which words grade it, is the business of a pack.
//
// The match (the window, the least quote, the size limit, the path check) is the port of agentic
// v0.5.8 lib/review.js. An item that cannot be checked is a fault of the report; only a fault of
// the harness itself (no source, the deadline) gives no answer.

import fs from 'node:fs';
import path from 'node:path';
import { ITEM_CORE_FIELDS } from '../contracts/manifest.ts';
import { isObj } from '../contracts/shape.ts';

export const MAX_ITEMS = 10;
export const WINDOW = 3; // lines around the cited line or range where the quote can be
export const MIN_QUOTE = 8; // characters of a quote that are not spaces
export const SIZE_CAP = 1 << 20; // bytes: a larger file is not read

export type ItemFault = 'bad_item' | 'unknown_field' | 'bad_field' | 'no_location' | 'no_quote' | 'short_quote' | 'no_file' | 'not_in_change' | 'not_found' | 'no_text' | 'rejected';
// `no_check`, `check_failed`: a check script of a pack that is missing or did not answer.
export type AnswerReason = 'no_source' | 'deadline' | 'bad_report' | 'too_many' | 'faults' | 'no_check' | 'check_failed' | 'work_changed' | 'no_work';
export type Answer = {
  result: 'PASS' | 'FAIL' | 'none';
  reason?: AnswerReason;
  n: number; // the items that were read
  faults: { n: number; fault: ItemFault }[]; // at most one for an item, `n` counts from 1
  parts?: { name: string; result: 'FAIL' | 'none' }[]; // a check of several parts: each part that did not pass
  // A check script that gave no answer: its name and the cause. `exit` and `stderr` are of a script
  // that ran and failed; `limit_s` is the time limit that it passed. A script that answered FAIL and
  // wrote an error text has the cause `fail` and the end of that text. The text is for the agent
  // and the human: the journal has only the cause of a script without an answer.
  why?: { name: string; cause: string; exit?: number; stderr?: string; limit_s?: number }[];
  recheck?: number; // a PASS: the items with a value that the manifest names as an item to fix (`done.recheck`)
};

export type CitationOptions = {
  root: string; // the source: an absolute path of a directory
  changed?: readonly string[]; // the files of the change, relative to the root; an item must be in one of them
  maxItems?: number;
  fields?: Readonly<Record<string, readonly string[]>>; // the fields of an item that the manifest names, with their values
  texts?: Readonly<Record<string, string>>; // the named texts of the source: a ticket, a log, the output of a command
  reject?: Readonly<Record<string, readonly string[]>>; // the values of a field that fail an item
  unquoted?: Readonly<Record<string, readonly string[]>>; // the values of a field that free an item from its quote
  recheck?: Readonly<Record<string, readonly string[]>>; // the values of a field that mark an item which needs a fix
  expired?: () => boolean; // the deadline of the caller, asked before each file
};

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

// The list of items of a report, or null when the text is not the one object `{"items": [...]}`.
// A code fence around the object is formatting; any other text around it is not allowed.
function readItems(text: string): unknown[] | null {
  const body = text.trim().replace(/^```[^\n]*\r?\n/, '').replace(/\r?\n```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObj(value) || Object.keys(value).length !== 1 || !Array.isArray(value.items)) return null;
  return value.items;
}

const isLine = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

const weight = (q: string): number => q.replace(/\s+/g, '').length;

// The parts of the quote around `…` or `...`, in their order, each found in the text of the window.
function matches(quote: string, windowText: string): boolean {
  const parts = quote.split(/…|\.\.\./).map(norm).filter(Boolean);
  if (parts.length === 0) return false;
  let at = 0;
  for (const p of parts) {
    const i = windowText.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return true;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realDir(root: string): string | null {
  if (root === '' || !path.isAbsolute(root)) return null;
  try {
    const real = fs.realpathSync(root);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// The cited file as the file system has it, or null: outside the root (a symbolic link out of it
// too), missing, not a regular file, over the size limit.
function locate(realRoot: string, file: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(realRoot, file));
    if (!isInside(real, realRoot)) return null;
    const st = fs.lstatSync(real);
    return st.isFile() && st.size <= SIZE_CAP ? real : null;
  } catch {
    return null;
  }
}

function faultOf(realRoot: string, item: unknown, options: CitationOptions): ItemFault | null {
  if (!isObj(item)) return 'bad_item';
  const named = options.fields ?? {};
  for (const key of Object.keys(item)) {
    if (!ITEM_CORE_FIELDS.includes(key) && !Object.hasOwn(named, key)) return 'unknown_field';
  }
  for (const [key, values] of Object.entries(named)) {
    const value = item[key];
    if (typeof value !== 'string' || !values.includes(value)) return 'bad_field';
  }
  if (item.text !== undefined && typeof item.text !== 'string') return 'bad_field';
  const has = (lists: CitationOptions['reject']): boolean => Object.entries(lists ?? {}).some(([key, values]) => typeof item[key] === 'string' && values.includes(item[key]));
  // A value that the manifest rejects: the item says about itself that it does not hold.
  if (has(options.reject)) return 'rejected';
  // A value that needs no quote: the item says that nothing was verified. It still says about what.
  // A quote beside such a value would look verified: the item carries none.
  if (has(options.unquoted)) {
    if (['file', 'line', 'end', 'quote', 'source'].some((key) => item[key] !== undefined)) return 'no_location';
    return typeof item.text === 'string' && item.text.trim() !== '' ? null : 'no_text';
  }
  // A quote of a named text: the text as the collect step gave it. The item has one place.
  if (item.source !== undefined) {
    if (item.file !== undefined || item.line !== undefined || item.end !== undefined) return 'no_location';
    const body = typeof item.source === 'string' && options.texts !== undefined && Object.hasOwn(options.texts, item.source) ? options.texts[item.source] : undefined;
    if (body === undefined) return 'no_text';
    if (typeof item.quote !== 'string') return 'no_quote';
    const cited = norm(item.quote);
    if (weight(cited) < MIN_QUOTE) return 'short_quote';
    return matches(cited, norm(body)) ? null : 'not_found';
  }
  const { file, line, end } = item;
  if (typeof file !== 'string' || file === '' || !isLine(line) || (end !== undefined && !isLine(end))) return 'no_location';
  const from = Math.min(line, end ?? line);
  const to = Math.max(line, end ?? line);
  if (typeof item.quote !== 'string') return 'no_quote';
  const quote = norm(item.quote);
  if (weight(quote) < MIN_QUOTE) return 'short_quote';
  const real = locate(realRoot, file);
  if (real === null) return 'no_file';
  if (options.changed !== undefined) {
    const rel = path.relative(realRoot, real).split(path.sep).join('/');
    // By the real path, or by the path as the report wrote it (a link inside the source).
    if (!options.changed.includes(rel) && !options.changed.includes(path.posix.normalize(file))) return 'not_in_change';
  }
  let text: string;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch {
    return 'no_file';
  }
  const lines = text.split('\n');
  const lo = Math.max(1, from - WINDOW);
  const hi = Math.min(lines.length, to + WINDOW);
  return matches(quote, norm(lines.slice(lo - 1, hi).join('\n'))) ? null : 'not_found';
}

// The answer of the check for the text of a report. PASS: the report is the object with the list
// of items, and every item is found in the source. An empty list is a valid report. No answer is
// never a pass.
export function checkCitations(text: string, options: CitationOptions): Answer {
  const items = readItems(text);
  const n = items?.length ?? 0;
  const realRoot = realDir(options.root);
  if (realRoot === null) return { result: 'none', reason: 'no_source', n, faults: [] };
  if (items === null) return { result: 'FAIL', reason: 'bad_report', n, faults: [] };
  if (n > Math.min(options.maxItems ?? MAX_ITEMS, MAX_ITEMS)) return { result: 'FAIL', reason: 'too_many', n, faults: [] };
  const faults: Answer['faults'] = [];
  for (const [i, item] of items.entries()) {
    if (options.expired?.() === true) return { result: 'none', reason: 'deadline', n, faults: [] };
    const fault = faultOf(realRoot, item, options);
    if (fault !== null) faults.push({ n: i + 1, fault });
  }
  if (faults.length > 0) return { result: 'FAIL', reason: 'faults', n, faults };
  // The items that need a fix are counted in a report that holds: the count is a fact for the stop.
  const lists = Object.entries(options.recheck ?? {});
  const recheck = lists.length === 0 ? undefined : items.filter((item) => isObj(item) && lists.some(([key, values]) => typeof item[key] === 'string' && values.includes(item[key]))).length;
  return { result: 'PASS', n, faults, ...(recheck !== undefined ? { recheck } : {}) };
}
