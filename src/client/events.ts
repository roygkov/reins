// One entry for the events of a client, in one form: an object with the name of the event. A
// codec of a client that has no forms of its own passes its events here as they are, and prints
// the answer of the core as it is. The answer has one form for every client.
// Specification: docs/spec/harness-client, pages 1, 2 and 4.

import { afterAction, beforeAction, type ClientTools, type ToolCall } from './before.ts';
import { noteCost } from './cost.ts';
import { executorReported, executorStarted } from './executors.ts';
import { agentStopped, beforeCompaction, humanRequest, sessionEnd, sessionStart, type SessionEvent } from './session.ts';
import { isObj } from '../contracts/shape.ts';
import type { Runtime } from '../core/runtime.ts';

export const EVENTS = ['session_start', 'request', 'before', 'after', 'executor_start', 'executor_report', 'stop', 'before_compaction', 'session_end'] as const;
export type EventName = (typeof EVENTS)[number];
export type EventReply = Record<string, unknown>;

// The answer to an event whose form cannot be read: a doubt about a write goes to the human.
export const UNREADABLE: EventReply = { outcome: 'ask', rule: 'adapter.shape' };

// The common fields of an event, or null when the form is not the form of an event.
export function readEvent(value: unknown): { event: EventName; cwd: string; session?: string } | null {
  if (!isObj(value) || typeof value.event !== 'string' || !(EVENTS as readonly string[]).includes(value.event)) return null;
  if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) return null;
  const out: { event: EventName; cwd: string; session?: string } = { event: value.event as EventName, cwd: value.cwd };
  if (typeof value.session === 'string' && value.session !== '') out.session = value.session;
  return out;
}

export function handleEvent(rt: Runtime, value: unknown, tools: ClientTools, client: string): EventReply {
  const head = readEvent(value);
  if (head === null || !isObj(value)) return UNREADABLE;
  const session = head.session !== undefined ? { session: head.session } : {};
  const e: SessionEvent = { cwd: head.cwd, client, ...session };
  if (value.headless === true) e.headless = true;
  switch (head.event) {
    case 'session_start': {
      if (isObj(value.capabilities)) {
        e.capabilities = {};
        if (typeof value.capabilities.before === 'boolean') e.capabilities.before = value.capabilities.before;
        if (typeof value.capabilities.choice === 'boolean') e.capabilities.choice = value.capabilities.choice;
      }
      return { context: sessionStart(rt, e).context };
    }
    case 'request': return humanRequest(rt, e);
    case 'stop': return agentStopped(rt, e);
    case 'before_compaction': return beforeCompaction(rt, e);
    case 'session_end': return sessionEnd(rt, e);
    case 'executor_start': {
      const r = executorStarted(rt, { cwd: head.cwd, ...session, ...(typeof value.role === 'string' ? { role: value.role } : {}) });
      return { outcome: r.outcome, rule: r.rule, task: r.task };
    }
    case 'executor_report':
      return executorReported(rt, { cwd: head.cwd, ...session, ...(typeof value.role === 'string' ? { role: value.role } : {}), ...(typeof value.size === 'number' ? { size: value.size } : {}), ...(typeof value.report === 'string' ? { report: value.report } : {}) });
    case 'before':
    case 'after': {
      if (typeof value.tool !== 'string' || value.tool === '' || !isObj(value.input)) return head.event === 'before' ? UNREADABLE : {};
      const call: ToolCall = { cwd: head.cwd, tool: value.tool, input: value.input, ...session };
      if (typeof value.executor === 'string' && value.executor !== '') call.sub = value.executor;
      if (value.headless === true) call.headless = true;
      if (head.event === 'after') {
        const done = afterAction(rt, call, tools, value.asked !== false, value.failed === true);
        // What the model spent since the event before, when the client knows it.
        if (typeof value.tokens === 'number') noteCost(rt, { ...session, tokens: value.tokens });
        // The source of the output: the client tells the agent that the output is data of that source.
        return done.source !== undefined ? { source: done.source } : {};
      }
      const r = beforeAction(rt, call, tools);
      const out: EventReply = { outcome: r.outcome, rule: r.rule };
      if (r.task !== undefined) out.task = r.task;
      if (r.grant !== undefined) out.grant = r.grant;
      if (r.queued !== undefined) out.queued = r.queued;
      if (r.scope !== undefined) out.scope = r.scope;
      if (r.envelope !== 'none') out.envelope = r.envelope;
      return out;
    }
  }
}
