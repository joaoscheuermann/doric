// `AskForm`'s component (conversation-openui.md D21), in the renderer chunk.
// It ignores the props `Renderer` passes and reads the question from the
// fence's own program (`questionOf`), then draws the row of D21's table that
// fits: a notice, a settled block, the disabled form while it streams, an
// error, or the form bound to `openui.questions/v1`.

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type AskInput,
  type AskQuestion,
  OpenuiQuestionsV1,
  type QuestionState,
} from '../../contracts/index.js';
import { AskQuestions } from './ask.js';
import { questionOf } from './ask-input.js';
import { type FenceContextValue, useFence } from './fence-context.js';
import { fromAnswers, type Picks, toAnswers } from './picks.js';

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
          services
            .use(OpenuiQuestionsV1, { projectId, threadId })
            .status({ promptId, questions: input }),
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
    const next = await services
      .use(OpenuiQuestionsV1, { projectId, threadId })
      .answer({
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
