// The decision before an action. A client tells the core that the agent wants to call a tool;
// the core says what the action is and what the policy decides.
// Specification: docs/spec/harness-client, pages 1 and 2; harness-core, page 3.
//
// What a tool does comes from two places. The adapter of a client describes the tools of the
// client itself (read a file, change a file, run a command). The organization pack describes the
// tools of the connectors. A tool that nothing describes counts as a write.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, grantKey, plainValue, type Action, type Decision, type EnvelopeEffect, type Layer, type LayerDecision, type Outcome } from '../contracts/policy.ts';
import { confirm, decideAction, loadTask, type Runtime } from '../core/runtime.ts';
import { sessionTask } from './session.ts';
import type { RowInput } from '../journal/writer.ts';
import { shellAction } from '../gate/index.ts';
import type { ToolRule } from '../packs/packs.ts';

// `session`: the session of the client, when the client names it.
export type ToolCall = { cwd: string; tool: string; input: Record<string, unknown>; session?: string };

// A tool of the client: it reads, it changes a file (the input field `path` names the file),
// or it runs a shell command (the input field `command` holds it).
export type ClientTool = { kind: 'read' } | { kind: 'local'; path: string } | { kind: 'shell'; command: string };
export type ClientTools = Record<string, ClientTool>;

export type Reply = {
  outcome: Outcome;
  rule: string;
  layer: Layer;
  envelope: EnvelopeEffect;
  scope?: 'action' | 'task';
  task?: string; // the task whose envelope names the action
  grant?: string; // the key of the grant: action, target, environment
};

const UNKNOWN: Action = { via: 'tool', kind: 'unknown', name: 'unknown', target: '', env: { name: 'unknown', known: false, production: false } };
const LOCAL_ENV = { name: 'local', known: true, production: false };
const PUBLISH_IDLE_MS = 60 * 60 * 1000;
const TASK_FILE = /^(t[0-9a-f]{12})\.json$/;

// The rule of the pack for a tool name: the exact name, else the longest pattern that ends with `*`.
function packRule(tools: Record<string, ToolRule>, name: string): ToolRule | undefined {
  if (Object.hasOwn(tools, name)) return tools[name];
  let best: string | undefined;
  for (const pattern of Object.keys(tools)) {
    if (!pattern.endsWith('*') || !name.startsWith(pattern.slice(0, -1))) continue;
    if (best === undefined || pattern.length > best.length) best = pattern;
  }
  return best === undefined ? undefined : tools[best];
}

// The target of a write with the fields of the tool input filled in; null when a field is not
// a plain value. Then nothing says what the write touches, and the action counts as unknown.
function fillTarget(template: string, input: Record<string, unknown>): string | null {
  let ok = true;
  const out = template.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, name: string) => {
    const value = Object.hasOwn(input, name) ? input[name] : undefined;
    let text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text === 'string') text = plainValue(text);
    if (typeof text !== 'string' || text === '' || text.length > 200 || /[\s{}]/.test(text)) {
      ok = false;
      return '';
    }
    return text;
  });
  return ok ? out : null;
}

// A path as the file system has it: the links of the part that exists are followed.
function real(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// What a change of a file touches of the harness itself. The state and the config are closed for
// an agent: with them it could forge a task, an approval or the list of packs. A pack is the
// rules of the harness: the human decides each change.
function protectedBy(rt: Runtime, file: string): { outcome: 'deny' | 'ask'; rule: string } | null {
  const target = real(file);
  if (inside(target, real(rt.stateDir))) return { outcome: 'deny', rule: 'protect.state' };
  if (rt.configFile !== undefined && target === real(rt.configFile)) return { outcome: 'deny', rule: 'protect.config' };
  if (rt.merged.packs.some((p) => inside(target, real(p.dir)))) return { outcome: 'ask', rule: 'protect.packs' };
  // `.reins` of any repository is a pack directory, also before it exists and in another repository.
  if ((rt.projectPackDir !== undefined && inside(target, real(rt.projectPackDir))) || /(^|\/)\.reins(\/|$)/.test(target)) return { outcome: 'ask', rule: 'protect.packs' };
  if ((rt.harnessDirs ?? []).some((d) => inside(target, real(d)))) return { outcome: 'ask', rule: 'protect.harness' };
  return null;
}

// The spellings of a path that a shell command can use: the path, its real path, and both
// relative to the home directory (`~/`, `$HOME/`, `${HOME}/`).
function spellings(p: string): string[] {
  const out = new Set<string>();
  for (const abs of [path.resolve(p), real(p)]) {
    out.add(abs);
    for (const home of [os.homedir(), real(os.homedir())]) {
      if (!inside(abs, home) || abs === home) continue;
      const rel = path.relative(home, abs);
      for (const prefix of ['~/', '$HOME/', '${HOME}/']) out.add(prefix + rel);
    }
  }
  return [...out];
}

// A shell command that names the state, the config or a pack of the harness: the human looks at
// it. This is a match of the text, not a parse of the command: a relative path gets through.
function namedInCommand(rt: Runtime, command: string): string | null {
  const names = (p: string): boolean => spellings(p).some((s) => command.includes(s));
  if (names(rt.stateDir)) return 'protect.state';
  if (rt.configFile !== undefined && names(rt.configFile)) return 'protect.config';
  if (rt.merged.packs.some((p) => names(p.dir)) || (rt.projectPackDir !== undefined && names(rt.projectPackDir)) || /(^|[\s\/="'])\.reins(\/|[\s"']|$)/.test(command)) return 'protect.packs';
  if ((rt.harnessDirs ?? []).some(names)) return 'protect.harness';
  return null;
}

type Read = { action: Action; layers: LayerDecision[]; command?: string } | { guard: { outcome: 'deny' | 'ask'; rule: string } };

// What the call is, in the words of the policy.
function readCall(rt: Runtime, call: ToolCall, clientTools: ClientTools): Read {
  const own = Object.hasOwn(clientTools, call.tool) ? clientTools[call.tool] : undefined;
  if (own !== undefined) {
    if (own.kind === 'read') return { action: { via: 'tool', kind: 'read', name: 'read', target: '', env: LOCAL_ENV }, layers: [] };
    if (own.kind === 'local') {
      const file = call.input[own.path];
      if (typeof file !== 'string' || file === '') return { action: UNKNOWN, layers: [] };
      const guard = protectedBy(rt, path.resolve(call.cwd, file));
      if (guard !== null) return { guard };
      return { action: { via: 'tool', kind: 'local', name: 'change', target: '', env: LOCAL_ENV }, layers: [] };
    }
    const command = call.input[own.command];
    if (typeof command !== 'string') return { action: UNKNOWN, layers: [] };
    const shell = shellAction(command, call.cwd, rt.gateConfig);
    // A refusal of the gate stays a refusal: the question about a path of the harness does not soften it.
    // `reins stop` is the word of the human. The agent can type the command, so the client asks.
    // Quotes and backslashes are dropped first: `reins 'stop'` runs the same command.
    const human = /(^|[\s;&|(/`])(reins|cli\.ts)\s+(stop|memory\s+(veto|decide)|craft\s+(accept|reject))(\s|$|[`)])/.test(command.replace(/\$?['"\\]/g, '')) ? 'protect.human-command' : null;
    const named = shell.result?.decision === 'deny' ? null : (human ?? namedInCommand(rt, command));
    if (named !== null) return { guard: { outcome: 'ask', rule: named } };
    return { action: shell.action, layers: shell.layers, command };
  }
  const rule = packRule(rt.merged.tools, call.tool);
  if (rule === undefined) return { action: UNKNOWN, layers: [] };
  if (rule.kind === 'read') return { action: { via: 'tool', kind: 'read', name: 'read', target: '', env: LOCAL_ENV }, layers: [] };
  const target = fillTarget(rule.target, call.input);
  if (target === null) return { action: UNKNOWN, layers: [] };
  const known = (rt.merged.context.envs ?? []).includes(rule.env);
  const production = !known || (rt.merged.context.productionEnvs ?? []).includes(rule.env);
  return { action: { via: 'tool', kind: 'write', name: rule.action, target, env: { name: rule.env, known, production } }, layers: [] };
}

// The question waits for its answer under the session, the tool and the input of the call: a run
// of the same call in another session is not the answer.

// The rules of the packs that match this call: one layer decision for each. A rule only adds
// strictness; the policy takes the strictest of all layers.
function packLayers(rt: Runtime, call: ToolCall, action: Action, command: string | undefined): LayerDecision[] {
  const out: LayerDecision[] = [];
  for (const rule of rt.merged.rules) {
    if (rule.tool !== undefined && !(rule.tool.endsWith('*') ? call.tool.startsWith(rule.tool.slice(0, -1)) : call.tool === rule.tool)) continue;
    if (rule.action !== undefined && !(action.kind === 'write' && action.via === 'tool' && action.name === rule.action)) continue;
    if (rule.env !== undefined && action.env.name !== rule.env) continue;
    if (rule.command !== undefined && !(command !== undefined && command.includes(rule.command))) continue;
    out.push({ layer: rule.level, outcome: rule.outcome, rule: rule.id });
  }
  return out;
}

// The task that executes and whose envelope names this write. A grant names one action on one
// target: the task is found by the grant, not by the session of the client.
function taskFor(rt: Runtime, key: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(rt.stateDir, 'tasks')).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    const id = TASK_FILE.exec(name)?.[1];
    if (id === undefined) continue;
    const task = loadTask(rt, id);
    if (task === null || !task.envelope.some((g) => grantKey(g.action, g.target, g.env) === key)) continue;
    if (task.state === 'executing') return id;
    // A publication that nobody ended must not leave an approved write for ever: without a use
    // or another change of the task for this long, its envelope no longer answers.
    if (task.state === 'publishing' && Date.now() - fs.statSync(path.join(rt.stateDir, 'tasks', name)).mtimeMs <= (rt.publishIdleMs ?? PUBLISH_IDLE_MS)) return id;
  }
  return undefined;
}

function record(rt: Runtime, call: ToolCall, rows: Pick<RowInput, 'kind' | 'data'>[]): void {
  const task = sessionTask(rt, call.session);
  for (const row of rows) rt.journal.write({ ...row, project: rt.project, task, ...(call.session !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(call.session) ? { session: call.session } : {}) });
}

const pendingFile = (rt: Runtime, call: ToolCall): string =>
  path.join(rt.stateDir, 'pending', `${crypto.createHash('sha256').update(`${call.session ?? ''}\n${call.tool}\n${JSON.stringify(call.input)}`).digest('hex').slice(0, 32)}.json`);

function reply(d: Decision, more: { task?: string; grant?: string } = {}): Reply {
  const r: Reply = { outcome: d.outcome, rule: d.basis.rule, layer: d.basis.layer, envelope: d.envelope };
  if (d.scope !== undefined) r.scope = d.scope;
  if (more.task !== undefined) r.task = more.task;
  if (more.grant !== undefined) r.grant = more.grant;
  return r;
}

export function beforeAction(rt: Runtime, call: ToolCall, clientTools: ClientTools): Reply {
  const read = readCall(rt, call, clientTools);
  if ('guard' in read) {
    record(rt, call, [{ kind: 'policy.protected_attempt', data: { rule: read.guard.rule, outcome: read.guard.outcome } }]);
    return { outcome: read.guard.outcome, rule: read.guard.rule, layer: 'core', envelope: 'none' };
  }
  const { action } = read;
  const layers = [...read.layers, ...packLayers(rt, call, action, read.command)];
  if (action.via === 'tool' && action.kind === 'write') {
    const key = grantKey(action.name, action.target, action.env.name);
    const id = taskFor(rt, key);
    const decision = id === undefined ? null : decideAction(rt, id, action, layers);
    if (id !== undefined && decision !== null) {
      // The question for the whole task: the answer of the human comes back as "the tool ran".
      if (decision.outcome === 'ask' && decision.envelope === 'confirm') {
        const file = pendingFile(rt, call);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ task: id, key }));
      }
      return reply(decision, { task: id, grant: key });
    }
  }
  const decision = decide({ action, layers });
  record(rt, call, [
    { kind: 'policy.decision', data: { outcome: decision.outcome, action_kind: action.kind, env: action.env.name } },
    { kind: 'policy.basis', data: { layer: decision.basis.layer, rule: decision.basis.rule } },
  ]);
  return reply(decision);
}

// The tool ran. When the core asked the one question of a task about this call, the run means
// that the human approved: the grant is confirmed and this first use is counted.
// `asked`: false when the client did not show the question to the human (a mode of the client
// that skips permission questions). Then the run of the tool is no approval.
export function afterAction(rt: Runtime, call: ToolCall, clientTools: ClientTools, asked = true): { confirmed: boolean } {
  if (Object.hasOwn(clientTools, call.tool)) return { confirmed: false };
  if (!asked) {
    fs.rmSync(pendingFile(rt, call), { force: true });
    return { confirmed: false };
  }
  const file = pendingFile(rt, call);
  let pending: unknown;
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
  } catch {
    return { confirmed: false };
  }
  if (pending === null || typeof pending !== 'object') return { confirmed: false };
  const { task, key } = pending as { task?: unknown; key?: unknown };
  if (typeof task !== 'string' || typeof key !== 'string') return { confirmed: false };
  const read = readCall(rt, call, clientTools);
  if ('guard' in read || read.action.kind !== 'write' || grantKey(read.action.name, read.action.target, read.action.env.name) !== key) return { confirmed: false };
  if (!confirm(rt, task, key)) return { confirmed: false };
  decideAction(rt, task, read.action, [...read.layers, ...packLayers(rt, call, read.action, read.command)]);
  return { confirmed: true };
}
