---
name: systematic-debugging
description: 'Use when: a bug, an error, a failing test; a second "let us try this" change in a row that did not help'
---

# systematic-debugging

The forbidden mode: random changes that are faster than thought. Two failed "what if" attempts in a row: stop
and follow the procedure:

1. **Memory**: was there a similar case? `reins memory find <symptom>`, then `reins memory find <module>` and
   `reins memory find <error code>`. The whole record: `reins memory show <id>`. An old root cause is gold.
2. **Reproduce**: a minimal reliable reproduction before any change.
3. **Hypothesis in writing**: "it breaks because of X; if so, Y shows Z". Check Y. Not confirmed: the next
   hypothesis, not a change.
4. **Tell apart**: did you remove the symptom or the cause? A change of the symptom without a named cause: say
   "I treat the symptom, the cause is not found". This is a line for the field `unverified` of the state of
   the project.
5. **Write the cause** at the moment you find it, with a scenario that may write a pitfall (`memory-note`,
   `/reins:run memory-note`):
   - a permanent property of the system that somebody will hit again:
     `reins memory add pitfall '<fact and workaround>' task=<task> path=<path from the root of the repository>`;
   - a single event that is corrected and visible in the git history: do not write it.
   A record of the agent waits for the veto of the human.
   A choice between ways to repair is a decision: give the human the command `reins memory decide`.
