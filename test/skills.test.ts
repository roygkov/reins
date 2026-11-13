// The skills of the Claude Code plugin: each one is a directory with a SKILL.md that the client can read,
// and each `reins memory` command that a skill names is a command of the harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const SKILLS = path.join(ROOT, 'clients', 'claude-code', 'skills');
const NAMES = ['decision-hygiene', 'search-first', 'strategic-compact', 'systematic-debugging'];

function read(name: string): { head: Record<string, string>; body: string } {
  const text = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}: the file starts with a frontmatter block`);
  const head: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    assert.ok(at > 0, `${name}: a frontmatter line is "key: value"`);
    head[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { head, body: m[2] ?? '' };
}

test('the plugin ships the skills of the memory, and no other', () => {
  assert.deepEqual(fs.readdirSync(SKILLS).sort(), NAMES);
});

test('each skill has a name equal to its directory and a short description with a trigger', () => {
  for (const name of NAMES) {
    const { head } = read(name);
    assert.deepEqual(Object.keys(head).sort(), ['description', 'name'], name);
    assert.equal(head.name, name);
    const description = (head.description ?? '').replace(/^'|'$/g, '');
    assert.ok(description.startsWith('Use when: '), `${name}: the description names the trigger`);
    assert.ok(description.length <= 160, `${name}: the description is short (${description.length})`);
  }
});

test('each `reins memory` command in a skill is a command of the harness', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
  for (const name of NAMES) {
    const { body } = read(name);
    const words = new Set([...body.matchAll(/reins memory ([a-z]+)/g)].map((m) => m[1] ?? ''));
    for (const word of words) assert.ok(cli.includes(`'${word}'`), `${name}: reins memory ${word}`);
  }
});

test('a skill names no place of one workspace', () => {
  for (const name of NAMES) {
    const { body } = read(name);
    for (const word of ['docs/memory', 'exocortex', 'agentic', 'IdeaProjects']) assert.ok(!body.includes(word), `${name}: ${word}`);
  }
});
