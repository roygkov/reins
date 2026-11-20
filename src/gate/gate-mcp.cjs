'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/gate-mcp.js. The logic is unchanged.
// The gate's hosting and MCP rules: gh and glab (merges, api writes), MCP tools on production servers, GitHub and
// GitLab MCP servers and the desktop app's PR tools. The gh/glab rules live here with the MCP hosting rules because
// both apply the one hosting policy (a merge, an auto-merge, a repository delete or a write to a protected branch
// is `protected`; any other write is `hosting`; reads pass).
const { base } = require('./tokenize.cjs');
const ctxr = require('./context.cjs');
const { matchGlob } = require('./util.cjs');
const { positionals, matchSub, short, splitArgs } = require('./gate-common.cjs');
const { protectedBranches } = require('./gate-git.cjs');
const { DESTRUCTIVE_SQL } = require('./gate-data.cjs');

// gh and glab: merges, and `api` calls with a write method (A10.04 Human Gate). Reads pass.
const API_WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];
function evalHostingCli(seg) {
  const b = base(seg.argv[0]);
  if (b !== 'gh' && b !== 'glab') return null;
  const pos = positionals(seg.argv);
  // The words of a write stand anywhere among the positionals: a value of a flag is a positional too, so
  // a window of the first words would let `gh --repo a --hostname b -R c --foo d pr comment` pass.
  const has = (seqs) => matchSub(pos, seqs, true);
  if (has([['pr', 'merge'], ['mr', 'merge']])) return { decision: 'ask', id: 'hosting.merge', cls: 'protected', why: b + ' merges a pull request into its base branch' };
  // a comment, a review or a note is a text that other people read; `mr comment` is the other name of `mr note`
  if (has([['pr', 'comment'], ['pr', 'review'], ['issue', 'comment'], ['mr', 'note'], ['mr', 'comment'], ['issue', 'note']])) return { decision: 'ask', id: 'hosting.comment', cls: 'hosting', why: b + ' writes a text that other people read in the hosting' };
  // a change of the state with a comment writes the comment: `gh pr close 1 --comment text`, `gh issue reopen 1
  // -c text`; the letter `c` stands at any place of a group of short flags (`-dc text`, `-ctext`)
  if (has([['pr', 'close'], ['issue', 'close'], ['pr', 'reopen'], ['issue', 'reopen']]) && seg.argv.some((a) => a === '--comment' || a.startsWith('--comment=') || /^-[a-zA-Z]*c/.test(a))) return { decision: 'ask', id: 'hosting.comment', cls: 'hosting', why: b + ' writes a text that other people read in the hosting' };
  // a change of a pull request, merge request or issue changes a record that other people read: its title,
  // its text, its labels, its reviewers
  if (has([['pr', 'edit'], ['issue', 'edit'], ['mr', 'update'], ['issue', 'update'], ['issue', 'transfer']])) return { decision: 'ask', id: 'hosting.edit', cls: 'hosting', why: b + ' changes a record that other people read in the hosting' };
  // a delete of a pull request, merge request or issue takes away a record that other people read, for ever
  if (has([['pr', 'delete'], ['mr', 'delete'], ['issue', 'delete']])) return { decision: 'ask', id: 'hosting.delete', cls: 'protected', why: b + ' deletes a record that other people read in the hosting' };
  // an approval of a merge request, or its withdrawal, is a decision that other people act on
  if (has([['mr', 'approve'], ['mr', 'revoke']])) return { decision: 'ask', id: 'hosting.approve', cls: 'hosting', why: b + ' approves a merge request or takes the approval back' };
  // a new pull request, merge request or issue is a record that other people read and act on; `new` is the
  // other name of `create`, and `mr for <issue>` creates a merge request for an issue
  if (has([['pr', 'create'], ['pr', 'new'], ['mr', 'create'], ['mr', 'new'], ['mr', 'for'], ['issue', 'create'], ['issue', 'new']])) return { decision: 'ask', id: 'hosting.create', cls: 'hosting', why: b + ' creates a record that other people read in the hosting' };
  // an alias gives a write command another name: the rules above read the words of the command, not of the alias
  if (has([['alias', 'set'], ['alias', 'import']])) return { decision: 'ask', id: 'hosting.alias', cls: 'hosting', why: b + ' alias gives a command another name that the rules of the hosting do not read' };
  const k = seg.argv.indexOf('api');
  if (k < 0 || k > 3) return null;
  const argv = seg.argv.slice(k);
  let method = ctxr.flagValue(argv, ['-X', '--method']);
  const attached = argv.find((a) => /^-X[A-Za-z]/.test(a)); // pflag takes `-XDELETE`, `-ftitle=x`
  if (!method && attached) method = attached.slice(2);
  if (!method && argv.some((a) => API_WRITE_FLAGS.includes(a) || /^-[fF]./.test(a) || API_WRITE_FLAGS.some((f) => f.startsWith('--') && a.startsWith(f + '=')))) method = 'POST';
  if (!method || /^(GET|HEAD)$/i.test(method)) return null;
  const endpoint = splitArgs(argv.slice(1), ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache', '-R', '--repo']).pos[0] || '';
  if (endpoint === 'graphql') {
    // a query from a file or stdin cannot be read: it may be a mutation
    const hidden = argv.some((a, j) => a === '--input' || a.startsWith('--input=') || /=@/.test(a) || (/^-[fF]$|^--(raw-)?field$/.test(argv[j - 1] || '') && /=@/.test(a)));
    if (!hidden && !/\bmutation\b/i.test(seg.argv.join(' ') + '\n' + (seg.heredoc || ''))) return null;
    return { decision: 'ask', id: 'hosting.api-write', cls: /merge|delete|update[A-Z]?ref|createCommitOnBranch/i.test(seg.argv.join(' ')) ? 'protected' : 'hosting', why: b + ' api graphql mutation writes to the hosting' };
  }
  const prot = /^DELETE$/i.test(method) || /(^|\/)(merges?|git\/refs|contents)(\/|$)/i.test(endpoint);
  return { decision: 'ask', id: 'hosting.api-write', cls: prot ? 'protected' : 'hosting', why: b + ' api ' + method.toUpperCase() + ' ' + short(endpoint) + ' writes to the hosting' };
}
// `gh pr view` stays out of Node; a merge, a create, a comment or an `api` call goes in (the release and repo rules are data)
evalHostingCli.NEEDLES = [{ cmd: ['gh', 'glab'], sub: 'merge' }, { cmd: ['gh', 'glab'], sub: 'api' }, { cmd: ['gh', 'glab'], sub: 'comment' }, { cmd: ['gh', 'glab'], sub: 'review' }, { cmd: ['gh', 'glab'], sub: 'note' }, { cmd: ['gh', 'glab'], sub: 'create' }, { cmd: ['gh', 'glab'], sub: 'new' }, { cmd: ['gh', 'glab'], sub: 'for' }, { cmd: ['gh', 'glab'], sub: 'alias' }, { cmd: ['gh', 'glab'], sub: 'close' }, { cmd: ['gh', 'glab'], sub: 'reopen' }, { cmd: ['gh', 'glab'], sub: 'edit' }, { cmd: ['gh', 'glab'], sub: 'update' }, { cmd: ['gh', 'glab'], sub: 'approve' }, { cmd: ['gh', 'glab'], sub: 'revoke' }, { cmd: ['gh', 'glab'], sub: 'delete' }, { cmd: ['gh', 'glab'], sub: 'transfer' }];

const MCP_DENY = /^(drop|delete[-_]?many|deletemany|drop[-_]?(database|collection|table|index)|rename[-_]?collection|truncate)/i;
const MCP_ASK = /^(insert|update|delete|create|replace|bulk|write|put|set|upsert|patch|remove|move|rename|import|restore)/i;
const MCP_SQLISH = /^(execute|exec|run|query|sql|aggregate|command|eval)/i;
// Hosting servers (GitHub, GitLab by name; the desktop app's PR tools). A read passes; a write asks; a write that
// lands on a protected or the default branch, a merge, an auto-merge and a repository delete ask one by one.
// The shell prefilter in hook.sh uses the same server and read patterns.
const HOSTING_SERVER = /git(hub|lab)/i;
const HOSTING_READ = /^((get|list|search)[-_].*|.*[-_]read)$/i;
const HOSTING_DELETE_REPO = /delete[-_](repository|repo|project)$/i;
const HOSTING_MERGE = /^(merge|accept[-_]merge)([-_]|$)/i;
const HOSTING_REF_WRITE = /^(push[-_]files|create[-_]or[-_]update[-_]files?|delete[-_](file|branch)|update[-_](ref|file)|create[-_]commit|commit[-_]files?)$/i;
const AUTO_MERGE_KEYS = ['auto_merge', 'automerge', 'autoMerge', 'merge_when_pipeline_succeeds', 'auto_merge_enabled'];
function decideHosting(server, tool, input, cfg, info) {
  const ask = (cls, why) => ({ decision: 'ask', id: cls === 'protected' ? 'mcp.hosting-protected' : 'mcp.hosting-write', cls, why });
  if (server === 'ccd_pr') return tool === 'set_auto_merge' && input.enabled !== false ? ask('protected', 'auto-merge lands the pull request without another look') : null;
  if (!HOSTING_SERVER.test(server)) return null;
  if (HOSTING_READ.test(tool)) return null;
  if (HOSTING_DELETE_REPO.test(tool)) return ask('protected', '"' + tool + '" deletes a repository on "' + server + '"');
  if (HOSTING_MERGE.test(tool) && !/branch/i.test(tool)) return ask('protected', '"' + tool + '" merges into the base branch on "' + server + '"');
  if (/auto[-_]?merge/i.test(tool) || AUTO_MERGE_KEYS.some((k) => input[k] === true || input[k] === 'true')) return ask('protected', '"' + tool + '" turns on auto-merge on "' + server + '"');
  if (HOSTING_REF_WRITE.test(tool)) {
    // with no branch the API writes the repository's default branch
    const br = String(input.branch || input.branch_name || input.ref || '').replace(/^refs\/heads\//, '');
    if (!br || matchGlob(br, protectedBranches(cfg, info))) return ask('protected', '"' + tool + '" writes ' + (br ? 'protected branch "' + br + '"' : 'the default branch') + ' on "' + server + '"');
  }
  return ask('hosting', 'write "' + tool + '" on hosting server "' + server + '"');
}
function evalMcpForms(toolName, cfg) {
  const f = (cfg.forms || []).find((x) => x && x.tool && x.tool === toolName);
  return f ? { decision: f.decision === 'deny' ? 'deny' : 'ask', id: 'user.' + (f.id || 'form'), cls: 'user', why: f.reason || 'matches your configured form' } : null;
}
function decideMcp(toolName, toolInput, cfg, info) {
  const m = /^mcp__(.+)__([^_].*)$/.exec(toolName || '');
  if (!m) return null;
  const server = m[1], tool = m[2];
  const own = evalMcpForms(toolName, cfg);
  if (own && own.decision === 'deny') return Object.assign(own, { command: toolName });
  const host = decideHosting(server, tool, toolInput || {}, cfg, info);
  // a hosting server that is also production: the production rule wins unless the hosting one is `protected`
  const prod = host && host.cls === 'protected' ? null : decideProdMcp(server, tool, toolInput, cfg, toolName);
  if (prod || host || own) return Object.assign(prod || host || own, { command: toolName });
  return null;
}
function decideProdMcp(server, tool, toolInput, cfg, toolName) {
  const listed = (cfg.mcp_prod_servers || []).some((s) => server === s || server.endsWith('__' + s) || server.includes(s));
  if (!listed && !ctxr.isProdName(server.replace(/__/g, '-'), cfg.markers)) return null;
  const text = JSON.stringify(toolInput || {});
  if (MCP_DENY.test(tool)) return { decision: 'deny', id: 'mcp.prod-destructive', cls: 'mcp', why: 'destructive operation "' + tool + '" on production server "' + server + '"', command: toolName };
  if (MCP_ASK.test(tool)) return { decision: 'ask', id: 'mcp.prod-write', cls: 'mcp', why: 'write "' + tool + '" on production server "' + server + '"', command: toolName };
  if (MCP_SQLISH.test(tool) && (/\$(out|merge)\b/.test(text) || DESTRUCTIVE_SQL.test(text) || /\b(insert|update|delete|create|alter|grant|revoke)\b/i.test(text))) {
    return { decision: 'ask', id: 'mcp.prod-write', cls: 'mcp', why: 'statement that writes on production server "' + server + '"', command: toolName };
  }
  return null;
}

module.exports = { evalHostingCli, decideMcp, decideHosting, decideProdMcp, evalMcpForms };
