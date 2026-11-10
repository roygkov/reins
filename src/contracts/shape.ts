// Small helpers shared by the contract validators. No dependencies.

export type Fault<Code extends string> = { code: Code; path: string };

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function oneLine(value: string): boolean {
  return value.length > 0 && !/[\r\n]/.test(value);
}

export function inList<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}
