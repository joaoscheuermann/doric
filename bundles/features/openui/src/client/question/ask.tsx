// The question form's view (conversation-openui.md D21): a copy of `threads`'
// `AskQuestions` and `Settled` (`bundles/features/threads/src/client/ask.tsx`),
// with three props more: `settledHeading`, `disabled` and `note`. With all
// three at their defaults it renders the markup `threads`' copy renders (C9).

import { Button } from 'desktop/ui/button';
import { cn } from 'desktop/ui/utils';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  createLucideIcon,
  MessageCircleQuestionMarkIcon,
} from 'lucide-react';
import { useState } from 'react';

import type { AskQuestion } from '../../contracts/index.js';
import { OTHER, type Picks, summary } from './picks.js';

/**
 * Lucide's message-circle-check, which the lucide-react the app pins (0.544)
 * does not ship yet: the same paths, drawn by lucide's own factory.
 */
const MessageCircleCheckIcon = createLucideIcon('message-circle-check', [
  [
    'path',
    {
      d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719',
      key: 'bubble',
    },
  ],
  ['path', { d: 'm16 9-5.5 5.5L8 12', key: 'check' }],
]);

/**
 * A faint card around the block. It bleeds out of the conversation column by
 * its own padding, so the text inside stays on the column's edge.
 */
const frame =
  '-mx-4 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 font-conversation text-sm font-light';

export interface AskQuestionsProps {
  /** Shown under the first question only. */
  readonly context?: string;
  /** One or more questions, shown one at a time. */
  readonly questions: readonly AskQuestion[];
  /** The answers sent: "Answered" and each question with its `summary`. Takes precedence over `superseded`. */
  readonly answered?: Picks;
  /** A later ask replaced this one: "Superseded" and the numbered questions, no answers or controls. */
  readonly superseded?: boolean;
  /**
   * Called with the picks when Send is pressed on the last question (an empty
   * question is skipped). While pending, Send is disabled. If it rejects: "Could not send.
   * Try again." (`role="status"`), picks kept, Send enabled again. If it resolves,
   * the block stays until its owner passes `answered` or `superseded`.
   */
  readonly onSend: (picks: Picks) => Promise<void>;
  /** The question shown first (0-based, default 0); for stories. */
  readonly step?: number;
  /** The picks when the block mounts (default none); for stories. Later changes ignored. */
  readonly picked?: Picks;
  /** Starts with the send error shown (story state 10); the next Send clears it. */
  readonly failed?: boolean;
  /** The heading `Settled` shows when `answered` is not set. Default "Superseded". */
  readonly settledHeading?: string;
  /** Disables every option row, the free answer, Back, Next and Send. Default false. */
  readonly disabled?: boolean;
  /** A line in the place and style of the send error, shown while the error is not. Default none. */
  readonly note?: string;
}

/** The answers sent, or the questions a later ask replaced: no controls. */
function Settled({
  questions,
  answered,
  heading,
}: {
  readonly questions: readonly AskQuestion[];
  readonly answered: Picks | undefined;
  readonly heading: string;
}) {
  const Mark = answered
    ? MessageCircleCheckIcon
    : MessageCircleQuestionMarkIcon;
  return (
    <section className={cn('flex flex-col gap-1.5', frame)}>
      <h2 className="flex items-center gap-2 text-muted-foreground">
        <Mark className="size-4 shrink-0" />
        {answered ? 'Answered' : heading}
      </h2>
      {/* Each question in the muted tone, its answer under it. */}
      <ol className="flex flex-col gap-2">
        {questions.map((q, i) => (
          <li key={q.id} className="flex items-start gap-2">
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-xs leading-none text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0 leading-5">
              <p className="text-muted-foreground">{q.question}</p>
              {answered && (
                <p className="text-foreground">{summary(answered[q.id])}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The approved ask block (prototype revision 14). Pending: one question at a time,
 * "n/N" count with more than one question, numbered option rows as `radio`/`checkbox`
 * with `aria-checked`, the "Type your answer..." row ("Your answer") unless
 * `allowOther` is false, Back from the second question on (keeping picks), Next and
 * Send always enabled (an empty question is skipped). Keys stay in the block.
 * Typing in the free answer picks that row; on a single-select question it
 * replaces the picked option.
 */
export function AskQuestions({
  context,
  questions,
  answered,
  superseded,
  onSend,
  step: firstStep = 0,
  picked = {},
  failed = false,
  settledHeading = 'Superseded',
  disabled = false,
  note,
}: AskQuestionsProps) {
  const [step, setStep] = useState(firstStep);
  const [picks, setPicks] = useState<Picks>(picked);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(failed);

  if (answered || superseded)
    return (
      <Settled
        questions={questions}
        answered={answered}
        heading={settledHeading}
      />
    );

  const q = questions[step];
  if (q === undefined) return null;
  const answer = picks[q.id] ?? { picked: [] };
  const last = step === questions.length - 1;
  const rows: readonly AskQuestion['options'][number][] =
    q.allowOther === false ? q.options : [...q.options, { label: OTHER }];

  const pick = (label: string) => {
    const on = answer.picked.includes(label);
    const next = q.multiSelect
      ? on
        ? answer.picked.filter((p) => p !== label)
        : [...answer.picked, label]
      : [label];
    setPicks({ ...picks, [q.id]: { ...answer, picked: next } });
  };

  const send = () => {
    setError(false);
    setSending(true);
    onSend(picks).then(
      () => setSending(false),
      () => {
        setSending(false);
        setError(true);
      },
    );
  };

  return (
    // Keys stay here: with the block selected, the chat editor (Lexical) would
    // cancel Backspace, Delete, arrows and Enter (as in delegated-turn.tsx).
    <section
      aria-label="Question from the agent"
      className={cn('flex flex-col gap-2', frame)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {/* The question is the block's title: its mark on the left, the step
          count on the right when there is more than one. */}
      <h2 className="flex items-start gap-2 text-foreground">
        <MessageCircleQuestionMarkIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          {q.question}
          {q.multiSelect && (
            <span className="text-muted-foreground"> (one or more)</span>
          )}
        </span>
        {questions.length > 1 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {step + 1}/{questions.length}
          </span>
        )}
      </h2>

      {context && step === 0 && (
        <p className="pl-6 text-muted-foreground">{context}</p>
      )}

      <ol className="-mx-2.5 flex flex-col gap-0.5">
        {rows.map((o, i) => {
          const on = answer.picked.includes(o.label);
          const mark = (
            // One line tall and centred, so the number and the check sit on
            // the first line of every row, whatever follows it.
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-xs leading-none text-muted-foreground tabular-nums">
              {on ? <CheckIcon className="size-3.5 text-foreground" /> : i + 1}
            </span>
          );
          // The free answer is typed where its row stands: typing picks it,
          // like clicking an option does.
          if (o.label === OTHER) {
            const write = (text: string) => {
              const rest = q.multiSelect
                ? answer.picked.filter((p) => p !== OTHER)
                : [];
              setPicks({
                ...picks,
                [q.id]: {
                  picked: text.trim() ? [...rest, OTHER] : rest,
                  other: text,
                },
              });
            };
            return (
              <li key={o.label} className="min-w-0">
                <label
                  className={cn(
                    'flex w-full cursor-text items-start gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted',
                    on && 'bg-muted',
                  )}
                >
                  {mark}
                  <textarea
                    rows={1}
                    aria-label="Your answer"
                    placeholder="Type your answer..."
                    value={answer.other ?? ''}
                    disabled={disabled}
                    onChange={(e) => write(e.target.value)}
                    className="min-w-0 flex-1 resize-none bg-transparent p-0 leading-5 field-sizing-content text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                </label>
              </li>
            );
          }
          return (
            <li key={o.label} className="min-w-0">
              <Button
                variant="ghost"
                size="sm"
                role={q.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                disabled={disabled}
                onClick={() => pick(o.label)}
                className={cn(
                  'h-auto w-full items-start justify-start gap-2 rounded-md py-1.5 text-left text-sm leading-5 font-light whitespace-normal',
                  on && 'bg-muted text-foreground',
                )}
              >
                {mark}
                <span className="min-w-0">
                  <span className={cn(!on && 'text-foreground/90')}>
                    {o.label}
                  </span>
                  {o.recommended && (
                    <span className="text-muted-foreground">
                      {' '}
                      · recommended
                    </span>
                  )}
                  {o.description && (
                    <span className="block text-xs text-muted-foreground">
                      {o.description}
                    </span>
                  )}
                </span>
              </Button>
            </li>
          );
        })}
      </ol>

      <div className="flex items-center justify-end gap-1">
        {error ? (
          <p role="status" className="mr-auto text-xs text-muted-foreground">
            Could not send. Try again.
          </p>
        ) : (
          note !== undefined && (
            <p role="status" className="mr-auto text-xs text-muted-foreground">
              {note}
            </p>
          )
        )}
        {step > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            disabled={disabled}
            onClick={() => setStep(step - 1)}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        {last ? (
          <Button
            size="icon-sm"
            aria-label="Send"
            disabled={sending || disabled}
            onClick={send}
          >
            <ArrowUpIcon />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            aria-label="Next"
            disabled={disabled}
            onClick={() => setStep(step + 1)}
          >
            <ArrowRightIcon />
          </Button>
        )}
      </div>
    </section>
  );
}
