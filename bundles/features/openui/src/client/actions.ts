// The text of a conversation action (conversation-openui.md D20), in the
// renderer chunk: what a click on a control sends to the agent through
// `chat.send/v1.sendAction`, or the line shown under the fence instead.

import type { ActionEvent } from '@openuidev/lang-core';

/** The most UTF-16 code units an action's text holds (`ChatActionInput.text`). */
export const MAX_ACTION_TEXT = 16_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** react-lang's `unwrapFieldValue`: a field object stands for its own `value`. */
const unwrap = (value: unknown): unknown =>
  isRecord(value) && Object.hasOwn(value, 'value') ? value.value : value;

/** A value as its line writes it, or `undefined` to leave the line out. */
const written = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  try {
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
};

/** `<key>: <value>` lines of `entries`, without the values that write nothing. */
const linesOf = (entries: readonly (readonly [string, unknown])[]): string[] =>
  entries.flatMap(([key, value]) => {
    const text = written(value);
    return text === undefined ? [] : [`${key}: ${text}`];
  });

const parameterLines = (params: Record<string, unknown>): string[] => [
  ...linesOf(
    params.context === undefined ? [] : [['context', params.context] as const],
  ),
  ...linesOf(Object.entries(params).filter(([key]) => key !== 'context')),
];

const valueLines = (event: ActionEvent): string[] => {
  const state = event.formState ?? {};
  if (event.formName !== undefined) {
    const form = state[event.formName];
    if (!isRecord(form)) return [];
    return linesOf(
      Object.entries(form).map(
        ([field, value]) =>
          [`${event.formName}.${field}`, unwrap(value)] as const,
      ),
    );
  }
  return linesOf(
    Object.entries(state)
      .filter(([key]) => key.startsWith('$'))
      .map(([key, value]) => [key, unwrap(value)] as const),
  );
};

/** D20's text for `event`, or the line under the fence when nothing is sent. */
export const actionText = (
  event: ActionEvent,
): { readonly send: string } | { readonly line: string } => {
  if (event.type === 'open_url') {
    return { line: String(event.params.url ?? '') };
  }
  if (event.type !== 'continue_conversation') {
    return { line: `Not sent: action type ${event.type} is not supported` };
  }
  const message = event.humanFriendlyMessage.trim();
  if (message === '') return { line: 'Not sent: the action has no message' };

  const sections = [message];
  const parameters = parameterLines(event.params);
  if (parameters.length > 0) sections.push(parameters.join('\n'));
  const values = valueLines(event);
  if (values.length > 0) sections.push(values.join('\n'));

  const text = sections.join('\n\n');
  if (text.length > MAX_ACTION_TEXT) {
    return { line: "Not sent: the action's text is over 16,000 characters" };
  }
  return { send: text };
};
