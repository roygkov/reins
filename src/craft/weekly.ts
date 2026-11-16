// The summary of the week: the one thing of the craft that the human reads. It is a file. The
// harness writes it at the start of a session, once in `craft.summary_days` days of the pack
// (seven when no pack gives it); `reins week` writes it at once.
// The parts are those that the code has: the numbers of the week, the proposals that need a
// decision, the memory records in their veto window, the accepted proposals and their effect.
// Specification: docs/spec/harness-craft, page 7.

import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from '../core/runtime.ts';
import { EIGHT, costByScenario, eight, overTargets, series } from '../journal/metrics.ts';
import { readJournalSince } from '../journal/writer.ts';
import { listRecords } from '../memory/store.ts';
import { listProposals, proposalLine } from './craft.ts';
import { listQueue } from '../core/queue.ts';

const DAY = 24 * 60 * 60 * 1000;
const NAME = /^week-(\d{4}-\d{2}-\d{2})\.md$/;
const dirOf = (rt: Runtime): string => path.join(rt.stateDir, 'summaries');
const one = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const cell = (x: number | null): string => (x === null ? '-' : String(x));

// The text of the summary for the seven days that end at `now`.
export function weekText(rt: Runtime, now: number = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const journal = readJournalSince(rt.stateDir, now - 14 * DAY);
  const numbers = eight(journal, now);
  const lines = [`# reins: the week to ${day}`, '', '## Numbers of the week', '', '| number | this week | the week before | rows |', '|---|---|---|---|'];
  for (const name of EIGHT) lines.push(`| ${name} | ${cell(numbers[name].value)} | ${cell(numbers[name].prev)} | ${numbers[name].n} |`);
  // The results by label: only `verified_result` counts in the share.
  const parts = Object.entries(numbers.verified_share.parts ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (parts.length > 0) lines.push('', `Results by label (verified_share counts verified_result only): ${parts.map(([label, count]) => `${label} ${count}`).join(', ')}.`);
  // Where the tokens of the week went: one line for a scenario, the one that spent the most first.
  const costs = costByScenario(journal, now);
  lines.push('', '## Cost of each scenario', '');
  if (costs.length === 0) lines.push('Nothing.');
  else {
    lines.push('| scenario | tasks | tokens | tokens per task | the week before |', '|---|---|---|---|---|');
    for (const c of costs) lines.push(`| ${c.scenario} | ${c.tasks} | ${c.tokens} | ${c.per_task} | ${cell(c.prev_per_task)} |`);
  }
  // The measures against the targets of the packs, by day, for the seven days.
  lines.push('', '## Targets', '');
  const targets = rt.merged.targets;
  if (targets === undefined || Object.keys(targets).length === 0) lines.push('The packs name no target.');
  else {
    const end = Math.floor(now / DAY) * DAY + DAY;
    const { over, unknown } = overTargets(series(journal, end - 7 * DAY, end, DAY), targets);
    lines.push('| measure | target | days above | days with a value | worst day |', '|---|---|---|---|---|');
    for (const o of over) lines.push(`| ${o.name} | ${o.max} | ${o.days_over} | ${o.days} | ${cell(o.worst)} |`);
    if (unknown.length > 0) lines.push('', `Targets of an unknown measure: ${unknown.join(', ')}.`);
  }
  const proposals = listProposals(rt);
  const open = proposals.filter((p) => p.state === 'open');
  lines.push('', '## Needs a decision of the human', '');
  // The actions that wait in the queue: the summary is of the machine, so of all its projects.
  const waits = listQueue(rt, now).filter((q) => q.state === 'waiting');
  if (open.length === 0 && waits.length === 0) lines.push('Nothing.');
  for (const q of waits) lines.push(`- queue ${q.id} (project ${q.project}, ${q.rule}): ${one(q.what, 160)}. \`reins queue approve ${q.id}\` or \`reins queue reject ${q.id}\``);
  for (const p of open) lines.push(`- ${proposalLine(p)}${p.change !== undefined ? `; the ready change: ${p.change.kind}` : ''}. \`reins craft accept ${p.id}\` or \`reins craft reject ${p.id}\``);
  // What applied itself after its veto window, and the command that takes it back.
  const auto = proposals.filter((p) => p.auto === true && p.resolved !== undefined && now - Date.parse(p.resolved) < 35 * DAY);
  lines.push('', '## Applied by itself', '');
  if (auto.length === 0) lines.push('Nothing.');
  for (const p of auto) lines.push(`- ${proposalLine(p)}, applied ${(p.resolved ?? '').slice(0, 10)}${p.change?.kind === 'memory' ? `. \`reins memory restore ${p.change.record}\` takes it back` : ''}`);
  // The summary is of the machine, as the numbers are: the drafts of all the projects of the memory directory.
  const pending = listRecords(rt, now).filter((r) => r.state === 'pending');
  lines.push('', '## Waits for its term', '');
  if (pending.length === 0) lines.push('Nothing.');
  for (const r of pending) {
    const left = r.veto_until === undefined ? 0 : Math.max(0, Math.ceil((Date.parse(r.veto_until) - now) / DAY));
    lines.push(`- ${r.id} (${r.type}, project ${r.project}, ${left} day(s) left): ${one(r.text, 160)}. \`reins memory veto ${r.id}\``);
  }
  const accepted = proposals.filter((p) => p.state === 'accepted' && p.auto !== true && p.resolved !== undefined && now - Date.parse(p.resolved) < 35 * DAY);
  lines.push('', '## Accepted, and the effect', '');
  if (accepted.length === 0) lines.push('Nothing.');
  for (const p of accepted) lines.push(`- ${proposalLine(p)}, accepted ${(p.resolved ?? '').slice(0, 10)}: ${p.pattern === 'rollback' ? 'an undo' : p.effect === undefined || p.effect === 'not_measured' ? 'not measured' : p.effect}${p.undone !== undefined ? `, undone ${p.undone.slice(0, 10)}` : ''}`);
  return `${lines.join('\n')}\n`;
}

// Writes the summary. Without `force`: only when the last one is seven days old or more (a pack
// can set fewer days: `craft.summary_days`); null
// when it is not the time. The name of the file is the day: two sessions of one day write one file.
export function writeWeek(rt: Runtime, now: number = Date.now(), force = false): string | null {
  const day = new Date(now).toISOString().slice(0, 10);
  const file = path.join(dirOf(rt), `week-${day}.md`);
  try {
    fs.mkdirSync(dirOf(rt), { recursive: true });
    if (!force) {
      const days = fs.readdirSync(dirOf(rt)).map((name) => NAME.exec(name)?.[1]).filter((d): d is string => d !== undefined).sort();
      const last = days[days.length - 1];
      if (last !== undefined && now - Date.parse(`${last}T00:00:00Z`) < (rt.merged.craft?.summary_days ?? 7) * DAY) return null;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, weekText(rt, now));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}
