---
description: Run a scenario of the reins harness, for example `mr-review mr_url=<link>`
argument-hint: <scenario> [name=value ...]
---
Run the scenario `$ARGUMENTS` with the harness. The harness owns the task: it prepares the input and it decides when the work is done. You do not decide that.

1. Run `reins open` with the scenario name and the inputs from `$ARGUMENTS`. Put every `name=value` pair in single quotes: a link has characters that the shell reads. It prints one JSON object.
   - `ok: false`: show the error to the human and stop. For `unknown_scenario` run `reins scenarios` and show the list.
   - `state: "skipped"`: say that there is no new work and stop.
   - `state: "closed"`: the preparation failed. Say so and stop.
2. Read `input`. Follow `input.instructions`. A collected result given as `{"file": ..., "bytes": ...}` is a file: read what you need from it.
3. Write the report in the form that `input.report` and `input.protocol` describe. Save it to a file in your scratch directory.
4. Run `reins report <task> <file>`.
   - Exit code 0 and `state: "closed"`: the task is closed. Show the result to the human with the label from the answer.
   - Exit code 0 and `state: "publishing"`: the check passed and the task waits for the publication. Go to step 5.
   - Exit code 2 and `state: "executing"`: the report is not ready. Read `answer`, correct only what it names, and submit again. Do not remove a finding only to pass the check: correct its place or its quote, or say to the human that you removed it and why.
   - Exit code 2 and `state: "waiting_human"` with `waiting: "check"`: the limit of returns is reached. Show the last answer to the human and stop.
   - Exit code 2 and `state: "waiting_human"` with `waiting: "approval"`: nothing failed. The result waits for the approval of the human. Show the result and say so.
   - Exit code 2 and `state: "checking"`: the check did not answer. Run the same `reins report` command once more.
5. Publication. Show the result to the human with the label from the answer, and ask what to publish. Publish only what the human names, and only with the writes listed in `writes`: the instructions of the scenario say which tool makes them. The first write asks the human once for the whole task. Any other write is outside the task.
6. When the publication is over, or the human wants none, run `reins finish <task>`. It closes the task.
7. Before step 5, write to no system.

If the context was lost, `reins input <task>` prints the input again.
