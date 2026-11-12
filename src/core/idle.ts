// A scenario that nobody called for a long time is switched off by the harness itself. The term
// comes from the packs; without a term nothing is switched off. The fact lives in the state, not
// in the pack: the harness does not write packs. One command of the human brings the scenario back.
// Specification: docs/spec/harness-contracts, the page of the manifest.

import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from './runtime.ts';
import { locked } from './lock.ts';

const DAY = 24 * 60 * 60 * 1000;
// seen: the first look of the harness at the scenario. used: the last time it was opened.
type Entry = { seen: string; used?: string; off?: string };
type Scenario = Runtime['merged']['scenarios'][number];

const file = (rt: Runtime): string => path.join(rt.stateDir, 'scenarios.json');
// A scenario of a project pack is the scenario of that project: the same name in another project is another scenario.
const key = (rt: Runtime, s: Scenario): string => (s.level === 'project' ? `${rt.project}/${s.name}` : s.name);

function read(rt: Runtime): Record<string, Entry> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file(rt), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, Entry> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (entry !== null && typeof entry === 'object' && typeof (entry as Entry).seen === 'string') out[name] = entry as Entry;
    }
    return out;
  } catch {
    return {};
  }
}

// One read, change and write under the lock. false: the lock did not come, nothing was written.
function change(rt: Runtime, work: (all: Record<string, Entry>) => boolean): boolean {
  let done = false;
  try {
    fs.mkdirSync(rt.stateDir, { recursive: true });
    done = locked(`${file(rt)}.lock`, () => {
      const all = read(rt);
      if (!work(all)) return;
      const tmp = `${file(rt)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, file(rt));
    });
  } catch {
    return false;
  }
  return done;
}

// Only a scenario that a command starts can be idle: a schedule or an event starts the others,
// and a long period between two runs of them is no want of use. A scenario that its manifest
// disabled is out of the count too.
const counted = (rt: Runtime, s: Scenario): boolean => rt.merged.scenarioIdleDays !== undefined && s.manifest.trigger.kind === 'command' && s.manifest.state !== 'disabled';

// Is the scenario switched off for want of use? Without a term of the packs nothing is.
export function scenarioOff(rt: Runtime, name: string): boolean {
  const s = rt.merged.scenarios.find((x) => x.name === name);
  return s !== undefined && counted(rt, s) && read(rt)[key(rt, s)]?.off !== undefined;
}

// The scenario was opened: its term starts again.
export function noteUse(rt: Runtime, name: string, now: number = Date.now()): void {
  const s = rt.merged.scenarios.find((x) => x.name === name);
  if (s === undefined || !counted(rt, s)) return;
  change(rt, (all) => {
    const at = new Date(now).toISOString();
    const entry = all[key(rt, s)];
    if (entry?.off !== undefined) return false;
    all[key(rt, s)] = { seen: entry?.seen ?? at, used: at };
    return true;
  });
}

// The look of the sweep. A scenario that the harness sees for the first time gets its time: the
// term does not start before the scenario is connected. A scenario past the term is switched off.
// A scenario that is out of the count (no term in the packs, a manifest that disabled it) loses
// its entry: when it comes back into the count, its term starts from that look.
export function switchOffIdle(rt: Runtime, now: number = Date.now()): string[] {
  const off: string[] = [];
  const term = rt.merged.scenarioIdleDays;
  if (term === undefined && !fs.existsSync(file(rt))) return off;
  change(rt, (all) => {
    let changed = false;
    const at = new Date(now).toISOString();
    for (const s of rt.merged.scenarios) {
      const entry = all[key(rt, s)];
      if (term === undefined || !counted(rt, s)) {
        if (entry !== undefined) {
          delete all[key(rt, s)];
          changed = true;
        }
        continue;
      }
      if (entry === undefined) {
        all[key(rt, s)] = { seen: at };
        changed = true;
        continue;
      }
      if (entry.off !== undefined) continue;
      const last = Date.parse(entry.used ?? entry.seen);
      if (!Number.isFinite(last) || now - last <= term * DAY) continue;
      entry.off = at;
      off.push(s.name);
      changed = true;
    }
    return changed;
  });
  // The list of the kinds of the journal is closed: a scenario that acts no more is a change of what the packs give.
  for (const name of off) rt.journal.write({ kind: 'harness.pack_changed', project: rt.project, data: { scenario: name, state: 'off', reason: 'idle' } });
  return off;
}

// The word of the human: the scenario acts again, and its term starts again.
// not_off: the scenario was not switched off. busy: the file of the state did not come, nothing changed.
export function enableScenario(rt: Runtime, name: string, now: number = Date.now()): 'on' | 'not_off' | 'busy' {
  const s = rt.merged.scenarios.find((x) => x.name === name);
  if (s === undefined || !scenarioOff(rt, name)) return 'not_off';
  let was = false;
  const done = change(rt, (all) => {
    const entry = all[key(rt, s)];
    if (entry?.off === undefined) return false;
    was = true;
    all[key(rt, s)] = { seen: entry.seen, used: new Date(now).toISOString() };
    return true;
  });
  if (!done) return 'busy';
  if (!was) return 'not_off';
  rt.journal.write({ kind: 'harness.pack_changed', project: rt.project, data: { scenario: name, state: 'on' } });
  return 'on';
}
