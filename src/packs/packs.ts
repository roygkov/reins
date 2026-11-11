// Packs: the settings, manifests and scripts of the three levels, read from the disk and merged.
// One rule for everything: a lower level can narrow, never widen. A pack that tries to widen a list
// is not connected at all. The levels above it keep working; the levels below it are not connected,
// because the limits of the faulty level are lost. A limit is the smallest value across the levels:
// a larger value of a lower level changes nothing and is not a fault.
// Specification: docs/spec/harness-packs, pages 1 - 4.

import fs from 'node:fs';
import path from 'node:path';
import { inList, isInt, isObj, type Fault, type Obj } from '../contracts/shape.ts';
import { LEVELS, PACKAGES, RECORD_TYPES, validateManifest, type Level as ModelLevel, type Manifest, type ManifestErrorCode, type PackContext } from '../contracts/manifest.ts';

export const PACK_VERSION = 1;
export const PACK_LEVELS = PACKAGES; // organization, project, person: upper to lower
export type PackLevel = (typeof PACK_LEVELS)[number];

export type PackErrorCode =
  | 'missing' | 'bad_json' | 'too_large' | 'not_object' | 'not_array' | 'not_integer' | 'not_positive'
  | 'unknown_field' | 'version_unsupported' | 'level_mismatch' | 'bad_name' | 'not_in_list' | 'not_allowed'
  | 'duplicate' | 'widens' | 'upper_not_connected';
export type PackError = Fault<PackErrorCode>;

export type RejectCode = ManifestErrorCode | 'bad_json' | 'too_large' | 'package_mismatch' | 'not_a_file';
export type Rejected = { level: PackLevel; file: string; errors: Fault<RejectCode>[] };

// `instructions`: the text for the model, from the file `<manifest name>.md` beside the manifest.
export type Scenario = { name: string; level: PackLevel; file: string; manifest: Manifest; instructions?: string };

// What a tool of a connector does, by the name that the client gives to the tool. A name can end
// with `*`. A read tool only reads. A write tool performs a named action on a target in an
// environment; `{field}` in the target is a field of the input of the tool.
export type ToolRule = { kind: 'read' } | { kind: 'write'; action: string; target: string; env: string };

// What one pack says. Absent fields say nothing.
export type PackSettings = {
  name: string;
  connectors?: { read?: string[]; write?: string[] };
  envs?: { known?: string[]; production?: string[] };
  limits?: { level?: ModelLevel; tokens?: number; writes?: number; executors?: number };
  roles?: string[];
  checks?: string[];
  memory?: { types?: string[] };
  tools?: Record<string, ToolRule>;
};

export type LoadedPack = {
  level: PackLevel;
  dir: string;
  settings: PackSettings | null;
  scripts: string[]; // references: the path inside the pack without the extension
  scriptFiles: Record<string, string>; // reference -> absolute path of the file
  manifestFiles: string[]; // absolute paths
  errors: PackError[];
};

export type Merged = {
  context: PackContext; // what the validator of a manifest checks against
  origin: Partial<Record<keyof PackContext, PackLevel>>; // the level that gave a narrowed value
  packs: { level: PackLevel; dir: string; name: string | null; connected: boolean; errors: PackError[] }[];
  scenarios: Scenario[];
  rejected: Rejected[];
  scriptFiles: Record<string, string>; // the scripts of the connected packs: reference -> file
  tools: Record<string, ToolRule>; // the tools of the connectors, from the organization pack
};

const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEPTH = 4;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const REF = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
const SCRIPT_DIRS = ['collect', 'check'] as const;

const TOP = ['pack', 'level', 'name', 'connectors', 'envs', 'limits', 'roles', 'checks', 'memory', 'tools'] as const;

type ReadResult = { value: unknown } | { error: 'missing' | 'too_large' | 'bad_json' };

// Reads a JSON file of a pack. A symbolic link is not a file of the pack.
function readJson(file: string): ReadResult {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { error: 'missing' };
  }
  if (!stat.isFile()) return { error: 'missing' };
  if (stat.size > MAX_FILE_BYTES) return { error: 'too_large' };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { error: 'bad_json' };
  }
}

// The instruction text of a scenario: what the model must do. The manifest says what the harness
// allows and checks; this file is the words for the model. No file: no instructions.
function readInstructions(manifestFile: string): { text?: string } | { error: 'too_large' | 'not_a_file' } {
  const file = manifestFile.replace(/\.json$/, '.md');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return {};
  }
  if (!stat.isFile()) return { error: 'not_a_file' };
  if (stat.size > MAX_INSTRUCTION_BYTES) return { error: 'too_large' };
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch {
    return { error: 'not_a_file' };
  }
}

function section(errors: PackError[], value: unknown, name: string, allowed: readonly string[]): Obj | null {
  if (value === undefined) return null;
  if (!isObj(value)) {
    errors.push({ code: 'not_object', path: name });
    return null;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ code: 'unknown_field', path: `${name}.${key}` });
  return value;
}

// A list of distinct names. `among` closes the list of allowed values.
function names(errors: PackError[], value: unknown, at: string, among?: readonly string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ code: 'not_array', path: at });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || !NAME.test(item)) errors.push({ code: 'bad_name', path: `${at}[${i}]` });
    else if (among !== undefined && !among.includes(item)) errors.push({ code: 'not_in_list', path: `${at}[${i}]` });
    else if (out.includes(item)) errors.push({ code: 'duplicate', path: `${at}[${i}]` });
    else out.push(item);
  });
  return out;
}

function limit(errors: PackError[], value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isInt(value)) {
    errors.push({ code: 'not_integer', path: at });
    return undefined;
  }
  if (value <= 0) {
    errors.push({ code: 'not_positive', path: at });
    return undefined;
  }
  return value;
}

// The check of one pack.json on its own. Returns the settings, or null when the file has faults.
export function validateSettings(value: unknown, level: PackLevel): { settings: PackSettings | null; errors: PackError[] } {
  const errors: PackError[] = [];
  if (!isObj(value)) return { settings: null, errors: [{ code: 'not_object', path: '$' }] };
  for (const key of Object.keys(value)) if (!(TOP as readonly string[]).includes(key)) errors.push({ code: 'unknown_field', path: key });
  for (const key of ['pack', 'level', 'name']) if (value[key] === undefined) errors.push({ code: 'missing', path: key });

  if (value.pack !== undefined && value.pack !== PACK_VERSION) errors.push({ code: 'version_unsupported', path: 'pack' });
  if (value.level !== undefined) {
    if (!inList(PACK_LEVELS, value.level)) errors.push({ code: 'not_in_list', path: 'level' });
    else if (value.level !== level) errors.push({ code: 'level_mismatch', path: 'level' });
  }
  const settings: PackSettings = { name: '' };
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !NAME.test(value.name)) errors.push({ code: 'bad_name', path: 'name' });
    else settings.name = value.name;
  }

  const connectors = section(errors, value.connectors, 'connectors', ['read', 'write']);
  if (connectors !== null) {
    const read = names(errors, connectors.read, 'connectors.read');
    const write = names(errors, connectors.write, 'connectors.write');
    settings.connectors = { ...(read !== undefined && { read }), ...(write !== undefined && { write }) };
  }

  const envs = section(errors, value.envs, 'envs', ['known', 'production']);
  if (envs !== null) {
    // Only the organization lists the environments that are known. A lower level could
    // otherwise turn an unknown environment, which counts as production, into a plain one.
    if (envs.known !== undefined && level !== 'organization') errors.push({ code: 'not_allowed', path: 'envs.known' });
    const known = level === 'organization' ? names(errors, envs.known, 'envs.known') : undefined;
    const production = names(errors, envs.production, 'envs.production', level === 'organization' ? (known ?? []) : undefined);
    settings.envs = { ...(known !== undefined && { known }), ...(production !== undefined && { production }) };
  }

  const limits = section(errors, value.limits, 'limits', ['level', 'tokens', 'writes', 'executors']);
  if (limits !== null) {
    const out: NonNullable<PackSettings['limits']> = {};
    if (limits.level !== undefined) {
      if (!inList(LEVELS, limits.level)) errors.push({ code: 'not_in_list', path: 'limits.level' });
      else out.level = limits.level;
    }
    const tokens = limit(errors, limits.tokens, 'limits.tokens');
    const writes = limit(errors, limits.writes, 'limits.writes');
    const executors = limit(errors, limits.executors, 'limits.executors');
    if (tokens !== undefined) out.tokens = tokens;
    if (writes !== undefined) out.writes = writes;
    if (executors !== undefined) out.executors = executors;
    settings.limits = out;
  }

  const roles = names(errors, value.roles, 'roles');
  if (roles !== undefined) settings.roles = roles;
  const checks = names(errors, value.checks, 'checks');
  if (checks !== undefined) settings.checks = checks;

  const memory = section(errors, value.memory, 'memory', ['types']);
  if (memory !== null) {
    const types = names(errors, memory.types, 'memory.types', RECORD_TYPES);
    settings.memory = { ...(types !== undefined && { types }) };
  }
  if (value.tools !== undefined) {
    // Only the organization says what a tool does: a lower level could turn a write into a read.
    if (level !== 'organization') errors.push({ code: 'not_allowed', path: 'tools' });
    else if (!isObj(value.tools)) errors.push({ code: 'not_object', path: 'tools' });
    else settings.tools = toolRules(errors, value.tools, settings.connectors?.write ?? [], settings.envs?.known ?? []);
  }
  return { settings: errors.length === 0 ? settings : null, errors };
}

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,118}\*?$/;
const TARGET = /^(?:[A-Za-z0-9_.:\/@%!+-]|\{[a-z_][a-z0-9_]{0,39}\})+$/;

function toolRules(errors: PackError[], tools: Obj, actions: readonly string[], envs: readonly string[]): Record<string, ToolRule> {
  const out: Record<string, ToolRule> = {};
  for (const [name, rule] of Object.entries(tools)) {
    const at = `tools.${name}`;
    if (!TOOL_NAME.test(name)) {
      errors.push({ code: 'bad_name', path: at });
      continue;
    }
    if (!isObj(rule)) {
      errors.push({ code: 'not_object', path: at });
      continue;
    }
    if (rule.kind !== 'read' && rule.kind !== 'write') {
      errors.push({ code: rule.kind === undefined ? 'missing' : 'not_in_list', path: `${at}.kind` });
      continue;
    }
    const allowed = rule.kind === 'read' ? ['kind'] : ['kind', 'action', 'target', 'env'];
    for (const key of Object.keys(rule)) if (!allowed.includes(key)) errors.push({ code: 'unknown_field', path: `${at}.${key}` });
    if (rule.kind === 'read') {
      out[name] = { kind: 'read' };
      continue;
    }
    const { action, target, env } = rule;
    if (action === undefined) errors.push({ code: 'missing', path: `${at}.action` });
    else if (typeof action !== 'string' || !actions.includes(action)) errors.push({ code: 'not_in_list', path: `${at}.action` });
    if (target === undefined) errors.push({ code: 'missing', path: `${at}.target` });
    else if (typeof target !== 'string' || !TARGET.test(target)) errors.push({ code: 'bad_name', path: `${at}.target` });
    if (env === undefined) errors.push({ code: 'missing', path: `${at}.env` });
    else if (typeof env !== 'string' || !envs.includes(env)) errors.push({ code: 'not_in_list', path: `${at}.env` });
    if (typeof action === 'string' && typeof target === 'string' && typeof env === 'string') out[name] = { kind: 'write', action, target, env };
  }
  return out;
}

// The scripts of a pack: regular files under collect/ and check/. A symbolic link is skipped,
// so a script cannot point outside the pack.
function scriptRefs(dir: string, errors: PackError[], files: Record<string, string>): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(child, depth + 1);
      } else if (entry.isFile()) {
        const ref = child.replace(/\.[A-Za-z0-9]+$/, '');
        if (!REF.test(ref)) continue;
        // Two files that differ only by the extension give one reference: nothing says which one runs.
        if (out.includes(ref)) errors.push({ code: 'duplicate', path: ref });
        else {
          out.push(ref);
          files[ref] = path.join(dir, child);
        }
      }
    }
  };
  for (const top of SCRIPT_DIRS) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(path.join(dir, top));
    } catch {
      stat = null;
    }
    if (stat !== null && stat.isDirectory()) walk(top, 1);
  }
  return out.sort();
}

function manifestFiles(dir: string): string[] {
  const at = path.join(dir, 'manifests');
  let entries: fs.Dirent[];
  try {
    if (!fs.lstatSync(at).isDirectory()) return [];
    entries = fs.readdirSync(at, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => path.join(at, e.name))
    .sort();
}

export function loadPack(dir: string, level: PackLevel): LoadedPack {
  const pack: LoadedPack = { level, dir, settings: null, scripts: [], scriptFiles: {}, manifestFiles: [], errors: [] };
  const read = readJson(path.join(dir, 'pack.json'));
  if ('error' in read) {
    pack.errors.push({ code: read.error, path: 'pack.json' });
    return pack;
  }
  const checked = validateSettings(read.value, level);
  pack.errors.push(...checked.errors);
  pack.settings = checked.settings;
  if (pack.settings !== null) {
    pack.scripts = scriptRefs(dir, pack.errors, pack.scriptFiles);
    pack.manifestFiles = manifestFiles(dir);
    if (pack.errors.length > 0) pack.settings = null;
  }
  return pack;
}

const rank = (l: ModelLevel): number => LEVELS.indexOf(l);

// The faults of a pack against the levels above it: what it widens and what it repeats.
function against(context: PackContext, allScripts: Set<string>, pack: LoadedPack, s: PackSettings): PackError[] {
  const errors: PackError[] = [];
  const within = (list: string[] | undefined, upper: readonly string[], at: string, code: PackErrorCode): void => {
    (list ?? []).forEach((item, i) => {
      if (!upper.includes(item)) errors.push({ code, path: `${at}[${i}]` });
    });
  };
  if (pack.level !== 'organization') {
    // Connectors come from the organization. Without it a lower level has nothing to narrow.
    within(s.connectors?.read, context.readConnectors ?? [], 'connectors.read', 'widens');
    within(s.connectors?.write, context.writeActions ?? [], 'connectors.write', 'widens');
    within(s.memory?.types, context.memoryTypes ?? RECORD_TYPES, 'memory.types', 'widens');
    // An executor role is a permission: a manifest may start only the executors that the levels allow.
    within(s.roles, context.roles ?? [], 'roles', 'widens');
    within(s.envs?.production, context.envs ?? [], 'envs.production', 'not_in_list');
  }
  (s.checks ?? []).forEach((name, i) => {
    if ((context.checks ?? []).includes(name)) errors.push({ code: 'duplicate', path: `checks[${i}]` });
  });
  for (const ref of pack.scripts) if (allScripts.has(ref)) errors.push({ code: 'duplicate', path: ref });
  return errors;
}

function join(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (b === undefined || b.length === 0) return a;
  return [...(a ?? []), ...b.filter((x) => !(a ?? []).includes(x))];
}

function apply(m: Merged, pack: LoadedPack, s: PackSettings): void {
  const c = m.context;
  const narrow = (key: 'readConnectors' | 'writeActions' | 'memoryTypes' | 'envs' | 'roles', list: string[] | undefined): void => {
    if (list === undefined) return;
    const before = c[key];
    if (before === undefined || before.length !== list.length || before.some((x) => !list.includes(x))) m.origin[key] = pack.level;
    c[key] = list;
  };
  if (s.tools !== undefined) m.tools = s.tools;
  narrow('readConnectors', s.connectors?.read);
  narrow('writeActions', s.connectors?.write);
  narrow('memoryTypes', s.memory?.types);
  narrow('envs', s.envs?.known);
  narrow('roles', s.roles);

  const lower = (key: 'maxTokens' | 'maxWriteLimit' | 'maxExecutors', value: number | undefined): void => {
    if (value === undefined) return;
    const before = c[key];
    if (before === undefined || value < before) {
      c[key] = value;
      m.origin[key] = pack.level;
    }
  };
  lower('maxTokens', s.limits?.tokens);
  lower('maxWriteLimit', s.limits?.writes);
  lower('maxExecutors', s.limits?.executors);
  const level = s.limits?.level;
  if (level !== undefined && (c.maxLevel === undefined || rank(level) < rank(c.maxLevel))) {
    c.maxLevel = level;
    m.origin.maxLevel = pack.level;
  }

  // These lists only grow: one more production environment is a stricter setting.
  const productionEnvs = join(c.productionEnvs, s.envs?.production);
  const checks = join(c.checks, s.checks);
  // A manifest names a collect script. The scripts under check/ belong to the checks.
  const scripts = join(c.scripts, pack.scripts.filter((ref) => ref.startsWith('collect/')));
  if (productionEnvs !== undefined) c.productionEnvs = productionEnvs;
  if (checks !== undefined) c.checks = checks;
  if (scripts !== undefined) c.scripts = scripts;
}

// Merges packs that are already read, upper level first. Pure except for reading the manifest files.
export function mergePacks(loaded: LoadedPack[]): Merged {
  const m: Merged = { context: {}, origin: {}, packs: [], scenarios: [], rejected: [], scriptFiles: {}, tools: {} };
  const ordered = [...loaded].sort((a, b) => PACK_LEVELS.indexOf(a.level) - PACK_LEVELS.indexOf(b.level));
  const connected: LoadedPack[] = [];
  const allScripts = new Set<string>();
  let broken = false; // a level above was named and is not connected
  for (const pack of ordered) {
    const errors: PackError[] = broken ? [{ code: 'upper_not_connected', path: 'pack.json' }] : [...pack.errors];
    if (!broken && pack.settings !== null) errors.push(...against(m.context, allScripts, pack, pack.settings));
    const ok = errors.length === 0 && pack.settings !== null;
    m.packs.push({ level: pack.level, dir: pack.dir, name: pack.settings?.name ?? null, connected: ok, errors });
    if (ok && pack.settings !== null) {
      apply(m, pack, pack.settings);
      for (const ref of pack.scripts) allScripts.add(ref);
      Object.assign(m.scriptFiles, pack.scriptFiles);
      connected.push(pack);
    } else {
      broken = true;
    }
  }

  // Manifests are checked against the whole merge: a limit of the person holds for a scenario of the project.
  // In a merge a list that no pack gave means "nothing", not "not checked": the check fails closed.
  const closed: PackContext = {
    ...m.context,
    readConnectors: m.context.readConnectors ?? [],
    writeActions: m.context.writeActions ?? [],
    scripts: m.context.scripts ?? [],
    checks: m.context.checks ?? [],
    roles: m.context.roles ?? [],
  };
  const seen = new Set<string>();
  for (const pack of connected) {
    for (const file of pack.manifestFiles) {
      const label = `${pack.level}/manifests/${path.basename(file)}`;
      const read = readJson(file);
      if ('error' in read) {
        m.rejected.push({ level: pack.level, file: label, errors: [{ code: read.error === 'missing' ? 'bad_json' : read.error, path: '$' }] });
        continue;
      }
      const errors: Fault<RejectCode>[] = validateManifest(read.value, closed);
      const value = read.value as Manifest;
      if (errors.length === 0 && value.package !== pack.level) errors.push({ code: 'package_mismatch', path: 'package' });
      if (errors.length === 0 && seen.has(value.name)) errors.push({ code: 'duplicate', path: 'name' });
      if (errors.length > 0) {
        m.rejected.push({ level: pack.level, file: label, errors });
        continue;
      }
      const words = readInstructions(file);
      if ('error' in words) {
        m.rejected.push({ level: pack.level, file: label, errors: [{ code: words.error, path: 'instructions' }] });
        continue;
      }
      seen.add(value.name);
      const scenario: Scenario = { name: value.name, level: pack.level, file, manifest: value };
      if (words.text !== undefined) scenario.instructions = words.text;
      m.scenarios.push(scenario);
    }
  }
  return m;
}

// Reads the packs of the named levels and merges them. A level that is not named has no pack.
export function loadPacks(dirs: Partial<Record<PackLevel, string>>): Merged {
  const loaded: LoadedPack[] = [];
  for (const level of PACK_LEVELS) {
    const dir = dirs[level];
    if (dir !== undefined) loaded.push(loadPack(dir, level));
  }
  return mergePacks(loaded);
}
