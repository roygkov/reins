'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/gate-common.js. The logic is unchanged.
// Helpers shared by the gate's modules (gate.js, gate-git.js, gate-data.js, gate-mcp.js): argument reading and the
// short text of a prompt. No decisions, no I/O.

function positionals(argv) { return argv.slice(1).filter((a) => !a.startsWith('-')); }
function hasFlag(argv, flags) { return argv.some((a) => flags.some((f) => a === f || a.startsWith(f + '='))); }
// `anywhere`: the words stand at any place among the positionals, not only among the first four. A value of
// a flag is a positional too, so a window lets a command with several flags before its words pass.
function matchSub(pos, seqs, anywhere) {
  if (!seqs) return true;
  for (let s = 0; s < (anywhere ? pos.length : Math.min(4, pos.length)); s++) {
    for (const seq of seqs) if (seq.every((w, k) => pos[s + k] === w)) return true;
  }
  return false;
}
function short(text) { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > 120 ? t.slice(0, 117) + '...' : t; }
function unresolved(seg) { return seg.vars.slice(1).some(Boolean) || seg.vars[0]; }
// Positionals after the options; `valueOpts` take the next word. Everything after `--` is a path.
function splitArgs(args, valueOpts) {
  const pos = [], paths = [];
  let dashdash = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dashdash) { paths.push(a); continue; }
    if (a === '--') { dashdash = true; continue; }
    if (valueOpts.includes(a)) { k++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  return { pos, paths, dashdash };
}

module.exports = { positionals, hasFlag, matchSub, short, unresolved, splitArgs };
