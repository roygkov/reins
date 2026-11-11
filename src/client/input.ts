// The input of a task for the model: what a client gives to the agent when a scenario starts.
// It is data. The harness adds only the rules of the exchange (`protocol`); what the model must
// do is the instruction text of the scenario, which comes from a pack.
// Specification: docs/spec/harness-client, page 2, "Добавить во вход".

import type { Grant } from '../contracts/policy.ts';
import type { Task } from '../core/task.ts';
import { MAX_ITEMS } from '../check/citations.ts';

export type ReportSpec = {
  check: string; // the kind of the done check
  returns_left: number; // how many times a report that is not ready can still come back
  max_items?: number;
  max_bytes?: number;
  source?: string; // the collected result that holds the source of the quotes
  changed?: string; // the collected result that holds the list of changed files
  item?: Record<string, string>; // the fields of an item that the harness reads
  fields?: Record<string, string[]>; // the fields of an item that the scenario names, with their values
};

export type TaskInput = {
  task: string;
  scenario: string;
  title: string;
  description?: string;
  instructions?: string;
  collected: Record<string, unknown>;
  report: ReportSpec;
  writes: Grant[]; // the writes that the scenario can ask for; the policy decides each one
  protocol: string[];
  model: { level: string; name?: string; raise_to?: string }; // the level for this task; `name` when a pack names the model
  memory?: { id: string; type: string; text: string }[]; // records of the memory about this work, with their ids
  pack_notes?: { level: string; text: string }[]; // the notes of the packs, upper pack first
};

const ITEM: Record<string, string> = {
  file: 'path inside the source',
  line: 'number of the line, from 1',
  end: 'last line of a range (optional)',
  quote: 'text copied from the source, 8 characters or more',
  text: 'free text (optional)',
};

// The input of a scenario task that executes or publishes its result; null for any other task.
const LEVEL_ORDER: readonly string[] = ['weak', 'medium', 'strong'];

export function taskInput(task: Task, collected: Record<string, unknown> | null, command = 'reins', models: Partial<Record<string, string>> = {}): TaskInput | null {
  const m = task.manifest;
  if (m === undefined || (task.state !== 'executing' && task.state !== 'publishing')) return null;
  const report: ReportSpec = { check: m.done.kind, returns_left: Math.max(0, m.done.retries - task.returns) };
  const protocol = ['Do the work that the instructions describe. Use the collected data and the source that it names.'];
  if (m.done.kind === 'citations') {
    report.max_items = Math.min(m.output.max_items ?? MAX_ITEMS, MAX_ITEMS);
    if (m.done.source !== undefined) report.source = m.done.source;
    if (m.done.changed !== undefined) report.changed = m.done.changed;
    report.item = { ...ITEM };
    if (m.output.fields !== undefined) report.fields = m.output.fields;
    protocol.push(
      'The report is one JSON object: {"items": [...]}. An empty list is a valid report.',
      'Every item has the fields of `report.item` and every field of `report.fields` with one of its values.',
      'The harness checks every quote against the source. A quote that is not there makes the report not ready.',
    );
  } else {
    if (m.output.max_items !== undefined) report.max_items = m.output.max_items;
    if (m.output.max_bytes !== undefined) report.max_bytes = m.output.max_bytes;
  }
  protocol.push(
    `Submit the report with: ${command} report ${task.id} <file> (or - for the standard input).`,
    'Exit code 0: the check passed; the task is closed or, with `state: "publishing"`, waits for the publication. Exit code 2: not ready; read `answer`, correct the report and submit it again.',
    'Write to no system before the report passes. When the answer says `state: "publishing"`, the writes of `writes` can be made on the word of the human; no other write.',
    `After the publication, or when the human wants none, run: ${command} finish ${task.id}.`,
  );
  // A task has its level from the manifest or from the packs; the middle level is the last word.
  const level = task.level ?? m.model.level ?? 'medium';
  const model: TaskInput['model'] = { level };
  const name = models[level];
  if (name !== undefined) model.name = name;
  if (m.model.raise_to !== undefined && task.raised !== true && LEVEL_ORDER.indexOf(m.model.raise_to) > LEVEL_ORDER.indexOf(level)) {
    model.raise_to = m.model.raise_to;
    protocol.push(`When the work needs the higher level of the model, run once: ${command} raise ${task.id}.`);
  }
  const input: TaskInput = { task: task.id, scenario: m.name, title: m.title, collected: collected ?? {}, report, writes: task.envelope, model, protocol };
  if (m.description !== undefined) input.description = m.description;
  if (task.instructions !== undefined) input.instructions = task.instructions;
  return input;
}
