// The craft: the harness looks at its own journal, finds what repeats, and proposes a change to
// the human. It changes nothing itself: a proposal is resolved by the human.
// Specification: docs/spec/harness-craft.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JournalRow } from '../contracts/journal.ts';
import { isObj } from '../contracts/shape.ts';
import type { Runtime } from '../core/runtime.ts';
import { readJournalSince } from '../journal/writer.ts';

export type Pattern = { pattern: 'repeated_question' | 'check_fails_often'; key: string; n: number };
export type Proposal = Pattern & { id: string; created: string; state: 'open' | 'accepted' | 'rejected' };

const MIN_QUESTIONS = 5; // the same rule asked this often: describe the tool or name the write in a scenario
const MIN_CHECKS = 4; // a scenario with this many checks ...
const FAIL_SHARE = 0.5; // ... and this share of FAIL: its instructions do not lead to a ready report
const PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

// The patterns of a set of journal rows. A decision row is followed by its basis row.
export function detect(rows: JournalRow[]): Pattern[] {
  const asked = new Map<string, number>();
  const checks = new Map<string, { all: number; fail: number }>();
  let question = false;
  for (const row of rows) {
    if (row.kind === 'policy.decision') question = row.data?.outcome === 'ask';
    else if (row.kind === 'policy.basis') {
      const rule = row.data?.rule;
      if (question && typeof rule === 'string') asked.set(rule, (asked.get(rule) ?? 0) + 1);
      question = false;
    } else if (row.kind === 'check.answered' && row.scenario !== undefined) {
      const c = checks.get(row.scenario) ?? { all: 0, fail: 0 };
      c.all += 1;
      if (row.data?.result === 'FAIL') c.fail += 1;
      checks.set(row.scenario, c);
    }
  }
  const out: Pattern[] = [];
  for (const [key, n] of asked) if (n >= MIN_QUESTIONS) out.push({ pattern: 'repeated_question', key, n });
  for (const [key, c] of checks) if (c.all >= MIN_CHECKS && c.fail / c.all >= FAIL_SHARE) out.push({ pattern: 'check_fails_often', key, n: c.fail });
  return out;
}

const dirOf = (rt: Runtime): string => path.join(rt.stateDir, 'craft');

export function listProposals(rt: Runtime): Proposal[] {
  let names: string[];
  try {
    names = fs.readdirSync(dirOf(rt));
  } catch {
    return [];
  }
  const out: Proposal[] = [];
  for (const name of names) {
    if (!/^c[0-9a-f]{10}\.json$/.test(name)) continue;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dirOf(rt), name), 'utf8'));
      if (isObj(value) && typeof value.id === 'string' && typeof value.key === 'string') out.push(value as Proposal);
    } catch {
      // a broken file is no proposal
    }
  }
  return out.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

function save(rt: Runtime, p: Proposal): void {
  fs.mkdirSync(dirOf(rt), { recursive: true });
  fs.writeFileSync(path.join(dirOf(rt), `${p.id}.json`), JSON.stringify(p));
}

// Looks at the journal of the last two weeks and makes a proposal for every pattern that has
// none yet. A pattern that the human resolved is not proposed again.
export function propose(rt: Runtime, now: number = Date.now()): Proposal[] {
  const rows = readJournalSince(rt.stateDir, now - PERIOD_MS).filter((r) => Date.parse(r.ts) >= now - PERIOD_MS);
  const known = new Set(listProposals(rt).map((p) => `${p.pattern} ${p.key}`));
  const made: Proposal[] = [];
  for (const found of detect(rows)) {
    if (known.has(`${found.pattern} ${found.key}`)) continue;
    // The id comes from the pattern: two sessions that start together make one proposal, not two.
    const p: Proposal = { ...found, id: `c${crypto.createHash('sha256').update(`${found.pattern} ${found.key}`).digest('hex').slice(0, 10)}`, created: new Date(now).toISOString(), state: 'open' };
    try {
      fs.mkdirSync(dirOf(rt), { recursive: true });
      fs.writeFileSync(path.join(dirOf(rt), `${p.id}.json`), JSON.stringify(p), { flag: 'wx' });
    } catch {
      continue; // another process made it
    }
    rt.journal.write({ kind: 'craft.pattern_found', project: rt.project, data: { pattern: p.pattern, key: p.key, n: p.n } });
    rt.journal.write({ kind: 'craft.proposal_created', project: rt.project, data: { proposal: p.id, pattern: p.pattern } });
    made.push(p);
  }
  return made;
}

export function resolveProposal(rt: Runtime, id: string, state: 'accepted' | 'rejected'): boolean {
  const p = listProposals(rt).find((x) => x.id === id);
  if (p === undefined || p.state !== 'open') return false;
  save(rt, { ...p, state });
  rt.journal.write({ kind: 'craft.proposal_resolved', project: rt.project, data: { proposal: id, state } });
  return true;
}
