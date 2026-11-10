'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/context.js. The logic is unchanged.
// Read-only resolvers for implicit production context. No network, no CLI calls.
const path = require('path');
const { HOME, readText } = require('./util.cjs');

function isProdName(value, markers) {
  if (!value) return false;
  const parts = String(value).toLowerCase().split(/[-_/.:=@,\s${}()"']+/).filter(Boolean);
  const set = new Set((markers || []).map((m) => m.toLowerCase()));
  if (set.has(String(value).toLowerCase())) return true;
  return parts.some((p) => set.has(p));
}

function flagValue(argv, names) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const n of names) {
      if (a === n && i + 1 < argv.length) return argv[i + 1];
      if (a.startsWith(n + '=')) return a.slice(n.length + 1);
    }
  }
  return null;
}

function envOf(seg, name) {
  if (seg.env && seg.env[name] !== undefined) return seg.env[name];
  return process.env[name];
}

function kubeContext(seg) {
  const explicit = flagValue(seg.argv, ['--context', '--kube-context']);
  if (explicit) return { value: explicit, source: 'flag' };
  const kc = flagValue(seg.argv, ['--kubeconfig']) || envOf(seg, 'KUBECONFIG') || path.join(HOME, '.kube', 'config');
  for (const file of String(kc).split(':')) {
    const text = readText(file.replace(/^~(?=\/)/, HOME));
    if (!text) continue;
    const m = /^current-context:\s*["']?([^"'\n]+)["']?\s*$/m.exec(text);
    if (m) return { value: m[1].trim(), source: 'kubeconfig' };
  }
  return null;
}

function terraformWorkspace(seg, cwd) {
  const ws = envOf(seg, 'TF_WORKSPACE');
  if (ws) return { value: ws, source: 'TF_WORKSPACE' };
  const chdir = flagValue(seg.argv, ['-chdir']);
  const dir = chdir ? path.resolve(cwd, chdir) : cwd;
  const env = readText(path.join(dir, '.terraform', 'environment'));
  if (env) return { value: env.trim(), source: '.terraform/environment' };
  // terragrunt / directory naming: live/prod/...
  return { value: dir, source: 'directory' };
}

function awsProfile(seg) {
  const p = flagValue(seg.argv, ['--profile']) || envOf(seg, 'AWS_PROFILE') || envOf(seg, 'AWS_DEFAULT_PROFILE');
  return p ? { value: p, source: 'profile' } : null;
}

function gcloudConfig(seg) {
  const p = flagValue(seg.argv, ['--project', '--configuration']);
  if (p) return { value: p, source: 'flag' };
  const cfgDir = envOf(seg, 'CLOUDSDK_CONFIG') || path.join(HOME, '.config', 'gcloud');
  const active = (readText(path.join(cfgDir, 'active_config')) || '').trim();
  if (!active) return null;
  const props = readText(path.join(cfgDir, 'configurations', 'config_' + active)) || '';
  const proj = /^project\s*=\s*(.+)$/m.exec(props);
  return { value: active + (proj ? ' ' + proj[1].trim() : ''), source: 'gcloud active_config' };
}

function azSubscription(seg) {
  const s = flagValue(seg.argv, ['--subscription', '--resource-group', '-g']);
  return s ? { value: s, source: 'flag' } : null;
}

function dbtTarget(seg, cwd) {
  const t = flagValue(seg.argv, ['--target', '-t']);
  if (t) return { value: t, source: 'flag' };
  const profilesDir = flagValue(seg.argv, ['--profiles-dir']) || envOf(seg, 'DBT_PROFILES_DIR');
  const candidates = [profilesDir && path.join(path.resolve(cwd, profilesDir), 'profiles.yml'), path.join(cwd, 'profiles.yml'), path.join(HOME, '.dbt', 'profiles.yml')].filter(Boolean);
  for (const f of candidates) {
    const text = readText(f);
    if (!text) continue;
    const m = /^\s+target:\s*["']?([\w-]+)/m.exec(text);
    if (m) return { value: m[1], source: f };
  }
  return null;
}

// Liquibase: the JDBC URL from --url, the environment (LIQUIBASE_COMMAND_URL, LIQUIBASE_URL), or the defaults file
// (--defaults-file, LIQUIBASE_DEFAULTS_FILE, ./liquibase.properties).
function liquibaseUrl(seg, cwd) {
  const u = flagValue(seg.argv, ['--url']);
  if (u) return { value: u, source: 'flag' };
  const e = envOf(seg, 'LIQUIBASE_COMMAND_URL') || envOf(seg, 'LIQUIBASE_URL');
  if (e) return { value: e, source: 'environment' };
  const f = flagValue(seg.argv, ['--defaults-file', '--defaultsFile']) || envOf(seg, 'LIQUIBASE_DEFAULTS_FILE') || 'liquibase.properties';
  const text = readText(path.resolve(cwd, f));
  const m = text && /^\s*(?:liquibase\.command\.)?url\s*[:=]\s*(.+)$/m.exec(text);
  return m ? { value: m[1].trim(), source: f } : null;
}

const RESOLVERS = { kube: kubeContext, terraform: terraformWorkspace, aws: awsProfile, gcloud: gcloudConfig, az: azSubscription, dbt: dbtTarget, liquibase: liquibaseUrl };

function resolve(kind, seg, cwd) {
  const fn = RESOLVERS[kind];
  try { return fn ? fn(seg, cwd) : null; } catch (e) { return null; }
}

module.exports = { isProdName, flagValue, resolve, kubeContext, terraformWorkspace, awsProfile, gcloudConfig, dbtTarget, liquibaseUrl };
