// The craft: the harness looks at its own journal, finds what repeats, and proposes a change to
// the human. It changes nothing itself: a proposal is resolved by the human.
// Specification: docs/spec/harness-craft.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JournalRow } from '../contracts/journal.ts';
import type { CraftSettings } from '../packs/packs.ts';
import { isObj } from '../contracts/shape.ts';
import type { Runtime } from '../core/runtime.ts';
import { loadTask } from '../core/runtime.ts';
import { readJournalSince } from '../journal/writer.ts';
import { listRecords, retireRecord } from '../memory/store.ts';

export type Pattern = { pattern: 'repeated_question' | 'check_fails_often' | 'repeated_contract' | 'record_unused'; key: string; n: number };
// A change that the code made ready: the acceptance of the human applies it. A manifest goes into
// the person pack; a memory record goes stale.
export type Change = { kind: 'manifest'; path: string; manifest: unknown } | { kind: 'memory'; record: string; state: 'stale' };
export type Effect = 'better' | 'same' | 'worse' | 'not_measured';
// `rejected_n`: the size of the pattern when the human rejected it. `applied`: the ready change was made.
export type Proposal = Pattern & { id: string; created: string; state: 'open' | 'accepted' | 'rejected'; change?: Change; resolved?: string; applied?: boolean; effect?: Effect; rejected_n?: number };

const DAY = 24 * 60 * 60 * 1000;
// The thresholds of the code. A pack can set its own: the section `craft`.
const MIN_QUESTIONS = 5; // the same rule asked this often: describe the tool or name the write in a scenario
const MIN_CHECKS = 4; // a scenario with this many checks ...
const FAIL_SHARE = 0.5; // ... and this share of FAIL: its instructions do not lead to a ready report
const MIN_CONTRACTS = 3; // contracts with one name: the work repeats, it can be a scenario
const UNUSED_DAYS = 30; // a memory record that no report cited for this long
const PERIOD_MS = 14 * DAY;
const MEASURE_AFTER_MS = 7 * DAY; // an accepted proposal is measured after this long ...
const MEASURE_UNTIL_MS = 28 * DAY; // ... and no longer tried after this long
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

type Counts = { decisions: number; asked: Map<string, number>; checks: Map<string, { all: number; fail: number }>; contracts: Map<string, number>; started: Map<string, number>; returned: Map<string, number> };

// What a set of journal rows counts. A decision row is followed by its basis row.
function count(rows: JournalRow[]): Counts {
  const c: Counts = { decisions: 0, asked: new Map(), checks: new Map(), contracts: new Map(), started: new Map(), returned: new Map() };
  const add = (m: Map<string, number>, key: string): void => void m.set(key, (m.get(key) ?? 0) + 1);
  let question = false;
  for (const row of rows) {
    if (row.kind === 'policy.decision') {
      c.decisions += 1;
      // A question that no human saw (a mode of the client without questions) is no load on the human.
      question = row.data?.outcome === 'ask' && row.data.unshown !== 1;
    } else if (row.kind === 'policy.basis') {
      const rule = row.data?.rule;
      if (question && typeof rule === 'string') add(c.asked, rule);
      question = false;
    } else if (row.scenario === undefined) continue;
    else if (row.kind === 'check.answered') {
      const k = c.checks.get(row.scenario) ?? { all: 0, fail: 0 };
      k.all += 1;
      if (row.data?.result === 'FAIL') k.fail += 1;
      c.checks.set(row.scenario, k);
    } else if (row.kind === 'task.contract_approved') add(c.contracts, row.scenario);
    else if (row.kind === 'task.started') add(c.started, row.scenario);
    else if (row.kind === 'task.returned') add(c.returned, row.scenario);
  }
  return c;
}

// The patterns of a set of journal rows.
export function detect(rows: JournalRow[], set: CraftSettings = {}): Pattern[] {
  const c = count(rows);
  const out: Pattern[] = [];
  for (const [key, n] of c.asked) if (n >= (set.min_questions ?? MIN_QUESTIONS)) out.push({ pattern: 'repeated_question', key, n });
  for (const [key, k] of c.checks) {
    // A scenario that the packs tell the craft to leave alone gets no proposal about itself.
    if ((set.keep ?? []).includes(key)) continue;
    if (k.all >= (set.min_checks ?? MIN_CHECKS) && k.fail / k.all >= FAIL_SHARE) out.push({ pattern: 'check_fails_often', key, n: k.fail });
  }
  for (const [key, n] of c.contracts) if (n >= (set.min_contracts ?? MIN_CONTRACTS)) out.push({ pattern: 'repeated_contract', key, n });
  return out;
}

// The memory records of the project that are in use and that no report cited for a month. A
// decision does not age.
function unusedRecords(rt: Runtime, now: number): Pattern[] {
  const out: Pattern[] = [];
  for (const r of listRecords(rt, now)) {
    if (r.state !== 'active' || r.type === 'decision' || r.project !== rt.project) continue;
    const fresh = Math.max(Date.parse(r.created), r.verified === undefined ? 0 : Date.parse(r.verified), r.last_use === undefined ? 0 : Date.parse(r.last_use));
    const days = Math.floor((now - fresh) / DAY);
    if (days >= (rt.merged.craft?.unused_days ?? UNUSED_DAYS)) out.push({ pattern: 'record_unused', key: r.id, n: days });
  }
  return out;
}

// The manifest of the last contract with this name: the ready content of a scenario.
function contractManifest(rt: Runtime, name: string): unknown {
  let best: { at: number; manifest: unknown } | undefined;
  let names: string[];
  try {
    names = fs.readdirSync(path.join(rt.stateDir, 'tasks'));
  } catch {
    return undefined;
  }
  for (const file of names) {
    const id = /^(t[0-9a-f]{12})\.json$/.exec(file)?.[1];
    const task = id === undefined ? null : loadTask(rt, id);
    if (task === null || task.kind !== 'contract' || task.scenario !== name || task.manifest === undefined) continue;
    const at = fs.statSync(path.join(rt.stateDir, 'tasks', file)).mtimeMs;
    if (best === undefined || at > best.at) best = { at, manifest: task.manifest };
  }
  return best?.manifest;
}

function changeOf(rt: Runtime, found: Pattern): Change | undefined {
  if (found.pattern === 'record_unused') return { kind: 'memory', record: found.key, state: 'stale' };
  if (found.pattern === 'repeated_contract' && NAME.test(found.key)) {
    const manifest = contractManifest(rt, found.key);
    if (manifest !== undefined) return { kind: 'manifest', path: `manifests/${found.key}.json`, manifest };
  }
  return undefined;
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

// Looks at the journal of the last two weeks and at the memory, and makes a proposal for every
// pattern that has none yet. A pattern that the human rejected is proposed again only when it
// grew twice.
export function propose(rt: Runtime, now: number = Date.now()): Proposal[] {
  const rows = readJournalSince(rt.stateDir, now - PERIOD_MS).filter((r) => Date.parse(r.ts) >= now - PERIOD_MS);
  const known = new Map(listProposals(rt).map((p) => [`${p.pattern} ${p.key}`, p]));
  const made: Proposal[] = [];
  // The count of proposals in a week, when the packs name one: the human reads a few, not a heap.
  // What does not fit waits: its pattern stays in the journal and is found again.
  const perWeek = rt.merged.craft?.per_week;
  let week = [...known.values()].filter((p) => now - Date.parse(p.created) < 7 * DAY && Date.parse(p.created) <= now).length;
  for (const found of [...detect(rows, rt.merged.craft), ...unusedRecords(rt, now)]) {
    const before = known.get(`${found.pattern} ${found.key}`);
    if (before !== undefined && !(before.state === 'rejected' && found.n >= 2 * (before.rejected_n ?? before.n))) continue;
    if (perWeek !== undefined && week >= perWeek) break;
    const change = changeOf(rt, found);
    // The id comes from the pattern: two sessions that start together make one proposal, not two.
    const p: Proposal = {
      ...found, id: `c${crypto.createHash('sha256').update(`${found.pattern} ${found.key}`).digest('hex').slice(0, 10)}`, created: new Date(now).toISOString(), state: 'open',
      ...(change !== undefined ? { change } : {}),
    };
    try {
      fs.mkdirSync(dirOf(rt), { recursive: true });
      // A rejected proposal opens again only while it is still rejected: another session may have opened it.
      if (before !== undefined) {
        if (listProposals(rt).find((x) => x.id === p.id)?.state !== 'rejected') continue;
        save(rt, p);
      }
      else fs.writeFileSync(path.join(dirOf(rt), `${p.id}.json`), JSON.stringify(p), { flag: 'wx' });
    } catch {
      continue; // another process made it
    }
    week += 1;
    rt.journal.write({ kind: 'craft.pattern_found', project: rt.project, data: { pattern: p.pattern, key: p.key, n: p.n } });
    rt.journal.write({ kind: 'craft.proposal_created', project: rt.project, data: { proposal: p.id, pattern: p.pattern } });
    made.push(p);
  }
  return made;
}

// Makes the ready change of a proposal. False: there is no change, or it cannot be made.
function apply(rt: Runtime, p: Proposal, now: number): boolean {
  const change = p.change;
  if (change === undefined) return false;
  if (change.kind === 'memory') return retireRecord(rt, change.record, now, rt.merged.craft?.unused_days ?? UNUSED_DAYS);
  // A new scenario lies in the pack of the person. A file that is there already is not replaced.
  const dir = rt.merged.packs.find((x) => x.level === 'person')?.dir;
  if (dir === undefined || !NAME.test(p.key)) return false;
  try {
    fs.mkdirSync(path.join(dir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifests', `${p.key}.json`), `${JSON.stringify(change.manifest, null, 2)}\n`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// The decision of the human. An acceptance makes the ready change of the proposal.
export function resolveProposal(rt: Runtime, id: string, state: 'accepted' | 'rejected', now: number = Date.now()): boolean {
  const p = listProposals(rt).find((x) => x.id === id);
  if (p === undefined || p.state !== 'open') return false;
  const resolved = new Date(now).toISOString();
  save(rt, state === 'accepted' ? { ...p, state, resolved, applied: apply(rt, p, now) } : { ...p, state, resolved, rejected_n: p.n });
  rt.journal.write({ kind: 'craft.proposal_resolved', project: rt.project, data: { proposal: id, state } });
  return true;
}

const compare = (after: number, before: number): Effect => (after < before ? 'better' : after > before ? 'worse' : 'same');

// What an accepted proposal did: the same scenario or rule before the acceptance and after it,
// over equal periods. Without enough data after the acceptance the effect is "not measured".
function effectOf(p: Proposal, before: Counts, after: Counts): Effect {
  if (p.pattern === 'repeated_question') {
    // No decision of the policy after the acceptance: nobody worked, so nothing is measured.
    if (after.decisions === 0 || (before.asked.get(p.key) ?? 0) === 0) return 'not_measured';
    return compare(after.asked.get(p.key) ?? 0, before.asked.get(p.key) ?? 0);
  }
  if (p.pattern === 'check_fails_often') {
    const a = after.checks.get(p.key);
    const b = before.checks.get(p.key);
    if (a === undefined || a.all < MIN_CHECKS || b === undefined || b.all === 0) return 'not_measured';
    return compare(a.fail / a.all, b.fail / b.all);
  }
  if (p.pattern === 'repeated_contract') {
    const a = after.started.get(p.key) ?? 0;
    const b = before.started.get(p.key) ?? 0;
    // The size of the sample of a measure is a number of the code: a pack does not set how an effect is judged.
    if (a < MIN_CONTRACTS || b === 0) return 'not_measured';
    return compare((after.returned.get(p.key) ?? 0) / a, (before.returned.get(p.key) ?? 0) / b);
  }
  return 'not_measured';
}

// Measures the accepted proposals that are a week old. Returns those that got an effect now.
export function measure(rt: Runtime, now: number = Date.now()): Proposal[] {
  const out: Proposal[] = [];
  for (const p of listProposals(rt)) {
    if (p.state !== 'accepted' || p.resolved === undefined || (p.effect !== undefined && p.effect !== 'not_measured')) continue;
    const at = Date.parse(p.resolved);
    const age = now - at;
    if (Number.isNaN(at) || age < MEASURE_AFTER_MS || age > MEASURE_UNTIL_MS) continue;
    const span = Math.min(age, PERIOD_MS);
    const rows = readJournalSince(rt.stateDir, at - span);
    const within = (from: number, to: number): JournalRow[] => rows.filter((r) => { const t = Date.parse(r.ts); return t >= from && t < to; });
    const effect = effectOf(p, count(within(at - span, at)), count(within(at, at + span)));
    if (effect === p.effect) continue;
    const next: Proposal = { ...p, effect };
    save(rt, next);
    if (effect === 'not_measured') continue;
    rt.journal.write({ kind: 'craft.effect_measured', project: rt.project, data: { proposal: p.id, effect } });
    out.push(next);
  }
  return out;
}
