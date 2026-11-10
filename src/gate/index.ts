// Typed entry to the shell gate. The gate itself is the code of agentic v0.5.8, ported as CommonJS
// without a change of logic (src/gate/*.cjs); its decisions are held by the corpus in
// test/data/gate-decisions.json. This file turns a gate result into the input of the policy.

import { createRequire } from 'node:module';
import type { Action, LayerDecision } from '../contracts/policy.ts';

const require = createRequire(import.meta.url);

export type RepoInfo = { root: string; gitDir: string | null; commonDir: string | null; isRepo: boolean; key: string; wkey: string };

// The rule data after the layers are merged. The gate reads it; this code does not look inside.
export type GateConfig = Record<string, unknown>;

export type GateResult = {
  decision: 'ask' | 'deny';
  id: string; // the rule, for example git.push-protected
  cls: string; // the class of the rule, for example prod-env, git-discard
  why: string;
  command: string;
  part?: string;
  slow?: boolean;
};

type GateModule = {
  decideCommand(command: string, cfg: GateConfig, info: RepoInfo | null, cwd: string): GateResult | null;
  PRODUCTION: Set<string>;
};

const gate = require('./gate.cjs') as GateModule;
const config = require('./config.cjs') as { load(info: RepoInfo | null): GateConfig };
const root = require('./root.cjs') as { findRoot(cwd: string): RepoInfo };
const gitGate = require('./gate-git.cjs') as { setGitBudget(b: { perCall: number; total: number }): { perCall: number; total: number } };

export const findRoot = root.findRoot;
export const loadConfig = config.load;
export const setGitBudget = gitGate.setGitBudget;

// The decision of the gate for one shell command: null when no rule of a dangerous class matches.
export function decideCommand(command: string, cwd: string, cfg?: GateConfig, info?: RepoInfo): GateResult | null {
  const where = info ?? root.findRoot(cwd);
  return gate.decideCommand(command, cfg ?? config.load(where), where, cwd);
}

export function isProductionClass(cls: string): boolean {
  return gate.PRODUCTION.has(cls);
}

// Classes that the gate approves one action at a time (ONE_BY_ONE in gate.cjs): the action is
// irreversible, or it lands work on a protected branch, or it is a statement on a production database.
// A rule id alone does not name the target, so a task envelope must not cover these classes.
const ONE_BY_ONE: readonly string[] = ['data', 'publish', 'git-discard', 'blast-radius', 'protected'];

export function isOneByOneClass(cls: string): boolean {
  return ONE_BY_ONE.includes(cls);
}

// A shell command as the policy sees it. The rules of the dangerous classes are rules of the core layer.
// A command that no rule matches has no description: the policy lets it pass by default.
// The action name is the rule id for now: a connector description will replace it.
export function shellAction(command: string, cwd: string, cfg?: GateConfig, info?: RepoInfo): { action: Action; layers: LayerDecision[]; result: GateResult | null } {
  const result = decideCommand(command, cwd, cfg, info);
  if (result === null) {
    return {
      action: { via: 'shell', kind: 'unknown', name: 'shell', target: '', env: { name: 'local', known: true, production: false } },
      layers: [],
      result,
    };
  }
  // The policy does not apply an envelope to a production write, and an unknown environment
  // counts as production. A one-by-one class is marked unknown: the human approves each action.
  const production = isProductionClass(result.cls);
  const known = !isOneByOneClass(result.cls);
  return {
    action: { via: 'shell', kind: 'write', name: result.id, target: '', env: { name: production ? 'production' : known ? 'local' : 'unknown', known, production } },
    layers: [{ layer: 'core', outcome: result.decision, rule: result.id }],
    result,
  };
}
