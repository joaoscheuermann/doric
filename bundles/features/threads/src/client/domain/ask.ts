// The question block's pure part (DORIC-83): the projector that turns a
// `threads.asked/v1` row into one `threads.question/v1` block, the picks the
// reader makes and the answers they become, and which live rows make an open
// block read its ask's status again. No DOM, React or services.

import {
  type AskAnswer,
  type AskQuestion,
  answeredEvent,
  askedEvent,
} from '../../contracts/index.js';
import type { ChatThreadEvent, ProjectorSpec } from '../chat-contract.js';

/** The block type of one ask in the conversation; `threads-ask` draws it. */
export const ASK_BLOCK = 'threads.question/v1';

/** What an ask block carries: the asked row's payload and the Thread it came from. */
interface QuestionData {
  readonly askId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly context?: string;
  readonly questions: readonly AskQuestion[];
}

/** An ask block as the element reads it. `promptId` is the asked row's prompt, the scope `status` and `answer` are called with. */
export interface QuestionBlock {
  readonly promptId: string;
  readonly sequence: number;
  readonly data: QuestionData;
}

/** A row's event without its `type` key, as the payload schemas expect it. */
const payloadOf = (event: unknown): unknown =>
  typeof event === 'object' && event !== null
    ? Object.fromEntries(
        Object.entries(event).filter(([key]) => key !== 'type'),
      )
    : event;

/** The ask's data, when `payload` is an asked row's payload; `undefined` otherwise. */
const questionData = (
  payload: unknown,
  thread: { readonly projectId: unknown; readonly threadId: unknown },
): QuestionData | undefined => {
  if (
    typeof thread.projectId !== 'string' ||
    typeof thread.threadId !== 'string'
  )
    return undefined;
  const parsed = askedEvent.payload.safeParse(payload);
  if (!parsed.success) return undefined;
  const { askId, context, questions } = parsed.data;
  return {
    askId,
    projectId: thread.projectId,
    threadId: thread.threadId,
    ...(context === undefined ? {} : { context }),
    questions,
  };
};

/**
 * The projector of asks. It claims `threads.asked/v1` and `threads.answered/v1`,
 * so neither becomes a generic block. The state is the set of askIds already drawn.
 * - A `threads.asked/v1` row whose payload, without its `type` key, parses
 *   with `askedEvent.payload`, and whose askId is not in the state yet, gives
 *   one block: `{ id: `ask:${askId}`, type: ASK_BLOCK, promptId, sequence, data: QuestionData }`,
 *   taken from the row. Its askId joins the state.
 * - A repeated askId, a row that does not parse, a `threads.answered/v1` row
 *   and any other type give no block and leave the state as it was.
 * Never throws. Pure: never changes the state it receives; the same events
 * always give the same blocks. Pending/answered/superseded is not projected;
 * the block reads it from the host.
 */
export const askProjector: ProjectorSpec<ReadonlySet<string>> = {
  eventTypes: [askedEvent.type, answeredEvent.type],
  initial: () => new Set<string>(),
  reduce(state, event) {
    const none = { state, blocks: [] };
    if (event.type !== askedEvent.type) return none;
    const data = questionData(payloadOf(event.event), event);
    if (data === undefined || state.has(data.askId)) return none;
    return {
      state: new Set(state).add(data.askId),
      blocks: [
        {
          id: `ask:${data.askId}`,
          type: ASK_BLOCK,
          promptId: event.promptId,
          sequence: event.sequence,
          data,
        },
      ],
    };
  },
};

/** The ask block a value is, or `undefined` when it is not one `askProjector` made. Never throws. */
export const questionBlock = (block: unknown): QuestionBlock | undefined => {
  if (typeof block !== 'object' || block === null) return undefined;
  const { type, promptId, sequence, data } = block as Record<string, unknown>;
  if (
    type !== ASK_BLOCK ||
    typeof promptId !== 'string' ||
    typeof sequence !== 'number' ||
    typeof data !== 'object' ||
    data === null
  )
    return undefined;
  const { projectId, threadId, askId, context, questions } = data as {
    readonly [key: string]: unknown;
  };
  const parsed = questionData(
    { askId, context, questions },
    { projectId, threadId },
  );
  return parsed === undefined
    ? undefined
    : { promptId, sequence, data: parsed };
};

/** The pick that stands for the free answer. It is never sent as a label. */
export const OTHER = '__other__';

/** What the reader chose for one question: labels picked, plus `OTHER` when the free answer is picked; `other` is its text. */
interface Picked {
  readonly picked: readonly string[];
  readonly other?: string;
}

/** The reader's picks, by question id. */
export type Picks = Readonly<Record<string, Picked>>;

/** The free answer's text when its row is picked and the text is not blank. */
const freeText = (a: Picked | undefined): string | undefined =>
  a?.picked.includes(OTHER) && (a.other ?? '').trim().length > 0
    ? a.other
    : undefined;

/** Whether a question can be sent: an option picked, or `OTHER` picked with non-blank text. `undefined` is not filled. */
export const filled = (a: Picked | undefined): boolean =>
  a !== undefined &&
  (a.picked.some((p) => p !== OTHER) || freeText(a) !== undefined);

/** The one-line answer: picked labels, then the free text when `OTHER` is picked with non-empty text, joined by ", ". 'Skipped' when not `filled`. */
export const summary = (a: Picked | undefined): string => {
  if (a === undefined || !filled(a)) return 'Skipped';
  const words = a.picked.filter((p) => p !== OTHER);
  if (a.picked.includes(OTHER) && a.other) words.push(a.other);
  return words.join(', ');
};

/**
 * The answers `Ask.answer` takes, one per question, in `questions` order:
 * `options` = labels picked except `OTHER`; `other` only when `OTHER` is picked
 * and its text is not blank. A question without picks gives `{ id, options: [] }`.
 * Never throws.
 */
export const toAnswers = (
  questions: readonly AskQuestion[],
  picks: Picks,
): readonly AskAnswer[] =>
  questions.map(({ id }) => {
    const a = picks[id];
    const other = freeText(a);
    return {
      id,
      options: (a?.picked ?? []).filter((p) => p !== OTHER),
      ...(other === undefined ? {} : { other }),
    };
  });

/** The picks recorded answers stand for: each answer's labels, plus `OTHER` with its text when it carries `other`. */
export const fromAnswers = (answers: readonly AskAnswer[]): Picks =>
  Object.fromEntries(
    answers.map(({ id, options, other }) => [
      id,
      other === undefined
        ? { picked: options }
        : { picked: [...options, OTHER], other },
    ]),
  );

/**
 * Whether a live event of the ask's own Thread can change its status: a
 * `threads.answered/v1` row whose `askId` is `target.askId`, or a
 * `threads.asked/v1` row later than `target.sequence`. Never throws.
 */
export const rereadsStatus = (
  event: ChatThreadEvent,
  target: { readonly askId: string; readonly sequence: number },
): boolean => {
  if (event.type === askedEvent.type) return event.sequence > target.sequence;
  if (event.type !== answeredEvent.type) return false;
  const row = event.event;
  return (
    typeof row === 'object' &&
    row !== null &&
    'askId' in row &&
    row.askId === target.askId
  );
};
