// The journal read into counts: what the harness did in a period. The counts are facts of the
// journal; nothing here judges them.
// Specification: docs/spec/harness-journal.

import type { JournalRow } from '../contracts/journal.ts';

export type Metrics = {
  tasks: { opened: number; closed: number; by_label: Record<string, number>; changed_not_verified: number };
  scenarios: Record<string, { opened: number; accepted: number; returns: number }>;
  checks: { PASS: number; FAIL: number; none: number };
  unstable_checks: number; // the pairs of a work and a report that got both PASS and FAIL
  decisions: { allow: number; ask: number; defer: number; deny: number };
  protected_attempts: number;
  protected: { ask: number; deny: number }; // the attempts at a protected place: a question to the human, or a refusal
  failures: number;
  shape_changes: number;
  memory: { written: number; vetoed: number; reads: number };
  // What the tools of the connectors gave back: the calls and the bytes of each tool, the largest
  // sum first. The tools of the client itself write no row, so they are not here.
  tool_output: Record<string, { n: number; bytes: number }>;
  // The questions that the human saw, by the rule that asked, the most asked first: how many were
  // asked and how many got "yes". A rule where every answer is "yes" asks for nothing.
  questions: Record<string, { asked: number; yes: number }>;
  // The cost in time: one decision of the hook before an action (from the start of its process)
  // and one run of the done check. `n` counts the rows that carry a time.
  timing: { hook_ms: Spread; check_ms: Spread };
  // The text that the hooks gave to the agent, by the place: it stays in the context of a session.
  context: Record<string, { n: number; bytes: number }>;
  // The results that a human said were wrong, by the label that the result had.
  disputed: Record<string, number>;
  // The questions that the human saw, and how many fall on one opened task: the attention of the
  // human that one piece of work costs.
  asks: { shown: number; per_task: number | null };
  // The pitfalls that were written, and how many of them name an older record of the same
  // pitfall: the memory had it, and somebody hit it again.
  pitfalls: { written: number; repeats: number };
  // The last run of the commands with a known answer against the barrier in the period: the
  // commands that it let pass wrongly (misses) and that it asked about wrongly (noise).
  probes: { runs: number; n: number | null; misses: number | null; noise: number | null };
};
export type Spread = { n: number; p50: number | null; p95: number | null; max: number | null };

function spread(values: number[]): Spread {
  if (values.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

// The rows of one project. A row that an adapter writes before it knows the project (the
// project `p0`: an input of a hook that cannot be read) belongs to no project.
export const ofProject = (rows: JournalRow[], project: string): JournalRow[] => rows.filter((row) => row.project === project);

// The counts of the rows from `since` (milliseconds) on. A row whose time cannot be read is skipped.
export function summarize(rows: JournalRow[], since = 0): Metrics {
  const m: Metrics = {
    tasks: { opened: 0, closed: 0, by_label: {}, changed_not_verified: 0 }, scenarios: {}, checks: { PASS: 0, FAIL: 0, none: 0 },
    unstable_checks: 0,
    decisions: { allow: 0, ask: 0, defer: 0, deny: 0 }, protected_attempts: 0, protected: { ask: 0, deny: 0 }, failures: 0, shape_changes: 0,
    memory: { written: 0, vetoed: 0, reads: 0 },
    tool_output: {},
    questions: {}, timing: { hook_ms: spread([]), check_ms: spread([]) }, context: {}, disputed: {},
    asks: { shown: 0, per_task: null }, pitfalls: { written: 0, repeats: 0 },
    probes: { runs: 0, n: null, misses: null, noise: null },
  };
  const asked = new Map<string, { asked: number; yes: number }>();
  const question = (rule: string): { asked: number; yes: number } => asked.get(rule) ?? (asked.set(rule, { asked: 0, yes: 0 }), asked.get(rule) as { asked: number; yes: number });
  // A decision "ask" names its rule in the basis row that follows it for the same task and session.
  const waiting = new Set<string>();
  const place = (row: JournalRow): string => `${row.session ?? ''} ${row.task ?? ''}`;
  const hookMs: number[] = [];
  const checkMs: number[] = [];
  const outputs = new Map<string, { n: number; bytes: number }>();
  const answers = new Map<string, Set<string>>();
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
        // The same work and the same report must get the same answer: a check that says PASS and FAIL is not stable.
        if (row.fp !== undefined && typeof data.report === 'string' && typeof data.result === 'string') {
          const key = `${row.scenario ?? ''} ${row.fp} ${data.report} ${typeof data.check === 'string' ? data.check : ''}`;
          answers.set(key, (answers.get(key) ?? new Set()).add(data.result));
        }
        if (typeof data.ms === 'number') checkMs.push(data.ms);
        // A check before the report accepts nothing: the counts of the checks are of reports.
        if (data.probe === 1) break;
        if (data.result === 'PASS') {
          m.checks.PASS += 1;
          if (row.scenario !== undefined) scenario(row.scenario).accepted += 1;
        } else m.checks.FAIL += 1;
        break;
      case 'check.no_answer':
        if (typeof data.ms === 'number') checkMs.push(data.ms);
        if (data.probe === 1) break;
        m.checks.none += 1;
        break;
      case 'policy.decision': {
        const o = data.outcome;
        if (o === 'allow' || o === 'ask' || o === 'defer' || o === 'deny') m.decisions[o] += 1;
        if (typeof data.ms === 'number') hookMs.push(data.ms);
        // A question that no human saw is not a question to the human.
        if (o === 'ask' && data.unshown !== 1) {
          waiting.add(place(row));
          m.asks.shown += 1;
        } else waiting.delete(place(row));
        break;
      }
      case 'policy.basis':
        if (waiting.delete(place(row)) && typeof data.rule === 'string') question(data.rule).asked += 1;
        break;
      case 'policy.protected_attempt':
        m.protected_attempts += 1;
        if (data.outcome === 'ask' || data.outcome === 'deny') m.protected[data.outcome] += 1;
        if (typeof data.ms === 'number') hookMs.push(data.ms);
        if (data.outcome === 'ask' && data.unshown !== 1) m.asks.shown += 1;
        if (data.outcome === 'ask' && data.unshown !== 1 && typeof data.rule === 'string') question(data.rule).asked += 1;
        break;
      case 'task.human_decision':
        // The "yes" of the human to a question about one action names the rule of the question.
        if (data.decision === 'answered' && typeof data.rule === 'string') question(data.rule).yes += 1;
        break;
      case 'task.result_disputed': {
        const label = String(data.label ?? 'unknown');
        m.disputed[label] = (m.disputed[label] ?? 0) + 1;
        break;
      }
      case 'harness.context_given': {
        if (typeof data.where !== 'string' || typeof data.bytes !== 'number') break;
        const at = (m.context[data.where] ??= { n: 0, bytes: 0 });
        at.n += 1;
        at.bytes += data.bytes;
        break;
      }
      case 'harness.barrier_probed':
        if (typeof data.n !== 'number' || typeof data.misses !== 'number' || typeof data.noise !== 'number') break;
        m.probes = { runs: m.probes.runs + 1, n: data.n, misses: data.misses, noise: data.noise };
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
        // A pitfall that is written: a new record, not a step, a share or a mark on an old one.
        if (data.type === 'pitfall' && (data.state === 'active' || data.state === 'pending') && data.scope === undefined && data.wrong === undefined && data.restored === undefined) {
          m.pitfalls.written += 1;
          if (typeof data.repeats === 'string') m.pitfalls.repeats += 1;
        }
        if (data.state === 'vetoed') m.memory.vetoed += 1;
        // A share and a mark "this was wrong" change a record that was written before.
        // A step and the end of a case change a record that was written before, too.
        // A record that another one replaced, that went stale or that came back was written before, too.
        else if (data.scope === undefined && data.wrong === undefined && data.step === undefined && data.restored === undefined && (data.state === 'active' || data.state === 'pending')) m.memory.written += 1;
        break;
      case 'memory.read':
        m.memory.reads += 1;
        break;
      case 'executor.tool_output': {
        // A row without a name or without a size says nothing about a tool.
        if (typeof data.tool !== 'string' || typeof data.size !== 'number') break;
        const at = outputs.get(data.tool) ?? { n: 0, bytes: 0 };
        outputs.set(data.tool, { n: at.n + 1, bytes: at.bytes + data.size });
        break;
      }
      default:
        break;
    }
  }
  for (const [tool, at] of [...outputs].sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))) m.tool_output[tool] = at;
  for (const results of answers.values()) if (results.has('PASS') && results.has('FAIL')) m.unstable_checks += 1;
  for (const [rule, at] of [...asked].sort((a, b) => b[1].asked - a[1].asked || a[0].localeCompare(b[0]))) m.questions[rule] = at;
  m.timing = { hook_ms: spread(hookMs), check_ms: spread(checkMs) };
  m.asks.per_task = m.tasks.opened === 0 ? null : Math.round((m.asks.shown / m.tasks.opened) * 100) / 100;
  return m;
}

// The eight numbers of the specification (harness-journal, page 5): each answers one question of
// the human. `value` is for the last period, `prev` for the period before it, `n` is the count of
// the rows that the value stands on. A number without rows has no value.
// `parts`: for the share of verified results, the count of the results of each label other than
// "not verified". Only `verified_result` counts in the value: a check of the form and an approval
// of the human are not a check of the result, and the parts show how many they were.
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
        if (data.label === 'verified_result') verified += 1;
        if (typeof data.label === 'string' && data.label !== 'not_verified') labels[data.label] = (labels[data.label] ?? 0) + 1;
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

// The eight numbers for each bucket of `step` milliseconds from `from` to `to`, by the formulas of
// the week: a dashboard and the summary of the week never show two different numbers.
// `from` and `to` of a point are the bounds of its bucket; a row at `to` belongs to the next bucket.
// The measures of the harness itself for one period, as plain numbers for a series: the questions
// that fall on one task, the time of a decision of the hook (the middle and the tail), the time
// of a done check, the bytes that the hooks gave to the agent, the results that a human disputed,
// the pitfalls that somebody hit again. A measure without rows has no value.
export const MEASURES = ['asks_per_task', 'hook_ms_p50', 'hook_ms_p95', 'hook_ms_max', 'check_ms_p50', 'check_ms_p95', 'context_bytes', 'disputed', 'pitfall_repeats', 'denied', 'checks_no_answer', 'probe_misses', 'probe_noise'] as const;
export type Measures = Record<(typeof MEASURES)[number], number | null>;
// The numbers of a period that have a name of their own inside one measure (the form 3): the
// questions that the human saw and the "yes" among them by rule, the bytes that the hooks gave by
// place, the disputed results by label. A name without rows is absent.
export const BY = ['questions_asked', 'questions_yes', 'context_bytes', 'disputed'] as const;
export type By = Record<(typeof BY)[number], Record<string, number>>;
export function measures(rows: JournalRow[]): Measures {
  return measured(rows).measures;
}
function measured(rows: JournalRow[]): { measures: Measures; by: By } {
  const m = summarize(rows);
  const pick = <T>(from: Record<string, T>, value: (at: T) => number): Record<string, number> => Object.fromEntries(Object.entries(from).map(([name, at]) => [name, value(at)] as const).filter(([, n]) => n !== 0));
  return {
    measures: {
      asks_per_task: m.asks.per_task,
      hook_ms_p50: m.timing.hook_ms.p50,
      hook_ms_p95: m.timing.hook_ms.p95,
      hook_ms_max: m.timing.hook_ms.max,
      check_ms_p50: m.timing.check_ms.p50,
      check_ms_p95: m.timing.check_ms.p95,
      context_bytes: Object.values(m.context).reduce((sum, at) => sum + at.bytes, 0),
      disputed: Object.values(m.disputed).reduce((sum, n) => sum + n, 0),
      pitfall_repeats: m.pitfalls.repeats,
      // The refusals of the barrier: of the policy and of a protected place.
      denied: m.decisions.deny + m.protected.deny,
      checks_no_answer: m.checks.none,
      probe_misses: m.probes.misses,
      probe_noise: m.probes.noise,
    },
    by: {
      questions_asked: pick(m.questions, (at) => at.asked),
      questions_yes: pick(m.questions, (at) => at.yes),
      context_bytes: pick(m.context, (at) => at.bytes),
      disputed: pick(m.disputed, (n) => n),
    },
  };
}

export type Point = { from: string; to: string; measures: Measures; by: By } & Record<(typeof EIGHT)[number], { value: number | null; n: number; parts?: Record<string, number> }>;
export function series(rows: JournalRow[], from: number, to: number, step: number): Point[] {
  // Each row goes to its bucket once: a long series does not read the whole journal for every bucket.
  const count = Math.max(0, Math.ceil((to - from) / step));
  const buckets: JournalRow[][] = Array.from({ length: count }, () => []);
  for (const row of rows) {
    const time = Date.parse(row.ts);
    if (Number.isNaN(time) || time < from || time >= to) continue;
    buckets[Math.floor((time - from) / step)]?.push(row);
  }
  return buckets.map((bucket, i) => {
    const start = from + i * step;
    const end = Math.min(start + step, to);
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), ...period(bucket, start, end), ...measured(bucket) };
  });
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
