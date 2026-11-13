// The craft: the harness looks at its own journal, finds what repeats, and proposes a change to
// the human. It changes nothing itself: a proposal is resolved by the human.
// Specification: docs/spec/harness-craft.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RULE_NAME, type JournalRow } from '../contracts/journal.ts';
import type { CraftSettings } from '../packs/packs.ts';
import { isObj } from '../contracts/shape.ts';
import type { Runtime } from '../core/runtime.ts';
import { loadTask } from '../core/runtime.ts';
import { readJournalSince } from '../journal/writer.ts';
import { addRecord, listRecords, retireRecord } from '../memory/store.ts';

// `rollback`: an accepted proposal made things worse; the key is the id of that proposal.
// `repeated_approval`: a rule asked many times and the human said "yes" every time.
// `tool_fails_often`: one tool ended with an error many times.
// `repeated_chain`: the same three tools of connectors, in the same order, in several free tasks.
export type Pattern = { pattern: 'repeated_question' | 'repeated_approval' | 'tool_fails_often' | 'repeated_chain' | 'check_fails_often' | 'check_unstable' | 'repeated_contract' | 'record_unused' | 'level_too_low' | 'level_too_high' | 'rollback'; key: string; n: number };
// A change that the code made ready: the acceptance of the human applies it. A manifest goes into
// the person pack; a memory record goes stale.
// The undo of a manifest removes the file that the craft wrote, when it still holds that manifest.
// `pitfall`: a record for the memory, with the text that the code wrote from the facts of the journal;
// `record`: the record that the acceptance made. `undo` of a memory change: the record goes out of
// the work also when a report cited it lately.
export type Change = { kind: 'manifest'; path: string; manifest: unknown } | { kind: 'memory'; record: string; state: 'stale'; undo?: true } | { kind: 'remove_manifest'; path: string; manifest: unknown } | { kind: 'pitfall'; text: string; record?: string };
export type Effect = 'better' | 'same' | 'worse' | 'not_measured';
// `rejected_n`: the size of the pattern when the human rejected it. `applied`: the ready change was made.
// `undone`: the time when the human accepted the undo of this proposal.
// `auto_at`: the proposal applies itself at this time unless the human rejects it. `auto`: it did.
export type Proposal = Pattern & { id: string; created: string; state: 'open' | 'accepted' | 'rejected'; change?: Change; resolved?: string; applied?: boolean; effect?: Effect; rejected_n?: number; undone?: string; auto_at?: string; auto?: boolean };

const DAY = 24 * 60 * 60 * 1000;
// The thresholds of the code. A pack can set its own: the section `craft`.
const MIN_QUESTIONS = 5; // the same rule asked this often: describe the tool or name the write in a scenario
const MIN_APPROVALS = 5; // the human said "yes" to one rule this often, and never "no": the question costs more than it guards
const MIN_TOOL_FAILURES = 5; // one tool failed this often: its description, its connector or the way the agent calls it is wrong
const MIN_CHAINS = 3; // the same chain of tools in this many free tasks: the work repeats, it can be a scenario
const CHAIN = 3; // the length of a chain, in tools
const MIN_CHECKS = 4; // a scenario with this many checks ...
const FAIL_SHARE = 0.5; // ... and this share of FAIL: its instructions do not lead to a ready report
const MIN_RAISES = 3; // a scenario with this many raises of the level of the model ...
const MIN_SMOOTH = 10; // a scenario with this many tasks above the weak level, none came back and none raised the level: the level is too high
const MIN_LOWERED = 5; // the tasks at the lowered level that a measure of that change needs
const LEVEL_RANK: Readonly<Record<string, number>> = { weak: 0, medium: 1, strong: 2 };
const RAISE_SHARE = 0.5; // ... in this share of its tasks: the level of its manifest is too low
const MIN_CONTRACTS = 3; // contracts with one name: the work repeats, it can be a scenario
const UNUSED_DAYS = 30; // a memory record that no report cited for this long
const PERIOD_MS = 14 * DAY;
const MEASURE_AFTER_MS = 7 * DAY; // an accepted proposal is measured after this long ...
const MEASURE_UNTIL_MS = 28 * DAY; // ... and no longer tried after this long
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

type Counts = { decisions: number; asked: Map<string, number>; checks: Map<string, { all: number; fail: number }>; contracts: Map<string, number>; started: Map<string, number>; returned: Map<string, number>; raised: Map<string, number>; yes: Map<string, number>; no: Map<string, number>; failed: Map<string, number>; chains: Map<string, number>; restored: Set<string>; levels: Map<string, Map<string, number>>; unstable: Map<string, number> };

// One question to a check: the scenario, the work, the report and the version of the check.
const pairKey = (row: JournalRow): string => `${row.scenario ?? ''} ${row.fp ?? ''} ${String(row.data?.report)} ${typeof row.data?.check === 'string' ? row.data.check : ''}`;

// What a set of journal rows counts. A decision row is followed by its basis row.
function count(rows: JournalRow[]): Counts {
  const c: Counts = { decisions: 0, asked: new Map(), checks: new Map(), contracts: new Map(), started: new Map(), returned: new Map(), raised: new Map(), yes: new Map(), no: new Map(), failed: new Map(), chains: new Map(), restored: new Set(), levels: new Map(), unstable: new Map() };
  // The answers of the checks for one scenario, one work and one report.
  const answers = new Map<string, Set<string>>();
  const add = (m: Map<string, number>, key: string): void => void m.set(key, (m.get(key) ?? 0) + 1);
  let question = false;
  // The tools of the connectors that each free task called, in order. A task of a scenario repeats by design: it is not counted.
  const steps = new Map<string, string[]>();
  // The tasks whose start is in these rows: a raise of a task that started before them is no part of the share.
  const startedTasks = new Set<string>();
  for (const row of rows) {
    // A record of the memory that came back to work: the human restored it. A step of a case and a share say something else.
    // The last word counts: a record that went out of the work again after it is not restored.
    if (row.kind === 'memory.record_changed' && typeof row.data?.record === 'string' && row.data.step === undefined && row.data.scope === undefined && row.data.wrong === undefined) {
      if (row.data.state === 'active') c.restored.add(row.data.record);
      else if (row.data.state === 'stale' || row.data.state === 'vetoed') c.restored.delete(row.data.record);
    }
    if (row.kind === 'policy.decision') {
      c.decisions += 1;
      // A question that no human saw (a mode of the client without questions) is no load on the human.
      question = row.data?.outcome === 'ask' && row.data.unshown !== 1;
      const tool = row.data?.tool;
      if (typeof tool === 'string' && row.task !== undefined && row.scenario === undefined) {
        const list = steps.get(row.task) ?? [];
        // The same tool several times in a row is one step.
        if (list[list.length - 1] !== tool) list.push(tool);
        steps.set(row.task, list);
      }
    } else if (row.kind === 'policy.basis') {
      const rule = row.data?.rule;
      if (question && typeof rule === 'string') add(c.asked, rule);
      question = false;
    } else if (row.kind === 'executor.tool_failed') {
      const tool = row.data?.tool;
      if (typeof tool === 'string') add(c.failed, tool);
    } else if (row.kind === 'task.human_decision') {
      // The answer of the human to a question of a rule. A row without a rule (an older journal) is not counted.
      // A rule that guards the harness itself or the form of the client is no matter of the craft: its question is never "too many".
      const rule = row.data?.rule;
      if (typeof rule !== 'string' || rule.startsWith('protect.') || rule.startsWith('adapter.')) continue;
      if (row.data?.decision === 'answered') add(c.yes, rule);
      else if (row.data?.decision === 'refused') add(c.no, rule);
    } else if (row.scenario === undefined) continue;
    else if (row.kind === 'check.answered' && row.fp !== undefined && typeof row.data?.report === 'string' && typeof row.data.result === 'string' && (answers.set(pairKey(row), (answers.get(pairKey(row)) ?? new Set<string>()).add(row.data.result)), row.data.probe === 1)) continue;
    else if (row.kind === 'check.answered' && row.data?.probe === 1) continue;
    else if (row.kind === 'check.answered') {
      const k = c.checks.get(row.scenario) ?? { all: 0, fail: 0 };
      k.all += 1;
      if (row.data?.result === 'FAIL') k.fail += 1;
      c.checks.set(row.scenario, k);
    } else if (row.kind === 'task.contract_approved') add(c.contracts, row.scenario);
    else if (row.kind === 'task.started') {
      add(c.started, row.scenario);
      // The level of the model that the task started at; a start without a level is counted under "unknown".
      const level = typeof row.data?.level === 'string' ? row.data.level : 'unknown';
      const at = c.levels.get(row.scenario) ?? new Map<string, number>();
      at.set(level, (at.get(level) ?? 0) + 1);
      c.levels.set(row.scenario, at);
      if (row.task !== undefined) startedTasks.add(row.task);
    }
    else if (row.kind === 'task.returned') add(c.returned, row.scenario);
    else if (row.kind === 'executor.level_raised') {
      if (row.task !== undefined && startedTasks.has(row.task)) add(c.raised, row.scenario);
    }
  }
  // A chain is counted once for a task, however many times the task walks it. A task that has a
  // row of a scenario is a task of a scenario, whatever its decision rows say.
  const ofScenario = new Set(rows.filter((row) => row.scenario !== undefined && row.task !== undefined).map((row) => row.task as string));
  for (const [task, list] of steps) {
    if (ofScenario.has(task)) continue;
    const seen = new Set<string>();
    for (let i = 0; i + CHAIN <= list.length; i += 1) seen.add(list.slice(i, i + CHAIN).join(' > '));
    for (const key of seen) add(c.chains, key);
  }
  for (const [key, results] of answers) if (results.has('PASS') && results.has('FAIL')) add(c.unstable, key.split(' ')[0] ?? '');
  return c;
}

// The patterns of a set of journal rows.
export function detect(rows: JournalRow[], set: CraftSettings = {}): Pattern[] {
  const c = count(rows);
  const out: Pattern[] = [];
  // A rule whose every question got "yes" is one pattern, not two: the approvals say more than the questions.
  const approved = new Set<string>();
  for (const [key, n] of c.yes) {
    if (n < (set.min_approvals ?? MIN_APPROVALS) || (c.no.get(key) ?? 0) > 0) continue;
    out.push({ pattern: 'repeated_approval', key, n });
    approved.add(key);
  }
  for (const [key, n] of c.asked) if (n >= (set.min_questions ?? MIN_QUESTIONS) && !approved.has(key)) out.push({ pattern: 'repeated_question', key, n });
  for (const [key, k] of c.checks) {
    // A scenario that the packs tell the craft to leave alone gets no proposal about itself.
    if ((set.keep ?? []).includes(key)) continue;
    if (k.all >= (set.min_checks ?? MIN_CHECKS) && k.fail / k.all >= FAIL_SHARE) out.push({ pattern: 'check_fails_often', key, n: k.fail });
  }
  // A check that gave PASS and FAIL for one work and one report: one such pair is a pattern.
  for (const [key, n] of c.unstable) if (!(set.keep ?? []).includes(key)) out.push({ pattern: 'check_unstable', key, n });
  for (const [key, n] of c.contracts) if (n >= (set.min_contracts ?? MIN_CONTRACTS)) out.push({ pattern: 'repeated_contract', key, n });
  for (const [key, n] of c.failed) if (n >= (set.min_tool_failures ?? MIN_TOOL_FAILURES)) out.push({ pattern: 'tool_fails_often', key, n });
  for (const [key, n] of c.chains) if (n >= (set.min_chains ?? MIN_CHAINS)) out.push({ pattern: 'repeated_chain', key, n });
  // The agent asked for the higher level in most tasks of a scenario: the level of the manifest
  // is too low for the work. A task raises once, so the count of raises is a count of tasks.
  for (const [key, n] of c.raised) {
    if ((set.keep ?? []).includes(key)) continue;
    const started = c.started.get(key) ?? 0;
    if (n >= (set.min_raises ?? MIN_RAISES) && started > 0 && n / started >= RAISE_SHARE) out.push({ pattern: 'level_too_low', key, n });
  }
  // The other side: every task of a scenario ran above the weak level, none came back and none
  // asked for more. The work may need less. The level that the journal does not name is not known to be high.
  for (const [key, n] of c.started) {
    if ((set.keep ?? []).includes(key) || n < (set.min_smooth ?? MIN_SMOOTH)) continue;
    if ((c.returned.get(key) ?? 0) > 0 || (c.raised.get(key) ?? 0) > 0) continue;
    const levels = c.levels.get(key);
    if (levels === undefined || [...levels.keys()].some((level) => !((LEVEL_RANK[level] ?? 0) > 0))) continue;
    out.push({ pattern: 'level_too_high', key, n });
  }
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

function changeOf(rt: Runtime, found: Pattern, now: number): Change | undefined {
  if (found.pattern === 'record_unused') return { kind: 'memory', record: found.key, state: 'stale' };
  if (found.pattern === 'repeated_contract' && NAME.test(found.key)) {
    const manifest = contractManifest(rt, found.key);
    if (manifest !== undefined) return { kind: 'manifest', path: `manifests/${found.key}.json`, manifest };
  }
  // A tool that fails again and again is a pitfall for the memory (harness-craft, page 2). The
  // text is written by the code from the facts of the journal: the name of the tool and the
  // count. The journal keeps no text of an error, so the pitfall says where to look, not why.
  if (found.pattern === 'tool_fails_often' && RULE_NAME.test(found.key)) {
    // The count is of its time: the text names the day, because the human can accept it days later.
    return { kind: 'pitfall', text: `The tool ${found.key} failed ${found.n} times in the ${Math.round(PERIOD_MS / DAY)} days to ${new Date(now).toISOString().slice(0, 10)}. Before the next call of it: check its input, and whether the system behind it answers.` };
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
  // The craft is switched off: no pattern becomes a proposal. What was proposed before stays for the human.
  if (rt.merged.craft?.off === true) return [];
  const rows = readJournalSince(rt.stateDir, now - PERIOD_MS).filter((r) => Date.parse(r.ts) >= now - PERIOD_MS);
  const known = new Map(listProposals(rt).map((p) => [`${p.pattern} ${p.key}`, p]));
  const made: Proposal[] = [];
  // The count of proposals in a week, when the packs name one: the human reads a few, not a heap.
  // What does not fit waits: its pattern stays in the journal and is found again.
  const perWeek = rt.merged.craft?.per_week;
  // An undo is outside the count: it comes from a measure, not from a pattern.
  let week = [...known.values()].filter((p) => p.pattern !== 'rollback' && now - Date.parse(p.created) < 7 * DAY && Date.parse(p.created) <= now).length;
  for (const found of [...detect(rows, rt.merged.craft), ...unusedRecords(rt, now)]) {
    const before = known.get(`${found.pattern} ${found.key}`);
    if (before !== undefined && !(before.state === 'rejected' && found.n >= 2 * (before.rejected_n ?? before.n))) continue;
    // The questions and the approvals of one rule are one matter for the human: one proposal about the rule is enough.
    const twin = found.pattern === 'repeated_approval' ? 'repeated_question' : found.pattern === 'repeated_question' ? 'repeated_approval' : undefined;
    // A twin that the human rejected stops the rule only until the rule grew twice, as its own rejected proposal would.
    const other = twin === undefined ? undefined : known.get(`${twin} ${found.key}`);
    if (other !== undefined && !(other.state === 'rejected' && found.n >= 2 * (other.rejected_n ?? other.n))) continue;
    if (perWeek !== undefined && week >= perWeek) break;
    const change = changeOf(rt, found, now);
    // The class "with a veto window": a change that one command takes back (a memory record that
    // goes stale) applies itself after the term of the packs. Without the term the human decides all.
    const autoDays = rt.merged.craft?.auto_days;
    // A proposal that the human rejected once and that opens again waits for the human: the "no" was said about this record.
    const autoAt = change?.kind === 'memory' && autoDays !== undefined && before === undefined ? { auto_at: new Date(now + autoDays * DAY).toISOString() } : {};
    // The id comes from the pattern: two sessions that start together make one proposal, not two.
    const p: Proposal = {
      ...found, id: `c${crypto.createHash('sha256').update(`${found.pattern} ${found.key}`).digest('hex').slice(0, 10)}`, created: new Date(now).toISOString(), state: 'open',
      ...(change !== undefined ? { change } : {}), ...autoAt,
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
    // The journal takes a plain name. The key of a chain is three names for the human: the journal gets the number of the proposal.
    rt.journal.write({ kind: 'craft.pattern_found', project: rt.project, data: { pattern: p.pattern, key: RULE_NAME.test(p.key) ? p.key : p.id, n: p.n } });
    rt.journal.write({ kind: 'craft.proposal_created', project: rt.project, data: { proposal: p.id, pattern: p.pattern } });
    made.push(p);
  }
  return made;
}

// Makes the ready change of a proposal. False: there is no change, or it cannot be made.
function apply(rt: Runtime, p: Proposal, now: number): boolean {
  const change = p.change;
  if (change === undefined) return false;
  if (change.kind === 'memory') return retireRecord(rt, change.record, now, change.undo === true ? 0 : (rt.merged.craft?.unused_days ?? UNUSED_DAYS));
  // The human accepted the pitfall: the record is the word of the human, in use at once. The
  // proposal keeps the name of the record: an undo of the proposal takes that record out of the work.
  if (change.kind === 'pitfall') {
    const added = addRecord(rt, { type: 'pitfall', text: change.text, paths: [], by: 'human' }, now);
    if (!added.ok) return false;
    p.change = { ...change, record: added.record.id };
    return true;
  }
  if (change.kind === 'remove_manifest') {
    // The undo removes only what the craft wrote: a file that the human changed since is the work of the human.
    const dir = rt.merged.packs.find((x) => x.level === 'person')?.dir;
    if (dir === undefined || !/^manifests\/[a-z][a-z0-9-]{0,62}\.json$/.test(change.path)) return false;
    try {
      const file = path.join(dir, change.path);
      if (fs.readFileSync(file, 'utf8') !== `${JSON.stringify(change.manifest, null, 2)}\n`) return false;
      fs.rmSync(file);
      return true;
    } catch {
      return false;
    }
  }
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

// The proposals whose veto window is over apply themselves. Returns those that did.
export function applyDue(rt: Runtime, now: number = Date.now()): Proposal[] {
  const out: Proposal[] = [];
  if (rt.merged.craft?.off === true) {
    // The craft is off: nothing applies itself, now or later. A proposal loses its term, so the
    // craft that is switched on again does not apply it at once, with no window for a veto: it waits for the human.
    for (const p of listProposals(rt)) {
      if (p.state !== 'open' || p.auto_at === undefined) continue;
      const { auto_at: _, ...rest } = p;
      save(rt, rest);
    }
    return out;
  }
  // The term is gone from the packs: nothing applies itself, whatever a proposal says.
  if (rt.merged.craft?.auto_days === undefined) return out;
  for (const listed of listProposals(rt)) {
    if (listed.state !== 'open' || listed.auto_at === undefined || listed.change?.kind !== 'memory' || !(Date.parse(listed.auto_at) <= now)) continue;
    // The human can reject it at this same time: the proposal is read again just before the change.
    const p = listProposals(rt).find((x) => x.id === listed.id);
    if (p === undefined || p.state !== 'open' || p.auto_at === undefined) continue;
    const applied = apply(rt, p, now);
    // A change that cannot be made (the record was cited since, or it is gone) is not accepted by itself: the proposal waits for the human.
    if (!applied) {
      const { auto_at: _, ...rest } = p;
      save(rt, rest);
      continue;
    }
    const next: Proposal = { ...p, state: 'accepted', resolved: new Date(now).toISOString(), applied, auto: true };
    save(rt, next);
    rt.journal.write({ kind: 'craft.proposal_resolved', project: rt.project, data: { proposal: p.id, state: 'accepted', auto: 1 } });
    out.push(next);
  }
  return out;
}

// The decision of the human. An acceptance makes the ready change of the proposal.
export function resolveProposal(rt: Runtime, id: string, state: 'accepted' | 'rejected', now: number = Date.now()): boolean {
  const p = listProposals(rt).find((x) => x.id === id);
  if (p === undefined || p.state !== 'open') return false;
  const resolved = new Date(now).toISOString();
  const applied = state === 'accepted' ? apply(rt, p, now) : false;
  save(rt, state === 'accepted' ? { ...p, state, resolved, applied } : { ...p, state, resolved, rejected_n: p.n });
  // The undo was accepted: the proposal that it undoes says so. A ready change that could not be
  // made (the human changed the file) undid nothing: the first proposal stays as it is.
  if (state === 'accepted' && p.pattern === 'rollback' && (p.change === undefined || applied)) {
    const first = listProposals(rt).find((x) => x.id === p.key);
    if (first !== undefined) save(rt, { ...first, undone: resolved });
  }
  rt.journal.write({ kind: 'craft.proposal_resolved', project: rt.project, data: { proposal: id, state } });
  return true;
}

const compare = (after: number, before: number): Effect => (after < before ? 'better' : after > before ? 'worse' : 'same');

// What an accepted proposal did: the same scenario or rule before the acceptance and after it,
// over equal periods. Without enough data after the acceptance the effect is "not measured".
function effectOf(p: Proposal, before: Counts, after: Counts): Effect {
  if (p.pattern === 'repeated_question' || p.pattern === 'repeated_approval') {
    // No decision of the policy after the acceptance: nobody worked, so nothing is measured.
    if (after.decisions === 0 || (before.asked.get(p.key) ?? 0) === 0) return 'not_measured';
    return compare(after.asked.get(p.key) ?? 0, before.asked.get(p.key) ?? 0);
  }
  if (p.pattern === 'check_unstable') {
    // The scenario was checked after the acceptance: fewer unstable pairs is better.
    if ((after.checks.get(p.key)?.all ?? 0) === 0) return 'not_measured';
    return compare(after.unstable.get(p.key) ?? 0, before.unstable.get(p.key) ?? 0);
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
  if (p.pattern === 'tool_fails_often') {
    // No decision of the policy after the acceptance: the agent did not act, so nothing is measured.
    if (after.decisions === 0 || (before.failed.get(p.key) ?? 0) === 0) return 'not_measured';
    return compare(after.failed.get(p.key) ?? 0, before.failed.get(p.key) ?? 0);
  }
  if (p.pattern === 'level_too_low') {
    const a = after.started.get(p.key) ?? 0;
    const b = before.started.get(p.key) ?? 0;
    if (a < MIN_RAISES || b === 0) return 'not_measured';
    return compare((after.raised.get(p.key) ?? 0) / a, (before.raised.get(p.key) ?? 0) / b);
  }
  if (p.pattern === 'level_too_high') {
    // The human lowers the level in the manifest, some time after the acceptance. Only the tasks
    // that started below the level of before say something: the others ran before the change.
    const top = Math.max(-1, ...[...(before.levels.get(p.key)?.keys() ?? [])].map((level) => LEVEL_RANK[level] ?? -1));
    let lowered = 0;
    for (const [level, n] of after.levels.get(p.key) ?? []) if ((LEVEL_RANK[level] ?? top) < top) lowered += n;
    // Too few of them, or none (the change was not made): nothing is measured.
    if (lowered < MIN_LOWERED) return 'not_measured';
    // Before the change the scenario had no return and no raise: any one after it is more than
    // before. A lower level that brings one costs more than it saves.
    return (after.returned.get(p.key) ?? 0) + (after.raised.get(p.key) ?? 0) > 0 ? 'worse' : 'better';
  }
  if (p.pattern === 'record_unused') {
    // The record went out of the work. The human brought it back: the change was wrong. Nobody
    // brought it back while the agent worked: the memory is smaller at no cost.
    // A change that was not made (a report cited the record meanwhile) changed nothing: nothing is measured.
    if (p.applied !== true) return 'not_measured';
    if (after.restored.has(p.key)) return 'worse';
    return after.decisions === 0 ? 'not_measured' : 'better';
  }
  return 'not_measured';
}

// An accepted proposal made things worse: the craft proposes to undo it. The human decides. The
// undo has a ready change only when the first proposal had one that can be taken back.
function proposeUndo(rt: Runtime, first: Proposal, now: number): void {
  const change: Change | undefined = first.applied !== true ? undefined
    : first.change?.kind === 'manifest' ? { kind: 'remove_manifest', path: first.change.path, manifest: first.change.manifest }
    // The pitfall that the first proposal wrote did not help: the undo takes it out of the work.
    : first.change?.kind === 'pitfall' && first.change.record !== undefined ? { kind: 'memory', record: first.change.record, state: 'stale', undo: true }
    : undefined;
  const p: Proposal = {
    pattern: 'rollback', key: first.id, n: 1, id: `c${crypto.createHash('sha256').update(`rollback ${first.id}`).digest('hex').slice(0, 10)}`,
    created: new Date(now).toISOString(), state: 'open', ...(change !== undefined ? { change } : {}),
  };
  try {
    fs.writeFileSync(path.join(dirOf(rt), `${p.id}.json`), JSON.stringify(p), { flag: 'wx' });
  } catch {
    return; // it is there already
  }
  rt.journal.write({ kind: 'craft.proposal_created', project: rt.project, data: { proposal: p.id, pattern: p.pattern } });
}

// One proposal in the words for the human.
export const proposalLine = (p: Proposal): string =>
  p.pattern === 'rollback' ? `${p.id}: undo of the proposal ${p.key}, its effect was worse` : `${p.id}: ${p.pattern} of "${p.key.replace(/\s+/g, ' ').slice(0, 80)}", seen ${p.n} times${p.state === 'open' && p.auto_at !== undefined ? `, applies itself on ${p.auto_at.slice(0, 10)}` : ''}`;

// Measures the accepted proposals that are a week old. Returns those that got an effect now.
export function measure(rt: Runtime, now: number = Date.now()): Proposal[] {
  const out: Proposal[] = [];
  if (rt.merged.craft?.off === true) return out;
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
    // A record that the human restored is back already: there is nothing to undo.
    if (effect === 'worse' && p.pattern !== 'record_unused') proposeUndo(rt, next, now);
  }
  return out;
}
