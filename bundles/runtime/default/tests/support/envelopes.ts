import type { ProviderMessage } from 'llms';

/*
 * The history messages a real agent run stores, written out the way the
 * `agent` package frames them (`toolResultEnvelope`, `toolFailureEnvelope`),
 * so a test can seed or inspect a history that holds earlier `load_skill`
 * calls without running them.
 */

/** A block fenced with one more backtick than its longest run (at least three), as the agent fences. */
export const fenced = (value: string): string => {
  const longest = Math.max(
    0,
    ...[...value.matchAll(/`+/gu)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = value.endsWith('\n') ? value : `${value}\n`;
  return `${fence}text\n${body}${fence}`;
};

/** The model's turn that calls `name` with `input`, under the call id `id`. */
export const toolCall = (
  id: string,
  name: string,
  input: object = {},
): ProviderMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: JSON.stringify(input) }],
});

/** The model's turn that calls `load_skill` for `locator`. */
export const loadCall = (id: string, locator: string): ProviderMessage =>
  toolCall(id, 'load_skill', { name: locator });

/** A successful tool result answering call `id`, as the agent stores it. */
export const toolResult = (
  id: string,
  output: string,
  status?: 'incomplete',
): ProviderMessage => ({
  role: 'tool',
  toolCallId: id,
  content: [
    '# Tool Result',
    '',
    '## Observation ID',
    '',
    fenced(`observation-${id}`),
    '',
    '## Output',
    '',
    fenced(output),
  ].join('\n'),
  ...(status === undefined ? {} : { toolResultStatus: status }),
});

/** A failed tool call `id`, as the agent stores it. */
export const toolFailure = (id: string, failure: string): ProviderMessage => ({
  role: 'tool',
  toolCallId: id,
  content: [
    '# Tool Failure',
    '',
    'The tool call failed and returned no result.',
    '',
    '## Error',
    '',
    fenced(failure),
  ].join('\n'),
});

/** What `load_skill` answers for a skill: its heading, then its parts. */
export const skillText = (locator: string, ...parts: readonly string[]) =>
  [`# Skill: ${locator}`, ...parts].join('\n\n');

/** An instruction of the `default` bundle with `body`, in its input envelope. */
export const defaultInstruction = (reason: string, body: string): string =>
  `<bundle-instruction bundle="default" reason="${reason}">\n${body}\n</bundle-instruction>`;

/** One entry of a loaded-skills message: the skill's text in a `text` fence. */
export const loadedEntry = (text: string): string => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};
