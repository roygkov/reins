// The channel of a decision of the human. A decision (`reins approve`, `reins stop`,
// `reins queue approve`, `reins memory decide` and the others of the list) is a word of the
// human. The barrier knows such a command by the text of the line that the agent gives to its
// shell, and a text can hide. So the command itself looks where it runs: a terminal on its
// standard input, and no variable that a client gives to the shell of its agent. A command in
// the shell of a client is refused whatever its text was.
//
// What stays open: a process that removes the variables of the client and makes a terminal of
// its own passes. That is a deliberate step of the agent, not a hidden text.

import { DECISION_WORDS } from './places.ts';

// A start of a client (`run`, `tick run`, `fire`) is a word of the human for the barrier, but no
// decision about a task, a queue or the memory: the timer of the system runs `reins tick run`
// with no terminal. The list of the decisions is the one that the barrier reads.

// The words of a command line are a decision of the human.
export function humanDecision(args: readonly string[]): boolean {
  return DECISION_WORDS.test(args.join(' '));
}

export type HumanRefusal = 'agent_shell' | 'no_terminal';

// `markers`: the names of the variables that the clients give to the shell of an agent.
// `mode`: `terminal` asks for a terminal; `any` (the config of a test) does not. A variable of a
// client refuses in both modes: its value does not matter, its presence does.
export function humanChannel(at: { tty: boolean; env: Readonly<Record<string, string | undefined>>; markers: readonly string[]; mode: 'terminal' | 'any' }): HumanRefusal | null {
  if (at.markers.some((name) => at.env[name] !== undefined)) return 'agent_shell';
  if (at.mode === 'terminal' && !at.tty) return 'no_terminal';
  return null;
}
