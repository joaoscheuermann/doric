import { type Thread } from '@/app/workspace';
import { MessageColumn, MessageScroller } from '@/components/message-scroller';
import { cn } from '@/lib/utils';
import { BotIcon } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';

import { Delegated } from './delegated-input';
import { PromptEditor } from './editor';
import { Markdown } from './markdown';
import { emptyProjection, projectEvents, type PromptStatus } from './projector';
import { initialVisibleMarkdown, revealStep } from './reveal';
import { Thinking } from './thinking';
import { promptNotice } from './thread-state';
import { ToolCall } from './tool-call';
import { activeCallId, isReasoning, lastTextIndex } from './tool-display';

const terminal = (status: PromptStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

function RevealedMarkdown({
  markdown,
  status,
  live,
}: {
  readonly markdown: string;
  readonly status: PromptStatus;
  readonly live: boolean;
}) {
  const [visibleMarkdown, setVisibleMarkdown] = useState(
    initialVisibleMarkdown(markdown, live),
  );

  useEffect(() => {
    if (!live) {
      setVisibleMarkdown(markdown);
      return;
    }
    if (visibleMarkdown === markdown) return;
    const frame = requestAnimationFrame(() =>
      setVisibleMarkdown((visible) =>
        revealStep({
          receivedMarkdown: markdown,
          visibleMarkdown: visible,
          terminal: terminal(status),
        }),
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [live, markdown, status, visibleMarkdown]);

  return (
    <Markdown streaming={live && visibleMarkdown !== markdown}>
      {visibleMarkdown}
    </Markdown>
  );
}

const TurnRow = ({
  role,
  raised,
  children,
}: {
  readonly role: 'user' | 'agent';
  readonly raised?: boolean;
  readonly children: React.ReactNode;
}) => (
  // The icon slot sits at the column top (`size-7`, so its center is 14px down),
  // so the content's first line must center at 14px too:
  // offset + firstLineBoxHeight / 2 = 14. Band padding stays outside that invariant.
  <div className={cn('w-full', raised && 'bg-secondary/25')}>
    <MessageColumn className={raised ? 'py-4' : 'py-2'}>
      {/* The slot stays reserved so every row's text shares one column. Only the
          agent shows an icon, and it carries no disc of its own. */}
      <div
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center"
      >
        {role === 'agent' && <BotIcon className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </MessageColumn>
  </div>
);

/** Explains why a prompt that never finished has no answer. */
const turnNotice = (status: PromptStatus, stopped: boolean): string => {
  if (status === 'cancelled') return 'Cancelled.';
  if (status === 'failed') return 'Failed.';
  return stopped ? 'No response — this thread stopped before it ran.' : '';
};

export function Conversation({
  thread,
  threadName,
}: {
  readonly thread: Thread;
  /** Resolves a Thread id to its name for delegated rows. */
  readonly threadName?: (id: string) => string | undefined;
}) {
  const [record, setRecord] = useState(thread);
  const [projectState, setProjectState] = useState<string>();
  const [projection, setProjection] = useState(emptyProjection);
  const [livePrompts, setLivePrompts] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    setProjection(emptyProjection);
    setLivePrompts(new Set());
    setError(undefined);
    return window.doric.threads.watch(thread.id, 0, (update) => {
      if (update.kind === 'snapshot') {
        // A reconnect replays only events after the delivered cursor, so the
        // snapshot is merged into what the conversation already shows.
        setProjection((current) =>
          projectEvents(current, update.snapshot.events),
        );
        if (update.snapshot.thread) setRecord(update.snapshot.thread);
        if (update.snapshot.project)
          setProjectState(update.snapshot.project.state);
      } else if (update.kind === 'event') {
        setProjection((current) => projectEvents(current, [update.event]));
        if (update.event.type === 'text.delta') {
          setLivePrompts(
            (current) => new Set([...current, update.event.promptId]),
          );
        }
      } else if (update.kind === 'updated') {
        setRecord(update.thread);
      } else if (update.kind === 'error') {
        setError(update.message);
      } else if (update.kind === 'deleted') {
        setError('This thread was deleted.');
      }
    });
  }, [thread.id]);

  const notice = promptNotice(record.state, projectState);
  const stopped = notice !== undefined;

  return (
    <MessageScroller aria-label="Conversation" aria-live="off" role="log">
      {projection.turns.map((turn) => {
        const isTerminal = terminal(turn.status);
        const lastText = lastTextIndex(turn.segments);
        const activeCall = activeCallId(turn.segments, isTerminal);
        const reasoning = isReasoning(turn.segments, isTerminal);
        // Rows are siblings of the list, so one parent gap spaces every row —
        // a prompt and its answer are no closer than two separate turns.
        return (
          <Fragment key={turn.promptId}>
            {turn.accepted && turn.delegated === undefined && (
              <TurnRow raised={turn.inputRole === 'user'} role={turn.inputRole}>
                {turn.userMarkdown ? (
                  <Markdown>{turn.userMarkdown}</Markdown>
                ) : (
                  <p className="text-sm leading-7 text-muted-foreground">
                    This prompt’s text was not recorded.
                  </p>
                )}
              </TurnRow>
            )}
            {(turn.delegated !== undefined ||
              turn.segments.length > 0 ||
              stopped ||
              turn.status === 'failed' ||
              turn.status === 'cancelled') && (
              <TurnRow role="agent">
                {turn.delegated !== undefined || turn.segments.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {turn.delegated !== undefined && (
                      <Delegated
                        name={threadName?.(turn.delegated.threadId)}
                        segment={turn.delegated}
                      />
                    )}
                    {turn.segments.map((segment, index) => {
                      if (segment.kind === 'thinking') {
                        return (
                          <Thinking
                            key={index}
                            pulsing={reasoning}
                            segment={segment}
                          />
                        );
                      }
                      if (segment.kind === 'tool') {
                        return (
                          <ToolCall
                            key={index}
                            active={segment.callId === activeCall}
                            segment={segment}
                            terminal={isTerminal}
                          />
                        );
                      }
                      return index === lastText &&
                        livePrompts.has(turn.promptId) ? (
                        <RevealedMarkdown
                          key={index}
                          live
                          markdown={segment.text}
                          status={turn.status}
                        />
                      ) : (
                        <Markdown key={index}>{segment.text}</Markdown>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm leading-7 text-muted-foreground">
                    {turnNotice(turn.status, stopped)}
                  </p>
                )}
              </TurnRow>
            )}
          </Fragment>
        );
      })}
      {error && (
        <MessageColumn className="py-2">
          <p className="text-sm leading-7 text-destructive" role="alert">
            {error}
          </p>
        </MessageColumn>
      )}
      {notice ? (
        <MessageColumn className="py-2">
          <p className="text-sm leading-7 text-muted-foreground">{notice}</p>
        </MessageColumn>
      ) : (
        <PromptEditor threadId={record.id} />
      )}
    </MessageScroller>
  );
}
