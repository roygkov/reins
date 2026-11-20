'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/gate.js. One change of the logic: the
// list `words` of a form in evalUserForms (docs/contracts.md, S7).
// Production gate: decides allow / ask / deny for shell segments and MCP calls. This file is the dispatcher: it
// tokenizes the command, runs the data rules (data/gate.json), rm, the human's forms and the evaluators of
// gate-git.js, gate-data.js and gate-mcp.js over every segment, ranks the decisions and holds the grant scopes.
const path = require('path');
const os = require('os');
const { parse, base } = require('./tokenize.cjs');
const ctxr = require('./context.cjs');
const { HOME, expandPath, isInside } = require('./util.cjs');
const { positionals, hasFlag, matchSub, short, unresolved } = require('./gate-common.cjs');
const git = require('./gate-git.cjs');
const data = require('./gate-data.cjs');
const mcp = require('./gate-mcp.cjs');

const RANK = { allow: 0, ask: 1, deny: 2 };
const TEMP_ROOTS = () => [os.tmpdir(), '/tmp', '/var/folders', '/private/tmp', '/private/var/folders'];
const SAFE_RM_ROOTS = () => [...TEMP_ROOTS(),
  path.join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData'), path.join(HOME, '.gradle', 'caches'), path.join(HOME, '.m2', 'repository'),
  path.join(HOME, '.npm'), path.join(HOME, '.cache'), path.join(HOME, 'Library', 'Caches'), path.join(HOME, '.cargo', 'registry'), path.join(HOME, '.pnpm-store')];

// Shell prefilter needles. hook.sh greps the whole JSON hook input, without case, against data/prefilter-bash.txt and
// starts Node only on a hit, so every evaluator in this file and in gate-git.js, gate-data.js and gate-mcp.js names in `NEEDLES` what must reach it. scripts/gen-prefilter.js
// writes the file from these, from perimeter.js and protect.js, and from gate.json (`cmd` with `sub` or
// `task_contains`, `markers`); test/prefilter.test.js fails when the file is stale. A needle is a POSIX ERE as hook.sh
// greps it, or a command form the script renders: `{ cmd }` the command word at a word start and before a separator,
// `{ cmd, sub }` the command with the word later in the same shell segment (`kubectl get` stays out of Node,
// `kubectl -n x delete` goes in), `{ cmd, contains }` the word anywhere after the command. A needle change comes with
// a risky command and a safe twin in test/gate.test.js.

function cmdMatches(rule, argv0) { const b = base(argv0); return rule.cmd.includes(b) || rule.cmd.includes(argv0); }
// The human confirms the real action, so the prompt shows the command as typed; only a very long one is cut.
const SHOW_MAX = 600;
function full(text) { const t = String(text || '').trim(); return t.length > SHOW_MAX ? t.slice(0, SHOW_MAX) + '…(' + (t.length - SHOW_MAX) + ' more chars)' : t; }

// Grant scopes (A10.04: a standing "yes" only for the reversible). `all` lifts every class except these two groups;
// production classes have their own scope; the irreversible ones only the one action the last prompt showed (`this`).
const PRODUCTION = new Set(['prod-default', 'prod-env', 'infra', 'secrets', 'mcp']);
// `protected`: lands work on a protected or the default branch, or deletes a repository (push, merge, auto-merge)
const ONE_BY_ONE = new Set(['data', 'publish', 'git-discard', 'blast-radius', 'protected']);
function grantCovers(scope, r) {
  if (!scope || !r) return false;
  if (scope === r.id) return true;
  if (scope === 'tests') return r.cls === 'tests';
  if (scope === 'production') return PRODUCTION.has(r.cls);
  if (scope === 'all') return !PRODUCTION.has(r.cls) && !ONE_BY_ONE.has(r.cls);
  return false;
}

function prodEvidence(seg, rule, cfg, cwd) {
  const markers = cfg.markers;
  // explicit tokens in arguments (by token boundaries, not substrings)
  for (const a of seg.argv.slice(1)) {
    if (a.startsWith('-') && !a.includes('=')) continue;
    if (ctxr.isProdName(a, markers)) return 'argument "' + short(a) + '"';
  }
  for (const k of Object.keys(seg.env || {})) if (ctxr.isProdName(seg.env[k], markers) && /PROFILE|ENV|STAGE|TARGET|WORKSPACE|CONTEXT|PROJECT/i.test(k)) return k + '=' + seg.env[k];
  if (rule && rule.context) {
    const r = ctxr.resolve(rule.context, seg, cwd);
    if (r && r.value) {
      const m = r.source === 'directory' ? markers.filter((x) => x !== 'live') : markers;
      if (ctxr.isProdName(r.value, m)) return rule.context + ' context "' + short(r.value) + '" (' + r.source + ')';
    }
  }
  return null;
}

function evalRule(rule, seg, cfg, cwd) {
  if (!cmdMatches(rule, seg.argv[0])) return null;
  const pos = positionals(seg.argv);
  if (rule.sub && !matchSub(pos, rule.sub, rule.sub_anywhere === true)) {
    if (!(rule.flags && !rule.sub_required && hasFlag(seg.argv, rule.flags) && false)) return null;
  }
  if (rule.flags && !hasFlag(seg.argv, rule.flags)) return null;
  if (rule.verb_prefix && !pos.slice(0, 6).some((p) => rule.verb_prefix.some((v) => p.startsWith(v)))) return null;
  if (rule.verb_any && !pos.some((p) => rule.verb_any.includes(p))) return null;
  if (rule.task_contains) {
    const tasks = pos.filter((p) => rule.task_contains.some((t) => p.toLowerCase().includes(t.toLowerCase())) && !(rule.task_exclude || []).some((x) => p.endsWith(x)));
    if (!tasks.length) return null;
  }
  if (rule.flags_any_for) {
    for (const k of Object.keys(rule.flags_any_for)) if (pos.includes(k) && !hasFlag(seg.argv, rule.flags_any_for[k])) return null;
  }
  if (hasFlag(seg.argv, cfg.exempt_flags)) return null;
  if (rule.requires_prod) {
    const ev = prodEvidence(seg, rule, cfg, cwd);
    if (ev) return { decision: rule.decision || 'ask', id: rule.id, cls: rule.class, why: 'production ' + ev };
    if (unresolved(seg)) return { decision: 'ask', id: rule.id, cls: rule.class, why: 'a variable in the command cannot be resolved, so production cannot be ruled out' };
    return null;
  }
  return { decision: rule.decision || 'ask', id: rule.id, cls: rule.class, why: rule.why || (rule.class === 'publish' ? 'publishing is public and cannot be undone' : 'this target is production by default') };
}

function evalRm(seg, info, cwd) {
  const b = base(seg.argv[0]);
  let targets = [];
  if (b === 'rm') {
    if (!seg.argv.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || /^--rec/.test(a))) return null; // GNU takes any unique prefix of --recursive
    targets = positionals(seg.argv);
  } else if (b === 'find') {
    if (!seg.argv.includes('-delete') && !(seg.argv.includes('-exec') && seg.argv.some((a) => base(a) === 'rm'))) return null;
    targets = [positionals(seg.argv)[0] || '.'];
  } else return null;
  const root = info && info.root ? info.root : cwd;
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k];
    if (/\$|`/.test(t)) return { decision: 'ask', id: 'blast.rm-unresolved', cls: 'blast-radius', why: 'recursive delete of "' + t + '" with an unresolved variable' };
    const abs = expandPath(t, cwd, seg.env);
    if (isInside(abs, root)) continue;
    // a home folder below a temp root (HOME=/tmp/ci in CI) is still the home folder: only its caches stay free.
    // HOME equal to a temp root (HOME=/tmp) leaves that root a temp directory.
    const inHome = (isInside(abs, HOME) || isInside(HOME, abs)) && TEMP_ROOTS().some((s) => isInside(HOME, s) && path.resolve(HOME) !== path.resolve(s));
    if (SAFE_RM_ROOTS().some((s) => isInside(abs, s) && !(inHome && TEMP_ROOTS().includes(s)))) continue;
    return { decision: 'ask', id: 'blast.rm-outside', cls: 'blast-radius', why: 'recursive delete outside the project: ' + abs };
  }
  return null;
}
// `rm` as a command word (`docker run --rm`, `terraform` stay out); `find` only with `-delete` or `-exec`
evalRm.NEEDLES = [{ cmd: 'rm' }, '-delete', '-exec'];

function evalUserForms(seg, cfg) {
  for (const f of cfg.forms || []) {
    // a literal substring of the command text, case-sensitive (since 0.4.1; a regex-looking pattern is literal too)
    // `words` (reins): the form holds only when the command, with its here-document, also has one of
    // the words as a whole word, in any case of the letters
    if (Array.isArray(f.words) && f.words.length) {
      const body = ((seg.text || seg.argv.join(' ')) + '\n' + (seg.heredoc || '')).toLowerCase();
      const has = (w) => typeof w === 'string' && new RegExp('(^|[^a-z0-9_])' + w.toLowerCase().replace(/[^a-z0-9_]/g, '') + '($|[^a-z0-9_])').test(body);
      if (!f.words.some(has)) continue;
    }
    if (typeof f.pattern === 'string' && f.pattern && (seg.text || seg.argv.join(' ')).includes(f.pattern)) return { decision: f.decision === 'deny' ? 'deny' : 'ask', id: 'user.' + (f.id || 'form'), cls: 'user', why: f.reason || 'matches your configured form' };
  }
  return null;
}
// the human's forms reach Node through their own lists (forms.js: forms/<key>.bash in the config dir), not this file
evalUserForms.NEEDLES = [];

function decideSegment(seg, cfg, info, cwd) {
  if (!seg.argv.length) return null;
  const b = base(seg.argv[0]);
  const results = [];
  if (b === 'git') results.push(git.evalGit(seg, cfg, info, cwd));
  // a dashed builtin from git's exec path (`git-update-ref`) is the same command
  else if (/^git-[a-z]/.test(b)) results.push(git.evalGit(Object.assign({}, seg, { argv: ['git', b.slice(4)].concat(seg.argv.slice(1)), vars: [seg.vars[0], false].concat(seg.vars.slice(1)) }), cfg, info, cwd));
  results.push(mcp.evalHostingCli(seg), evalRm(seg, info, cwd), data.evalScripts(seg, cfg), data.evalFastlane(seg, cfg), data.evalDb(seg, cfg), data.evalHttp(seg, cfg));
  for (const rule of cfg.rules || []) results.push(evalRule(rule, seg, cfg, cwd));
  results.push(evalUserForms(seg, cfg));
  let best = results.filter(Boolean).sort((a, z) => RANK[z.decision] - RANK[a.decision])[0] || null;
  if (!best) best = data.evalEnvFlag(seg, cfg);
  if (best) best.command = seg.text || seg.argv.join(' ');
  return best;
}

function decideCommand(command, cfg, info, cwd) {
  let best = null;
  git.resetGitBudget(); // one time budget for the git calls of this command
  for (const seg of parse(command)) {
    const r = decideSegment(seg, cfg, info, cwd);
    if (r && (!best || RANK[r.decision] > RANK[best.decision])) best = r;
  }
  // the prompt shows the whole command, and the step that triggered it when the command has several
  if (best) {
    const part = full(best.command);
    best.command = full(command);
    if (part !== best.command) best.part = part;
  }
  return best;
}

// the evaluators are exported for their NEEDLES (scripts/gen-prefilter.js, test/prefilter.test.js); the ones of
// gate-git.js, gate-data.js and gate-mcp.js are re-exported so that callers see one gate
module.exports = { decideCommand, decideSegment, decideMcp: mcp.decideMcp, grantCovers, PRODUCTION, DESTRUCTIVE_SQL: data.DESTRUCTIVE_SQL,
  evalGit: git.evalGit, evalMerge: git.evalMerge, evalHostingCli: mcp.evalHostingCli, evalDiscard: git.evalDiscard, evalRemoteRef: git.evalRemoteRef,
  evalRm, evalScripts: data.evalScripts, evalFastlane: data.evalFastlane, evalDb: data.evalDb, evalHttp: data.evalHttp, evalEnvFlag: data.evalEnvFlag, evalUserForms };
