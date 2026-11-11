// The adapter of Claude Code for the events "before an action" and "after an action".
// It checks the form of the hook input, turns it into a call of the core, and turns the decision
// of the core into the hook output of the client. The core knows nothing of these forms.
// `hook.ts` loads this file: a failure of the load itself is then a question, not a silent pass.
//   pre    PreToolUse: prints a permission decision, or nothing
//   post   PostToolUse: prints nothing
// Rule of a failure: a doubt about a write goes to the human, a doubt about a read passes.

import fs from 'node:fs';
import { afterAction, beforeAction, type ClientTools, type Reply, type ToolCall } from '../../../src/client/before.ts';
import { loadRuntime } from '../../../src/client/config.ts';
import { executorReported, executorStarted } from '../../../src/client/executors.ts';
import { agentStopped, humanRequest, sessionEnd, sessionStart, type SessionEvent } from '../../../src/client/session.ts';
import { isObj } from '../../../src/contracts/shape.ts';
import type { Runtime } from '../../../src/core/runtime.ts';
import { fileURLToPath } from 'node:url';

const TOOLS = JSON.parse(fs.readFileSync(new URL('../tools.json', import.meta.url), 'utf8')) as ClientTools;
// The settings of Claude Code that register hooks and plugins: a change of them can turn the
// harness off, so the human decides it.
const CLIENT_PATHS = ['(^|/)\\.claude/(settings[^/]*\\.json|plugins(/|$))'];
// The code of the harness and of this adapter: a change of it changes every decision.
const HARNESS_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function say(decision: 'allow' | 'ask' | 'deny', reason: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
}

// The fields of the hook input that the adapter relies on, checked at every event.
let skipsQuestions = false; // the permission mode of the client that shows no question

function readEvent(): ToolCall | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
  if (!isObj(value) || typeof value.tool_name !== 'string' || value.tool_name === '' || !isObj(value.tool_input)) return null;
  if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) return null;
  // The modes of the client where the human answers a question. In the other modes (`auto`,
  // `dontAsk`, `bypassPermissions`) the documentation does not say that "ask" shows a question.
  skipsQuestions = typeof value.permission_mode === 'string' && !['default', 'acceptEdits', 'plan'].includes(value.permission_mode);
  const call: ToolCall = { cwd: value.cwd, tool: value.tool_name, input: value.tool_input };
  if (typeof value.session_id === 'string' && value.session_id !== '') call.session = value.session_id;
  return call;
}

function runtime(cwd?: string): Runtime | null {
  try {
    return { ...loadRuntime(cwd), harnessDirs: [HARNESS_ROOT], clientPaths: CLIENT_PATHS };
  } catch {
    return null;
  }
}

function reason(r: Reply): string {
  let text = `reins: ${r.rule}`;
  if (r.outcome === 'defer') text += ': the action cannot wait in a queue in this client, it is refused';
  else if (r.scope === 'task' && r.task !== undefined) text += `: one approval for the task ${r.task} covers "${r.grant ?? ''}"`;
  else if (r.envelope === 'limit') text += ': the limit of writes of the task is reached';
  else if (r.envelope === 'applied') text += `: named by the task ${r.task ?? ''}`;
  else if (r.outcome === 'deny') text += ': the harness does not allow this action';
  else text += ': the human decides';
  return text;
}

function pre(): void {
  const call = readEvent();
  if (call === null) {
    // The form of the input changed: the barrier still works, as a question for every action.
    runtime()?.journal.write({ kind: 'harness.client_shape_changed', project: 'p0', data: { client: 'claude_code', event: 'pre' } });
    say('ask', 'reins: the input of the hook has an unknown form: the human decides');
    return;
  }
  const isRead = Object.hasOwn(TOOLS, call.tool) && TOOLS[call.tool]?.kind === 'read';
  let r: Reply;
  try {
    const rt = runtime(call.cwd);
    if (rt === null) {
      if (!isRead) say('ask', 'reins: no configuration: the human decides');
      return;
    }
    r = beforeAction(rt, call, TOOLS);
    // A subordinate executor starts through these tools. The core gives it a place only when the
    // call itself passes: a call that is refused or asked about takes no place.
    if ((call.tool === 'Agent' || call.tool === 'Task') && r.outcome === 'allow') {
      // Without a type the client starts its general-purpose agent, and names it so when it ends.
      const role = typeof call.input.subagent_type === 'string' ? call.input.subagent_type : 'general-purpose';
      const started = executorStarted(rt, { cwd: call.cwd, ...(call.session !== undefined ? { session: call.session } : {}), ...(role !== undefined ? { role } : {}) });
      if (started.outcome === 'deny') {
        say('deny', `reins: ${started.rule}: the task ${started.task} has no place for this subordinate executor`);
        return;
      }
    }
  } catch {
    if (!isRead) say('ask', 'reins: failure of the decision: the human decides');
    return;
  }
  if (r.outcome === 'deny' || r.outcome === 'defer') say('deny', reason(r));
  else if (r.outcome === 'ask') say('ask', reason(r));
  // "allow" is said aloud only when the envelope of a task covers the action. Any other allowed
  // action gets no output: the own permission rules of the client still apply to it.
  else if (r.envelope === 'applied') say('allow', reason(r));
}

function post(): void {
  try {
    const call = readEvent();
    if (call === null) return;
    const rt = runtime(call.cwd);
    // In the mode that skips permission questions the human saw no question: no approval.
    if (rt !== null) afterAction(rt, call, TOOLS, !skipsQuestions);
  } catch {
    // "after" never blocks the client
  }
}

// The events of the session. They never block the client: a failure here costs context, not a barrier.
function session(mode: string): void {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (!isObj(value) || typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) return;
    const rt = runtime(value.cwd);
    if (rt === null) return;
    const e: SessionEvent = { cwd: value.cwd, client: 'claude_code' };
    if (typeof value.session_id === 'string' && value.session_id !== '') e.session = value.session_id;
    if (mode === 'session-start') {
      const { context } = sessionStart(rt, e);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }));
    } else if (mode === 'prompt') humanRequest(rt, e);
    else if (mode === 'stop') {
      // The label of the result goes to the human when the request changed the work tree. A request
      // that changed nothing is a question: it has no result to label.
      if (agentStopped(rt, e).changed === true) {
        process.stdout.write(JSON.stringify({ systemMessage: 'reins: this request changed the work tree and no check judged the result: not verified. A scenario with a done check gives a verified result (`reins scenarios`).' }));
      }
    }
    else if (mode === 'session-end') sessionEnd(rt, e);
    else if (mode === 'subagent-stop') {
      const role = typeof value.agent_type === 'string' ? value.agent_type : undefined;
      executorReported(rt, { cwd: e.cwd, ...(e.session !== undefined ? { session: e.session } : {}), ...(role !== undefined ? { role } : {}) });
    }
  } catch {
    // no output: the client goes on
  }
}

export function main(mode: string | undefined): void {
  if (mode === 'pre') pre();
  else if (mode === 'post') post();
  else if (mode !== undefined && ['session-start', 'prompt', 'stop', 'session-end', 'subagent-stop'].includes(mode)) session(mode);
}
