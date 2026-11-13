---
name: strategic-compact
description: 'Use when: the context of the session is about half full; a logical stage of a large task is closed'
---

# strategic-compact

The automatic compaction at 95% comes at the worst moment and removes the middle of the reasoning. Control it.

1. At about 50% of the context find the nearest border: a stage is closed, a test is green, a decision is made.
2. At the border, first run the scenario that writes the state of the project and the cases (`wrapup`,
   `/reins:run wrapup`): the state, the cases with the next step, the complete `reins memory decide` commands
   for the human. After `/compact` the context gets `CLAUDE.md` and `AGENTS.md` again. The state and the cases
   are in the memory of the harness: the work continues from what is written there. A state that is only in
   the context does not survive the compaction.
3. Compact at the border. Never compact in the middle of a debugging or of a reasoning: it is cheaper to reach
   the border.
4. After the compaction read the state of the project and its next steps first, as at the start of a session.
   The harness did not print them again: read the active states with a filter:
   `reins memory | jq -c '.records[] | select(.type=="state" and .state=="active") | {id, project, text, next, unverified}'`.
   Do not run `reins memory` without a filter: it prints all records of all projects.
