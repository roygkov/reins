import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, strictest, OUTCOMES, type DecideInput } from '../src/contracts/policy.ts';
import { loadCases } from './cases.ts';

type Case = { name: string; input: DecideInput; expect: { outcome: string; scope?: string; layer: string; rule: string; envelope: string } };

for (const c of loadCases<Case>('policy-cases')) {
  test(`policy: ${c.name}`, () => {
    const d = decide(c.input);
    const got: Record<string, string> = { outcome: d.outcome, layer: d.basis.layer, rule: d.basis.rule, envelope: d.envelope };
    if (d.scope !== undefined) got.scope = d.scope;
    assert.deepEqual(got, c.expect);
  });
}

test('policy: strictness grows allow, ask, defer, deny', () => {
  assert.deepEqual([...OUTCOMES], ['allow', 'ask', 'defer', 'deny']);
  assert.equal(strictest('allow', 'ask'), 'ask');
  assert.equal(strictest('deny', 'defer'), 'deny');
  assert.equal(strictest('defer', 'ask'), 'defer');
  assert.equal(strictest('allow', 'allow'), 'allow');
});

test('policy: an envelope never makes the outcome less strict than deny or defer, and never touches production', () => {
  for (const layer of ['defer', 'deny'] as const) {
    for (const production of [false, true]) {
      const d = decide({
        action: { via: 'tool', kind: 'write', name: 'comment', target: 'change/7', env: { name: 'e', known: true, production } },
        layers: [{ layer: 'organization', outcome: layer, rule: 'r' }],
        envelope: [{ action: 'comment', target: 'change/7', env: 'e', limit: 5, confirm: 'none' }],
      });
      assert.equal(d.outcome, layer);
    }
  }
});
