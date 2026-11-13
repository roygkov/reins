// The measure of the barrier: commands with a known answer. A pack can hold a file
// `gate-probes.json`, a list of `{ "command": ..., "expect": "pass" | "ask" | "deny", "note": ... }`.
// The harness asks its barrier about each command, with no task and no journal, and names the
// commands whose answer is not the expected one:
//   a miss: the barrier is softer than expected (it lets pass where it must ask or refuse);
//   a noise: the barrier is stricter than expected (it asks where nothing is due).
// The human adds a command when the barrier was wrong about it: the set grows from real cases.
// In a command `{harness}` is the directory of the code of the harness, `{packs}` the directory
// of the pack of the file, `{state}` the state directory, `{home}` the home directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from '../core/runtime.ts';
import { probeCommand } from './before.ts';

export const PROBES_FILE = 'gate-probes.json';
const MAX_PROBES = 500;
const MAX_COMMAND = 2000;
const RANK = { pass: 0, allow: 0, ask: 1, deny: 2 } as const;

export type ProbeFault = { pack: string; n: number; expect: 'pass' | 'ask' | 'deny'; got: 'allow' | 'ask' | 'deny'; rule?: string; note?: string };
// `n`: the commands that were asked. `bad`: the files and the items that cannot be read as a probe.
export type ProbeResult = { n: number; bad: number; misses: ProbeFault[]; noise: ProbeFault[] };

export function runProbes(rt: Runtime, cwd: string): ProbeResult {
  const out: ProbeResult = { n: 0, bad: 0, misses: [], noise: [] };
  const harness = rt.harnessDirs?.[0] ?? '';
  for (const pack of rt.merged.packs) {
    const file = path.join(pack.dir, PROBES_FILE);
    if (!fs.existsSync(file)) continue;
    let items: unknown;
    try {
      items = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      items = null;
    }
    if (!Array.isArray(items) || items.length > MAX_PROBES) {
      out.bad += 1;
      continue;
    }
    items.forEach((item: unknown, i) => {
      const probe = item !== null && typeof item === 'object' ? (item as { command?: unknown; expect?: unknown; note?: unknown }) : {};
      const expect = probe.expect;
      if (typeof probe.command !== 'string' || probe.command === '' || probe.command.length > MAX_COMMAND || (expect !== 'pass' && expect !== 'ask' && expect !== 'deny')) {
        out.bad += 1;
        return;
      }
      const command = probe.command.replaceAll('{harness}', harness).replaceAll('{packs}', pack.dir).replaceAll('{state}', rt.stateDir).replaceAll('{home}', os.homedir());
      const got = probeCommand(rt, command, cwd);
      out.n += 1;
      if (RANK[got.outcome] === RANK[expect]) return;
      const fault: ProbeFault = { pack: pack.level, n: i + 1, expect, got: got.outcome, ...(got.rule !== undefined ? { rule: got.rule } : {}), ...(typeof probe.note === 'string' && probe.note.length <= 200 ? { note: probe.note } : {}) };
      (RANK[got.outcome] < RANK[expect] ? out.misses : out.noise).push(fault);
    });
  }
  return out;
}
