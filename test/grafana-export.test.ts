// The export of the series of `reins metrics` for the local stand of Grafana.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { localUrl, toLines, type Series } from '../examples/grafana/export.ts';
import { BY, EIGHT, MEASURES } from '../src/journal/metrics.ts';

const DAY1 = '2026-11-12T00:00:00.000Z';
const DAY2 = '2026-11-13T00:00:00.000Z';
const series: Series = {
  metrics: 9, targets: { hook_ms_p50: 100, 'Bad-Name': 1 }, step: 'day', project: 'all', names: ['verified_share', 'cost_per_scenario'], measures: ['asks_per_task', 'hook_ms_p50'], by: ['questions_asked'],
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

test('grafana export: the store is on this machine only', () => {
  assert.equal(localUrl('http://127.0.0.1:8428')?.origin, 'http://127.0.0.1:8428');
  assert.equal(localUrl('http://localhost:8428')?.origin, 'http://localhost:8428');
  for (const bad of ['http://vm.example.com:8428', 'https://127.0.0.1:8428', 'http://127.0.0.1.example.com', 'http://10.0.0.5:8428', 'not a url']) assert.equal(localUrl(bad), null, bad);
});

test('grafana export: the dashboard asks only for the numbers that the series has', () => {
  const dir = path.join(import.meta.dirname, '..', 'examples', 'grafana');
  const dash = JSON.parse(fs.readFileSync(path.join(dir, 'dashboards', 'reins.json'), 'utf8')) as { panels: { targets: { expr: string }[] }[] };
  // The line of a target is a series of its own.
  const known = new Set<string>(['reins_target_max', 'reins_target_over', ...[...EIGHT, ...MEASURES].flatMap((n) => [`reins_${n}`, `reins_${n}_n`, `reins_${n}_parts`]), ...BY.map((n) => `reins_${n}_by`)]);
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
