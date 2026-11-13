---
name: decision-hygiene
description: 'Use when: a decision that is not trivial is made, or the human says "we do it this way"; the record is reins memory decide'
---

# decision-hygiene → reins memory decide

A decision that nobody said aloud does not reach the memory. Somebody will make it again, possibly another way.
Only the human writes a decision to the memory of the harness: the agent proposes the complete command.

1. At the moment of the decision say the formula in one paragraph: **"We decided X. Because Y. We rejected Z
   (cause)."** No "because": this is not a decision yet. No alternative: say `none voiced`.
2. Give the human the complete command at once. The human runs it from the directory of the repository that
   the decision is about:
   `reins memory decide "<text>" because="<cause>" rejected="<what was rejected>"`.
   Do not put a backquote, the sign `$` or the sign `!` in the text: the shell changes a string in double quotes.
   Write only proven facts in `because`. Do not wait for the end of the session: by then half of the causes
   are forgotten.
3. You cancel an earlier decision: say so and add `supersedes=<id>` to the command. Without it both records
   stay in the memory as true.
