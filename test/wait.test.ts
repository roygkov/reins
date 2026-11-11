// The queue of deferred actions in daily work: how long an action waits, what the human sees,
// which call an approval is for. And a strict form of the gate that a lower pack gives.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPacks } from '../src/packs/packs.ts';
import { openJournal } from '../src/journal/writer.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { sweep } from '../src/core/sweep.ts';
import { listQueue, resolveQueued } from '../src/core/queue.ts';
import { beforeAction, type ClientTools } from '../src/client/before.ts';
import { loadCases } from './cases.ts';

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-'));
after(() => fs.rmSync(SB, { recursive: true, force: true }));
const manifests = new Map(loadCases<{ name: string; manifest: unknown }>('manifest-bases').map((b) => [b.name, b.manifest]));
const files = loadCases<{ name: string; files: Record<string, unknown> }>('packs-bases').find((b) => b.name === 'three')?.files ?? {};
const CLIENT: ClientTools = { shell: { kind: 'shell', command: 'command' }, write_file: { kind: 'local', path: 'path' } };
const DAY = 24 * 60 * 60 * 1000;

type Box = { rt: Runtime; root: string; cwd: string };
let n = 0;
function box(extra: Record<string, object> = {}): Box {
  n += 1;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SB, `${n}-`)));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, 'packs', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const level = rel.split('/')[0] ?? '';
    if (rel.endsWith('.sh')) fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    else if (typeof value === 'string' && value.startsWith('$manifest:')) fs.writeFileSync(file, JSON.stringify(manifests.get(value.slice(10))));
    else if (rel.endsWith('pack.json')) fs.writeFileSync(file, JSON.stringify({ ...(value as object), ...(extra[level] ?? {}) }));
    else fs.writeFileSync(file, JSON.stringify(value));
  }
  const merged = loadPacks({ organization: path.join(root, 'packs/organization'), project: path.join(root, 'packs/project'), person: path.join(root, 'packs/person') });
  assert.deepEqual(merged.packs.map((p) => p.errors), [[], [], []]);
  const stateDir = path.join(root, 'state');
  return { rt: { merged, stateDir, journal: openJournal(stateDir), project: 'p1a2b3c4', gateConfig: {} }, root, cwd };
}
const DEFER = { person: { rules: [{ id: 'later', outcome: 'defer', command: 'deploy-tool' }] } };
const sh = (b: Box, command: string, more: Record<string, unknown> = {}) => beforeAction(b.rt, { cwd: b.cwd, tool: 'shell', input: { command, ...more }, session: 's1' }, CLIENT);

// ---- The queue.

test('wait: an approval is for the command, not for the words that the agent puts beside it', () => {
  const b = box(DEFER);
  const first = sh(b, 'deploy-tool run', { description: 'run the deploy', timeout: 1000 });
  assert.equal(first.outcome, 'defer');
  assert.equal(sh(b, 'deploy-tool run', { description: 'the same command, other words' }).queued, first.queued, 'the same command waits once');
  assert.notEqual(sh(b, 'deploy-tool run --all').queued, first.queued, 'another command is another action');
  resolveQueued(b.rt, first.queued ?? '', 'approved');
  assert.equal(sh(b, 'deploy-tool run', { description: 'a third wording' }).rule, 'queue.approved');
});

test('wait: the human sees the whole command in the queue', () => {
  const b = box(DEFER);
  const command = `deploy-tool run ${'--flag=value '.repeat(60)}--last`;
  sh(b, command);
  assert.equal(listQueue(b.rt)[0]?.what, command.replace(/\s+/g, ' '));
});

test('wait: an action that nobody answered for a week leaves the queue, and the sweep removes old entries', () => {
  const b = box(DEFER);
  const now = Date.now();
  const id = sh(b, 'deploy-tool run').queued ?? '';
  assert.deepEqual(listQueue(b.rt, now + 6 * DAY).map((q) => q.id), [id]);
  assert.deepEqual(listQueue(b.rt, now + 8 * DAY), [], 'the action waited too long');
  assert.equal(resolveQueued(b.rt, id, 'approved', now + 8 * DAY), false, 'an approval that comes too late approves nothing');
  const dir = path.join(b.rt.stateDir, 'queue');
  assert.equal(fs.readdirSync(dir).length, 1);
  sweep(b.rt, now + 8 * DAY);
  assert.equal(fs.readdirSync(dir).length, 1, 'kept for a week after its end, for the human who looks back');
  sweep(b.rt, now + 16 * DAY);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---- A form of the gate.

test('wait: a form of a lower pack that refuses wins over a form above it that asks', () => {
  const b = box({
    organization: { gate: { forms: [{ id: 'careful', pattern: 'wipe-tool', decision: 'ask' }] } },
    person: { gate: { forms: [{ id: 'never', pattern: 'wipe-tool --all', decision: 'deny' }] } },
  });
  assert.deepEqual([sh(b, 'wipe-tool --all').outcome, sh(b, 'wipe-tool --all').rule], ['deny', 'user.never']);
  assert.deepEqual([sh(b, 'wipe-tool --one').outcome, sh(b, 'wipe-tool --one').rule], ['ask', 'user.careful']);
});

// ---- Cases of the review.

test('wait: an approval of a file change is for its content too, and a field that changes the run stays in the key', () => {
  const b = box();
  const write = (content: string) => beforeAction(b.rt, { cwd: b.cwd, tool: 'write_file', input: { path: '.reins/pack.json', content }, session: 's1', headless: true }, CLIENT);
  const first = write('A');
  assert.equal(first.outcome, 'defer');
  assert.equal(listQueue(b.rt)[0]?.what, 'write_file .reins/pack.json');
  resolveQueued(b.rt, first.queued ?? '', 'approved');
  assert.equal(write('B').outcome, 'defer', 'another content is another action');
  assert.equal(write('A').rule, 'queue.approved');
  const d = box(DEFER);
  const plain = sh(d, 'deploy-tool run');
  assert.notEqual(sh(d, 'deploy-tool run', { run_in_background: true }).queued, plain.queued);
});

test('wait: a text that is too long for the queue says that it was cut', () => {
  const b = box(DEFER);
  sh(b, `deploy-tool run ${'x'.repeat(5000)}; rm -rf ~`);
  const what = listQueue(b.rt)[0]?.what ?? '';
  assert.match(what, /characters cut: the approval covers the whole action\)$/);
  assert.ok(what.length < 4200);
});

test('wait: the sweep removes a used entry, a rejected entry and an approval that nobody used, a week after their end', () => {
  const b = box(DEFER);
  const now = Date.now();
  const used = sh(b, 'deploy-tool one').queued ?? '';
  const rejected = sh(b, 'deploy-tool two').queued ?? '';
  const unused = sh(b, 'deploy-tool three').queued ?? '';
  resolveQueued(b.rt, used, 'approved', now);
  sh(b, 'deploy-tool one');
  resolveQueued(b.rt, rejected, 'rejected', now);
  resolveQueued(b.rt, unused, 'approved', now);
  const dir = path.join(b.rt.stateDir, 'queue');
  fs.writeFileSync(path.join(dir, 'q0000000000.json.taken'), '');
  fs.utimesSync(path.join(dir, 'q0000000000.json.taken'), new Date(now - 30 * DAY), new Date(now - 30 * DAY));
  sweep(b.rt, now + 6 * DAY);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 3);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.taken')), []);
  sweep(b.rt, now + 7.5 * DAY);
  assert.deepEqual(fs.readdirSync(dir), [`${unused}.json`], 'an approval lives a day and is kept a week more');
  sweep(b.rt, now + 9 * DAY);
  assert.deepEqual(fs.readdirSync(dir), []);
});
