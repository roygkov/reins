// The entry of the Claude Code hooks. It holds no logic: it loads the adapter and, when the load
// or the run fails before an action, asks the human. A failure must not be a silent pass.
//   node hook.ts pre | post
// A crash of Node itself, or a time limit of the client, is outside this file: then the client
// decides alone (see docs/contracts.md, B10).

const mode = process.argv[2];
try {
  const adapter = await import('./run.ts');
  adapter.main(mode);
} catch {
  if (mode === 'pre') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'reins: the adapter did not start: the human decides' } }));
  }
}
process.exitCode = 0;
