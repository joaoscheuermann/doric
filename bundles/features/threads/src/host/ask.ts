// `threads.ask/v1` (host): the state and the answer of an ask. The durable
// record is the call's Thread log and nothing else: `status` and `answer`
// fold the `threads.asked/v1` and `threads.answered/v1` rows again on every
// call, through `runtime.threads/v1.threadEvents`.

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  EventsV1,
  type Services,
} from 'bundle/contracts';
import { RuntimeThreadsV1, type ThreadEvent } from 'runtime/contracts';

import {
  type AskAnswer,
  type AskAnswerInput,
  type AskQuestion,
  type AskRef,
  type AskState,
  AskV1,
  answeredEvent,
  askedEvent,
  askMethods,
} from '../contracts/index.js';

/** The Project and the Thread whose log a call folds. */
interface ThreadScope {
  readonly projectId: string;
  readonly threadId: string;
}

const scopeError = (needs: string): ContractError =>
  new ContractError(
    'invalid_scope',
    `threads.ask/v1 needs a call scope with ${needs}.`,
  );

/** The scope `status` reads: the Project and the Thread. */
const readScope = (call: Call): ThreadScope => {
  const { projectId, threadId } = call.scope ?? {};

  if (projectId === undefined || threadId === undefined) {
    throw scopeError('a project and a Thread');
  }

  return { projectId, threadId };
};

/** The scope `answer` writes in: the answered row needs a prompt too. */
const writeScope = (call: Call): ThreadScope => {
  if (call.scope?.promptId === undefined) {
    throw scopeError('a project, a Thread and a prompt');
  }

  return readScope(call);
};

/** One ask as the log records it. */
interface RecordedAsk {
  /** The prompt its asked row was written under. */
  readonly promptId: string;
  readonly questions: readonly AskQuestion[];
  /** The answers of its first answered row. */
  answers?: readonly AskAnswer[];
  /** Whether a later asked row of the Thread exists. */
  superseded: boolean;
}

/** A row's event without its `type` key, as the payload schemas expect it. */
const payloadOf = (event: unknown): unknown =>
  typeof event === 'object' && event !== null
    ? Object.fromEntries(
        Object.entries(event).filter(([key]) => key !== 'type'),
      )
    : event;

/**
 * Folds one Thread's rows into its asks, in log order: an asked row records
 * an ask and supersedes the earlier ones, an answered row sets the answers of
 * a known ask once. A row that does not parse is skipped.
 */
const fold = (events: readonly ThreadEvent[]): Map<string, RecordedAsk> => {
  const asks = new Map<string, RecordedAsk>();

  for (const entry of events) {
    if (entry.type === askedEvent.type) {
      const parsed = askedEvent.payload.safeParse(payloadOf(entry.event));

      if (!parsed.success || asks.has(parsed.data.askId)) continue;

      for (const ask of asks.values()) ask.superseded = true;

      asks.set(parsed.data.askId, {
        promptId: entry.promptId,
        questions: parsed.data.questions,
        superseded: false,
      });
    } else if (entry.type === answeredEvent.type) {
      const parsed = answeredEvent.payload.safeParse(payloadOf(entry.event));

      if (!parsed.success) continue;

      const ask = asks.get(parsed.data.askId);

      if (ask !== undefined && ask.answers === undefined) {
        ask.answers = parsed.data.answers;
      }
    }
  }

  return asks;
};

/** The ask of the scope's Thread with this id, read from its log. */
const recordedAsk = async (
  services: Services,
  call: Call,
  scope: ThreadScope,
  askId: string,
): Promise<RecordedAsk> => {
  const log = await services
    .use(RuntimeThreadsV1)
    .threadEvents({ id: scope.threadId, afterSequence: 0 }, call);

  const ask = fold(
    (log?.events ?? []).filter(
      (entry) =>
        entry.projectId === scope.projectId &&
        entry.threadId === scope.threadId,
    ),
  ).get(askId);

  if (ask === undefined) {
    throw new ContractError('not_found', `No ask "${askId}" in this Thread.`);
  }

  return ask;
};

const stateOf = (ask: RecordedAsk): AskState => {
  if (ask.answers !== undefined) {
    return { state: 'answered', answers: ask.answers };
  }

  return ask.superseded ? { state: 'superseded' } : { state: 'pending' };
};

const invalid = (message: string): ContractError =>
  new ContractError('invalid_input', message);

/** Throws `invalid_input` unless the answers fit the recorded questions. */
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
 * - Then, for each recorded question in order, `${n}. ${question}`
 *   (n from 1) and on the next line `   ${values}`.
 * - `values` are the selected labels in the question's option order, then
 *   the trimmed `other` when it is not blank, joined with `; `. A newline
 *   inside a value becomes `\n   `, so it stays indented.
 * - A skipped question (no label, `other` blank or absent) gets `(skipped)`.
 * - Items are joined with `\n`, with no trailing newline.
 *
 * Expects answers already checked against the questions (`Ask.answer`).
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

/**
 * Sends the answers to the Thread: into its running prompt, or the ask's own
 * prompt when none runs. Anything but steered or queued is `unavailable`.
 */
const send = async (
  services: Services,
  call: Call,
  threadId: string,
  ask: RecordedAsk,
  answers: readonly AskAnswer[],
): Promise<void> => {
  const threads = services.use(RuntimeThreadsV1);
  const thread = await threads.thread(threadId, call);
  const result = await threads
    .steer(
      {
        id: threadId,
        prompt: formatAnswers(ask.questions, answers),
        promptId: thread?.activePromptId ?? ask.promptId,
      },
      call,
    )
    .catch((error: unknown) => {
      throw unavailable({
        reason: error instanceof Error ? error.message : String(error),
      });
    });

  if (result.status !== 'steered' && result.status !== 'queued') {
    throw unavailable({ status: result.status });
  }
};

/** Provides `threads.ask/v1`; both methods are exposed to the desktop. */
export const askService = () => {
  // The answer calls in flight, one chain per askId, so they run one at a time.
  const chains = new Map<string, Promise<void>>();

  const oneAtATime = <T>(askId: string, run: () => Promise<T>): Promise<T> => {
    const result = (chains.get(askId) ?? Promise.resolve()).then(run);
    const release = (): void => {
      if (chains.get(askId) === settled) chains.delete(askId);
    };
    const settled: Promise<void> = result.then(release, release);

    chains.set(askId, settled);

    return result;
  };

  return defineService(AskV1, {
    status: defineMethod({
      expose: 'desktop',
      ...askMethods.status,
      execute: async (
        input: AskRef,
        call: Call,
        services: Services,
      ): Promise<AskState> =>
        stateOf(
          await recordedAsk(services, call, readScope(call), input.askId),
        ),
    }),
    answer: defineMethod({
      expose: 'desktop',
      ...askMethods.answer,
      execute: (
        input: AskAnswerInput,
        call: Call,
        services: Services,
      ): Promise<AskState> =>
        oneAtATime(input.askId, async () => {
          const scope = writeScope(call);
          const ask = await recordedAsk(services, call, scope, input.askId);
          const state = stateOf(ask);

          if (state.state !== 'pending') return state;

          checkAnswers(ask.questions, input.answers);
          await send(services, call, scope.threadId, ask, input.answers);
          await services
            .use(EventsV1)
            .append(
              answeredEvent,
              { askId: input.askId, answers: [...input.answers] },
              call,
            );

          return { state: 'answered', answers: input.answers };
        }),
    }),
  });
};
