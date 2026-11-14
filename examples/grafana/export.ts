#!/usr/bin/env node
// The export of the series of `reins metrics` (form 4) to a local VictoriaMetrics.
// The journal is the source: the store of the stand is a view of it. Each run removes the series
// `reins_*` from the store and writes the whole window again, so a point of the current day
// always has its last value. Before the export the script runs `reins probes`: the run writes the
// counts of the barrier to the journal, so each day of an export has a point of the barrier.
//
//   node examples/grafana/export.ts [days=90] [url=http://127.0.0.1:8428] [project=here|<project>]
//
// The address must be a local one: the data of the harness does not leave the machine.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Value = { value: number | null; n: number; parts?: Record<string, number> };
type SeriesPoint = { from: string; to: string; measures?: Record<string, number | null>; by?: Record<string, Record<string, number>>; [name: string]: unknown };
export type Series = { metrics: number; step: string; project: string; names: string[]; measures?: string[]; by?: string[]; points: SeriesPoint[] };
export type Line = { metric: Record<string, string>; values: number[]; timestamps: number[] };

const NAME = /^[a-z][a-z0-9_]{0,59}$/;
// The name of a rule, a place or a label: the value of the label `name` of a series.
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

// One line of the import of VictoriaMetrics for each number that has a value in the window.
// A point without a value (null) gives no sample: the graph has a gap there, not a zero.
export function toLines(series: Series): Line[] {
  const lines = new Map<string, Line>();
  const put = (name: string, labels: Record<string, string>, ts: number, value: unknown): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const metric = { __name__: `reins_${name}`, project: series.project, step: series.step, ...labels };
    const key = JSON.stringify(metric);
    const line: Line = lines.get(key) ?? { metric, values: [], timestamps: [] };
    line.values.push(value);
    line.timestamps.push(ts);
    lines.set(key, line);
  };
  for (const point of series.points) {
    const ts = Date.parse(point.from);
    if (!Number.isFinite(ts)) continue;
    for (const name of series.names) {
      if (!NAME.test(name)) continue;
      const v = point[name] as Value | undefined;
      if (v === undefined || v === null || typeof v !== 'object') continue;
      put(name, {}, ts, v.value);
      put(`${name}_n`, {}, ts, v.n);
      for (const [part, count] of Object.entries(v.parts ?? {})) if (NAME.test(part)) put(`${name}_parts`, { part }, ts, count);
    }
    for (const name of series.measures ?? []) if (NAME.test(name)) put(name, {}, ts, point.measures?.[name]);
    for (const name of series.by ?? []) {
      if (!NAME.test(name)) continue;
      for (const [key, value] of Object.entries(point.by?.[name] ?? {})) if (KEY.test(key)) put(`${name}_by`, { name: key }, ts, value);
    }
  }
  return [...lines.values()];
}

// The store must be on this machine.
export function localUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' ? url : null;
}

async function main(): Promise<void> {
  const args = new Map(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)] as const; }));
  const days = Number(args.get('days') ?? '90');
  const url = localUrl(args.get('url') ?? 'http://127.0.0.1:8428');
  if (!Number.isInteger(days) || days < 1 || days > 366 || url === null) {
    console.log(JSON.stringify({ ok: false, error: 'bad_argument', usage: 'export.ts [days=1..366] [url=http://127.0.0.1:8428] [project=here|<project>]' }));
    process.exitCode = 2;
    return;
  }
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.ts');
  const more = args.has('project') ? [`project=${args.get('project')}`] : [];
  try {
    execFileSync(process.execPath, [cli, 'probes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // No probes: the series has no point of the barrier for this run.
  }
  const series = JSON.parse(execFileSync(process.execPath, [cli, 'metrics', `days=${days}`, 'step=day', ...more], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Series & { ok?: boolean };
  if (series.ok !== true || series.metrics !== 4) {
    console.log(JSON.stringify({ ok: false, error: 'bad_series', metrics: series.metrics ?? null }));
    process.exitCode = 1;
    return;
  }
  const lines = toLines(series);
  const base = url.origin;
  try {
    const selector = encodeURIComponent(`{__name__=~"reins_.*",project="${series.project}"}`);
    const removed = await fetch(`${base}/api/v1/admin/tsdb/delete_series?match[]=${selector}`, { method: 'POST' });
    if (!removed.ok) throw new Error(`delete ${removed.status}`);
    const written = await fetch(`${base}/api/v1/import`, { method: 'POST', body: lines.map((l) => JSON.stringify(l)).join('\n') });
    if (!written.ok) throw new Error(`import ${written.status}`);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'store_unreachable', url: base, detail: String((e as Error).message).slice(0, 120) }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, url: base, project: series.project, days, series: lines.length, samples: lines.reduce((n, l) => n + l.values.length, 0) }));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
