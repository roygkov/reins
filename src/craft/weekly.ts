// The summary of the week: the one thing of the craft that the human reads. It is a file. The
// harness writes it at the start of a session, once in seven days; `reins week` writes it at once.
// The parts are those that the code has: the numbers of the week, the proposals that need a
// decision, the memory records in their veto window, the accepted proposals and their effect.
// Specification: docs/spec/harness-craft, page 7.

import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from '../core/runtime.ts';
import { EIGHT, eight } from '../journal/metrics.ts';
import { readJournalSince } from '../journal/writer.ts';
import { listRecords } from '../memory/store.ts';
import { listProposals } from './craft.ts';

const DAY = 24 * 60 * 60 * 1000;
const NAME = /^week-(\d{4}-\d{2}-\d{2})\.md$/;
const dirOf = (rt: Runtime): string => path.join(rt.stateDir, 'summaries');
const one = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const cell = (x: number | null): string => (x === null ? '-' : String(x));

// The text of the summary for the seven days that end at `now`.
export function weekText(rt: Runtime, now: number = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const numbers = eight(readJournalSince(rt.stateDir, now - 14 * DAY), now);
  const lines = [`# reins: the week to ${day}`, '', '## Numbers of the week', '', '| number | this week | the week before | rows |', '|---|---|---|---|'];
  for (const name of EIGHT) lines.push(`| ${name} | ${cell(numbers[name].value)} | ${cell(numbers[name].prev)} | ${numbers[name].n} |`);
  const proposals = listProposals(rt);
  const open = proposals.filter((p) => p.state === 'open');
  lines.push('', '## Needs a decision of the human', '');
  if (open.length === 0) lines.push('Nothing.');
  for (const p of open) lines.push(`- ${p.id}: ${p.pattern} of "${one(p.key, 80)}", seen ${p.n} times${p.change !== undefined ? `; the ready change: ${p.change.kind}` : ''}. \`reins craft accept ${p.id}\` or \`reins craft reject ${p.id}\``);
  // The summary is of the machine, as the numbers are: the drafts of all the projects of the memory directory.
  const pending = listRecords(rt, now).filter((r) => r.state === 'pending');
  lines.push('', '## Waits for its term', '');
  if (pending.length === 0) lines.push('Nothing.');
  for (const r of pending) {
    const left = r.veto_until === undefined ? 0 : Math.max(0, Math.ceil((Date.parse(r.veto_until) - now) / DAY));
    lines.push(`- ${r.id} (${r.type}, project ${r.project}, ${left} day(s) left): ${one(r.text, 160)}. \`reins memory veto ${r.id}\``);
  }
  const accepted = proposals.filter((p) => p.state === 'accepted' && p.resolved !== undefined && now - Date.parse(p.resolved) < 35 * DAY);
  lines.push('', '## Accepted, and the effect', '');
  if (accepted.length === 0) lines.push('Nothing.');
  for (const p of accepted) lines.push(`- ${p.id}: ${p.pattern} of "${one(p.key, 80)}", accepted ${(p.resolved ?? '').slice(0, 10)}: ${p.effect === undefined || p.effect === 'not_measured' ? 'not measured' : p.effect}`);
  return `${lines.join('\n')}\n`;
}

// Writes the summary. Without `force`: only when the last one is seven days old or more; null
// when it is not the time. The name of the file is the day: two sessions of one day write one file.
export function writeWeek(rt: Runtime, now: number = Date.now(), force = false): string | null {
  const day = new Date(now).toISOString().slice(0, 10);
  const file = path.join(dirOf(rt), `week-${day}.md`);
  try {
    fs.mkdirSync(dirOf(rt), { recursive: true });
    if (!force) {
      const days = fs.readdirSync(dirOf(rt)).map((name) => NAME.exec(name)?.[1]).filter((d): d is string => d !== undefined).sort();
      const last = days[days.length - 1];
      if (last !== undefined && now - Date.parse(`${last}T00:00:00Z`) < 7 * DAY) return null;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, weekText(rt, now));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}
