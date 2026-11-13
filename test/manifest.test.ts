import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, labelOf, type PackContext } from '../src/contracts/manifest.ts';
import { loadCases, patch } from './cases.ts';

type Case = { name: string; base?: string; patch?: unknown; manifest?: unknown; pack?: PackContext | 'default'; errors: string[] };
type Base = { name: string; manifest: unknown };

const bases = new Map(loadCases<Base>('manifest-bases').map((b) => [b.name, b.manifest]));
const packs = loadCases<{ name: string; pack: PackContext }>('manifest-packs');
const defaultPack = packs.find((p) => p.name === 'default')?.pack;

for (const c of loadCases<Case>('manifest-cases')) {
  test(`manifest: ${c.name}`, () => {
    const source = c.base === undefined ? c.manifest : patch(bases.get(c.base), c.patch ?? {});
    const pack = c.pack === 'default' ? defaultPack : c.pack;
    const found = validateManifest(source, pack).map((e) => `${e.code} ${e.path}`).sort();
    assert.deepEqual(found, [...c.errors].sort());
  });
}

test('manifest: the result label follows the kind of the done check', () => {
  assert.equal(labelOf('command'), 'verified_result');
  assert.equal(labelOf('artifact'), 'verified_result');
  assert.equal(labelOf('external'), 'verified_result');
  assert.equal(labelOf('citations'), 'verified_form');
  assert.equal(labelOf('human'), 'approved_by_human');
});

test('manifest: the trigger says who opens the scenario: the agent or only the human', () => {
  const base = loadCases<{ name: string; manifest: Record<string, unknown> }>('manifest-bases').find((b) => b.name === 'review')?.manifest;
  assert.ok(base !== undefined);
  const withOpen = (open: unknown): unknown => ({ ...base, trigger: { ...(base.trigger as object), open } });
  for (const open of ['agent', 'human']) assert.deepEqual(validateManifest(withOpen(open)), [], open);
  assert.deepEqual(validateManifest(withOpen('anyone')).map((e) => [e.code, e.path]), [['not_in_list', 'trigger.open']]);
  // Only a command is opened by somebody: a schedule and an event open by themselves.
  const scheduled = { ...base, trigger: { kind: 'schedule', value: 'daily 09:00', open: 'human' } };
  assert.ok(validateManifest(scheduled).some((e) => e.code === 'not_allowed' && e.path === 'trigger.open'));
});
