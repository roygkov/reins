// The journal read into counts: what the harness did in a period. The counts are facts of the
// journal; nothing here judges them.
// Specification: docs/spec/harness-journal.

import type { JournalRow } from '../contracts/journal.ts';

export type Metrics = {
  tasks: { opened: number; closed: number; by_label: Record<string, number>; changed_not_verified: number };
  scenarios: Record<string, { opened: number; accepted: number; returns: number }>;
  checks: { PASS: number; FAIL: number; none: number };
  decisions: { allow: number; ask: number; defer: number; deny: number };
  protected_attempts: number;
  protected: { ask: number; deny: number }; // the attempts at a protected place: a question to the human, or a refusal
  failures: number;
  shape_changes: number;
  memory: { written: number; vetoed: number; reads: number };
};

// The rows of one project. A row that an adapter writes before it knows the project (the
// project `p0`: an input of a hook that cannot be read) belongs to no project.
export const ofProject = (rows: JournalRow[], project: string): JournalRow[] => rows.filter((row) => row.project === project);

// The counts of the rows from `since` (milliseconds) on. A row whose time cannot be read is skipped.
export function summarize(rows: JournalRow[], since = 0): Metrics {
  const m: Metrics = {
    tasks: { opened: 0, closed: 0, by_label: {}, changed_not_verified: 0 }, scenarios: {}, checks: { PASS: 0, FAIL: 0, none: 0 },
    decisions: { allow: 0, ask: 0, defer: 0, deny: 0 }, protected_attempts: 0, protected: { ask: 0, deny: 0 }, failures: 0, shape_changes: 0,
    memory: { written: 0, vetoed: 0, reads: 0 },
  };
  const scenario = (name: string): Metrics['scenarios'][string] => (m.scenarios[name] ??= { opened: 0, accepted: 0, returns: 0 });
  for (const row of rows) {
    const time = Date.parse(row.ts);
    if (Number.isNaN(time) || time < since) continue;
    const data = row.data ?? {};
    switch (row.kind) {
      case 'task.opened':
        m.tasks.opened += 1;
        if (row.scenario !== undefined) scenario(row.scenario).opened += 1;
        break;
      case 'task.closed': {
        m.tasks.closed += 1;
        const label = String(data.label ?? 'unknown');
        m.tasks.by_label[label] = (m.tasks.by_label[label] ?? 0) + 1;
        // Free requests that changed the work and that nothing verified.
        if (row.scenario === undefined && data.changed === 1) m.tasks.changed_not_verified += 1;
        break;
      }
      case 'task.returned':
        if (row.scenario !== undefined) scenario(row.scenario).returns += 1;
        break;
      case 'check.answered':
        if (data.result === 'PASS') {
          m.checks.PASS += 1;
          if (row.scenario !== undefined) scenario(row.scenario).accepted += 1;
        } else m.checks.FAIL += 1;
        break;
      case 'check.no_answer':
        m.checks.none += 1;
        break;
      case 'policy.decision': {
        const o = data.outcome;
        if (o === 'allow' || o === 'ask' || o === 'defer' || o === 'deny') m.decisions[o] += 1;
        break;
      }
      case 'policy.protected_attempt':
        m.protected_attempts += 1;
        if (data.outcome === 'ask' || data.outcome === 'deny') m.protected[data.outcome] += 1;
        break;
      case 'harness.failure':
        m.failures += 1;
        break;
      case 'harness.client_shape_changed':
        m.shape_changes += 1;
        break;
      case 'memory.record_changed':
        // The file of a removed record that went away past its term is no second veto.
        if (data.gone !== undefined) break;
        if (data.state === 'vetoed') m.memory.vetoed += 1;
        // A share and a mark "this was wrong" change a record that was written before.
        // A step and the end of a case change a record that was written before, too.
        // A record that another one replaced, that went stale or that came back was written before, too.
        else if (data.scope === undefined && data.wrong === undefined && data.step === undefined && data.restored === undefined && (data.state === 'active' || data.state === 'pending')) m.memory.written += 1;
        break;
      case 'memory.read':
        m.memory.reads += 1;
        break;
      default:
        break;
    }
  }
  return m;
}

// The eight numbers of the specification (harness-journal, page 5): each answers one question of
// the human. `value` is for the last period, `prev` for the period before it, `n` is the count of
// the rows that the value stands on. A number without rows has no value.
// `parts`: for the share of verified results, the count of the results of each label that is
// counted as verified. A check of the form is not a check of the result: the parts say which it was.
export type Number8 = { value: number | null; prev: number | null; n: number; parts?: Record<string, number> };
export const EIGHT = ['verified_share', 'returns_per_task', 'gate_yes_share', 'no_model_share', 'cost_per_scenario', 'memory_use', 'proposal_effect', 'harness_failures'] as const;
export type Eight = Record<(typeof EIGHT)[number], Number8>;

const round = (x: number): number => Math.round(x * 100) / 100;
const share = (part: number, whole: number): { value: number | null; n: number } => ({ value: whole === 0 ? null : round(Math.min(part / whole, 1)), n: whole });

function period(rows: JournalRow[], from: number, to: number): Record<(typeof EIGHT)[number], { value: number | null; n: number; parts?: Record<string, number> }> {
  const labels: Record<string, number> = {};
  let closed = 0, verified = 0, started = 0, returned = 0, skipped = 0, asks = 0, yes = 0, tokens = 0, given = 0, used = 0, measured = 0, better = 0, failures = 0;
  const costTasks = new Set<string>();
  for (const row of rows) {
    const time = Date.parse(row.ts);
    if (Number.isNaN(time) || time < from || time >= to) continue;
    const data = row.data ?? {};
    switch (row.kind) {
      case 'task.closed':
        // A result is the end of a scenario task, or of a free request that changed the work. A
        // free request that changed nothing is a question: it has no result, verified or not.
        if (row.scenario === undefined && data.changed !== 1) break;
        closed += 1;
        if (typeof data.label === 'string' && data.label !== 'not_verified') {
          verified += 1;
          labels[data.label] = (labels[data.label] ?? 0) + 1;
        }
        break;
      case 'task.started': started += 1; break;
      case 'task.returned': returned += 1; break;
      case 'task.skipped': skipped += 1; break;
      // A question to the human: one that the client showed. In a mode of the client without
      // questions no human can say "yes", so the question is not counted.
      case 'policy.decision': if (data.outcome === 'ask' && data.unshown !== 1) asks += 1; break;
      case 'policy.protected_attempt': if (data.outcome === 'ask' && data.unshown !== 1) asks += 1; break;
      // The "yes" of the human: an answer to a question about one action, or the one approval of a task.
      case 'task.human_decision': if (data.decision === 'answered' || data.decision === 'confirm') yes += 1; break;
      case 'executor.cost':
        // The cost of a scenario: what a free request spent is not counted here.
        if (row.scenario === undefined) break;
        if (typeof data.tokens === 'number') tokens += data.tokens;
        if (row.task !== undefined) costTasks.add(row.task);
        break;
      case 'memory.read': if (typeof data.n === 'number') given += data.n; break;
      case 'memory.record_used': used += 1; break;
      case 'craft.effect_measured':
        measured += 1;
        if (data.effect === 'better') better += 1;
        break;
      case 'harness.failure': case 'harness.client_shape_changed': failures += 1; break;
      // A collect step past its time already has its failure row: the same fault is not counted twice.
      case 'harness.step_timeout': if (data.where !== 'collect') failures += 1; break;
      default: break;
    }
  }
  return {
    verified_share: { ...share(verified, closed), ...(Object.keys(labels).length > 0 ? { parts: labels } : {}) },
    returns_per_task: { value: started === 0 ? null : round(returned / started), n: started },
    gate_yes_share: share(yes, asks),
    no_model_share: share(skipped, skipped + started),
    cost_per_scenario: { value: costTasks.size === 0 ? null : Math.round(tokens / costTasks.size), n: costTasks.size },
    memory_use: share(used, given),
    proposal_effect: share(better, measured),
    harness_failures: { value: failures, n: failures },
  };
}

export function eight(rows: JournalRow[], now: number = Date.now(), days = 7): Eight {
  const span = days * 24 * 60 * 60 * 1000;
  const last = period(rows, now - span, now + 1);
  const before = period(rows, now - 2 * span, now - span);
  const out = {} as Eight;
  for (const name of EIGHT) out[name] = { value: last[name].value, prev: before[name].value, n: last[name].n, ...(last[name].parts !== undefined ? { parts: last[name].parts } : {}) };
  return out;
}

// The cost of each scenario in the period that ends at `now`: its tasks that spent something,
// the tokens, the tokens for one task, and the same number of the period before. The scenario
// that spent the most comes first. A free request is no scenario.
export type ScenarioCost = { scenario: string; tasks: number; tokens: number; per_task: number; prev_per_task: number | null };
export function costByScenario(rows: JournalRow[], now: number = Date.now(), days = 7): ScenarioCost[] {
  const span = days * 24 * 60 * 60 * 1000;
  const sum = (from: number, to: number): Map<string, { tokens: number; tasks: Set<string> }> => {
    const by = new Map<string, { tokens: number; tasks: Set<string> }>();
    for (const row of rows) {
      const time = Date.parse(row.ts);
      if (row.kind !== 'executor.cost' || row.scenario === undefined || Number.isNaN(time) || time < from || time >= to) continue;
      const at = by.get(row.scenario) ?? { tokens: 0, tasks: new Set<string>() };
      if (typeof row.data?.tokens === 'number') at.tokens += row.data.tokens;
      if (row.task !== undefined) at.tasks.add(row.task);
      by.set(row.scenario, at);
    }
    return by;
  };
  const before = sum(now - 2 * span, now - span);
  const out: ScenarioCost[] = [];
  for (const [scenario, at] of sum(now - span, now)) {
    if (at.tasks.size === 0) continue;
    const prev = before.get(scenario);
    out.push({ scenario, tasks: at.tasks.size, tokens: at.tokens, per_task: Math.round(at.tokens / at.tasks.size), prev_per_task: prev === undefined || prev.tasks.size === 0 ? null : Math.round(prev.tokens / prev.tasks.size) });
  }
  return out.sort((a, b) => b.tokens - a.tokens || a.scenario.localeCompare(b.scenario));
}
