// The merge of the packs as a fact: what the journal keeps of it, and what the human reads of it.
// Specification: docs/spec/harness-spec.md, section 19: the result of the merge is written to the
// journal, and the human can see which level gave each value.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from './runtime.ts';

const token = (text: string): string => text.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'x';

// What of the merge decides: a change of any of these is a new merge.
function fingerprint(rt: Runtime): string {
  const m = rt.merged;
  const view = {
    packs: m.packs.map((p) => [p.level, p.name, p.connected, p.errors]),
    scenarios: m.scenarios.map((s) => [s.name, s.level, s.manifest]),
    rejected: m.rejected, context: m.context, tools: m.tools, rules: m.rules, gate: m.gate, models: m.models,
    // What a pack says about its connectors and its scripts: the names, never a value of a variable.
    network: m.connectorNetwork, files: m.connectorFiles, env: m.connectorEnv, scripts: Object.keys(m.scriptFiles).sort(), notes: m.notes, origin: m.origin,
  };
  return crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 12);
}

// Writes the merge to the journal when it is not the merge that the journal has for this project:
// the first start, and every change of a pack. A manifest that the packs refused and a pack that
// did not connect are facts of their own: nothing else tells the human that a scenario is gone.
// Two sessions that start at the same moment can both write the row: a second row of the same
// merge is a repeat, not a wrong fact.
export function noteMerge(rt: Runtime): boolean {
  const file = path.join(rt.stateDir, 'merged.json');
  let seen: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) seen = value as Record<string, unknown>;
  } catch {
    // no merge was written yet
  }
  const merge = fingerprint(rt);
  if (seen[rt.project] === merge) return false;
  const m = rt.merged;
  rt.journal.write({ kind: 'harness.packs_merged', project: rt.project, data: { levels: m.packs.filter((p) => p.connected).length, scenarios: m.scenarios.length, rejected: m.rejected.length, merge } });
  for (const r of m.rejected) rt.journal.write({ kind: 'harness.manifest_rejected', project: rt.project, data: { level: r.level, manifest: token(path.basename(r.file).replace(/\.json$/, '')), code: r.errors[0]?.code ?? 'unknown' } });
  for (const p of m.packs) if (!p.connected) rt.journal.write({ kind: 'harness.failure', project: rt.project, data: { where: 'pack', level: p.level, code: p.errors[0]?.code ?? 'unknown' } });
  try {
    fs.mkdirSync(rt.stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...seen, [rt.project]: merge }));
    fs.renameSync(tmp, file);
  } catch {
    // the merge is written again at the next start
  }
  return true;
}

export type MergeView = {
  packs: { level: string; name: string | null; dir: string; connected: boolean; errors: string[] }[];
  rejected: { level: string; file: string; errors: string[] }[];
  values: Record<string, { value: unknown; level?: string }>; // a value of the merge and the level that gave it
};

// The merge for the human: the packs, the manifests that were refused, and each value with its level.
export function mergeView(rt: Runtime): MergeView {
  const m = rt.merged;
  const origin = m.origin as Record<string, string | undefined>;
  const values: MergeView['values'] = {};
  for (const [key, value] of Object.entries(m.context)) {
    if (value === undefined) continue;
    values[key] = { value, ...(origin[key] !== undefined ? { level: origin[key] } : {}) };
  }
  const faults = (errors: { code: string; path: string }[]): string[] => errors.map((e) => `${e.code} ${e.path}`);
  return {
    packs: m.packs.map((p) => ({ level: p.level, name: p.name, dir: p.dir, connected: p.connected, errors: faults(p.errors) })),
    rejected: m.rejected.map((r) => ({ level: r.level, file: r.file, errors: faults(r.errors) })),
    values,
  };
}
