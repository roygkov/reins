// The adapter did not load, or it loaded and its run broke outside its own guards. This file needs only the core: it writes the failure to the journal.
// When the core does not load either, nothing can be written: the entry asks the human all the same.
import { clientRuntime, loadRuntime } from '../../../src/client/config.ts';

export function loadFailed(event: 'load' | 'run'): void {
  const rt = clientRuntime(loadRuntime(), 'claude_code');
  rt.journal.write({ kind: 'harness.failure', project: rt.project, data: { where: 'adapter', event } });
}
