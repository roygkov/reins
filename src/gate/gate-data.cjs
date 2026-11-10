'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/gate-data.js. The logic is unchanged.
// The gate's production-data rules: database clients, HTTP writes, environment flags, script runners and fastlane.
// Each evaluator names its prefilter needles (see gate.js).
const { base } = require('./tokenize.cjs');
const ctxr = require('./context.cjs');
const { matchGlob } = require('./util.cjs');
const { positionals, short, unresolved } = require('./gate-common.cjs');

const DB_CLIENTS = new Set(['psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'mysql', 'mysqldump', 'mariadb', 'mongosh', 'mongo', 'mongodump', 'mongorestore', 'redis-cli', 'sqlcmd', 'bq', 'snowsql', 'databricks', 'clickhouse-client', 'clickhouse', 'cqlsh', 'sqlite3']);
const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh']);
const SCRIPT_RUNNERS = { npm: 'run', pnpm: 'run', bun: 'run', yarn: null, make: null, just: null, task: null, mise: 'run' };
const WRITE_VERBS = new Set(['deploy', 'apply', 'migrate', 'migration', 'delete', 'drop', 'destroy', 'push', 'release', 'publish', 'rollback', 'send', 'upload', 'seed', 'sync', 'import', 'purge', 'truncate', 'wipe', 'reset', 'restore', 'invoice', 'invoices', 'submit']);
const FASTLANE_ACTIONS = ['deliver', 'supply', 'pilot', 'upload_to_app_store', 'upload_to_play_store', 'upload_to_testflight', 'appstore', 'testflight'];

function evalScripts(seg, cfg) {
  const b = base(seg.argv[0]);
  if (!(b in SCRIPT_RUNNERS)) return null;
  const pos = positionals(seg.argv);
  let names = [];
  const runWord = SCRIPT_RUNNERS[b];
  if (runWord) { if (pos[0] === runWord) names = [pos[1]]; else if (b === 'bun' || b === 'pnpm') names = []; }
  else if (b === 'yarn') { if (pos[0] === 'run') names = [pos[1]]; else if (pos[0] && !['add', 'install', 'remove', 'upgrade', 'publish', 'npm', 'dlx', 'workspace', 'workspaces', 'why', 'info', 'init', 'set', 'config'].includes(pos[0])) names = [pos[0]]; }
  else names = pos.filter((p) => !p.includes('='));
  for (const n of names.filter(Boolean)) {
    if (matchGlob(n, cfg.prod_scripts) || ctxr.isProdName(n, cfg.markers)) return { decision: 'ask', id: 'script.prod', cls: 'prod-default', why: b + ' target "' + n + '" looks like a production deploy or release' };
  }
  return null;
}
// a runner with a run word only with it (`npm test`, `pnpm install` stay out); yarn, make, just, task take any target
evalScripts.NEEDLES = Object.keys(SCRIPT_RUNNERS).map((b) => (SCRIPT_RUNNERS[b] ? { cmd: b, sub: SCRIPT_RUNNERS[b] } : { cmd: b }));

function evalFastlane(seg, cfg) {
  if (base(seg.argv[0]) !== 'fastlane') return null;
  const pos = positionals(seg.argv).filter((p) => !['ios', 'android', 'mac'].includes(p) && !p.includes(':'));
  const lane = pos[0];
  if (!lane) return null;
  if (FASTLANE_ACTIONS.includes(lane) || matchGlob(lane, cfg.prod_fastlane_lanes) || /release|deploy|beta|prod|store|upload/i.test(lane)) {
    return { decision: 'ask', id: 'release.fastlane', cls: 'prod-default', why: 'fastlane "' + lane + '" uploads or releases a build' };
  }
  return null;
}
evalFastlane.NEEDLES = [{ cmd: 'fastlane' }];

const DESTRUCTIVE_SQL = /\b(drop|truncate|alter)\s+(table|database|schema|index|collection|user|role|view)\b|\bdelete\s+from\b(?![\s\S]*\bwhere\b)|\bupdate\s+\w+\s+set\b(?![\s\S]*\bwhere\b)|\bflushall\b|\bflushdb\b|dropDatabase|\.drop\(|deleteMany\(\s*\{\s*\}\s*\)/i;
function evalDb(seg, cfg) {
  const b = base(seg.argv[0]);
  if (!DB_CLIENTS.has(b)) return null;
  const text = seg.argv.join(' ') + '\n' + (seg.heredoc || '');
  const envProd = ['PGHOST', 'PGDATABASE', 'PGSERVICE', 'MYSQL_HOST', 'DATABASE_URL', 'MONGODB_URI'].map((k) => (seg.env && seg.env[k]) || '').find((v) => ctxr.isProdName(v, cfg.markers));
  const argProd = seg.argv.slice(1).find((a) => ctxr.isProdName(a, cfg.markers) || /:\/\/[^\s]*\b(prod|production|prd)\b/i.test(a));
  // a host from -h/--host or a URL that is in prod_hosts (the same list as HTTP writes)
  const hostArg = ctxr.flagValue(seg.argv, ['-h', '--host']) || seg.argv.slice(1).map((a) => { const m = /^[a-z+]+:\/\/([^/?#\s]+)/i.exec(a); return m ? m[1].split('@').pop().split(':')[0] : null; }).find(Boolean);
  const hostProd = hostArg && matchGlob(hostArg, cfg.prod_hosts) ? hostArg : null;
  const prod = envProd || argProd || hostProd;
  if (!prod) {
    if (DESTRUCTIVE_SQL.test(text) && unresolved(seg)) return { decision: 'ask', id: 'data.destructive-sql', cls: 'data', why: 'destructive statement and the target database comes from a variable, so production cannot be ruled out' };
    return null;
  }
  if (DESTRUCTIVE_SQL.test(text)) return { decision: 'ask', id: 'data.destructive-sql', cls: 'data', why: 'destructive statement against production ("' + short(prod) + '")' };
  if (seg.inputs.length || seg.argv.some((a) => a === '-f' || a === '--file' || a === '-i')) return { decision: 'ask', id: 'data.script-on-prod', cls: 'data', why: 'runs a script file against production ("' + short(prod) + '")' };
  // any other connection to a production database (a query, a dump, a restore, a shell): the data is production's
  return { decision: 'ask', id: 'data.prod-db', cls: 'data', why: b + ' connects to a production database ("' + short(prod) + '")' };
}
// every client: production shows in a host, a URL or an environment variable the prefilter cannot read
evalDb.NEEDLES = [...DB_CLIENTS].map((c) => ({ cmd: c }));

function evalHttp(seg, cfg) {
  const b = base(seg.argv[0]);
  if (!HTTP_CLIENTS.has(b)) return null;
  let method = ctxr.flagValue(seg.argv, ['-X', '--request', '--method']);
  if (!method && (b === 'http' || b === 'https' || b === 'xh')) { const m = positionals(seg.argv).find((p) => /^(GET|POST|PUT|PATCH|DELETE)$/i.test(p)); if (m) method = m; }
  if (!method && seg.argv.some((a) => /^(-d|--data.*|-F|--form|-T|--upload-file|--json|--post-data|--post-file)$/.test(a))) method = 'POST';
  if (!method || /^(GET|HEAD|OPTIONS)$/i.test(method)) return null;
  const urls = seg.argv.slice(1).filter((a) => /^https?:\/\//i.test(a) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(a));
  for (const u of urls) {
    let host = u.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].split('@').pop().split(':')[0];
    if (matchGlob(host, cfg.prod_hosts) || ctxr.isProdName(host, cfg.markers)) return { decision: 'ask', id: 'http.prod-write', cls: 'prod-default', why: method.toUpperCase() + ' to production host ' + host };
  }
  return null;
}
// a client with a method flag, a data flag or a method word (`curl https://…` without them stays out)
evalHttp.NEEDLES = [{ cmd: [...HTTP_CLIENTS], sub: ['-X', '--request', '--method', '-d', '--data', '-F', '--form', '-T', '--upload-file', '--json', '--post-data', '--post-file', 'POST', 'PUT', 'PATCH', 'DELETE'] }];

const PRINTERS = new Set(['echo', 'printf', 'cat', 'grep', 'rg', 'ls', 'less', 'head', 'tail', 'man', 'which', 'type', 'wc', 'jq', 'yq', 'tree', 'find']);
function evalEnvFlag(seg, cfg) {
  if (PRINTERS.has(base(seg.argv[0]))) return null;
  const val = ctxr.flagValue(seg.argv, ['--env', '--environment', '--stage', '--target', '--profile', '--context', '--namespace', '--app-env']);
  if (!val || !ctxr.isProdName(val, cfg.markers)) return null;
  const words = seg.argv.flatMap((a) => (a.startsWith('-') ? [] : base(a).toLowerCase().split(/[^a-z]+/)));
  if (words.some((w) => WRITE_VERBS.has(w))) return { decision: 'ask', id: 'env.prod-write', cls: 'prod-env', why: 'production environment "' + val + '" with a write action' };
  return null;
}
// the production name is the needle: gate.json `markers` are prefilter lines themselves (a marker added in a config
// layer is not, unless it holds one of them; a form covers it)
evalEnvFlag.NEEDLES = [];

module.exports = { evalScripts, evalFastlane, evalDb, evalHttp, evalEnvFlag, DESTRUCTIVE_SQL };
