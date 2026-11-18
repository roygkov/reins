'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/gate-git.js. The logic is unchanged.
// The gate's git rules: push to a protected branch, merge into one, local irreversible git (reset, clean, checkout,
// branch -D, …) and writes of remote-tracking refs. Each evaluator names its prefilter needles (see gate.js).
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ctxr = require('./context.cjs');
const { matchGlob } = require('./util.cjs');
const { splitArgs } = require('./gate-common.cjs');

function evalGit(seg, cfg, info, cwd) {
  const argv = seg.argv;
  let i = 1;
  const where = []; // global options that pick the repository, repeated in the gate's own read-only git calls
  const conf = []; // `-c` settings, repeated where the gate reads remote URLs
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '-c') conf.push(a, argv[i + 1], seg.vars[i + 1]);
    // a value from the environment cannot be read like `-c`: the gate's URL reads fail closed (null prefix)
    if (a === '--config-env' || a.startsWith('--config-env=')) conf.push('-c', '', true);
    if (a === '--config-env') i++;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a)) { if (a !== '-c' && a !== '--namespace') where.push(a, argv[i + 1], seg.vars[i + 1]); i++; }
    else if (/^--(git-dir|work-tree)=/.test(a)) where.push(a, null, seg.vars[i]);
    i++;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  // an alias defined in the command can hide any subcommand from the rules below
  for (let k = 0; k < conf.length; k += 3) if (/^alias\./i.test(conf[k + 1] || '')) return { decision: 'ask', id: 'git.alias', cls: 'git', why: '`-c alias.` defines a git command that the gate cannot read' };
  if (rest.includes('--no-verify') || (sub === 'commit' && rest.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) && !a.startsWith('--')))) {
    return { decision: 'ask', id: 'git.no-verify', cls: 'git', why: '--no-verify skips the repository hooks' };
  }
  const remoteRef = evalRemoteRef(sub, rest, seg, where, conf, cwd, protectedBranches(cfg, info));
  if (remoteRef) return remoteRef;
  const merge = evalMerge(sub, rest, cfg, info);
  if (merge) return merge;
  if (sub !== 'push') return evalDiscard(sub, rest, seg, where, cwd);
  const flags = rest.filter((a) => a.startsWith('-'));
  const pos = rest.filter((a) => !a.startsWith('-'));
  const force = flags.some((f) => /^(-f|--force|--force-with-lease.*|-[a-zA-Z]*f[a-zA-Z]*)$/.test(f) && !f.startsWith('--follow'));
  const mirror = flags.some((f) => f === '--mirror' || f === '--prune');
  const del = flags.some((f) => f === '--delete' || f === '-d');
  const tags = flags.some((f) => f === '--tags' || f === '--follow-tags');
  const remote = pos[0];
  const refspecs = pos.slice(1);
  if (remote && (remote === 'heroku' || ctxr.isProdName(remote, cfg.markers))) return { decision: 'ask', id: 'git.push-prod-remote', cls: 'prod-default', why: 'remote "' + remote + '" deploys on push' };
  if (mirror) return { decision: 'ask', id: 'git.push-mirror', cls: 'protected', why: '--mirror/--prune can delete remote refs' };
  // A delete of a remote ref asks when the ref is a protected branch or a tag, in both forms of the
  // command: `--delete <ref>` and the refspec `:<ref>`. A ref that is not named asks too.
  // The name is read the way git resolves it on the remote: `refs/heads/x`, `heads/x` and `x` name one
  // branch. A tag (`refs/tags/x`, `tags/x`, `v<digit>`), a ref outside refs/heads (notes, remotes) and
  // HEAD ask always: the name alone does not show that the ref is safe to delete.
  const guarded = (r) => {
    if (r === '' || /^(HEAD|@)$/.test(r)) return true;
    const explicit = /^refs\//.test(r);
    let n = explicit ? r.slice(5) : r;
    if (/^tags\//.test(n) || (explicit && !/^heads\//.test(n))) return true;
    n = n.replace(/^heads\//, '');
    return matchGlob(n, protectedBranches(cfg, info)) || /^v\d/.test(n);
  };
  if (del) {
    const hit = refspecs.find(guarded);
    if (hit !== undefined || !refspecs.length) return { decision: 'ask', id: 'git.push-delete', cls: 'protected', why: 'deletes remote ref "' + (hit || '?') + '"' };
    return null;
  }
  if (tags) return { decision: 'ask', id: 'git.push-tags', cls: 'prod-default', why: 'pushing tags usually starts a release' };
  if (flags.some((f) => f === '--all' || f === '--branches')) return { decision: 'ask', id: 'git.push-protected', cls: 'protected', why: 'git push --all pushes every local branch, protected ones too' };
  const branchNow = require('./root.cjs').currentBranch(info);
  const prot = protectedBranches(cfg, info);
  const targets = refspecs.length ? refspecs : [branchNow || ''];
  for (const r of targets) {
    const plus = r.startsWith('+');
    const s = plus ? r.slice(1) : r;
    if (s.startsWith(':')) {
      if (guarded(s.slice(1))) return { decision: 'ask', id: 'git.push-delete', cls: 'protected', why: 'refspec "' + r + '" deletes a remote ref' };
      continue;
    }
    let dst = (s.includes(':') ? s.split(':').pop() : s).replace(/^refs\/heads\//, '');
    if (/^(HEAD|@)$/.test(dst)) dst = branchNow || '';
    if (/^refs\/tags\//.test(dst) || /^v\d/.test(dst)) return { decision: 'ask', id: 'git.push-tag', cls: 'prod-default', why: 'pushing tag "' + dst + '" usually starts a release' };
    if (dst && matchGlob(dst, prot)) {
      // a push to a protected or the default branch lands work without review, like a merge (A10.04 Human Gate)
      return force || plus ? { decision: 'ask', id: 'git.force-protected', cls: 'protected', why: 'force push to protected branch "' + dst + '"' }
        : { decision: 'ask', id: 'git.push-protected', cls: 'protected', why: 'push to protected branch "' + dst + '" lands work there without a review' };
    }
  }
  return null;
}
// the git forms, as the prefilter has carried them since 0.3.5–0.3.12: `push` for every push rule, `--no-verify` and
// the `-n` cluster of `commit`, `-c alias.`
evalGit.NEEDLES = ['push', 'no-verify', 'commit.* -[a-zA-Z]*n', 'alias\\.'];
// protected_branches plus each remote's default branch (refs/remotes/<remote>/HEAD)
function protectedBranches(cfg, info) { return [...new Set((cfg.protected_branches || []).concat(require('./root.cjs').defaultBranches(info)))]; }

// `git merge` and `git pull` into a protected or the default branch (local; the push after it asks too). A merge
// of the branch's own remote-tracking ref (`origin/main` on main, `git pull` with no refspec) is a sync and passes.
function evalMerge(sub, rest, cfg, info) {
  if (sub !== 'merge' && sub !== 'pull') return null;
  if (rest.some((a) => ['--abort', '--continue', '--quit', '--skip'].includes(a))) return null;
  const branchNow = require('./root.cjs').currentBranch(info);
  if (!branchNow || !matchGlob(branchNow, protectedBranches(cfg, info))) return null;
  const p = splitArgs(rest, ['-m', '--message', '-s', '--strategy', '-X', '--strategy-option', '-F', '--file', '--into-name', '--cleanup', '-S', '--gpg-sign', '--depth', '--upstream-pack', '-o', '--server-option']).pos;
  const own = (x) => x === branchNow || x === 'refs/heads/' + branchNow || /^@\{(u|upstream)\}$/i.test(x) || new RegExp('^(refs/remotes/)?[^/]+/' + branchNow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').test(x);
  const sources = sub === 'pull' ? p.slice(1).map((x) => x.replace(/^\+/, '').split(':')[0]) : p;
  if (!sources.length || sources.every(own)) return null;
  return { decision: 'ask', id: 'git.merge-protected', cls: 'git', why: 'git ' + sub + ' of "' + sources.filter((x) => !own(x)).join(' ') + '" into protected branch "' + branchNow + '"' };
}
// `merge` as a word (`merge-base`, `mergeSort.js` stay out); `fetch` and `pull` at a word start and end
evalMerge.NEEDLES = ['(^|[^a-z_-])merge( |"|$)', '(^|[^a-z_])(fetch|pull)([ "|;&)\\\\]|$)'];

// Local irreversible git (A10.03 Checkpoint and Rollback, A10.04 Human Gate). Ask only when the command would lose
// work that no commit, ref or reflog holds: changed tracked files, untracked files, unique branch commits, stashes,
// the reflog itself. The same command on a clean tree passes: git can take it back. Read-only git calls, each with
// a short timeout; when the state cannot be read, the gate asks (fail closed).
// 0.4.4: 1 500 per call, 3 500 for all calls of one command (hook.sh and the Node start take about 0.3 s of the 5 s
// PreToolUse timeout); a call that hits it sets `gitSlow`, so the ask names the busy machine as its cause and the
// journal counts it. The suites that test the decision logic widen the budget (`setGitBudget`); one test keeps it
// narrow with a slow git on PATH.
let GIT_MS = 1500;
let GIT_TOTAL_MS = 3500;
let gitSlow = false;
const LIST_MAX = 5;
function discardAsk(form, why) { return { decision: 'ask', id: 'git.discard.' + form, cls: 'git-discard', why }; }
// the fail-closed asks: `slow` when a git call ran out of the time budget (a busy machine), so the prompt and the journal name the cause
function unknownState(form, what) { return Object.assign(discardAsk(form, what + ', and the repository state cannot be read, so lost work cannot be ruled out'), gitSlow ? { slow: true } : {}); }
function listed(files) { return files.slice(0, LIST_MAX).join(', ') + (files.length > LIST_MAX ? ', … (' + files.length + ' in all)' : ''); }
// Pairs of [-C dir | --git-dir x | --work-tree x] from the command; null when one of them is a variable.
function gitPrefix(where) {
  const out = [];
  for (let k = 0; k < where.length; k += 3) {
    if (where[k + 2]) return null;
    out.push(where[k]); if (where[k + 1] !== null && where[k + 1] !== undefined) out.push(where[k + 1]);
  }
  return out;
}
let gitUntil = 0;
function gitRead(cwd, prefix, args) {
  const left = Math.min(GIT_MS, gitUntil - Date.now());
  if (left <= 0) { gitSlow = true; return null; }
  const env = Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const r = spawnSync('git', prefix.concat(args), { cwd, encoding: 'utf8', env, timeout: left, maxBuffer: 8 << 20 });
  // spawnSync reports a timeout as ETIMEDOUT with the kill signal; a git that answers late is a busy machine, not a broken repository
  if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) gitSlow = true;
  return r.status === 0 && !r.error ? r.stdout : null;
}
// Changed tracked files (staged or not) in the given paths; null when git cannot tell.
function changedTracked(cwd, prefix, paths) {
  const out = gitRead(cwd, prefix, ['status', '--porcelain', '--untracked-files=no', '--'].concat(paths));
  return out === null ? null : out.split('\n').filter(Boolean).map((l) => l.slice(3));
}
// Short clusters: `-fdx` holds f, d and x.
function shortHas(args, ch) { return args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.slice(1).includes(ch)); }

function evalDiscard(sub, rest, seg, where, cwd) {
  const FORMS = { reset: 1, clean: 1, checkout: 1, switch: 1, restore: 1, branch: 1, stash: 1, worktree: 1, 'update-ref': 1, reflog: 1, gc: 1, prune: 1 };
  if (!FORMS[sub]) return null;
  const prefix = gitPrefix(where);
  const has = (...f) => rest.some((a) => f.includes(a) || f.some((x) => x.startsWith('--') && a.startsWith(x + '=')));
  if (!gitUntil) gitUntil = Date.now() + GIT_TOTAL_MS;
  // a path or branch name from a variable or `$(...)` cannot be checked: the loss cannot be ruled out
  const restVars = seg.vars.slice(seg.argv.length - rest.length).some(Boolean);
  const base0 = cwd || process.cwd();
  // forms that are always lost work: no dirty check can make them safe
  if (sub === 'stash') {
    const p = splitArgs(rest, ['-m', '--message']).pos;
    if (p[0] === 'drop' || p[0] === 'clear') return discardAsk('stash', 'git stash ' + p[0] + ' deletes stashed changes that no commit holds');
    return null;
  }
  if (sub === 'update-ref') return has('-d', '--delete') ? discardAsk('ref', 'git update-ref -d deletes a ref; commits only it reaches are then lost') : null;
  if (sub === 'reflog') {
    const p = splitArgs(rest, []).pos;
    return p[0] === 'expire' || p[0] === 'delete' ? discardAsk('reflog', 'git reflog ' + p[0] + ' removes the history that undoes a reset or a deleted branch') : null;
  }
  if (sub === 'gc') return rest.some((a) => /^--prune=(now|all)$/.test(a)) ? discardAsk('reflog', 'git gc ' + rest.find((a) => a.startsWith('--prune=')) + ' deletes unreachable commits at once, the last copy of reset or deleted work') : null;
  if (sub === 'prune') return has('-n', '--dry-run') ? null : discardAsk('reflog', 'git prune deletes unreachable objects, the last copy of reset or deleted work');
  const what = { reset: 'git reset', clean: 'git clean', checkout: 'git checkout', switch: 'git switch', restore: 'git restore', branch: 'git branch -D', worktree: 'git worktree remove --force' }[sub];
  const form = { switch: 'checkout' }[sub] || sub;
  if (restVars && ['clean', 'checkout', 'restore', 'branch', 'worktree'].includes(sub)) return unknownState(form, what + ' with a path or name from a variable');
  const tracked = (paths, verb) => {
    const files = prefix && changedTracked(base0, prefix, paths);
    if (!files) return unknownState(form, what + ' ' + verb);
    return files.length ? discardAsk(form, what + ' ' + verb + ': uncommitted changes in ' + files.length + ' tracked file(s) are lost (' + listed(files) + ')') : null;
  };
  if (sub === 'reset') return has('--hard', '--merge') ? tracked([], 'overwrites the working tree') : null;
  if (sub === 'clean') {
    if (has('-i', '--interactive') || has('-n', '--dry-run') || shortHas(rest, 'n')) return null;
    if (!has('--force') && !shortHas(rest, 'f')) return null; // without -f git refuses (clean.requireForce)
    // the same command as a dry run lists what it would delete
    const dry = ['clean', '-n'].concat(rest.filter((a) => a !== '--force').map((a) => (/^-[a-zA-Z]+$/.test(a) ? '-' + a.slice(1).replace(/f/g, '') : a)).filter((a) => a !== '-'));
    const out = prefix && gitRead(base0, prefix, dry);
    if (out === null || out === undefined || prefix === null) return unknownState('clean', 'git clean deletes untracked files');
    const files = out.split('\n').filter(Boolean).map((l) => l.replace(/^Would (remove|skip repository) /, ''));
    return files.length ? discardAsk('clean', 'git clean deletes ' + files.length + ' untracked file(s) that git cannot restore (' + listed(files) + ')') : null;
  }
  if (sub === 'checkout' || sub === 'switch') {
    if (has('-p', '--patch')) return null;
    if (has('--pathspec-from-file')) return unknownState('checkout', what + ' overwrites paths listed in a file');
    if (has('-f', '--force', '--discard-changes') || shortHas(rest, 'f')) return tracked([], 'with --force drops local changes');
    if (sub === 'switch') return null;
    const s = splitArgs(rest, ['-b', '-B', '--orphan', '--conflict']);
    if (has('-b', '-B', '--orphan') && !s.dashdash) return null;
    // without `--`, a word may be a branch or a path: git status on it is empty for a branch
    const paths = s.dashdash ? s.paths : s.pos;
    // `--` with no paths: they come from elsewhere (`xargs git checkout --`)
    if (s.dashdash && !paths.length) return unknownState('checkout', 'git checkout -- with paths from input');
    return paths.length ? tracked(paths, 'overwrites files with the committed version') : null;
  }
  if (sub === 'restore') {
    if (has('-p', '--patch')) return null;
    if (has('--pathspec-from-file')) return unknownState('restore', 'git restore overwrites paths listed in a file');
    const staged = has('--staged') || shortHas(rest, 'S');
    const worktree = has('--worktree') || shortHas(rest, 'W');
    if (staged && !worktree) return null; // only the index: the files keep their content
    const s = splitArgs(rest, ['-s', '--source']);
    const paths = s.pos.concat(s.paths);
    if (!paths.length) return unknownState('restore', 'git restore with paths from input');
    return tracked(paths, 'overwrites files with the committed version');
  }
  if (sub === 'branch') {
    const del = has('-D') || shortHas(rest, 'D') || ((has('-d', '--delete') || shortHas(rest, 'd')) && (has('-f', '--force') || shortHas(rest, 'f')));
    if (!del || has('-r', '--remotes') || shortHas(rest, 'r')) return null;
    const names = splitArgs(rest, []).pos;
    if (!prefix || !names.length) return unknownState('branch', 'git branch -D deletes branches');
    const lost = [];
    for (const n of names) {
      // commits on this branch that no other branch, remote-tracking ref or tag reaches
      const out = gitRead(base0, prefix, ['rev-list', '-n', '1', 'refs/heads/' + n, '--not', '--exclude=' + n, '--branches', '--remotes', '--tags']);
      if (out === null) return unknownState('branch', 'git branch -D deletes "' + n + '"');
      if (out.trim()) lost.push(n);
    }
    return lost.length ? discardAsk('branch', 'git branch -D deletes ' + listed(lost) + ' with commits that are on no other branch, remote or tag') : null;
  }
  if (sub === 'worktree') {
    const s = splitArgs(rest, []);
    if (s.pos[0] !== 'remove' || !(has('-f', '--force') || shortHas(rest, 'f'))) return null; // without --force git refuses a dirty worktree
    const target = s.pos[1];
    if (!target || !prefix || /\$|`/.test(target)) return unknownState('worktree', 'git worktree remove --force deletes a working tree');
    let dir = base0;
    for (let k = 0; k < prefix.length; k++) if (prefix[k] === '-C') dir = path.resolve(dir, prefix[++k]);
    const out = gitRead(path.resolve(dir, target), [], ['status', '--porcelain']);
    if (out === null) return unknownState('worktree', 'git worktree remove --force deletes "' + target + '"');
    const files = out.split('\n').filter(Boolean).map((l) => l.slice(3));
    return files.length ? discardAsk('worktree', 'git worktree remove --force deletes "' + target + '" with ' + files.length + ' uncommitted or untracked file(s) (' + listed(files) + ')') : null;
  }
  return null;
}
// the discard forms; `git checkout <word>` reaches Node only when the word has `/` or `.`, so `git checkout main` stays out
evalDiscard.NEEDLES = ['reset .*--(hard|merge)', 'clean +-', 'checkout +[^- "|;&]*[./]', 'checkout [^|;&]*( --( |"|$)| \\.( |"|$)| -[a-z]*f)',
  'checkout +(-f|--force|--|-p|--patch|--ours|--theirs|-m|--merge)( |"|$)', 'switch [^|;&]*(--discard-changes|--force|-f)( |"|$)', 'restore( |"|$)',
  'branch [^|;&]*(-d|--delete)', 'stash +(drop|clear)', 'worktree +remove', 'update-ref', 'reflog +(expire|delete)', '(^|[ "])prune( |"|$)', 'gc .*--prune=', 'pathspec-from-file'];

// Remote-tracking refs (A10.04 Human Gate). Stop leaves out of the agent's change the files that came with HEAD moving
// through history, and only when a remote-tracking ref already holds every new commit (tree.fromHistory). So the agent
// may not write such a ref itself: update-ref or symbolic-ref on refs/remotes, refs read from input (update-ref
// --stdin, fast-import, send-pack), a fetch from a local source (a path, file://, a remote with such a URL, a loopback
// host) that updates refs/remotes, and a push into a local repository there. Fetch and push with a network remote
// stay silent. URLs are read the way git expands them (`insteadOf`, `-c`); when they cannot be read, the gate asks.
const FULL_REMOTE = /^refs\/+remotes\//i; // case-insensitive file systems store refs/Remotes/x in refs/remotes/x
const FETCH_REMOTE = /^(refs\/+)?remotes\//i; // a fetch destination `remotes/x` is refs/remotes/x
const FETCH_VALUE = ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--negotiation-tip', '-o', '--server-option', '--filter', '--refmap', '--upload-pack', '--recurse-submodules-default', '--submodule-prefix', '-s', '--strategy', '-X', '--strategy-option', '--cleanup'];
const PUSH_VALUE = ['--repo', '--receive-pack', '--exec', '-o', '--push-option'];
function remoteRefAsk(form, why) { return { decision: 'ask', id: 'git.remote-ref.' + form, cls: 'git', why: why + '; Stop counts commits on a remote-tracking ref as history, not as the agent\'s change' }; }
function loopback(host) {
  let h = host.replace(/^.*@/, '');
  h = h.startsWith('[') ? h.slice(1, h.includes(']') ? h.indexOf(']') : undefined) : h.replace(/:\d*$/, '');
  h = h.toLowerCase().replace(/\.$/, '');
  const v6 = ipv6(h);
  if (v6) return (v6.slice(0, 7).every((x) => x === 0) && v6[7] <= 1) || (v6.slice(0, 5).every((x) => x === 0) && v6[5] === 0xffff && v6[6] >> 8 === 127);
  return h === 'localhost' || h.endsWith('.localhost') || loopbackV4(h) || h === os.hostname().toLowerCase();
}
// An IPv6 literal as 8 numbers (a trailing dotted IPv4 counts as two), or null.
function ipv6(h) {
  if (!h.includes(':') || !/^[0-9a-f:.]+$/.test(h)) return null;
  let tail = [];
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (m) { const q = m[2].split('.').map(Number); tail = [q[0] * 256 + q[1], q[2] * 256 + q[3]]; h = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1); }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const num = (x) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const left = num(halves[0]), right = num(halves[1]).concat(tail);
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0) || left.concat(right).some((x) => !(x >= 0 && x <= 0xffff))) return null;
  return left.concat(Array(halves.length === 2 ? fill : 0).fill(0), right);
}
// IPv4 in any form the resolver takes (`127.1`, `2130706433`, `0x7f.0.0.1`, `0177.1`, `0`): 127/8 or 0.0.0.0
function loopbackV4(h) {
  const parts = h.split('.');
  if (parts.length > 4 || !parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/.test(p))) return false;
  const n = parts.map((p) => (p.startsWith('0x') ? parseInt(p, 16) : p.length > 1 && p[0] === '0' ? parseInt(p, 8) : parseInt(p, 10)));
  const first = parts.length === 1 ? Math.floor(n[0] / 16777216) : n[0];
  return first === 127 || n.every((x) => x === 0);
}
// git's rule: `scheme://` is a URL, `helper::address` a remote helper, `host:path` (no `/` before the `:`) is ssh,
// anything else is a local path. `ext::` and `fd::` run or read locally.
function localUrl(u) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(u);
  if (m) return m[1].toLowerCase() === 'file' || loopback(m[2]);
  const helper = /^([a-z][a-z0-9+.-]*)::/i.exec(u);
  if (helper) return ['ext', 'fd'].includes(helper[1].toLowerCase());
  const scp = /^((?:[^@/:]*@)?(?:\[[^\]/]*\]|[^/:]{2,})):/.exec(u); // one letter before `:` is a drive
  return scp ? loopback(scp[1]) : true;
}
// `git config -z -l`: remote names, groups and the settings the gate needs, with `-c` applied.
function readGitConfig(base0, prefix) {
  const out = prefix && gitRead(base0, prefix, ['config', '-z', '-l']);
  if (out === null || out === undefined) return null;
  const vals = new Map(), remotes = new Set(), withUrl = new Set();
  for (const e of out.split('\0').filter(Boolean)) {
    const nl = e.indexOf('\n');
    const key = nl < 0 ? e : e.slice(0, nl), val = nl < 0 ? '' : e.slice(nl + 1);
    const a = key.indexOf('.'), z = key.lastIndexOf('.');
    const k = key.slice(0, a).toLowerCase() + key.slice(a, z + 1) + key.slice(z + 1).toLowerCase();
    if (!vals.has(k)) vals.set(k, []);
    vals.get(k).push(val);
    // git takes any `remote.<name>.*` (a `fetch` line alone too) as a remote; with no `url` the name is the URL
    if (key.slice(0, a).toLowerCase() === 'remote' && z > a) {
      remotes.add(key.slice(a + 1, z));
      if (key.slice(z + 1).toLowerCase() === 'url') withUrl.add(key.slice(a + 1, z));
    }
  }
  const get = (k) => (vals.get(k) || []).slice(-1)[0];
  return { remotes, withUrl, get, all: (k) => vals.get(k) || [] };
}

// A fetch refspec `src:dst` whose dst is a protected branch's remote-tracking ref and whose src is another branch.
function crossProtected(spec, prot) {
  const t = spec.replace(/^\+/, '');
  const i = t.indexOf(':');
  if (i < 0) return false;
  const m = /^(?:refs\/+)?remotes\/+[^/]+\/+(.+)$/i.exec(t.slice(i + 1));
  if (!m) return false;
  const src = t.slice(0, i).replace(/^refs\/+heads\/+/i, ''), dst = m[1];
  // a pattern may reach a protected name: only the plain mirror (`refs/heads/*:refs/remotes/<r>/*`) passes
  if (src === dst) return false;
  if (!dst.includes('*')) return matchGlob(dst, prot);
  // `pr/*` cannot give `main`; an empty prefix or one a protected name or pattern starts with can
  const pre = dst.slice(0, dst.indexOf('*'));
  return prot.some((p) => { const lit = p.split('*')[0]; return p.startsWith(pre) || pre.startsWith(lit) && (p.includes('*') || p === pre); });
}

function evalRemoteRef(sub, rest, seg, where, conf, cwd, prot) {
  const off = seg.argv.length - rest.length;
  const has = (...f) => rest.some((a) => f.includes(a) || f.some((x) => x.startsWith('--') && a.startsWith(x + '=')));
  const optValues = (opt) => rest.flatMap((a, k) => (a === opt ? [{ a: rest[k + 1] || '', v: !!seg.vars[off + k + 1] }] : a.startsWith(opt + '=') ? [{ a: a.slice(opt.length + 1), v: !!seg.vars[off + k] }] : []));
  // positionals, each with whether it comes from a variable; `valueOpts` take the next word
  const words = (valueOpts) => {
    const out = [];
    let dd = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (!dd && a === '--') { dd = true; continue; }
      if (!dd && valueOpts.includes(a)) { k++; continue; }
      if (!dd && a.startsWith('-')) continue;
      out.push({ a, v: !!seg.vars[off + k] });
    }
    return out;
  };
  if (sub === 'update-ref') {
    if (has('--stdin')) return remoteRefAsk('update-ref', 'git update-ref --stdin writes refs read from input');
    if (has('-d', '--delete')) return null; // the discard rule covers a delete
    const ref = words(['-m'])[0];
    if (ref && ref.v) return remoteRefAsk('update-ref', 'git update-ref writes a ref named by a variable');
    return ref && FULL_REMOTE.test(ref.a) ? remoteRefAsk('update-ref', 'git update-ref writes remote-tracking ref "' + ref.a + '"') : null;
  }
  if (sub === 'symbolic-ref') {
    if (has('-d', '--delete')) return null;
    const w = words(['-m']);
    if (w.length < 2) return null; // a read
    if (w[0].v || w[1].v) return remoteRefAsk('symbolic-ref', 'git symbolic-ref with a ref named by a variable');
    if (FULL_REMOTE.test(w[0].a)) return remoteRefAsk('symbolic-ref', 'git symbolic-ref makes remote-tracking ref "' + w[0].a + '"');
    return FULL_REMOTE.test(w[1].a) ? remoteRefAsk('symbolic-ref', 'git symbolic-ref points "' + w[0].a + '" at remote-tracking ref "' + w[1].a + '", so commits on it write that ref') : null;
  }
  if (sub === 'fast-import') return remoteRefAsk('fast-import', 'git fast-import writes refs read from input');
  if (sub === 'send-pack') return remoteRefAsk('send-pack', 'git send-pack writes refs into a repository');
  if (sub === 'receive-pack') return remoteRefAsk('receive-pack', 'git receive-pack writes refs read from input');
  if (sub === 'filter-branch') return remoteRefAsk('filter-branch', 'git filter-branch rewrites the refs it is given, remote-tracking ones too');
  if (!['fetch', 'pull', 'push', 'remote'].includes(sub)) return null;
  if (sub === 'remote') {
    const w = words(['-t', '--track', '-m', '--master']);
    // `set-head <remote> <branch>` names the default branch that Stop and the gate take as protected
    if (w[0] && w[0].a === 'set-head' && has('-d', '--delete')) return remoteRefAsk('set-head', 'git remote set-head -d removes the default branch of "' + (w[1] ? w[1].a : '?') + '", so it is no longer protected');
    if (w[0] && ['remove', 'rm', 'rename'].includes(w[0].a)) return remoteRefAsk('remote', 'git remote ' + w[0].a + ' drops the remote-tracking refs and default branch of "' + (w[1] ? w[1].a : '?') + '"');
    if (w[0] && w[0].a === 'set-head' && !has('-a', '--auto') && w[2]) return remoteRefAsk('set-head', 'git remote set-head makes "' + w[2].a + '" the default branch of "' + w[1].a + '"');
    if (!w[0] || !['add', 'update'].includes(w[0].a) || (w[0].a === 'add' && !has('-f', '--fetch'))) return null;
  }
  if (!gitUntil) gitUntil = Date.now() + GIT_TOTAL_MS;
  const base0 = cwd || process.cwd();
  // the gate's reads run in this repository with this config; the command's environment may pick others
  const moved = Object.keys(seg.env || {}).some((k) => /^GIT_(DIR|WORK_TREE|COMMON_DIR|NAMESPACE|CONFIG.*)$/.test(k));
  const prefix = moved ? null : gitPrefix(where.concat(conf));
  const unknown = (what) => Object.assign(remoteRefAsk(sub, what + ', and the repository config cannot be read, so a local source cannot be ruled out'), gitSlow ? { slow: true } : {});
  const c = readGitConfig(base0, prefix);
  if (!c) return unknown('git ' + sub);
  const url = (name, push) => {
    // a configured remote: every URL it has (`-c` adds one); a bare path or URL: as git expands it
    const args = c.withUrl.has(name) ? ['remote', 'get-url', '--all'].concat(push ? ['--push'] : [], [name]) : ['ls-remote', '--get-url', name];
    const out = prefix && gitRead(base0, prefix, args);
    return out === null || out === undefined ? null : out.split('\n').filter(Boolean);
  };
  const branch = () => { const b = prefix && gitRead(base0, prefix, ['symbolic-ref', '-q', '--short', 'HEAD']); return b ? b.trim() : ''; };
  // fetch destinations: a refspec `src:dst` with dst in refs/remotes, or one from a variable
  const fetchDst = (s) => s.v || FETCH_REMOTE.test(s.a.replace(/^\+/, '').split(':').slice(1).join(':'));
  if (sub === 'push') {
    const repo = optValues('--repo');
    const w = words(PUSH_VALUE);
    const b = branch();
    const target = repo.length ? repo[repo.length - 1] : w[0] || { a: c.get('branch.' + b + '.pushremote') || c.get('remote.pushdefault') || c.get('branch.' + b + '.remote') || 'origin', v: false };
    if (target.v) return remoteRefAsk('push', 'git push to a repository named by a variable');
    let specs = repo.length ? w : w.slice(1);
    if (!specs.length) specs = c.all('remote.' + target.a + '.push').map((a) => ({ a, v: false }));
    // a configured remote's tracking refs follow every push to it; into another local repository, a destination in
    // refs/remotes, a short one (resolved against the target's refs, remote-tracking ones too), or a source with no
    // destination that is a remote-tracking ref here (its full name is the destination)
    const configured = c.remotes.has(target.a);
    const urls = url(target.a, true);
    if (!urls) return unknown('git push to "' + target.a + '"');
    if (!urls.some(localUrl)) return null;
    if (configured) return remoteRefAsk('push', 'git push to remote "' + target.a + '" with a local URL updates its remote-tracking refs');
    const full = (src) => { const o = prefix && gitRead(base0, prefix, ['rev-parse', '--symbolic-full-name', src]); return o ? o.trim() : ''; };
    const bad = specs.find((s) => {
      if (s.v || s.a.includes('*')) return true; // a pattern (`refs/*:refs/*`) may copy remote-tracking refs
      const t = s.a.replace(/^\+/, '');
      const i = t.indexOf(':');
      if (i < 0) return FULL_REMOTE.test(t) || FULL_REMOTE.test(full(t)); // a source git cannot resolve fails the push
      const dst = t.slice(i + 1);
      return dst !== '' && (FULL_REMOTE.test(dst) || !/^refs\//i.test(dst));
    });
    return bad ? remoteRefAsk('push', 'git push into local repository "' + target.a + '" with "' + bad.a + '" may write a remote-tracking ref') : null;
  }
  let names, specs = [], maps = [], stdin = false;
  if (sub === 'remote') {
    const w = words(['-t', '--track', '-m', '--master']);
    if (w[0].a === 'add') {
      const u = w[2];
      if (!u) return null;
      if (u.v) return remoteRefAsk('remote', 'git remote add -f fetches from a URL named by a variable');
      const urls = url(u.a);
      if (!urls) return unknown('git remote add -f');
      return urls.some(localUrl) ? remoteRefAsk('remote', 'git remote add -f "' + w[1].a + '" fetches a local repository into refs/remotes/' + w[1].a) : null;
    }
    names = w.length > 1 ? w.slice(1) : null; // `remote update` with no names: every remote
  } else {
    const w = words(FETCH_VALUE);
    maps = optValues('--refmap');
    stdin = sub === 'fetch' && has('--stdin');
    if (has('--all')) names = null;
    else if (sub === 'fetch' && has('--multiple')) names = w;
    else {
      const b = branch();
      names = [w[0] || { a: c.get('branch.' + b + '.remote') || 'origin', v: false }];
      specs = w.slice(1);
    }
  }
  if (!names) names = [...c.remotes].map((a) => ({ a, v: false }));
  const sources = names.flatMap((n) => (!n.v && !c.remotes.has(n.a) && c.get('remotes.' + n.a.toLowerCase()) !== undefined ? c.all('remotes.' + n.a.toLowerCase()).join(' ').split(/\s+/).filter(Boolean).map((a) => ({ a, v: false })) : [n]));
  const writes = stdin || specs.some(fetchDst) || maps.some(fetchDst);
  // Stop takes a protected branch's remote-tracking ref as history (tree.fromBase), so it may be fed only from the
  // branch of the same name, from any URL: `feature/x:refs/remotes/origin/main` asks, on the command line or in a
  // configured `remote.<name>.fetch` (git applies those to explicit refspecs too)
  const configured = sources.filter((s) => !s.v && c.remotes.has(s.a)).flatMap((s) => c.all('remote.' + s.a + '.fetch').map((a) => ({ a, v: false })));
  if (stdin) return remoteRefAsk(sub, 'git fetch --stdin writes refs read from input');
  const crossed = specs.concat(maps, configured).find((s) => !s.v && crossProtected(s.a, prot));
  if (crossed) return remoteRefAsk(sub, 'git ' + sub + ' with "' + crossed.a + '" writes a protected branch\'s remote-tracking ref from another branch');
  for (const s of sources) {
    if (s.v) return remoteRefAsk(sub, 'git ' + sub + ' from a source named by a variable');
    // a configured remote updates its remote-tracking refs on every fetch; a bare path or URL only with a destination
    if (!writes && !c.remotes.has(s.a)) continue;
    const urls = url(s.a);
    if (!urls) return unknown('git ' + sub + ' from "' + s.a + '"');
    if (urls.some(localUrl)) return remoteRefAsk(sub, 'git ' + sub + ' from local repository "' + s.a + '" writes remote-tracking refs');
  }
  return null;
}
// every subcommand that can write a remote-tracking ref; `git remote -v` and `git remote prune` stay out
evalRemoteRef.NEEDLES = ['update-ref', 'symbolic-ref', 'fast-import', 'send-pack', 'receive-pack', 'filter-branch', '(^|[^a-z_])(fetch|pull)([ "|;&)\\\\]|$)',
  'remote +[^|;&]*(add|update|set-head|remove|rm|rename)', 'push'];

// decideCommand (gate.js) resets the time budget of the gate's git calls once per command
function resetGitBudget() { gitUntil = 0; gitSlow = false; }
// tests only (in-process): the decision suites widen the budget so a loaded machine does not change a decision;
// returns the budget before, so a test can put it back
function setGitBudget(b) {
  const before = { perCall: GIT_MS, total: GIT_TOTAL_MS };
  if (b && b.perCall) GIT_MS = b.perCall;
  if (b && b.total) GIT_TOTAL_MS = b.total;
  return before;
}

module.exports = { evalGit, evalMerge, evalDiscard, evalRemoteRef, protectedBranches, resetGitBudget, setGitBudget };
