// The citation check, a kind of the done check: every finding of a report names a file and a line
// and quotes the source, and the quote is found there. It proves that a claim rests on the source.
// It does not prove that the claim is true: the label of the result is "form verified".
// Specification: docs/spec/harness-manifest, page 4, rule 4; harness-instance-mr-review, page 4.
//
// The parser and the match (the form of a finding, the window, the least quote, the size limit) are
// the port of agentic v0.5.8 lib/review.js. There the outcome was a metric; here it is the answer of
// the check. So a finding that cannot be checked is a fault of the report, and only a fault of the
// harness itself (no source, the deadline) gives no answer.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_FINDINGS = 10;
export const WINDOW = 3; // lines around the cited line or range where the quote can be
export const MIN_QUOTE = 8; // characters of a quote that are not spaces
export const SIZE_CAP = 1 << 20; // bytes: a larger file is not read
export const SEVERITIES = ['blocking', 'should-fix', 'note'] as const;
export const CONFIDENCES = ['confirmed', 'likely', 'question'] as const;

export type Finding = {
  severity: (typeof SEVERITIES)[number];
  level: (typeof CONFIDENCES)[number] | null;
  category: string | null;
  file: string | null;
  from: number | null;
  to: number | null;
  quote: string | null;
  evidence: 'quote' | 'trace' | null;
  parsed: boolean;
  plan: boolean; // the place is not `file:line`
};

export type FindingFault = 'not_parsed' | 'no_level' | 'no_location' | 'no_quote' | 'short_quote' | 'no_file' | 'not_in_change' | 'not_found';
export type AnswerReason = 'no_source' | 'deadline' | 'no_header' | 'count_mismatch' | 'too_many' | 'faults';
export type Answer = {
  result: 'PASS' | 'FAIL' | 'none';
  reason?: AnswerReason;
  n: number; // the findings that were read
  faults: { n: number; fault: FindingFault }[]; // at most one for a finding, `n` counts from 1
};

export type CitationOptions = {
  root: string; // the source: an absolute path of a directory
  changed?: readonly string[]; // the files of the change, relative to the root; a finding must be in one of them
  maxFindings?: number;
  expired?: () => boolean; // the deadline of the caller, asked before each file
};

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
// ` — `, ` - ` and ` -- ` as the separator between the parts of a finding
const SEP = /\s+(?:—|–|--|-)\s+/;
const FINDING_RE = /^\s*\d+[.)]\s*\[(blocking|should-fix|note)\]\s*(?:\[(confirmed|likely|question)\]\s*)?(.*)$/;
// `path:line` or `path:a-b`; the backticks around it are formatting
const LOC_RE = /^`?([^\s`:]+):(\d+)(?:\s*[-–]\s*(\d+))?`?$/;
const QUOTE_RE = /["“”]([^"“”]*)["“”]/g;
const HEADER_RE = /^\s*review:\s*(\d+)\s+findings?\b/i;

// One numbered line of a report, or null when the line is no finding.
function parseLine(line: string): Finding | null {
  const m = FINDING_RE.exec(line);
  if (!m) return null;
  const f: Finding = {
    severity: m[1] as Finding['severity'], level: (m[2] as Finding['level'] | undefined) ?? null,
    category: null, file: null, from: null, to: null, quote: null, evidence: null, parsed: false, plan: false,
  };
  const rest = norm(m[3] ?? '');
  const segs = rest.split(SEP);
  const place = segs[1];
  if (segs.length < 2 || place === undefined) return f;
  f.category = segs[0] ?? null;
  const loc = LOC_RE.exec(place.trim());
  if (!loc) {
    f.plan = true;
    return f;
  }
  f.file = loc[1] ?? null;
  f.from = Number(loc[2]);
  f.to = loc[3] !== undefined ? Number(loc[3]) : f.from;
  if (f.to < f.from) [f.from, f.to] = [f.to, f.from];
  // The quote: the last "…" before the fix (` — fix:`), or the last one of the line when no fix follows.
  const fixAt = rest.search(/\s+(?:—|–|--|-)\s+fix:/i);
  const before = fixAt >= 0 ? rest.slice(0, fixAt) : rest;
  const ev = /evidence:\s*(quote|trace)\b/i.exec(before);
  f.evidence = ev ? (ev[1]?.toLowerCase() as Finding['evidence']) : null;
  let q: string | null = null;
  for (const mm of before.matchAll(QUOTE_RE)) q = mm[1] ?? null;
  if (q === null) return f;
  f.quote = norm(q);
  f.parsed = true;
  return f;
}

// All findings of a report: the numbered lines with a severity.
export function parseFindings(text: string): Finding[] {
  const out: Finding[] = [];
  for (const line of text.split('\n')) {
    const f = parseLine(line);
    if (f !== null) out.push(f);
  }
  return out;
}

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

function faultOf(realRoot: string, f: Finding, changed: readonly string[] | undefined): FindingFault | null {
  if (f.category === null) return 'not_parsed';
  if (f.level === null) return 'no_level';
  if (f.plan || f.file === null || f.from === null || f.to === null) return 'no_location';
  if (!f.parsed || f.quote === null) return 'no_quote';
  if (weight(f.quote) < MIN_QUOTE) return 'short_quote';
  const real = locate(realRoot, f.file);
  if (real === null) return 'no_file';
  if (changed !== undefined) {
    const rel = path.relative(realRoot, real).split(path.sep).join('/');
    // By the real path, or by the path as the report wrote it (a link inside the source).
    if (!changed.includes(rel) && !changed.includes(path.posix.normalize(f.file))) return 'not_in_change';
  }
  let text: string;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch {
    return 'no_file';
  }
  const lines = text.split('\n');
  const lo = Math.max(1, f.from - WINDOW);
  const hi = Math.min(lines.length, f.to + WINDOW);
  return matches(f.quote, norm(lines.slice(lo - 1, hi).join('\n'))) ? null : 'not_found';
}

// The answer of the check for the text of a report. PASS: the report gives its count of findings,
// the count agrees, and every finding is found in the source. No answer is never a pass.
export function checkCitations(text: string, options: CitationOptions): Answer {
  const findings = parseFindings(text);
  const n = findings.length;
  const realRoot = realDir(options.root);
  if (realRoot === null) return { result: 'none', reason: 'no_source', n, faults: [] };
  // The count line is the first line of the report that is not empty.
  const header = HEADER_RE.exec(text.split('\n').find((line) => line.trim() !== '') ?? '');
  if (!header) return { result: 'FAIL', reason: 'no_header', n, faults: [] };
  if (Number(header[1]) !== n) return { result: 'FAIL', reason: 'count_mismatch', n, faults: [] };
  if (n > (options.maxFindings ?? MAX_FINDINGS)) return { result: 'FAIL', reason: 'too_many', n, faults: [] };
  const faults: Answer['faults'] = [];
  for (const [i, f] of findings.entries()) {
    if (options.expired?.() === true) return { result: 'none', reason: 'deadline', n, faults: [] };
    const fault = faultOf(realRoot, f, options.changed);
    if (fault !== null) faults.push({ n: i + 1, fault });
  }
  return faults.length > 0 ? { result: 'FAIL', reason: 'faults', n, faults } : { result: 'PASS', n, faults };
}
