'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/util.js. The logic is unchanged.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PLUGIN_ROOT = __dirname;
const HOME = os.homedir();
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'reins');
const STATE_ROOT = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'reins');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function sha1(text) { return crypto.createHash('sha1').update(text).digest('hex'); }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function data(name) { return readJson(path.join(PLUGIN_ROOT, 'data', name), {}); }

// `$HOME` and `${HOME}`, not `$HOME_X` or `$HOMEDIR`
const varRe = (name) => new RegExp('\\$(\\{' + name + '\\}|' + name + '(?![A-Za-z0-9_]))', 'g');
const HOME_RE = varRe('HOME'), TMPDIR_RE = varRe('TMPDIR');
function expandText(p, env) {
  const e = env || process.env;
  return String(p).replace(/^~(?=$|\/)/, HOME).replace(HOME_RE, HOME).replace(TMPDIR_RE, () => (e.TMPDIR || os.tmpdir()));
}
function expandPath(p, cwd, env) {
  if (!p) return p;
  return path.resolve(cwd || process.cwd(), expandText(p, env));
}
function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// A path and its real location: HOME, XDG dirs or the repo may sit behind a symlink (macOS /var, /tmp; NFS homes),
// and the same directory then shows up under two spellings.
function spellings(p) {
  let head = p, tail = '';
  while (head !== path.dirname(head)) {
    try { const real = path.join(fs.realpathSync(head), tail); return real === p ? [p] : [p, real]; } catch (e) { /* missing: go up */ }
    tail = path.join(path.basename(head), tail); head = path.dirname(head);
  }
  return [p];
}
// APFS and NTFS ignore case by default, ext4 does not; ask the disk, not the OS. The nearest existing ancestor with a
// letter in its name is looked up with that letter's case flipped: the same inode means the volume folds case.
// Undecidable (no such ancestor) counts as folding: a wider match only denies more.
const foldCache = new Map();
function foldsCase(p) {
  for (let d = p; d !== path.dirname(d); d = path.dirname(d)) {
    const name = path.basename(d);
    if (!/[a-zA-Z]/.test(name)) continue;
    if (foldCache.has(d)) return foldCache.get(d);
    let st; try { st = fs.statSync(d, { bigint: true }); } catch (e) { continue; }
    const flipped = path.join(path.dirname(d), name.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())));
    let r = false;
    try { const s2 = fs.statSync(flipped, { bigint: true }); r = s2.ino === st.ino && s2.dev === st.dev; } catch (e) { /* no twin: case matters */ }
    foldCache.set(d, r);
    return r;
  }
  return true;
}
// isInside as the file system sees it: case-folded (and NFC, as APFS ignores normalization) where the volume folds case.
function isInsideOnDisk(child, parent) {
  if (!child || !parent) return false;
  if (!foldsCase(parent)) return isInside(child, parent);
  const fold = (s) => s.normalize('NFC').toLowerCase();
  return isInside(fold(child), fold(parent));
}
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
function matchGlob(value, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(value));
}
function emit(obj) { if (obj) process.stdout.write(JSON.stringify(obj)); }

module.exports = { spellings, foldsCase, isInsideOnDisk, expandText,
  PLUGIN_ROOT, HOME, CONFIG_DIR, STATE_ROOT,
  readStdin, parseJson, readJson, writeJson, sha1, exists, isDir, readText,
  data, expandPath, isInside, globToRegExp, matchGlob, emit,
};
