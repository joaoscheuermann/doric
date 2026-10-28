// Public contracts of the `threads` bundle. The delegation tools reach the
// runtime through `runtime.threads/v1`; what this bundle publishes is the ask
// of a main Thread to its user (DORIC-82): the `ask` tool writes
// `threads.asked/v1` into the Thread, the chat shows it as an interactive
// block, and `threads.ask/v1` answers it, writing `threads.answered/v1`.
//
// The Thread event log is the only record: every read folds the rows of the
// call's Thread again, so a restarted host, a replay or a rewind answers what
// the log holds.

import {
  type CallArg,
  defineEvent,
  type MethodSpecs,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

/** A non-blank string of at most `max` characters. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, {
      message: 'Must not be blank.',
    });

/** Whether no two items share a key. */
const distinct = <T>(items: readonly T[], key: (item: T) => string): boolean =>
  new Set(items.map(key)).size === items.length;

// The ask ----------------------------------------------------------------------

/**
 * One choice of a question. `label` is what an answer names it by, unique
 * within its question; `recommended` marks the options the agent advises.
 */
export const askOptionSchema = z
  .object({
    label: text(120),
    description: text(300).optional(),
    recommended: z.boolean().optional(),
  })
  .strict();

/**
 * One multiple-choice question: 2 to 6 options with distinct labels. `id` is
 * what its answer names it by, unique within the ask. `multiSelect` absent
 * means single-select (at most one label); `allowOther` absent means a free
 * answer is accepted beside or instead of the options.
 */
export const askQuestionSchema = z
  .object({
    id: text(64),
    question: text(500),
    options: z
      .array(askOptionSchema)
      .min(2)
      .max(6)
      .refine((options) => distinct(options, (option) => option.label), {
        message: 'Option labels must be unique within a question.',
      }),
    multiSelect: z.boolean().optional(),
    allowOther: z.boolean().optional(),
  })
  .strict();

/**
 * The `ask` tool's input: 1 to 5 questions with distinct ids, and an optional
 * `context` shown above them. Its uniqueness checks run at parse time; the
 * JSON Schema the model sees carries the lengths and counts only.
 */
export const askInputSchema = z
  .object({
    context: text(1000).optional(),
    questions: z
      .array(askQuestionSchema)
      .min(1)
      .max(5)
      .refine((questions) => distinct(questions, (question) => question.id), {
        message: 'Question ids must be unique within an ask.',
      }),
  })
  .strict();

export type AskInput = z.output<typeof askInputSchema>;
export type AskQuestion = z.output<typeof askQuestionSchema>;

// The answer -------------------------------------------------------------------

/**
 * The user's answer to one question: `id` names the question, `options` the
 * labels picked (possibly none), `other` the free answer when given. This is
 * the shape only; whether it fits the question is `Ask.answer`'s to check.
 */
export const askAnswerSchema = z
  .object({
    id: z.string().min(1),
    options: z.array(z.string()),
    other: z.string().optional(),
  })
  .strict();

export type AskAnswer = z.output<typeof askAnswerSchema>;

/**
 * Where an ask stands, folded from its Thread's log: `answered` with the
 * answers that were sent (the first answer wins and is final, even after a
 * later ask), else `superseded` when a later ask of the same Thread exists,
 * else `pending`.
 */
export type AskState =
  | { readonly state: 'pending' }
  | { readonly state: 'answered'; readonly answers: readonly AskAnswer[] }
  | { readonly state: 'superseded' };

export const askStateSchema: z.ZodType<AskState, AskState> =
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('pending') }).strict(),
    z
      .object({
        state: z.literal('answered'),
        answers: z.array(askAnswerSchema),
      })
      .strict(),
    z.object({ state: z.literal('superseded') }).strict(),
  ]);

/** One ask of the call's Thread, by the id its `threads.asked/v1` row carries. */
export interface AskRef {
  readonly askId: string;
}

/** The answers to one ask: one per question it recorded. */
export interface AskAnswerInput extends AskRef {
  readonly answers: readonly AskAnswer[];
}

export const askRefSchema: z.ZodType<AskRef, AskRef> = z
  .object({ askId: z.uuid() })
  .strict();

export const askAnswerInputSchema: z.ZodType<AskAnswerInput, AskAnswerInput> = z
  .object({ askId: z.uuid(), answers: z.array(askAnswerSchema) })
  .strict();

/**
 * `threads.ask/v1` (host), cardinality `one`, both methods exposed to the
 * desktop. The call's Thread is the scope: an ask is only read or answered in
 * the Thread whose log holds its `threads.asked/v1` row, so an askId of
 * another Thread or Project is `not_found`.
 *
 * Errors (`ContractError` codes): `invalid_scope` when the call scope lacks a
 * key the method needs; `not_found` for an askId the Thread's log does not
 * hold; `invalid_input` for answers that do not fit the recorded questions;
 * `unavailable` when the Thread did not take the answers.
 *
 * What stays true: at most one input is sent to the Thread per ask, and an ask
 * is recorded answered only after its input was sent. A refused send records
 * nothing, so the ask stays pending and can be answered again.
 */
export interface Ask {
  /**
   * Where the ask stands. Needs a scope with the Project and the Thread.
   * Folds the call's Thread log: its `threads.asked/v1` and
   * `threads.answered/v1` rows, each parsed without its `type` key, skipping
   * rows that do not parse. The result is `answered` when an answered row
   * exists (the first one wins), else `superseded` when a later asked row
   * exists, else `pending`. An askId with no asked row is `not_found`.
   */
  status(input: AskRef, call?: CallArg): Promise<AskState>;
  /**
   * Answers a pending ask. Needs a scope with the Project, the Thread and the
   * prompt the answered row is written under. Calls for the same askId run one
   * at a time.
   *
   * An ask already answered or superseded returns its state as is, without
   * checking the answers or sending anything. Otherwise the answers must:
   * give every recorded question exactly one answer, with no unknown or
   * repeated id; name only labels of that question, each once; name at most
   * one label on a single-select question; carry `other` only where
   * `allowOther` is not `false`; and pick at least one label or give a
   * non-blank `other`. Any violation is `invalid_input`.
   *
   * The answers are then sent to the Thread as one user input
   * (`formatAnswers`), steering its running prompt, or the ask's own prompt
   * when none runs. A result other than steered or queued, or a thrown send,
   * fails `unavailable` and records nothing. Once sent, `threads.answered/v1`
   * is written and the call returns `{ state: 'answered', answers }`.
   */
  answer(input: AskAnswerInput, call?: CallArg): Promise<AskState>;
}

export const askMethods = {
  status: { input: askRefSchema, output: askStateSchema },
  answer: { input: askAnswerInputSchema, output: askStateSchema },
} as const satisfies MethodSpecs;

export const AskV1 = ref<Ask>('threads.ask/v1');

// Events -----------------------------------------------------------------------

/**
 * The agent asked the user, written by the `ask` tool under the asking prompt.
 * `questions` is the validated tool input. The row's `promptId` is the prompt
 * the answers go back to when nothing runs. A later asked row of the same
 * Thread supersedes this ask if it is still unanswered.
 */
export const askedEvent = defineEvent({
  type: 'threads.asked/v1',
  payload: z
    .object({
      askId: z.uuid(),
      context: z.string().optional(),
      questions: z.array(askQuestionSchema),
    })
    .strict(),
});

/**
 * The user's answers reached the Thread, written by `Ask.answer` after the
 * send. The first answered row of an ask is the final one.
 */
export const answeredEvent = defineEvent({
  type: 'threads.answered/v1',
  payload: z
    .object({ askId: z.uuid(), answers: z.array(askAnswerSchema) })
    .strict(),
});
