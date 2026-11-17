// The export of the series of `reins metrics` for the local stand of Grafana.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exportTime, localUrl, toLines, type Series } from '../examples/grafana/export.ts';
import { BY, EIGHT, MEASURES } from '../src/journal/metrics.ts';

const DAY1 = '2026-11-12T00:00:00.000Z';
const DAY2 = '2026-11-13T00:00:00.000Z';
const series: Series = {
  metrics: 12, targets: { hook_ms_p50: 100, 'Bad-Name': 1 }, step: 'day', project: 'all', names: ['verified_share', 'cost_per_scenario'], measures: ['asks_per_task', 'hook_ms_p50'], by: ['questions_asked'],
  points: [
    { from: DAY1, to: DAY2, verified_share: { value: 0.04, n: 156, parts: { verified_form: 69, verified_result: 7 } }, cost_per_scenario: { value: null, n: 0 }, measures: { asks_per_task: 0.86, hook_ms_p50: null } },
    { from: DAY2, to: '2026-11-14T00:00:00.000Z', verified_share: { value: 0.23, n: 125 }, cost_per_scenario: { value: 38333, n: 37 }, measures: { asks_per_task: 0.95, hook_ms_p50: 125 }, by: { questions_asked: { 'protect.harness': 12, 'default.write': 3, 'bad"name': 1 }, not_named: { x: 1 } } },
  ],
};

test('grafana export: each number with a value gives a sample at the start of its step', () => {
  const lines = toLines(series);
  const of = (name: string, part?: string) => lines.find((l) => l.metric.__name__ === name && l.metric.part === part);
  assert.deepEqual(of('reins_verified_share'), { metric: { __name__: 'reins_verified_share', project: 'all', step: 'day' }, values: [0.04, 0.23], timestamps: [Date.parse(DAY1), Date.parse(DAY2)] });
  assert.deepEqual(of('reins_verified_share_n')?.values, [156, 125]);
  assert.deepEqual(of('reins_verified_share_parts', 'verified_form'), { metric: { __name__: 'reins_verified_share_parts', project: 'all', step: 'day', part: 'verified_form' }, values: [69], timestamps: [Date.parse(DAY1)] });
  assert.deepEqual(of('reins_asks_per_task')?.values, [0.86, 0.95]);
});

test('grafana export: a number with a name of its own gives a series for each name', () => {
  const by = toLines(series).filter((l) => (l.metric.__name__ ?? '').endsWith('_by'));
  assert.deepEqual(by, [
    { metric: { __name__: 'reins_questions_asked_by', project: 'all', step: 'day', name: 'protect.harness' }, values: [12], timestamps: [Date.parse(DAY2)] },
    { metric: { __name__: 'reins_questions_asked_by', project: 'all', step: 'day', name: 'default.write' }, values: [3], timestamps: [Date.parse(DAY2)] },
  ]);
});

test('grafana export: a point without a value gives no sample, not a zero', () => {
  const lines = toLines(series);
  const of = (name: string) => lines.find((l) => l.metric.__name__ === name);
  assert.deepEqual(of('reins_cost_per_scenario'), { metric: { __name__: 'reins_cost_per_scenario', project: 'all', step: 'day' }, values: [38333], timestamps: [Date.parse(DAY2)] });
  assert.deepEqual(of('reins_cost_per_scenario_n')?.values, [0, 37]);
  assert.deepEqual(of('reins_hook_ms_p50')?.timestamps, [Date.parse(DAY2)]);
  assert.deepEqual(toLines({ ...series, points: [] }), []);
});

test('grafana export: a name that is not a plain token gives no series', () => {
  const lines = toLines({ ...series, names: ['verified_share', 'Bad-Name"}'], measures: ['x{y}'], points: [{ from: DAY1, to: DAY2, verified_share: { value: 1, n: 1, parts: { 'a"b': 1 } }, 'Bad-Name"}': { value: 1, n: 1 }, measures: { 'x{y}': 1 } }] });
  assert.deepEqual(lines.map((l) => l.metric.__name__), ['reins_verified_share', 'reins_verified_share_n', 'reins_target_max']);
  // The target of a measure is one series with the name of the measure; a name that is no token gives none.
  assert.deepEqual(lines.filter((l) => l.metric.__name__ === 'reins_target_max').map((l) => [l.metric.name, l.values]), [['hook_ms_p50', [100]]]);
  // The state against the target: only a day with a value has one; a series by hours carries no target.
  assert.deepEqual(toLines(series).filter((l) => l.metric.__name__ === 'reins_target_over').map((l) => [l.metric.name, l.values, l.timestamps]), [['hook_ms_p50', [1], [Date.parse(DAY2)]]]);
  assert.deepEqual(toLines({ ...series, step: 'hour' }).filter((l) => (l.metric.__name__ ?? '').startsWith('reins_target')), []);
});

test('grafana export: a number by session goes to the series by hours only', () => {
  const point = { from: DAY1, to: DAY2, by: { session_context: { '0ac7e3a3': 225_000 }, context_bytes: { session_start: 9000 } } };
  const of = (step: string): string[] => toLines({ metrics: 12, step, project: 'all', names: [], by: ['session_context', 'context_bytes'], points: [point] }).map((l) => `${l.metric.__name__} ${l.metric.name}`);
  assert.deepEqual(of('hour'), ['reins_session_context_by 0ac7e3a3', 'reins_context_bytes_by session_start']);
  // A series by days lives for months: a label for every session would grow without end.
  assert.deepEqual(of('day'), ['reins_context_bytes_by session_start']);
});

test('grafana export: the list of periods of the dashboard has no period shorter than a step of the series', () => {
  const dash = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'grafana', 'dashboards', 'reins.json'), 'utf8')) as { timepicker?: { quick_ranges?: { display: string; from: string; to: string }[] }; panels: { title: string; interval?: string; timeFrom?: string; targets: { expr: string }[] }[] };
  const ranges = dash.timepicker?.quick_ranges ?? [];
  assert.ok(ranges.length >= 4);
  // A point of the series stands at the start of its hour or day: a period of minutes shows no point.
  const hours = (from: string): number => { const m = /^now-(\d+)([hd])$/.exec(from); return m === null ? 0 : Number(m[1]) * (m[2] === 'd' ? 24 : 1); };
  for (const r of ranges) assert.ok(r.to === 'now' && hours(r.from) >= 24 && r.display !== '', JSON.stringify(r));
  // A panel of the series by hours has its own period, of two days at most: the series holds two days.
  for (const p of dash.panels.filter((p) => p.targets.some((t) => t.expr.includes('step="hour"')))) assert.match(p.timeFrom ?? '', /^(24h|2d)$/, p.title);
});

test('grafana export: each run writes its own time, and the health panel shows how old the data is', () => {
  // The time of the run in seconds, as one sample at that moment: the series of the measures carry
  // the start of a bucket, which says nothing about the moment of the export.
  const now = Date.parse('2026-11-16T10:30:05.250Z');
  assert.deepEqual(exportTime('p1a2b3c4', now), { metric: { __name__: 'reins_export_time', project: 'p1a2b3c4' }, values: [Math.floor(now / 1000)], timestamps: [now] });
  const dash = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'grafana', 'dashboards', 'reins.json'), 'utf8')) as { panels: { id: number; targets: { expr: string; legendFormat: string; instant?: boolean }[]; fieldConfig: { overrides: { matcher: { options: string }; properties: { id: string; value: unknown }[] }[] } }[] };
  const health = dash.panels.find((p) => p.id === 1);
  const about = (health?.targets ?? []).filter((t) => t.expr.includes('reins_export_time'));
  // Two tiles: the age of the data and the moment of the last export. Both are asked at the end of
  // the period, not at the start of a day: the step of the panel is a day.
  assert.deepEqual(about.map((t) => [t.legendFormat, t.instant]), [['давность данных', true], ['данные от', true]]);
  assert.ok(about.every((t) => t.expr.includes('project="$project"') && t.expr.includes('last_over_time(')));
  // The tile of the age has its own colours: data older than three hours is red, and no text of a target stands on it.
  const age = health?.fieldConfig.overrides.find((o) => o.matcher.options === 'давность данных')?.properties ?? [];
  const steps = (age.find((p) => p.id === 'thresholds')?.value as { steps: { color: string; value: number | null }[] } | undefined)?.steps ?? [];
  assert.deepEqual(steps.map((x) => [x.color, x.value]), [['green', null], ['yellow', 5400], ['red', 10800]]);
  assert.deepEqual(age.find((p) => p.id === 'mappings')?.value, []);
});

test('grafana export: the store is on this machine only', () => {
  assert.equal(localUrl('http://127.0.0.1:8428')?.origin, 'http://127.0.0.1:8428');
  assert.equal(localUrl('http://localhost:8428')?.origin, 'http://localhost:8428');
  for (const bad of ['http://vm.example.com:8428', 'https://127.0.0.1:8428', 'http://127.0.0.1.example.com', 'http://10.0.0.5:8428', 'not a url']) assert.equal(localUrl(bad), null, bad);
});

test('grafana export: the dashboard asks only for the numbers that the series has', () => {
  const dir = path.join(import.meta.dirname, '..', 'examples', 'grafana');
  const dash = JSON.parse(fs.readFileSync(path.join(dir, 'dashboards', 'reins.json'), 'utf8')) as { panels: { targets: { expr: string }[] }[] };
  // The line of a target is a series of its own.
  const known = new Set<string>(['reins_target_max', 'reins_target_over', 'reins_export_time', ...[...EIGHT, ...MEASURES].flatMap((n) => [`reins_${n}`, `reins_${n}_n`, `reins_${n}_parts`]), ...BY.map((n) => `reins_${n}_by`)]);
  const asked = dash.panels.flatMap((p) => p.targets.flatMap((t) => t.expr.match(/reins_[a-z0-9_]+/g) ?? []));
  assert.ok(asked.length >= 10);
  for (const name of asked) assert.ok(known.has(name), name);
  // Each measure of the series is on the dashboard.
  for (const name of MEASURES) assert.ok(asked.includes(`reins_${name}`) || asked.includes(`reins_${name}_by`), name);
  for (const name of BY) assert.ok(asked.includes(`reins_${name}_by`), name);
  for (const name of EIGHT) assert.ok(asked.includes(`reins_${name}`), name);
  // The ports of the stand listen on this machine only.
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const ports = compose.split('\n').filter((l) => /^\s+- [\d.:]+:\d+$/.test(l));
  assert.equal(ports.length, 2);
  for (const p of ports) assert.match(p, /- 127\.0\.0\.1:\d+:\d+$/);
});

test('grafana export: the dashboard shows the craft: its last activity, the proposals that wait, and what was decided', () => {
  const dash = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'grafana', 'dashboards', 'reins.json'), 'utf8')) as { panels: { id: number; type: string; title: string; targets: { expr: string; legendFormat: string; instant?: boolean }[] }[] };
  const ids = dash.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const state = dash.panels.find((p) => p.title === 'Крафт: состояние');
  assert.equal(state?.type, 'stat');
  assert.deepEqual(state?.targets.map((t) => [t.legendFormat, /reins_[a-z_]+/.exec(t.expr)?.[0], t.instant]), [
    ['последняя активность', 'reins_craft_last_ts', true], ['без активности', 'reins_craft_last_ts', true], ['ждут решения', 'reins_craft_open', true],
    ['предложено', 'reins_craft_proposed', true], ['принято', 'reins_craft_accepted', true], ['отклонено', 'reins_craft_rejected', true],
  ]);
  // A day without a row of the craft has no moment: the tile takes the last moment of the window, not of the last day.
  assert.ok(state?.targets.filter((t) => t.expr.includes('reins_craft_last_ts')).every((t) => t.expr.includes('max_over_time(')));
  const days = dash.panels.find((p) => p.title === 'Крафт: предложения');
  assert.deepEqual(days?.targets.map((t) => t.legendFormat), ['предложено', 'принято', 'отклонено', 'ждут решения']);
  for (const t of [...(state?.targets ?? []), ...(days?.targets ?? [])]) assert.ok(t.expr.includes('project="$project", step="day"'), t.expr);
  // The bars of one day stand on one another, not behind one another: a bar of the same height hides no other. The line of the waiting ones is outside the stack.
  const drawn = days as unknown as { fieldConfig: { defaults: { custom: { drawStyle: string; stacking: { mode: string } } }; overrides: { matcher: { options: string }; properties: { id: string; value: unknown }[] }[] } } | undefined;
  assert.deepEqual([drawn?.fieldConfig.defaults.custom.drawStyle, drawn?.fieldConfig.defaults.custom.stacking.mode], ['bars', 'normal']);
  const line = drawn?.fieldConfig.overrides.find((o) => o.matcher.options === 'ждут решения')?.properties ?? [];
  assert.deepEqual([line.find((x) => x.id === 'custom.drawStyle')?.value, line.find((x) => x.id === 'custom.stacking')?.value], ['line', { mode: 'none' }]);
});

test('grafana export: a measure of the craft gives a series, and a day without its row gives no moment', () => {
  const lines = toLines({ metrics: 12, step: 'day', project: 'all', names: [], measures: ['craft_open', 'craft_last_ts'], points: [
    { from: DAY1, to: DAY2, measures: { craft_open: 2, craft_last_ts: 1794480000 } },
    { from: DAY2, to: '2026-11-14T00:00:00.000Z', measures: { craft_open: 0, craft_last_ts: null } },
  ] });
  assert.deepEqual(lines.map((l) => [l.metric.__name__, l.values]), [['reins_craft_open', [2, 0]], ['reins_craft_last_ts', [1794480000]]]);
});
