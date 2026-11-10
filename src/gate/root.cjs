'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/root.js. The logic is unchanged.
// Finds the repository root and a stable project key without running git.
const fs = require('fs');
const path = require('path');
const { sha1, readText } = require('./util.cjs');

function findRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (e) { st = null; }
    if (st) {
      let gitDir = dotgit;
      if (st.isFile()) {
        const m = /gitdir:\s*(.+)/.exec(readText(dotgit) || '');
        if (m) gitDir = path.resolve(dir, m[1].trim());
      }
      let commonDir = gitDir;
      const common = readText(path.join(gitDir, 'commondir'));
      if (common) commonDir = path.resolve(gitDir, common.trim());
      // key: the repository (grants, config, journal); wkey: this worktree (session, turn, checks, plans).
      // The main worktree's git dir is the common dir, so its wkey is the old key and its state stays in place.
      return { root: dir, gitDir, commonDir, isRepo: true, key: sha1(commonDir).slice(0, 12), wkey: sha1(gitDir).slice(0, 12) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const c = path.resolve(cwd || process.cwd());
  const key = sha1(c).slice(0, 12);
  return { root: c, gitDir: null, commonDir: null, isRepo: false, key, wkey: key };
}

function currentBranch(info) {
  if (!info || !info.gitDir) return null;
  const head = readText(path.join(info.gitDir, 'HEAD')) || '';
  const m = /ref:\s*refs\/heads\/(.+)/.exec(head);
  return m ? m[1].trim() : null;
}

// The default branch of each remote, from refs/remotes/<remote>/HEAD (written by clone and `git remote set-head`).
function defaultBranches(info) {
  if (!info || !info.commonDir) return [];
  const dir = path.join(info.commonDir, 'refs', 'remotes');
  let remotes = [];
  try { remotes = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const r of remotes) {
    const m = /ref:\s*refs\/remotes\/[^/]+\/(.+)/.exec(readText(path.join(dir, r, 'HEAD')) || '');
    if (m && !out.includes(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

// The repository's identity across clones and state keys (0.5.0, `session_start.remote`): sha1 of the first
// `remote.*.url` in the git config (the common dir, read as a file), 12 characters; null without a remote.
function remoteKey(info) {
  if (!info || !info.commonDir) return null;
  const text = readText(path.join(info.commonDir, 'config')) || '';
  let inRemote = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[/.test(line)) { inRemote = /^\[remote\s+"/.test(line); continue; }
    const m = inRemote ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (m && m[1].trim()) return sha1(m[1].trim()).slice(0, 12);
  }
  return null;
}

module.exports = { findRoot, currentBranch, defaultBranches, remoteKey };
