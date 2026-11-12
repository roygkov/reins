// The decision before an action. A client tells the core that the agent wants to call a tool;
// the core says what the action is and what the policy decides.
// Specification: docs/spec/harness-client, pages 1 and 2; harness-core, page 3.
//
// What a tool does comes from two places. The adapter of a client describes the tools of the
// client itself (read a file, change a file, run a command). The organization pack describes the
// tools of the connectors. A tool that nothing describes counts as a write.

import { RULE_NAME } from '../contracts/journal.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, grantKey, plainValue, type Action, type Decision, type EnvelopeEffect, type Layer, type LayerDecision, type Outcome } from '../contracts/policy.ts';
import { applyEvent, confirm, decideAction, frozenRuntime, loadTask, mutateTask, redGuards, verifyWork, type Runtime } from '../core/runtime.ts';
import { pausedUntil } from '../core/pause.ts';
import { deferCall } from '../core/queue.ts';
import { currentScenario, patchSession, readSession } from '../core/sessions.ts';
import { touchedPlaces } from './places.ts';
import { heldFreeTask, sessionTask } from './session.ts';
import { guardPattern } from '../contracts/manifest.ts';
import { roleOf } from './executors.ts';
import type { RowInput } from '../journal/writer.ts';
import { findRoot, loadConfig, shellAction, type GateConfig, isProdName } from '../gate/index.ts';
import { READ_WHEN_MAX, readWhenPattern, type ReadWhen, type ToolRule } from '../packs/packs.ts';

// `session`: the session of the client, when the client names it.
// `sub`: the role of the subordinate executor that makes the call. `headless`: the client runs
// without a window, so nobody can answer a question.
// `unshown`: the client shows no question to the human in its mode now: a question of the harness has no answer of a human.
// `subId`: the identifier of the subordinate executor that makes the call, when the client gives one (`sub` is its role).
// `callId`: the identifier that the client gives to one call of a tool, the same before and after it.
// `named`: the name of the tool for the journal, set by `beforeAction` for a tool that is not the client's own.
export type ToolCall = { cwd: string; tool: string; input: Record<string, unknown>; session?: string; sub?: string; subId?: string; callId?: string; headless?: boolean; unshown?: boolean; named?: string };

// What a question keeps while it waits: whose it is, and whether a human sees it.
const asker = (call: ToolCall): Record<string, unknown> => ({
  ...(call.session !== undefined ? { session: call.session } : {}), ...(call.subId !== undefined || call.sub !== undefined ? { sub: call.subId ?? call.sub } : {}), ...(call.unshown === true ? { shown: false } : {}),
});

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
  queued?: string; // the name of the deferred action in the queue of the human
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

// A tool that reads and writes: this call is a read when the field that the pack names is a text
// that matches the pattern of the pack as a whole. Anything else is the write that the pack names.
function readsNow(when: ReadWhen | undefined, input: Record<string, unknown>): boolean {
  if (when === undefined) return false;
  const value = Object.hasOwn(input, when.field) ? input[when.field] : undefined;
  if (typeof value !== 'string' || value.length > READ_WHEN_MAX) return false;
  try {
    return readWhenPattern(when.pattern).test(value);
  } catch {
    return false;
  }
}

// The target of a write with the fields of the tool input filled in; null when a field is not
// a plain value. Then nothing says what the write touches, and the action counts as unknown.
function fillTarget(template: string, input: Record<string, unknown>): string | null {
  let ok = true;
  const out = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
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
      // The native call gives the name as the disk has it: on a file system that ignores the case
      // of letters, `STATE` and `state` are one directory.
      return path.join(fs.realpathSync.native(head), ...tail);
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
  // The memory is written only through the harness: a direct write would skip the veto and the rules of the types.
  if (rt.memoryDir !== undefined && inside(target, real(rt.memoryDir))) return { outcome: 'deny', rule: 'protect.memory' };
  if (rt.configFile !== undefined && target === real(rt.configFile)) return { outcome: 'deny', rule: 'protect.config' };
  if (rt.merged.packs.some((p) => inside(target, real(p.dir)))) return { outcome: 'ask', rule: 'protect.packs' };
  if ((rt.clientPaths ?? []).some((source) => new RegExp(source).test(target))) return { outcome: 'ask', rule: 'protect.client' };
  // `.reins` of any repository is a pack directory, also before it exists and in another repository.
  if ((rt.projectPackDir !== undefined && inside(target, real(rt.projectPackDir))) || /(^|\/)\.reins(\/|$)/.test(target)) return { outcome: 'ask', rule: 'protect.packs' };
  if ((rt.harnessDirs ?? []).some((d) => inside(target, real(d)))) return { outcome: 'ask', rule: 'protect.harness' };
  return null;
}

type RedGuards = ReturnType<typeof redGuards>;
const CHECK_GUARD = { outcome: 'ask', rule: 'protect.check' } as const;
const GUARD_WALK = 5000;
// After a red answer of a check its tests and settings are not the work of the agent: a change of
// such a file asks the human. A directory is such a target too when the files lie under it: its
// removal removes the tests.
function checkGuard(guards: RedGuards, file: string): boolean {
  if (guards.length === 0) return false;
  const target = real(file);
  for (const guard of guards) {
    // A place above the work holds the whole work.
    if (inside(guard.root, target)) {
      if (target !== guard.root) return true;
    } else if (!inside(target, guard.root)) continue;
    const rel = path.relative(guard.root, target).split(path.sep).join('/');
    if (rel === '' || guard.patterns.some((p) => p.test(rel)) || guard.dirs.some((d) => d !== '' && (d === rel || d.startsWith(`${rel}/`)))) return true;
    // The files under a directory, by their names on the disk. A directory too large to read is a question.
    let left = GUARD_WALK;
    const holds = (dir: string, at: string): boolean => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of names) {
        if (entry.name === '.git') continue;
        left -= 1;
        if (left < 0) return true;
        const next = `${at}/${entry.name}`;
        if (guard.patterns.some((p) => p.test(next))) return true;
        if (entry.isDirectory() && holds(path.join(dir, entry.name), next)) return true;
      }
      return false;
    };
    if (holds(target, rel)) return true;
  }
  return false;
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
  if (rt.memoryDir !== undefined && names(rt.memoryDir)) return 'protect.memory';
  if (rt.configFile !== undefined && names(rt.configFile)) return 'protect.config';
  if (rt.merged.packs.some((p) => names(p.dir)) || (rt.projectPackDir !== undefined && names(rt.projectPackDir)) || /(^|[\s\/="'])\.reins(\/|[\s"']|$)/.test(command)) return 'protect.packs';
  if ((rt.harnessDirs ?? []).some(names)) return 'protect.harness';
  // Every word of the command is tested as a path: a relative path after a space or a redirect too.
  const words = command.replace(/['"\\]/g, '').split(/[\s;&|<>()=]+/);
  if ((rt.clientPaths ?? []).some((source) => words.some((w) => new RegExp(source).test(w)))) return 'protect.client';
  return null;
}

// What the places of a shell command touch of the harness. A place that the command can change
// gets the answer of a file change: a refusal for the state, the memory and the config. A place
// that the command only names gets a question when it lies in the state or in the memory.
function placesGuard(rt: Runtime, command: string, cwd: string): { outcome: 'deny' | 'ask'; rule: string } | null {
  let found: { outcome: 'deny' | 'ask'; rule: string } | null = null;
  let red: RedGuards | undefined;
  for (const place of touchedPlaces(command, cwd, os.homedir(), true)) {
    // A removal of a directory removes what lies under it: the state, the memory, the config, a pack.
    if (place.tree) {
      const target = real(place.path);
      const under = (p: string | undefined): boolean => p !== undefined && inside(real(p), target);
      if (under(rt.stateDir)) return { outcome: 'deny', rule: 'protect.state' };
      if (under(rt.memoryDir)) return { outcome: 'deny', rule: 'protect.memory' };
      if (under(rt.configFile)) return { outcome: 'deny', rule: 'protect.config' };
      if (rt.merged.packs.some((p) => under(p.dir))) found ??= { outcome: 'ask', rule: 'protect.packs' };
    }
    // A command that can write anywhere under a place: the human looks when the harness lies there.
    if (place.into) {
      const target = real(place.path);
      const under = (p: string | undefined): boolean => p !== undefined && inside(real(p), target);
      if (under(rt.stateDir)) found ??= { outcome: 'ask', rule: 'protect.state' };
      else if (under(rt.memoryDir)) found ??= { outcome: 'ask', rule: 'protect.memory' };
      else if (under(rt.configFile)) found ??= { outcome: 'ask', rule: 'protect.config' };
    }
    const guard = protectedBy(rt, place.path);
    if (guard === null) {
      if ((place.write || place.tree || place.into) && checkGuard((red ??= redGuards(rt)), place.path)) found ??= CHECK_GUARD;
      continue;
    }
    if (place.write && guard.outcome === 'deny') return guard;
    if (place.write || guard.rule === 'protect.state' || guard.rule === 'protect.memory') found ??= { outcome: 'ask', rule: guard.rule };
  }
  return found;
}

const isForm = (f: unknown): f is { decision?: unknown } => f !== null && typeof f === 'object';

// The rule data of the gate: its own layers, and the lists that the packs add.
function gateConfig(rt: Runtime, cwd: string): GateConfig {
  const cfg = rt.gateConfig ?? loadConfig(findRoot(cwd));
  const out: GateConfig = { ...cfg };
  for (const [key, list] of Object.entries(rt.merged.gate)) {
    const base = Array.isArray(cfg[key]) ? (cfg[key] as unknown[]) : [];
    out[key] = [...base, ...(list as unknown[]).filter((x) => !base.includes(x))];
  }
  // The gate takes the first form that matches. The forms that refuse stand first: a form of a
  // lower pack that refuses is not hidden by a form above it that only asks.
  if (Array.isArray(out.forms)) {
    const refuses = (f: unknown): boolean => isForm(f) && f.decision === 'deny';
    out.forms = [...out.forms.filter(refuses), ...out.forms.filter((f) => !refuses(f))];
  }
  return out;
}

// `connector`: the read connector that a read tool names in the table of the pack.
type Read = { action: Action; layers: LayerDecision[]; command?: string; connector?: string } | { guard: { outcome: 'deny' | 'ask'; rule: string } };

// A name in the input of a tool: a short value without a space. A sentence of the human is not a
// name, so a word in a text marks nothing. The look is bounded: the depth and the count of values;
// past the bound the call counts as a production one.
function namesProduction(input: unknown, markers: unknown): boolean {
  if (!Array.isArray(markers) || markers.length === 0) return false;
  let left = 200;
  const look = (value: unknown, depth: number): boolean => {
    // An input too large or too deep to read to its end is not known to name no production place.
    if (left <= 0 || depth > 4) return true;
    left -= 1;
    if (typeof value === 'string') {
      const name = value.trim();
      return !/\s/.test(name) && isProdName(name, markers);
    }
    if (Array.isArray(value)) return value.some((x) => look(x, depth + 1));
    if (value !== null && typeof value === 'object') return Object.values(value).some((x) => look(x, depth + 1));
    return false;
  };
  return look(input, 0);
}

// What the call is, in the words of the policy.
function readCall(rt: Runtime, call: ToolCall, clientTools: ClientTools): Read {
  const own = Object.hasOwn(clientTools, call.tool) ? clientTools[call.tool] : undefined;
  if (own !== undefined) {
    if (own.kind === 'read') return { action: { via: 'tool', kind: 'read', name: 'read', target: '', env: LOCAL_ENV }, layers: [] };
    if (own.kind === 'local') {
      const file = call.input[own.path];
      if (typeof file !== 'string' || file === '') return { action: UNKNOWN, layers: [] };
      const guard = protectedBy(rt, path.resolve(call.cwd, file)) ?? (checkGuard(redGuards(rt), path.resolve(call.cwd, file)) ? CHECK_GUARD : null);
      if (guard !== null) return { guard };
      return { action: { via: 'tool', kind: 'local', name: 'change', target: '', env: LOCAL_ENV }, layers: [] };
    }
    const command = call.input[own.command];
    if (typeof command !== 'string') return { action: UNKNOWN, layers: [] };
    const shell = shellAction(command, call.cwd, gateConfig(rt, call.cwd));
    // A refusal of the gate stays a refusal: the question about a path of the harness does not soften it.
    // `reins stop` is the word of the human. The agent can type the command, so the client asks.
    // Quotes and backslashes are dropped first: `reins 'stop'` runs the same command.
    const human = /(^|[\s;&|(/`])(reins|cli\.ts)\s+(stop|pause|enable|approve|memory\s+(veto|decide|restore|import|share|wrong|step|end)|craft\s+(accept|reject)|queue\s+(approve|reject)|retry|run|tick\s+run|fire\s+run)(\s|$|[`)])/.test(command.replace(/\$?['"\\]/g, '')) ? 'protect.human-command' : null;
    if (shell.result?.decision !== 'deny') {
      // The parse of the command says which places it changes: a change of the state, of the memory
      // or of the config is refused, as for a file tool. The match of the text is the second barrier.
      const places = placesGuard(rt, command, call.cwd);
      if (places?.outcome === 'deny') return { guard: places };
      const named = human ?? places?.rule ?? namedInCommand(rt, command);
      if (named !== null) return { guard: { outcome: 'ask', rule: named } };
    }
    return { action: shell.action, layers: shell.layers, command };
  }
  const rule = packRule(rt.merged.tools, call.tool);
  if (rule === undefined) return { action: UNKNOWN, layers: [] };
  if (rule.kind === 'read') return { action: { via: 'tool', kind: 'read', name: 'read', target: '', env: LOCAL_ENV, ...(rule.sensitive === true ? { sensitive: true } : {}) }, layers: [], ...(rule.connector !== undefined ? { connector: rule.connector } : {}) };
  const known = (rt.merged.context.envs ?? []).includes(rule.env);
  // The row of a tool names one environment. The call can name another: a name in its input that
  // holds a marker of the production environment (a cluster, a host, a project). Then the call
  // is a production one, whatever the row says: the markers of the gate hold for a tool as for a command.
  const production = !known || (rt.merged.context.productionEnvs ?? []).includes(rule.env) || namesProduction(call.input, gateConfig(rt, call.cwd).markers);
  // A read of a tool that also writes keeps the environment of the tool: a rule of a pack about
  // that environment still sees the call.
  if (readsNow(rule.read_when, call.input)) return { action: { via: 'tool', kind: 'read', name: 'read', target: '', env: { name: rule.env, known, production }, ...(rule.sensitive === true ? { sensitive: true } : {}) }, layers: [], ...(rule.connector !== undefined ? { connector: rule.connector } : {}) };
  const target = fillTarget(rule.target, call.input);
  if (target === null) return { action: UNKNOWN, layers: [] };
  const marks = { ...(rule.irreversible === true ? { irreversible: true } : {}), ...(rule.outward === true ? { outward: true } : {}), ...(rule.sensitive === true ? { sensitive: true } : {}) };
  return { action: { via: 'tool', kind: 'write', name: rule.action, target, env: { name: rule.env, known, production }, ...marks }, layers: [] };
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

// The task whose envelope names this write and that executes or publishes. A task that a
// session holds answers only that session; a task that no session holds answers any.
function taskFor(rt: Runtime, key: string, session: string | undefined): string | undefined {
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
    // A task that a session holds answers only that session, and only as its current task: a
    // suspended task and a task of another session do not open their envelope here.
    if (task.session !== undefined && (task.session !== session || currentScenario(rt, session) !== task.id)) continue;
    if (task.state === 'executing') return id;
    // A publication that nobody ended must not leave an approved write for ever: without a use
    // or another change of the task for this long, its envelope no longer answers.
    // An accepted result holds for the work that the check saw: after a change of the work the
    // publication ends, and its envelope does not answer.
    if (task.state === 'publishing' && Date.now() - fs.statSync(path.join(rt.stateDir, 'tasks', name)).mtimeMs <= (rt.publishIdleMs ?? PUBLISH_IDLE_MS) && verifyWork(rt, id)) return id;
  }
  return undefined;
}

// The subordinate executor that makes the call: its role, and the task that it started under.
// An executor keeps its parent when the free task of the session changes; one that the harness
// did not see start works under the task of the call.
function subOf(rt: Runtime, call: ToolCall, task: string): { role: string; parent: string } | undefined {
  if (call.sub === undefined) return undefined;
  const role = roleOf(call.sub);
  const started = (readSession(rt, call.session)?.executors ?? []).findLast((x) => x.role === role);
  return { role, parent: started?.task ?? task };
}

function record(rt: Runtime, call: ToolCall, rows: Pick<RowInput, 'kind' | 'data'>[]): void {
  const task = sessionTask(rt, call.session);
  const by = subOf(rt, call, task);
  const sub = by === undefined ? {} : { executor: 'sub' as const, ...by };
  // A question that no human saw says so: it is not counted among the questions to the human.
  const marked = call.unshown !== true ? rows : rows.map((row) => ((row.kind === 'policy.decision' || row.kind === 'policy.protected_attempt') && row.data?.outcome === 'ask' ? { ...row, data: { ...row.data, unshown: 1 } } : row));
  // The decision about a tool of a connector names the tool: the craft finds chains of tools that repeat.
  const tool = call.named;
  const named = tool === undefined ? marked : marked.map((row) => (row.kind === 'policy.decision' ? { ...row, data: { ...row.data, tool } } : row));
  for (const row of named) rt.journal.write({ ...row, ...sub, project: rt.project, task, ...(call.session !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(call.session) ? { session: call.session } : {}) });
}

// A question waits under the call that asked it. The identifier of the call, when the client gives
// one, names the call for sure: the input can change between the question and the run (another
// hook rewrites it), and two executors of one session can make the same call. Without an
// identifier the session, the tool and the input name the call.
const pendingFile = (rt: Runtime, call: ToolCall): string => {
  const name = call.callId !== undefined ? `id\n${call.session ?? ''}\n${call.callId}` : `${call.session ?? ''}\n${call.tool}\n${JSON.stringify(call.input)}`;
  return path.join(rt.stateDir, 'pending', `${crypto.createHash('sha256').update(name).digest('hex').slice(0, 32)}.json`);
};

function reply(d: Decision, more: { task?: string; grant?: string } = {}): Reply {
  const r: Reply = { outcome: d.outcome, rule: d.basis.rule, layer: d.basis.layer, envelope: d.envelope };
  if (d.scope !== undefined) r.scope = d.scope;
  if (more.task !== undefined) r.task = more.task;
  if (more.grant !== undefined) r.grant = more.grant;
  return r;
}

export function beforeAction(now: Runtime, call: ToolCall, clientTools: ClientTools): Reply {
  // The task of a scenario that the session holds decides with the packs that it started with.
  const rt = frozenRuntime(now, currentScenario(now, call.session));
  // The word before an action came: the first one of a session is noted, for the measure in `afterAction`.
  const seen = readSession(rt, call.session);
  if (seen !== null && seen !== undefined && seen.claims !== undefined && seen.before !== true) patchSession(rt, call.session, { before: true });
  // The name of a tool goes to the journal only for a tool of a work system: one that the pack
  // ties to a connector or to a write, or one that no pack describes yet (the human is asked about
  // it, and the name says about which). The tools of the client itself (read, edit, shell) and the
  // tools of its interface, which the pack describes as plain reads, are in every task and say
  // nothing about the work.
  // A session that works on a scenario repeats the tools of the scenario by design: no name there.
  const described = packRule(rt.merged.tools, call.tool);
  const ofWork = described === undefined || described.kind === 'write' || described.connector !== undefined;
  if (!Object.hasOwn(clientTools, call.tool) && ofWork && RULE_NAME.test(call.tool) && currentScenario(rt, call.session) === undefined) call = { ...call, named: call.tool };
  let r = decideBefore(rt, call, clientTools);
  // Without a window nobody answers a question: the action waits in the queue of the human.
  if (call.headless === true && r.outcome === 'ask') {
    // The human sees the command of a shell tool, and only the name of any other tool: the input
    // of a tool can hold the text of a file.
    const d = deferCall(rt, { ...call, input: keyInput(call, clientTools) }, { rule: r.rule, what: whatOf(call, clientTools), task: sessionTask(rt, call.session), anySession: true });
    if (d.pass) {
      // The approval of the human is a fact of the journal. It lets this one call pass; it does
      // not confirm a grant of a task envelope.
      record(rt, call, [{ kind: 'policy.decision', data: { outcome: 'allow', action_kind: 'unknown', env: 'unknown' } }, { kind: 'policy.basis', data: { layer: 'core', rule: 'queue.approved' } }]);
      r = { outcome: 'allow', rule: 'queue.approved', layer: 'core', envelope: 'none' };
    } else r = { ...r, outcome: 'defer', queued: d.id };
  }
  const file = pendingFile(rt, call);
  // A question waits for its answer: a run of the same call is the "yes" of the human. A question
  // for a whole task already wrote what it waits for. Any other outcome waits for nothing.
  if (r.outcome !== 'ask') fs.rmSync(file, { force: true });
  else if (!(r.scope === 'task' && fs.existsSync(file))) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The session is kept with the question: at the end of the turn a question without an answer is the "no" of the human.
    // The rule that asked is kept too: the answer of the human is an answer to this rule.
    fs.writeFileSync(file, JSON.stringify({ ask: true, rule: r.rule, ...asker(call) }));
  }
  return r;
}

// The role of a subordinate executor bounds what it does (harness-core, page 6). The manifest of
// its parent task names the rights of the role: `read` changes nothing; `write` with an area
// changes only the files of the area. A role without rights works in the envelope of its parent.
const GIT_CHANGE = /(^|[\s;&|(`])git\b[^;&|]*?\s(add|commit|stash|checkout|switch|restore|reset|merge|rebase|cherry-pick|revert|rm|mv|clean|apply|am|pull|push|tag|worktree)(\s|$)/;
function roleLimit(rt: Runtime, call: ToolCall, clientTools: ClientTools, read: Read): string | null {
  const by = subOf(rt, call, sessionTask(rt, call.session));
  if (by === undefined) return null;
  const place = loadTask(rt, by.parent)?.manifest?.model.executors?.find((x) => x.role === by.role);
  if (place?.rights === undefined) return null;
  const own = Object.hasOwn(clientTools, call.tool) ? clientTools[call.tool] : undefined;
  // The places that a shell command changes, as the parse of the command names them. A change that
  // the parse does not see (a script that writes) passes: the harness cannot look inside a program.
  const command = own?.kind === 'shell' ? call.input[own.command] : undefined;
  const changed = typeof command === 'string' ? touchedPlaces(command, call.cwd, os.homedir(), true).filter((p) => p.write || p.tree || p.into).map((p) => p.path) : [];
  // A command of git that changes the work tree, the index or the history names no path, and it
  // changes what all executors share: it is the work of the main executor.
  const shared = typeof command === 'string' && GIT_CHANGE.test(command);
  if (place.rights === 'read') {
    // A question about a protected place is a way to a change: a reader has none.
    if ('guard' in read) return read.guard.outcome === 'ask' ? 'executor.read-only' : null;
    if (read.action.via === 'shell') return read.action.kind === 'write' || shared || changed.length > 0 ? 'executor.read-only' : null;
    return read.action.kind === 'read' ? null : 'executor.read-only';
  }
  if (place.area === undefined || 'guard' in read) return null;
  // A command that the gate reads as a write names no path either: nothing says that it stays in the area.
  if (shared || (read.action.via === 'shell' && read.action.kind === 'write')) return 'executor.area';
  const files: string[] = [...changed];
  if (own?.kind === 'local') {
    const file = call.input[own.path];
    if (typeof file === 'string') files.push(path.resolve(call.cwd, file));
  }
  const root = real(rt.workDir ?? call.cwd);
  const patterns = place.area.map(guardPattern);
  const inArea = (file: string): boolean => {
    const target = real(file);
    return inside(target, root) && patterns.some((p) => p.test(path.relative(root, target).split(path.sep).join('/')));
  };
  return files.every(inArea) ? null : 'executor.area';
}

function decideBefore(rt: Runtime, call: ToolCall, clientTools: ClientTools): Reply {
  const read = readCall(rt, call, clientTools);
  const limit = call.sub === undefined ? null : roleLimit(rt, call, clientTools, read);
  if (limit !== null) {
    record(rt, call, [
      { kind: 'policy.decision', data: { outcome: 'deny', action_kind: 'guard' in read ? 'local' : read.action.kind, env: 'guard' in read ? LOCAL_ENV.name : read.action.env.name } },
      { kind: 'policy.basis', data: { layer: 'core', rule: limit } },
    ]);
    return { outcome: 'deny', rule: limit, layer: 'core', envelope: 'none' };
  }
  if ('guard' in read) {
    record(rt, call, [{ kind: 'policy.protected_attempt', data: { rule: read.guard.rule, outcome: read.guard.outcome } }]);
    return { outcome: read.guard.outcome, rule: read.guard.rule, layer: 'core', envelope: 'none' };
  }
  const { action } = read;
  const layers = [...read.layers, ...packLayers(rt, call, action, read.command)];
  // A pause of the human: a question passes without the question. A refusal holds.
  if (pausedUntil(rt) !== null && decide({ action, layers }).outcome === 'ask') {
    record(rt, call, [
      { kind: 'policy.decision', data: { outcome: 'allow', action_kind: action.kind, env: action.env.name } },
      { kind: 'policy.basis', data: { layer: 'core', rule: 'paused' } },
    ]);
    return { outcome: 'allow', rule: 'paused', layer: 'core', envelope: 'none' };
  }
  if (action.via === 'tool' && action.kind === 'write') {
    const key = grantKey(action.name, action.target, action.env.name);
    const id = taskFor(rt, key, call.session);
    const decision = id === undefined ? null : decideAction(rt, id, action, layers, subOf(rt, call, id), call.unshown === true);
    if (id !== undefined && decision !== null) {
      // The question for the whole task: the answer of the human comes back as "the tool ran".
      if (decision.outcome === 'ask' && decision.envelope === 'confirm') {
        const file = pendingFile(rt, call);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ task: id, key, ...asker(call) }));
      }
      return queued(rt, call, clientTools, action, read.command, reply(decision, { task: id, grant: key }));
    }
  }
  // A contract does not change after its approval. This holds for a write of a tool and for a
  // shell command that the gate reads as a write. A contract task that needs a write that the
  // contract does not name stops: the human gives a new contract, lets it go on, or ends it.
  const held = currentScenario(rt, call.session);
  const contract = held === undefined ? null : loadTask(rt, held);
  // The same holds for a read through a connector that the contract does not name: the human
  // approved the reads of the contract, not of every system.
  const outside = action.kind === 'write' || (read.connector !== undefined && !(contract?.manifest?.permissions.read ?? []).includes(read.connector));
  if (outside && contract !== null && contract.kind === 'contract' && contract.session === call.session && contract.state === 'executing' && contract.widened !== true) {
    applyEvent(rt, contract.id, { type: 'scope' }, 'harness');
    record(rt, call, [
      { kind: 'policy.decision', data: { outcome: 'deny', action_kind: action.kind, env: action.env.name } },
      { kind: 'policy.basis', data: { layer: 'core', rule: 'contract.scope' } },
    ]);
    // No envelope names this write: the reply names no task.
    return { outcome: 'deny', rule: 'contract.scope', layer: 'core', envelope: 'none' };
  }
  let decision = decide({ action, layers });
  // A read through a connector costs the system that answers it (harness-connector, page 4): the
  // packs bound the reads of one task. Past the limit the human decides each read.
  // The reads of a scenario are the reads that its manifest names (`permissions.read`). A read of
  // its task through another connector is outside what the pack described: the human decides,
  // once for the task and the connector (the answer is kept in `afterAction`).
  // The task goes on: a manifest of a pack is not a contract that one human approved for one task.
  if (read.connector !== undefined && action.kind === 'read' && decision.outcome === 'allow' && contract !== null && contract.kind === 'scenario' && contract.session === call.session
    && (contract.state === 'executing' || contract.state === 'publishing') && !(contract.manifest?.permissions.read ?? []).includes(read.connector) && !(contract.extraReads ?? []).includes(read.connector) && pausedUntil(rt) === null) {
    decision = { ...decision, outcome: 'ask', basis: { layer: 'core', rule: 'scenario.read-scope' } };
  }
  const maxReads = rt.merged.context.maxReads;
  if (maxReads !== undefined && read.connector !== undefined && action.kind === 'read' && decision.outcome === 'allow') {
    // The task of the scenario that the session holds, else the free task of the session.
    const id = contract !== null && contract.state !== 'closed' && contract.state !== 'skipped' ? contract.id : sessionTask(rt, call.session);
    // The look and the count are one step under the lock of the task: hooks of parallel calls are
    // separate processes. A read that could not be counted (a busy lock) is not known to be inside the limit.
    const counted = mutateTask(rt, id, (task) => ((task.reads ?? 0) >= maxReads ? null : { ...task, reads: (task.reads ?? 0) + 1 }));
    // A pause of the human removes this question as every other one.
    if (counted === null && pausedUntil(rt) === null) decision = { ...decision, outcome: 'ask', basis: { layer: 'core', rule: 'default.read-limit' } };
  }
  // A write that another human sees, outside the envelope of a task: no check of the harness saw
  // its text. The question has its own rule, so the client can say this to the human.
  if (decision.basis.rule === 'default.write' && action.outward === true) decision = { ...decision, basis: { ...decision.basis, rule: 'default.outward-write' } };
  record(rt, call, [
    { kind: 'policy.decision', data: { outcome: decision.outcome, action_kind: action.kind, env: action.env.name } },
    { kind: 'policy.basis', data: { layer: decision.basis.layer, rule: decision.basis.rule } },
  ]);
  return queued(rt, call, clientTools, action, read.command, reply(decision));
}

// What of the input of a call names the action. For a shell tool the words that the agent puts
// beside the command (a description, a time limit) do not make it another action. Every other
// field stays: it can change what the call does. For any other tool the whole input is the action:
// the content of a file is the change itself.
const BESIDE: readonly string[] = ['description', 'timeout', 'timeout_ms'];
function keyInput(call: ToolCall, clientTools: ClientTools): unknown {
  const own = Object.hasOwn(clientTools, call.tool) ? clientTools[call.tool] : undefined;
  if (own?.kind !== 'shell') return call.input;
  return Object.fromEntries(Object.entries(call.input).filter(([key]) => !BESIDE.includes(key)));
}

// The action of a call in words for the human: the command of a shell tool, the file of a file
// tool, else the name of the tool.
function whatOf(call: ToolCall, clientTools: ClientTools): string {
  const own = Object.hasOwn(clientTools, call.tool) ? clientTools[call.tool] : undefined;
  const text = own?.kind === 'shell' ? call.input[own.command] : own?.kind === 'local' ? call.input[own.path] : undefined;
  return typeof text === 'string' ? (own?.kind === 'local' ? `${call.tool} ${text}` : text) : call.tool;
}

// An action that the policy defers waits in the queue of the human. An approval of the human for
// this call lets it pass once.
function queued(rt: Runtime, call: ToolCall, clientTools: ClientTools, action: Action, command: string | undefined, r: Reply): Reply {
  if (r.outcome !== 'defer') return r;
  const what = command ?? `${action.name} ${action.target} @${action.env.name}`;
  const d = deferCall(rt, { ...call, input: keyInput(call, clientTools) }, { rule: r.rule, what, task: sessionTask(rt, call.session) });
  if (!d.pass) return { ...r, queued: d.id };
  record(rt, call, [
    { kind: 'policy.decision', data: { outcome: 'allow', action_kind: action.kind, env: action.env.name } },
    { kind: 'policy.basis', data: { layer: 'core', rule: 'queue.approved' } },
  ]);
  return { outcome: 'allow', rule: 'queue.approved', layer: 'core', envelope: 'none' };
}

// The tool ran. When the core asked the one question of a task about this call, the run means
// that the human approved: the grant is confirmed and this first use is counted.
// `asked`: false when the client did not show the question to the human (a mode of the client
// that skips permission questions). Then the run of the tool is no approval.
// `failed`: the tool started and ended with an error (not broken off by the human).
// `source`: the connector that the output of the call came from. What a connector returns is data
// of an outer source, never instructions: the client says so to the agent (harness-connector, pages 4 and 6).
// `offer`: a free task grew by facts (harness-core, page 8): it made the number of changes that
// the packs name. The client offers the human a contract, once for a task; the work goes on.
export function afterAction(rt: Runtime, call: ToolCall, clientTools: ClientTools, asked = true, failed = false): { confirmed: boolean; source?: string; offer?: 'contract' } {
  const base = settle(rt, call, clientTools, asked, failed);
  const settled: { confirmed: boolean; offer?: 'contract' } = !failed && grew(rt, call, clientTools) ? { ...base, offer: 'contract' } : base;
  if (failed || Object.hasOwn(clientTools, call.tool)) return settled;
  // The table of the tools that decided the call: the one of the task that the session holds.
  const rule = packRule(frozenRuntime(rt, currentScenario(rt, call.session)).merged.tools, call.tool);
  const reads = rule !== undefined && rule.connector !== undefined && (rule.kind === 'read' || readsNow(rule.read_when, call.input));
  return reads && rule.connector !== undefined ? { ...settled, source: rule.connector } : settled;
}

// Counts a change of the free task of the session. True once: when the count reaches the number of the packs.
function grew(rt: Runtime, call: ToolCall, clientTools: ClientTools): boolean {
  const max = rt.merged.context.maxFreeChanges;
  if (max === undefined) return false;
  // A session that holds a task of a scenario works under its manifest.
  const held = currentScenario(rt, call.session);
  const scenario = held === undefined ? null : loadTask(rt, held);
  if (scenario !== null && scenario.state !== 'closed' && scenario.state !== 'skipped') return false;
  const id = heldFreeTask(rt, call.session);
  if (id === undefined) return false;
  // A change: a file tool, a write of a connector, a tool without a description, a shell command whose parse names a place that it changes.
  const own = Object.hasOwn(clientTools, call.tool) ? clientTools[call.tool] : undefined;
  let change: boolean;
  if (own === undefined) {
    const rule = packRule(rt.merged.tools, call.tool);
    change = rule === undefined || (rule.kind === 'write' && !readsNow(rule.read_when, call.input));
  } else if (own.kind === 'local') change = true;
  else if (own.kind === 'shell') {
    const command = call.input[own.command];
    // Also a command that the gate reads as a write (a push, a deploy, a statement on a database)
    // and a command of git that changes the tree or the history: they name no file.
    change = typeof command === 'string' && (touchedPlaces(command, call.cwd, os.homedir(), true).some((p) => p.write || p.tree || p.into) || GIT_CHANGE.test(command) || shellAction(command, call.cwd, gateConfig(rt, call.cwd)).action.kind === 'write');
  } else change = false;
  if (!change) return false;
  let offer = false;
  mutateTask(rt, id, (task) => {
    if (task.kind !== 'free') return null;
    const changes = (task.changes ?? 0) + 1;
    offer = changes >= max && task.offered !== true;
    return { ...task, changes, ...(offer ? { offered: true } : {}) };
  });
  // The kind of the task stays "free", and the facts brought the offer: a fact of the journal (page 8, rule 5).
  if (offer) record(rt, call, [{ kind: 'task.kind_decided', data: { kind: 'free', reason: 'facts', offer: 'contract', changes: max } }]);
  return offer;
}

function settle(rt: Runtime, call: ToolCall, clientTools: ClientTools, asked: boolean, failed: boolean): { confirmed: boolean } {
  // A tool that failed is a fact for the craft: the name of the tool, never the text of the error.
  // The tools of the client itself fail all the time (a command with an exit code, a file that is
  // not there): that is the work, not a fault of a tool.
  if (failed && !Object.hasOwn(clientTools, call.tool) && RULE_NAME.test(call.tool)) record(rt, call, [{ kind: 'executor.tool_failed', data: { tool: call.tool } }]);
  // The measure of the level of the client. The adapter said that the client tells the harness
  // before an action; an action ended, and no such word came in this session. The barriers did
  // not act: that is a fact for the journal and for the human, written once for a session.
  const seen = readSession(rt, call.session);
  // A call that failed may never have started (a bad input, a tool that is not there): the client
  // had nothing to tell before it, so it is no proof.
  if (!failed && seen !== null && seen !== undefined && seen.claims !== undefined && seen.before !== true && seen.unguarded !== true) {
    patchSession(rt, call.session, { unguarded: true });
    rt.journal.write({ kind: 'harness.client_level_detected', project: rt.project, data: { client: seen.claims, level: 'no_before', measured: 1 } });
  }
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
  if (typeof task !== 'string' || typeof key !== 'string') {
    // A question about this one action: the human said "yes". The fact goes to the journal, with the rule that asked.
    const rule = (pending as { rule?: unknown }).rule;
    // The human let the task of a scenario read through a connector outside its manifest: the
    // answer holds for this task and this connector, so the next read of the same kind does not ask.
    if (rule === 'scenario.read-scope') {
      const held = currentScenario(rt, call.session);
      const connector = packRule(frozenRuntime(rt, held).merged.tools, call.tool)?.connector;
      if (held !== undefined && connector !== undefined) mutateTask(rt, held, (task) => ((task.extraReads ?? []).includes(connector) ? null : { ...task, extraReads: [...(task.extraReads ?? []), connector] }));
    }
    record(rt, call, [{ kind: 'task.human_decision', data: { decision: 'answered', ...(typeof rule === 'string' && RULE_NAME.test(rule) ? { rule } : {}) } }]);
    return { confirmed: false };
  }
  if (Object.hasOwn(clientTools, call.tool)) return { confirmed: false };
  const read = readCall(rt, call, clientTools);
  if ('guard' in read || read.action.kind !== 'write' || grantKey(read.action.name, read.action.target, read.action.env.name) !== key) return { confirmed: false };
  if (!confirm(rt, task, key, read.action.outward === true)) return { confirmed: false };
  decideAction(rt, task, read.action, [...read.layers, ...packLayers(rt, call, read.action, read.command)]);
  return { confirmed: true };
}
