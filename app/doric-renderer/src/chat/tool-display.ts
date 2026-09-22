import type { PromptSegment, ToolSegment, ToolStatus } from './projector';

/** Shown when a turn ended while its call was still running. */
export const NO_RESULT = 'no result recorded';

/** Default result length before a call is truncated behind `show all`. */
export const RESULT_PREVIEW_LIMIT = 2000;

/**
 * `incomplete` is the display-only status for a call the turn left running:
 * the model never reported a result, so the row stops pulsing and says so.
 */
export type ToolDisplayStatus = ToolStatus | 'incomplete';

export const toolStatus = (
  segment: ToolSegment,
  terminal: boolean,
): ToolDisplayStatus =>
  segment.status === 'running' && terminal ? 'incomplete' : segment.status;

/** Pretty-prints JSON output so `terminal` payloads stay readable. */
export const prettyResult = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** Clamps a result to the preview length; a shorter result is unchanged. */
const previewResult = (text: string): string =>
  text.length > RESULT_PREVIEW_LIMIT
    ? text.slice(0, RESULT_PREVIEW_LIMIT)
    : text;

/**
 * The text a tool row shows once expanded. A running call has no result yet;
 * a failing call shows its error, and a finished one shows its output.
 */
export const resultText = (
  segment: ToolSegment,
  status: ToolDisplayStatus,
  showAll: boolean,
): string => {
  if (status === 'running' || status === 'incomplete') return '';
  const source = status === 'failed' ? segment.error : segment.result;
  const full = prettyResult(source ?? '');
  return showAll ? full : previewResult(full);
};

/**
 * The one call marked as active: the most recent tool still running. A
 * terminal turn has no active call, so its incomplete rows stop pulsing.
 */
export const activeCallId = (
  segments: readonly PromptSegment[],
  terminal: boolean,
): string | undefined => {
  if (terminal) return undefined;
  for (let position = segments.length - 1; position >= 0; position -= 1) {
    const segment = segments[position];
    if (segment?.kind === 'tool' && segment.status === 'running') {
      return segment.callId;
    }
  }
  return undefined;
};

/** A live turn pulses its thinking word only while reasoning trails the turn. */
export const isReasoning = (
  segments: readonly PromptSegment[],
  terminal: boolean,
): boolean => !terminal && segments.at(-1)?.kind === 'thinking';

/** Index of the last text segment, or `-1` when the turn has no text. */
export const lastTextIndex = (segments: readonly PromptSegment[]): number => {
  for (let position = segments.length - 1; position >= 0; position -= 1) {
    if (segments[position]?.kind === 'text') return position;
  }
  return -1;
};
