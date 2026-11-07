// The question service (conversation-openui.md D21, D22): the schemas copied
// from `threads`' `ask` (the source of the limits for questions from now on),
// `openui.questions/v1` and the `openui.answered/v1` event.

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

/** One choice of a question; `label` is unique within its question. */
export const askOptionSchema = z
  .object({
    label: text(120),
    description: text(300).optional(),
    recommended: z.boolean().optional(),
  })
  .strict();

/** One multiple-choice question: 2 to 6 options with distinct labels. */
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

/** A question form: 1 to 5 questions with distinct ids, and an optional `context`. */
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
export type AskOption = z.output<typeof askOptionSchema>;

/** The reader's answer to one question: the labels picked and the free answer. */
export const askAnswerSchema = z
  .object({
    id: z.string().min(1),
    options: z.array(z.string()),
    other: z.string().optional(),
  })
  .strict();

export type AskAnswer = z.output<typeof askAnswerSchema>;

/** One question: the prompt that wrote its fence and the questions the app parsed from it. */
export interface QuestionRef {
  /** The prompt that wrote the question fence: the first part of its key (D2). */
  readonly promptId: string;
  /** The questions as the app parsed them from the closed fence (D21). */
  readonly questions: AskInput;
}

export interface QuestionAnswerInput extends QuestionRef {
  readonly answers: readonly AskAnswer[];
}

export type QuestionState =
  | { readonly state: 'pending' }
  | { readonly state: 'answered'; readonly answers: readonly AskAnswer[] };

export const questionRefSchema = z
  .object({ promptId: z.string().min(1), questions: askInputSchema })
  .strict();

export const questionAnswerInputSchema = z
  .object({
    promptId: z.string().min(1),
    questions: askInputSchema,
    answers: z.array(askAnswerSchema),
  })
  .strict();

export const questionStateSchema: z.ZodType<QuestionState, QuestionState> =
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('pending') }).strict(),
    z
      .object({
        state: z.literal('answered'),
        answers: z.array(askAnswerSchema),
      })
      .strict(),
  ]);

/**
 * `openui.questions/v1` (host), both methods exposed to the desktop with the
 * scope `projectId`, `threadId`. A question is its `promptId` and the SHA-256
 * of its parsed `questions`; the same questions of another prompt are another
 * question.
 *
 * Errors (`ContractError` codes): `invalid_scope` when the call scope lacks
 * the Project or the Thread; `invalid_input` for an input that fails its
 * schema, or answers that do not fit the questions; `unavailable` ("The Thread
 * did not take the answers.") when the answers were not sent, with `details`
 * `{ status }` or `{ reason }`. A rejected log read or append rejects with
 * that error.
 *
 * What stays true: the first answer is final; answers are sent to the Thread
 * at most once per accepted call, and recorded only after they were sent.
 */
export interface Questions {
  /** `answered` with the answers of the first matching `openui.answered/v1` row of the Thread's log, else `pending`. */
  status(input: QuestionRef, call?: CallArg): Promise<QuestionState>;
  /**
   * Answers a pending question: sends the formatted answers as the reader's
   * next message by the composer's route, then appends `openui.answered/v1`
   * under the prompt that took them, and answers `answered`. An already
   * answered question is returned unchanged, without sending. An agent's
   * Thread, an unknown one or one of another Project is `unavailable` with
   * nothing sent. Calls for one question run one at a time.
   */
  answer(input: QuestionAnswerInput, call?: CallArg): Promise<QuestionState>;
}

export const openuiQuestionsMethods = {
  status: {
    input: questionRefSchema,
    output: questionStateSchema,
    expose: 'desktop',
  },
  answer: {
    input: questionAnswerInputSchema,
    output: questionStateSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

export const OpenuiQuestionsV1 = ref<Questions>('openui.questions/v1');

/**
 * The reader's answers reached the Thread: written under the prompt that took
 * them, naming the question's prompt and digest (hex SHA-256 of the parsed
 * questions' JSON). The first row of a question is the final answer.
 */
export const answeredEvent = defineEvent({
  type: 'openui.answered/v1',
  payload: z
    .object({
      questionPromptId: z.string().min(1),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      answers: z.array(askAnswerSchema),
    })
    .strict(),
});
