// Test cases are data: test/data/*.json. A port to another language reuses the files as they are.
import { readFileSync } from 'node:fs';

export function loadCases<T>(name: string): T[] {
  const url = new URL(`./data/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${name}.json must hold an array of cases`);
  return parsed as T[];
}

// Deep merge for "base object plus patch" cases. `null` in the patch removes the key.
export function patch(base: unknown, change: unknown): unknown {
  if (change === null || typeof change !== 'object' || Array.isArray(change)) return change;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return change;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(change as Record<string, unknown>)) {
    if (value === null) delete out[key];
    else out[key] = patch(out[key], value);
  }
  return out;
}
