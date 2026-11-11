// The journal read into counts: what the harness did in a period. The counts are facts of the
// journal; nothing here judges them.
// Specification: docs/spec/harness-journal.

import type { JournalRow } from '../contracts/journal.ts';

export type Metrics = {
  tasks: { opened: number; closed: number; by_label: Record<string, number> };
  scenarios: Record<string, { opened: number; accepted: number; returns: number }>;
  checks: { PASS: number; FAIL: number; none: number };
  decisions: { allow: number; ask: number; defer: number; deny: number };
  protected_attempts: number;
  failures: number;
  shape_changes: number;
  memory: { written: number; vetoed: number; reads: number };
};

// The counts of the rows from `since` (milliseconds) on. A row whose time cannot be read is skipped.
export function summarize(rows: JournalRow[], since = 0): Metrics {
  const m: Metrics = {
    tasks: { opened: 0, closed: 0, by_label: {} }, scenarios: {}, checks: { PASS: 0, FAIL: 0, none: 0 },
    decisions: { allow: 0, ask: 0, defer: 0, deny: 0 }, protected_attempts: 0, failures: 0, shape_changes: 0,
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
        break;
      case 'harness.failure':
        m.failures += 1;
        break;
      case 'harness.client_shape_changed':
        m.shape_changes += 1;
        break;
      case 'memory.record_changed':
        if (data.state === 'vetoed') m.memory.vetoed += 1;
        else m.memory.written += 1;
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
