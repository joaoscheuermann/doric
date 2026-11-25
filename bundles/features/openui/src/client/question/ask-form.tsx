// `AskForm`'s component (conversation-openui.md D21), in the renderer chunk.
// It ignores the props `Renderer` passes and reads the question from the
// fence's own program (`questionOf`), then draws the row of D21's table that
// fits: a notice, a settled block, the disabled form while it streams, an
// error, or the form bound to `openui.questions/v1`, called over its
// generated Connect client (slice S65b): each request written as its proto
// message, each answer's `questionState` read back as today's state.

import { ConnectError } from '@connectrpc/connect';
import {
  type ClientServices,
  fromConnectError,
  type Services,
} from 'bundle/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { decode, encode } from 'runtime/contracts';

import {
  AnswerRequestSchema,
  type QuestionState as QuestionStateMessage,
  QuestionStateSchema,
  QuestionsService,
  StatusRequestSchema,
} from '../../contracts/gen/doric/openui/questions/v1/questions_pb.js';
import {
  type AskInput,
  type AskQuestion,
  type QuestionState,
  questionStateSchema,
} from '../../contracts/index.js';
import { AskQuestions } from './ask.js';
import { questionOf } from './ask-input.js';
import { type FenceContextValue, useFence } from './fence-context.js';
import { fromAnswers, type Picks, toAnswers } from './picks.js';

/**
 * `openui.questions/v1` over `QuestionsService`, in the Thread's scope: each
 * call answers today's state, an answer outside its schema rejects.
 */
const questionsOf = (
  services: Services,
  scope: { readonly projectId: string; readonly threadId: string },
) => {
  // The window's services: host contracts over Connect.
  const client = (services as ClientServices).use(QuestionsService, scope);
  const stateOf = (state: QuestionStateMessage | undefined): QuestionState =>
    questionStateSchema.parse(
      state === undefined ? undefined : decode(QuestionStateSchema, state),
    );

  /** A call's answer, a failure as its Doric error (`fromConnectError`). */
  const answered = async (
    call: () => Promise<{ readonly questionState?: QuestionStateMessage }>,
  ): Promise<QuestionState> => {
    try {
      return stateOf((await call()).questionState);
    } catch (error) {
      throw error instanceof ConnectError ? fromConnectError(error) : error;
    }
  };

  return {
    status: (input: {
      readonly promptId: string;
      readonly questions: AskInput;
    }): Promise<QuestionState> =>
      answered(() => client.status(encode(StatusRequestSchema, input))),
    answer: (input: {
      readonly promptId: string;
      readonly questions: AskInput;
      readonly answers: unknown;
    }): Promise<QuestionState> =>
      answered(() => client.answer(encode(AnswerRequestSchema, input))),
  };
};

/** Settled blocks never send. */
const noSend = (): Promise<void> => Promise.resolve();

/** A block with no controls: the numbered questions under `heading`. */
function SettledQuestions({
  heading,
  questions,
}: {
  readonly heading: string;
  readonly questions: readonly AskQuestion[];
}) {
  return (
    <AskQuestions
      questions={questions}
      superseded
      settledHeading={heading}
      onSend={noSend}
    />
  );
}

/**
 * A closed, valid question bound to its state: `status` read on mount and on
 * each live row that can change it, the answers sent with `answer`. Nothing
 * before the first read; a failed read reads `pending`; a read that finishes
 * after a newer one is ignored.
 */
function BoundQuestion({
  fence,
  input,
}: {
  readonly fence: FenceContextValue;
  readonly input: AskInput;
}) {
  const { view, services, watchAnswers, superseded } = fence;
  const { projectId, threadId, promptId } = view.fence;
  const [status, setStatus] = useState<QuestionState | undefined>(undefined);
  const latest = useRef(0);

  useEffect(() => {
    const read = () => {
      const generation = ++latest.current;
      const settle = (next: QuestionState) => {
        if (generation === latest.current) setStatus(next);
      };
      Promise.resolve()
        .then(() =>
          questionsOf(services, { projectId, threadId }).status({
            promptId,
            questions: input,
          }),
        )
        .then(settle, () => settle({ state: 'pending' }));
    };
    read();
    const release = watchAnswers({ projectId, threadId, promptId }, read);
    return () => {
      release();
      latest.current += 1;
    };
  }, [services, watchAnswers, projectId, threadId, promptId, input]);

  if (status === undefined) return null;

  if (status.state === 'answered') {
    return (
      <AskQuestions
        {...(input.context === undefined ? {} : { context: input.context })}
        questions={input.questions}
        answered={fromAnswers(status.answers)}
        onSend={noSend}
      />
    );
  }

  if (superseded) {
    return (
      <SettledQuestions
        heading="Replaced by a later question"
        questions={input.questions}
      />
    );
  }

  const send = async (picks: Picks) => {
    const next = await questionsOf(services, { projectId, threadId }).answer({
      promptId,
      questions: input,
      answers: toAnswers(input.questions, picks),
    });
    latest.current += 1;
    setStatus(next);
  };

  return (
    <AskQuestions
      {...(input.context === undefined ? {} : { context: input.context })}
      questions={input.questions}
      onSend={send}
    />
  );
}

/** The component of the `AskForm` built-in. */
export function AskFormView() {
  const fence = useFence();
  const program = fence?.revision.program;
  const read = useMemo(
    () => (program === undefined ? undefined : questionOf(program)),
    [program],
  );

  if (fence === undefined || read === undefined) return null;
  const { view, revision } = fence;

  if (!revision.question) {
    return (
      <p className="text-xs text-muted-foreground">
        A question must be the root of its own fence
      </p>
    );
  }

  if (view.origin === 'agent') {
    return (
      <SettledQuestions
        heading="Not asked: only the main thread can ask the reader."
        questions={read.input?.questions ?? read.questions}
      />
    );
  }

  if (view.fence.state === 'streaming') {
    if (read.questions.length === 0) {
      return (
        <p className="text-xs text-muted-foreground">Writing the question…</p>
      );
    }
    return (
      <AskQuestions
        questions={read.questions}
        disabled
        note="Writing the question…"
        onSend={noSend}
      />
    );
  }

  if (view.fence.state === 'unterminated') {
    return (
      <SettledQuestions
        heading="Not asked: the question was cut off"
        questions={read.questions}
      />
    );
  }

  if (read.input === undefined) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {read.issue}
      </p>
    );
  }

  return <BoundQuestion fence={fence} input={read.input} />;
}
