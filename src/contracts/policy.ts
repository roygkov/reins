// Policy: layers of rules, the strictest decision wins, four outcomes.
// A lower layer can only make a decision stricter. The envelope of a task turns "ask" into
// "allow" for the actions that the manifest names, and for nothing else.
// Specification: docs/spec/harness-core page 3, harness-manifest page 3, harness-connector page 2.

export const OUTCOMES = ['allow', 'ask', 'defer', 'deny'] as const; // strictness grows left to right
export type Outcome = (typeof OUTCOMES)[number];

export const LAYERS = ['core', 'organization', 'project', 'person'] as const; // upper to lower
export type Layer = (typeof LAYERS)[number];

// read: no change. local: a change inside the work tree, covered by the fingerprint.
// write: a change outside the work tree. unknown: the action has no description.
export const ACTION_KINDS = ['read', 'local', 'write', 'unknown'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type Action = {
  via: 'tool' | 'shell';
  kind: ActionKind;
  name: string;
  target: string;
  env: { name: string; known: boolean; production: boolean };
};

export type LayerDecision = { layer: Layer; outcome: Outcome; rule: string };

// A write that the manifest names, with the target already filled in from the task inputs.
export type Grant = { action: string; target: string; env: string; limit: number; confirm: 'none' | 'once' };

export type TaskUse = { confirmed: string[]; used: Record<string, number> };

export type DecideInput = { action: Action; layers: LayerDecision[]; envelope?: Grant[]; task?: TaskUse };

export type EnvelopeEffect = 'none' | 'not_needed' | 'not_applicable' | 'production' | 'not_named' | 'limit' | 'confirm' | 'applied';

export type Decision = {
  outcome: Outcome;
  scope?: 'action' | 'task'; // for "ask": one question for this action, or one for the whole task
  basis: { layer: Layer; rule: string };
  envelope: EnvelopeEffect;
};

const rank = (o: Outcome): number => OUTCOMES.indexOf(o);

export function strictest(a: Outcome, b: Outcome): Outcome {
  return rank(a) >= rank(b) ? a : b;
}

export function grantKey(action: string, target: string, env: string): string {
  return `${action} ${target} ${env}`;
}

// The decision of the core when no rule names the action.
// An unknown tool call counts as a write. A shell command outside the dangerous classes
// passes: the dangerous classes are rules of the core layer.
function byDefault(action: Action): LayerDecision {
  switch (action.kind) {
    case 'read':
      return { layer: 'core', outcome: 'allow', rule: 'default.read' };
    case 'local':
      return { layer: 'core', outcome: 'allow', rule: 'default.local' };
    case 'write':
      return { layer: 'core', outcome: 'ask', rule: 'default.write' };
    case 'unknown':
      return action.via === 'tool'
        ? { layer: 'core', outcome: 'ask', rule: 'default.unknown-tool' }
        : { layer: 'core', outcome: 'allow', rule: 'default.shell' };
  }
}

// For the envelope, every action that is not a known read or a local change is a write.
// That includes an unclassified shell command that a rule of a layer asks about.
function isWrite(action: Action): boolean {
  return action.kind === 'write' || action.kind === 'unknown';
}

// Layer decisions come from pack data. An outcome outside the list counts as deny.
function outcomeOf(l: LayerDecision): Outcome {
  return OUTCOMES.includes(l.outcome) ? l.outcome : 'deny';
}

// An environment that is not known counts as production.
function isProduction(action: Action): boolean {
  return action.env.production || !action.env.known;
}

export function decide(input: DecideInput): Decision {
  const { action, layers, envelope, task } = input;
  const fallback = byDefault(action);

  // The strictest decision wins. Among equal decisions the basis is the uppermost layer,
  // and a named rule comes before the default.
  let outcome = fallback.outcome;
  for (const l of layers) outcome = strictest(outcome, outcomeOf(l));
  const named = layers
    .filter((l) => outcomeOf(l) === outcome)
    .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer))[0];
  const basis = named === undefined ? { layer: fallback.layer, rule: fallback.rule } : { layer: named.layer, rule: named.rule };

  if (outcome !== 'ask') {
    const effect: EnvelopeEffect = envelope === undefined ? 'none' : outcome === 'allow' ? 'not_needed' : 'not_applicable';
    return { outcome, basis, envelope: effect };
  }
  const ask = (effect: EnvelopeEffect): Decision => ({ outcome: 'ask', scope: 'action', basis, envelope: effect });
  if (envelope === undefined) return ask('none');
  // A production write is approved by the human for each action. The envelope does not act on it.
  if (isWrite(action) && isProduction(action)) return ask('production');

  const grant = envelope.find((g) => g.action === action.name && g.target === action.target && g.env === action.env.name);
  if (grant === undefined) return ask('not_named');
  const key = grantKey(grant.action, grant.target, grant.env);
  if ((task?.used[key] ?? 0) >= grant.limit) return ask('limit');
  if (grant.confirm === 'once' && !(task?.confirmed ?? []).includes(key)) {
    return { outcome: 'ask', scope: 'task', basis, envelope: 'confirm' };
  }
  return { outcome: 'allow', basis, envelope: 'applied' };
}
