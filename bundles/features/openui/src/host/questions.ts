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
  type Services,
} from 'bundle/contracts';

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
import { kernelOpenuiPorts, type OpenuiPorts } from './ports.js';

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
  ports: OpenuiPorts,
  call: Call,
  scope: ThreadScope,
  promptId: string,
  digest: string,
): Promise<QuestionState> => {
  const rows = await ports.threads.rows(scope.threadId, call);

  for (const entry of rows) {
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
  ports: OpenuiPorts,
  call: Call,
  scope: ThreadScope,
  prompt: string,
): Promise<string> => {
  const { threads } = ports;
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

/**
 * The two question operations over ports, with the per-question queue: answer
 * calls for one question (prompt id and digest) run one at a time across both
 * entries' callers of this object.
 *
 * - `status`: `answered` with the answers of the first `openui.answered/v1`
 *   row of the call's Thread (same Project) whose `questionPromptId` and
 *   `digest` match, else `pending`. Reads the log once; writes nothing.
 * - `answer`: an already answered question answers that state, sending
 *   nothing. Otherwise checks the answers, sends `formatAnswers(...)` by
 *   today's route (steer of the active prompt; else prompt, after resuming a
 *   paused, empty queue), then appends the row under the prompt that took
 *   them, and answers `answered` with the input's answers.
 *
 * Errors (`ContractError`): `invalid_scope` when `call.scope` lacks
 * `projectId` or `threadId`; `invalid_input` for answers that do not fit;
 * `unavailable` "The Thread did not take the answers." with `{status}`
 * (missing Thread, other Project, an agent's Thread, a refused
 * steer/resume/prompt) or `{reason}` (a rejected runtime call, its message);
 * a rejected log read or append rejects with that error. What stays true: the
 * first answer is final; answers are sent at most once per accepted call and
 * recorded only after they were sent.
 */
export interface QuestionOperations {
  status(
    ports: OpenuiPorts,
    input: QuestionRef,
    call: Call,
  ): Promise<QuestionState>;
  answer(
    ports: OpenuiPorts,
    input: QuestionAnswerInput,
    call: Call,
  ): Promise<QuestionState>;
}

/** Creates the operations with an empty queue. No I/O; never throws. */
export const createQuestions = (): QuestionOperations => {
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

  return {
    status: async (ports, input, call) =>
      readState(
        ports,
        call,
        scopeOf(call),
        input.promptId,
        digestOf(input.questions),
      ),
    answer: async (ports, input, call) => {
      const scope = scopeOf(call);
      const digest = digestOf(input.questions);

      return await oneAtATime(`${input.promptId}\n${digest}`, async () => {
        const state = await readState(
          ports,
          call,
          scope,
          input.promptId,
          digest,
        );

        if (state.state === 'answered') return state;

        checkAnswers(input.questions.questions, input.answers);
        const promptId = await send(
          ports,
          call,
          scope,
          formatAnswers(input.questions.questions, input.answers),
        );
        await ports.appendAnswered(
          { ...scope, promptId },
          {
            questionPromptId: input.promptId,
            digest,
            answers: input.answers,
          },
          call,
        );

        return { state: 'answered', answers: input.answers };
      });
    },
  };
};

/** Kernel: provides `openui.questions/v1` over `createQuestions()` with `kernelOpenuiPorts(services)` per call; both methods are exposed to the desktop. */
export const questionsService = () => {
  const questions = createQuestions();

  return defineService(OpenuiQuestionsV1, {
    status: defineMethod({
      ...openuiQuestionsMethods.status,
      execute: (
        input: QuestionRef,
        call: Call,
        services: Services,
      ): Promise<QuestionState> =>
        questions.status(kernelOpenuiPorts(services), input, call),
    }),
    answer: defineMethod({
      ...openuiQuestionsMethods.answer,
      execute: (
        input: QuestionAnswerInput,
        call: Call,
        services: Services,
      ): Promise<QuestionState> =>
        questions.answer(kernelOpenuiPorts(services), input, call),
    }),
  });
};
