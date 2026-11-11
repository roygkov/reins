// The form of a schedule trigger. A value is one of four forms, in the local time of the machine:
//   every <n>m | every <n>h | every <n>d    a period
//   daily HH:MM                            every day at this time
//   weekdays HH:MM                         Monday to Friday at this time
//   weekly <mon|tue|wed|thu|fri|sat|sun> HH:MM
// Pure: no clock of its own.

export type Schedule =
  | { kind: 'every'; ms: number }
  | { kind: 'daily' | 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number };

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSchedule(value: string): Schedule | null {
  const every = /^every ([1-9][0-9]{0,3})([mhd])$/.exec(value);
  if (every !== null) return { kind: 'every', ms: Number(every[1]) * (UNIT[every[2] ?? ''] ?? 0) };
  const timed = /^(daily|weekdays|weekly (sun|mon|tue|wed|thu|fri|sat)) ([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (timed === null) return null;
  const hour = Number(timed[3]);
  const minute = Number(timed[4]);
  if (timed[2] !== undefined) return { kind: 'weekly', day: DAYS.indexOf(timed[2]), hour, minute };
  return { kind: timed[1] === 'daily' ? 'daily' : 'weekdays', hour, minute };
}

// The first run of a schedule that is later than `after`.
export function nextRun(s: Schedule, after: Date): Date {
  if (s.kind === 'every') return new Date(after.getTime() + s.ms);
  const next = new Date(after.getFullYear(), after.getMonth(), after.getDate(), s.hour, s.minute, 0, 0);
  for (let i = 0; i < 9; i += 1) {
    const day = next.getDay();
    const fits = s.kind === 'daily' || (s.kind === 'weekdays' && day >= 1 && day <= 5) || (s.kind === 'weekly' && day === s.day);
    if (fits && next.getTime() > after.getTime()) return next;
    next.setDate(next.getDate() + 1);
  }
  return next;
}
