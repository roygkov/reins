// What a task spends. A client reports the tokens that the model used; the core adds them to the
// task of the session and stops a task that went past its limit. The limit of a task is the
// limit of its manifest, else the limit of the packs. A free task has no limit.
// Specification: docs/spec/harness-core, page 4, rule 4; page 5, rule 4.

import { applyEvent, frozenRuntime, loadTask, mutateTask, type Runtime } from '../core/runtime.ts';
import { currentScenario } from '../core/sessions.ts';
import type { RowInput } from '../journal/writer.ts';
import { heldFreeTask, sessionTask } from './session.ts';

// `model`: the name of the model that spent, as the client gives it. `parts`: the tokens by kind;
// `cache_read` is not a part of `tokens` (the tokens that were read from the cache cost a small
// share and are not counted in the limit of a task).
export type CostParts = { input?: number; output?: number; cache_write?: number; cache_read?: number };
// `context`: the largest prompt of the answers of the event, when they are answers of the session
// itself and not of a subordinate: the context of the session at that moment.
// `executor`: who spent. Without the field it is the main executor. `role`: the role of a
// subordinate, when the client knows it. What a subordinate spent counts in the task of the
// session and in its limit; the row names the subordinate and carries the task as its parent.
export type CostEvent = { session?: string; tokens: number; calls?: number; ms?: number; model?: string; parts?: CostParts; context?: number; executor?: 'main' | 'sub'; role?: string };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const PARTS = ['input', 'output', 'cache_write', 'cache_read'] as const;
export type CostReply = { task?: string; tokens?: number; over?: boolean };

// The limit of tokens of a task now: what the human gave on top of the first limit counts.
export function tokenLimit(rt: Runtime, id: string): number | undefined {
  const task = loadTask(rt, id);
  if (task === null || task.manifest === undefined) return undefined;
  return task.budget ?? task.manifest.model.token_limit ?? frozenRuntime(rt, task.id).merged.context.maxTokens;
}

export function noteCost(rt: Runtime, e: CostEvent): CostReply {
  // The task that spends: the scenario task that the session holds while it is open, else the free task.
  const held = currentScenario(rt, e.session);
  const scenario = held === undefined ? null : loadTask(rt, held);
  const own = scenario !== null && scenario.session === e.session && scenario.state !== 'closed' && scenario.state !== 'skipped' ? scenario.id : undefined;
  const tokens = Number.isFinite(e.tokens) && e.tokens > 0 ? Math.round(e.tokens) : 0;
  if (tokens === 0) {
    // A count of nothing opens no task: the client sends events after the end of a request too.
    const open = own ?? heldFreeTask(rt, e.session);
    return open === undefined ? {} : { task: open, tokens: loadTask(rt, open)?.cost?.tokens ?? 0, over: false };
  }
  const id = own ?? sessionTask(rt, e.session);
  const task = mutateTask(rt, id, (t) => ({ ...t, cost: { tokens: (t.cost?.tokens ?? 0) + tokens } }));
  if (task === null) return {};
  const sub = e.executor === 'sub';
  const row: RowInput = { kind: 'executor.cost', project: rt.project, task: id, executor: sub ? 'sub' : 'main', data: { tokens, ms: e.ms ?? 0, calls: e.calls ?? 1 } };
  if (sub) {
    row.parent = id;
    if (e.role !== undefined && MODEL.test(e.role)) row.role = e.role;
  }
  const data = row.data as Record<string, unknown>;
  if (e.model !== undefined && MODEL.test(e.model)) data.model = e.model;
  for (const part of PARTS) {
    const n = e.parts?.[part];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) data[part] = Math.round(n);
  }
  // The prompt of a subordinate is not the context of the session.
  if (!sub && typeof e.context === 'number' && Number.isFinite(e.context) && e.context > 0) data.context = Math.round(e.context);
  if (e.session !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(e.session)) row.session = e.session;
  if (task.scenario !== undefined) {
    row.scenario = task.scenario;
    row.scenario_v = task.version ?? 1;
  }
  rt.journal.write(row);
  const limit = tokenLimit(rt, id);
  const total = task.cost?.tokens ?? tokens;
  const over = limit !== undefined && total > limit;
  // A task past its limit does no more work until the human says so.
  if (over && task.state === 'executing') applyEvent(rt, id, { type: 'limit' }, 'harness');
  return { task: id, tokens: total, over };
}
