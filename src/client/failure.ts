// The kind of an error as a code: the code of the system or of the loader (`ENOTDIR`,
// `ERR_MODULE_NOT_FOUND`), else the name of the error (`TypeError`). A row of the journal about a
// failure of an adapter carries it, so the cause is not lost. The text of an error can hold a path
// or a line of a file: it never goes to the journal. The entry of the hooks of a client has its
// own copy of this rule: it must work when the core does not load.
export function errorToken(e: unknown): string | undefined {
  const code = e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  const named = typeof code === 'string' ? code : e instanceof Error ? e.name : '';
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(named) ? named : undefined;
}
