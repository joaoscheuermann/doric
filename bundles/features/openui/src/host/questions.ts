// `openui.questions/v1` (host, conversation-openui.md D22): the state and the
// answer of a question fence. A question is the prompt that wrote its fence
// and the digest of its parsed questions; the durable record is the Thread's
// log, folded again on every call. The answer checks and `formatAnswers` are
// copied from `threads`' `ask` with their behavior unchanged.

import { createHash } from 'node:crypto';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  EventsV1,
  type Services,
} from 'bundle/contracts';
import { RuntimeThreadsV1 } from 'runtime/contracts';

import {
  type AskAnswer,
  type AskInput,
  type AskQuestion,
  answeredEvent,
  OpenuiQuestionsV1,
  openuiQuestionsMethods,
  type QuestionAnswerInput,
  type QuestionRef,
  type QuestionState,
} from '../contracts/index.js';

/** The Project and the Thread whose log a call folds. */
interface ThreadScope {
  readonly projectId: string;
  readonly threadId: string;
}

const scopeOf = (call: Call): ThreadScope => {
  const { projectId, threadId } = call.scope ?? {};

  if (projectId === undefined || threadId === undefined) {
    throw new ContractError(
      'invalid_scope',
      'openui.questions/v1 needs a call scope with a project and a Thread.',
    );
  }

  return { projectId, threadId };
};

/** Hex SHA-256 of the parsed questions' JSON. */
const digestOf = (questions: AskInput): string =>
  createHash('sha256').update(JSON.stringify(questions)).digest('hex');

/** A row's event without its `type` key, as the payload schemas expect it. */
const payloadOf = (event: unknown): unknown =>
  typeof event === 'object' && event !== null
    ? Object.fromEntries(
        Object.entries(event).filter(([key]) => key !== 'type'),
      )
    : event;

/** The question's state from the first matching answered row of the scope's Thread. */
const readState = async (
  services: Services,
  call: Call,
  scope: ThreadScope,
  promptId: string,
  digest: string,
): Promise<QuestionState> => {
  const log = await services
    .use(RuntimeThreadsV1)
    .threadEvents({ id: scope.threadId, afterSequence: 0 }, call);

  for (const entry of log?.events ?? []) {
    if (
      entry.projectId !== scope.projectId ||
      entry.threadId !== scope.threadId ||
      entry.type !== answeredEvent.type
    ) {
      continue;
    }
    const parsed = answeredEvent.payload.safeParse(payloadOf(entry.event));
    if (
      parsed.success &&
      parsed.data.questionPromptId === promptId &&
      parsed.data.digest === digest
    ) {
      return { state: 'answered', answers: parsed.data.answers };
    }
  }

  return { state: 'pending' };
};

const invalid = (message: string): ContractError =>
  new ContractError('invalid_input', message);

/** Throws `invalid_input` unless the answers fit the questions. */
const checkAnswers = (
  questions: readonly AskQuestion[],
  answers: readonly AskAnswer[],
): void => {
  const answered = new Set<string>();

  for (const answer of answers) {
    const question = questions.find(({ id }) => id === answer.id);

    if (question === undefined) {
      throw invalid(`The ask has no question "${answer.id}".`);
    }

    if (answered.has(answer.id)) {
      throw invalid(`The question "${answer.id}" is answered twice.`);
    }

    answered.add(answer.id);

    const labels = question.options.map(({ label }) => label);

    if (answer.options.some((label) => !labels.includes(label))) {
      throw invalid(`An answer to "${answer.id}" names an unknown option.`);
    }

    if (new Set(answer.options).size !== answer.options.length) {
      throw invalid(`An answer to "${answer.id}" names an option twice.`);
    }

    if (question.multiSelect !== true && answer.options.length > 1) {
      throw invalid(`The question "${answer.id}" takes one option at most.`);
    }

    if (answer.other !== undefined && question.allowOther === false) {
      throw invalid(`The question "${answer.id}" takes no free answer.`);
    }
  }

  const missing = questions.filter(({ id }) => !answered.has(id));

  if (missing.length > 0) {
    throw invalid(
      `Unanswered questions: ${missing.map(({ id }) => id).join(', ')}.`,
    );
  }
};

/**
 * The text the answers reach the Thread as.
 * - It starts with `Answers to your questions:` and a blank line.
 * - Then, for each question in order, `${n}. ${question}` (n from 1) and on
 *   the next line `   ${values}`.
 * - `values` are the selected labels in the question's option order, then
 *   the trimmed `other` when it is not blank, joined with `; `. A newline
 *   inside a value becomes `\n   `, so it stays indented.
 * - A skipped question (no label, `other` blank or absent) gets `(skipped)`.
 * - Items are joined with `\n`, with no trailing newline.
 */
export const formatAnswers = (
  questions: readonly AskQuestion[],
  answers: readonly AskAnswer[],
): string => {
  const items = questions.map((question, index) => {
    const answer = answers.find(({ id }) => id === question.id);
    const other = answer?.other?.trim();
    const values = [
      ...question.options
        .map(({ label }) => label)
        .filter((label) => answer?.options.includes(label)),
      ...(other ? [other] : []),
    ]
      .join('; ')
      .replaceAll('\n', '\n   ');

    return `${index + 1}. ${question.question}\n   ${values || '(skipped)'}`;
  });

  return `Answers to your questions:\n\n${items.join('\n')}`;
};

const unavailable = (details: unknown): ContractError =>
  new ContractError(
    'unavailable',
    'The Thread did not take the answers.',
    details,
  );

const reasonOf = (error: unknown): { readonly reason: string } => ({
  reason: error instanceof Error ? error.message : String(error),
});

/** Runs a runtime call; a rejection is `unavailable` with its reason. */
const routed = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw unavailable(reasonOf(error));
  }
};

/**
 * Sends the answers as the reader's next message by D20's route and answers
 * the prompt that took them: a steer of the running prompt, else a prompt,
 * after resuming a paused, empty queue. Anything else is `unavailable`.
 */
const send = async (
  services: Services,
  call: Call,
  scope: ThreadScope,
  prompt: string,
): Promise<string> => {
  const threads = services.use(RuntimeThreadsV1);
  const thread = await routed(() => threads.thread(scope.threadId, call));

  if (thread === undefined || thread.projectId !== scope.projectId) {
    throw unavailable({ status: 'missing' });
  }

  if (thread.origin === 'agent') throw unavailable({ status: 'forbidden' });

  if (thread.activePromptId !== undefined) {
    const result = await routed(() =>
      threads.steer(
        {
          id: scope.threadId,
          prompt,
          promptId: thread.activePromptId as string,
        },
        call,
      ),
    );

    if (result.status !== 'steered' && result.status !== 'queued') {
      throw unavailable({ status: result.status });
    }

    return result.promptId;
  }

  const queue = await routed(() => threads.queue(scope.threadId, call));

  if (queue === undefined) throw unavailable({ status: 'missing' });

  if (
    queue.paused &&
    queue.current === undefined &&
    queue.resumable === undefined &&
    queue.items.length === 0
  ) {
    const resumed = await routed(() =>
      threads.resumeQueue(scope.threadId, call),
    );

    if (resumed.status !== 'resumed') {
      throw unavailable({ status: resumed.status });
    }
  }

  const result = await routed(() =>
    threads.prompt({ id: scope.threadId, prompt }, call),
  );

  if (result.status !== 'accepted') {
    throw unavailable({ status: result.status });
  }

  return result.promptId;
};

/** Provides `openui.questions/v1`; both methods are exposed to the desktop. */
export const questionsService = () => {
  // The answer calls in flight, one chain per question, so they run one at a time.
  const chains = new Map<string, Promise<void>>();

  const oneAtATime = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const result = (chains.get(key) ?? Promise.resolve()).then(run);
    const release = (): void => {
      if (chains.get(key) === settled) chains.delete(key);
    };
    const settled: Promise<void> = result.then(release, release);

    chains.set(key, settled);

    return result;
  };

  return defineService(OpenuiQuestionsV1, {
    status: defineMethod({
      ...openuiQuestionsMethods.status,
      execute: async (
        input: QuestionRef,
        call: Call,
        services: Services,
      ): Promise<QuestionState> =>
        readState(
          services,
          call,
          scopeOf(call),
          input.promptId,
          digestOf(input.questions),
        ),
    }),
    answer: defineMethod({
      ...openuiQuestionsMethods.answer,
      execute: async (
        input: QuestionAnswerInput,
        call: Call,
        services: Services,
      ): Promise<QuestionState> => {
        const scope = scopeOf(call);
        const digest = digestOf(input.questions);

        return await oneAtATime(`${input.promptId}\n${digest}`, async () => {
          const state = await readState(
            services,
            call,
            scope,
            input.promptId,
            digest,
          );

          if (state.state === 'answered') return state;

          checkAnswers(input.questions.questions, input.answers);
          const promptId = await send(
            services,
            call,
            scope,
            formatAnswers(input.questions.questions, input.answers),
          );
          await services.use(EventsV1, { ...scope, promptId }).append(
            answeredEvent,
            {
              questionPromptId: input.promptId,
              digest,
              answers: [...input.answers],
            },
            call,
          );

          return { state: 'answered', answers: input.answers };
        });
      },
    }),
  });
};
