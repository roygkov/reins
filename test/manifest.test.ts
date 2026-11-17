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
  // A script that proves only the form of the result (a record was written, a file is there)
  // says so in the manifest: the label is the lower one. The manifest cannot raise a label.
  assert.equal(labelOf('command', 'form'), 'verified_form');
  assert.equal(labelOf('external', 'form'), 'verified_form');
  assert.equal(labelOf('citations', 'form'), 'verified_form');
  assert.equal(labelOf('human', 'form'), 'approved_by_human');
});

test('manifest: only a script check says that it proves the form, and only that word is taken', () => {
  const base = loadCases<{ name: string; manifest: Record<string, unknown> }>('manifest-bases').find((b) => b.name === 'review')?.manifest;
  assert.ok(base !== undefined);
  const withDone = (done: unknown): unknown => ({ ...base, done });
  const errors = (done: unknown): string[] => validateManifest(withDone(done)).map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, unbound: true, proves: 'form' }), []);
  assert.deepEqual(errors({ kind: 'command', check: 'tests', retries: 1, proves: 'result' }), ['not_in_list done.proves']);
  assert.deepEqual(errors({ kind: 'citations', retries: 2, source: 'worktree', proves: 'form' }), ['not_allowed done.proves']);
  assert.deepEqual(errors({ kind: 'human', retries: 0, proves: 'form' }), ['not_allowed done.proves']);
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

test('manifest: `permissions.harness` names an input of the scenario: the directory that the task may change in the code of the harness', () => {
  const base = loadCases<{ name: string; manifest: Record<string, unknown> }>('manifest-bases').find((b) => b.name === 'review')?.manifest;
  assert.ok(base !== undefined);
  const inputs = ((base.trigger as { inputs?: { name: string }[] }).inputs ?? []).map((i) => i.name);
  assert.ok(inputs.length > 0);
  const withKey = (harness: unknown): unknown => ({ ...base, permissions: { ...(base.permissions as object), harness } });
  assert.deepEqual(validateManifest(withKey(inputs[0])), []);
  const codes = (harness: unknown): string[] => validateManifest(withKey(harness)).map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(codes('no_such_input'), ['unknown_input permissions.harness']);
  assert.deepEqual(codes(true), ['not_string permissions.harness']);
  assert.deepEqual(codes(''), ['unknown_input permissions.harness']);
});
