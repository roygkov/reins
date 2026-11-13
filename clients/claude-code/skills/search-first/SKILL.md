---
name: search-first
description: 'Use when: before you build something new, before you answer "how does this system work", before you research a known subject again'
---

# search-first

Do not decide again what is decided. Search from the cheap and proven source to the expensive one:

1. **Memory of the harness.** Search with 2–3 forms of the term (English, the language of the human, the ticket
   number), one run for each form: `reins memory find valkey`, `reins memory find keepalive`. The search reads
   the records of all projects. A row gives the id: `reins memory show <id>` gives the whole record.
2. **Documents of the project**: README, `docs/`, ADR, `CLAUDE.md` and `AGENTS.md` of the repository.
3. **Code**: only the entity that the memory names (`rg -n '<symbol>' <path from the field paths>`), not a scan.
4. **Outside world** (web, documents of other teams): last.

A record that you found: use it and name its id in the answer, or reject it aloud with the cause: "record …
does not apply, because …". A rejected record is a candidate for a new decision: give the human the command
`reins memory decide` with the key `supersedes=<id>`.

## Memory against code

The memory says one thing and the code says another: trust the code, and say so. Name the id of the record and
the difference to the human. The record is wrong: propose the command `reins memory wrong <id>` to the human.
Write the new fact with a scenario that may write a pitfall or a state (`memory-note`). A contradiction that
you kept silent about is the main source of false facts.

## The memory found nothing

Do steps 2–4 and ask the human: "did we do this before?".
