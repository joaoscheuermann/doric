import { messageFrom, type Thread } from '@/app/workspace';
import { MessageColumn, MessageScroller } from '@/components/message-scroller';
import { cn } from '@/lib/utils';
import { BotIcon } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AnswerNode } from './answer-node';
import { Delegated } from './delegated-input';
import { Document } from './document';
import {
  agentNode,
  type CaretKey,
  caretTarget,
  type Comment,
  type CommentAnchor,
  commentsFor,
  composePrompt,
  continuesComment,
  dirtyIndex,
  draftNode,
  draftNodeId,
  extendComment,
  proseNodes,
  removeComment,
  startComment,
  trimComment,
  userNode,
} from './editing';
import { emptyProjection, projectEvents, type PromptStatus } from './projector';
import { Thinking } from './thinking';
import { promptNotice } from './thread-state';
import { ToolCall } from './tool-call';
import { activeCallId, isReasoning, lastTextIndex } from './tool-display';
import { TurnNode } from './turn-node';

const terminal = (status: PromptStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

const TurnRow = ({
  role,
  raised,
  marker,
  children,
}: {
  readonly role: 'user' | 'agent';
  readonly raised?: boolean;
  /** The draft's terminal marker; a saved prompt keeps the band without it. */
  readonly marker?: boolean;
  readonly children: React.ReactNode;
}) => (
  // The icon slot sits at the column top (`size-7`, so its center is 14px down),
  // so the content's first line must center at 14px too:
  // offset + firstLineBoxHeight / 2 = 14. Band padding stays outside that invariant.
  <div
    className={cn(
      'w-full',
      raised && 'bg-secondary/25 focus-within:bg-secondary/40',
    )}
  >
    <MessageColumn className={raised ? 'py-4' : 'py-2'}>
      {/* The slot stays reserved so every row's text shares one column. Only the
          agent shows an icon, and it carries no disc of its own. */}
      <div
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center"
      >
        {role === 'agent' ? (
          <BotIcon className="size-4" />
        ) : (
          marker && (
            <span className="font-mono text-xs text-muted-foreground/60">
              ❯
            </span>
          )
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </MessageColumn>
  </div>
);

/** The transient line a prompt surface shows while sending or after a refusal. */
function SendStatus({
  sending,
  error,
}: {
  readonly sending: boolean;
  readonly error?: string;
}) {
  if (!sending && error === undefined) return null;
  return sending ? (
    <p className="text-xs text-muted-foreground">Sending…</p>
  ) : (
    <p className="text-sm text-destructive" role="alert">
      {error}
    </p>
  );
}

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

  // The open node, its pending prompt edits, and the comments they carry.
  const [focus, setFocus] = useState<{ id: string; edge?: 'start' | 'end' }>();
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [comments, setComments] = useState<readonly Comment[]>([]);
  const [sending, setSending] = useState(false);
  const [draftRun, setDraftRun] = useState(0);
  const [sendError, setSendError] = useState<string>();
  // Typing reads the active comment synchronously, before React commits it.
  const active = useRef<string | undefined>(undefined);
  const sequence = useRef(0);

  useEffect(() => {
    setProjection(emptyProjection);
    setLivePrompts(new Set());
    setError(undefined);
    setFocus(undefined);
    setEdits({});
    setComments([]);
    active.current = undefined;
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

  const nodes = useMemo(
    () => [...proseNodes(projection.turns), draftNode],
    [projection.turns],
  );
  const dim = dirtyIndex(nodes, edits);
  const dimmed = useMemo(
    () => new Set(dim < 0 ? [] : nodes.slice(dim + 1).map((node) => node.id)),
    [nodes, dim],
  );

  // A rewind removes turns from the projection. Their pending edits, comments and
  // focus must not outlive them, or the next send would carry comments for a turn
  // that no longer exists.
  useEffect(() => {
    const ids = new Set(nodes.map((node) => node.id));
    setEdits((current) => {
      const kept = Object.entries(current).filter(([id]) => ids.has(id));
      return kept.length === Object.keys(current).length
        ? current
        : Object.fromEntries(kept);
    });
    setComments((current) => {
      const kept = current.filter((comment) => ids.has(comment.nodeId));
      return kept.length === current.length ? current : kept;
    });
    setFocus((current) =>
      current !== undefined && !ids.has(current.id) ? undefined : current,
    );
  }, [nodes]);

  const focusEdge = (id: string): 'start' | 'end' | undefined =>
    focus?.id === id ? focus.edge : undefined;

  /**
   * Focuses a node for editing or commenting. A focus event without an edge
   * keeps whatever edge a navigation just set, so the caret still lands.
   */
  const focusNode = useCallback((id: string, edge?: 'start' | 'end') => {
    setFocus((current) =>
      current?.id === id && (edge === undefined || current.edge === edge)
        ? current
        : { id, edge },
    );
  }, []);

  const navigate = useCallback(
    (id: string, key: CaretKey): boolean => {
      const target = caretTarget(nodes, id, key);
      if (target === undefined) return false;
      setFocus({ id: target.id, edge: target.edge });
      return true;
    },
    [nodes],
  );

  const typeComment = useCallback(
    (nodeId: string, text: string, block: number, anchor?: CommentAnchor) => {
      const current = comments.find((c) => c.id === active.current);
      // A different excerpt is a different comment: only the same anchor extends.
      if (current !== undefined && continuesComment(current, anchor, block)) {
        setComments((pending) => extendComment(pending, current.id, text));
        return;
      }
      sequence.current += 1;
      const id = `comment-${sequence.current}`;
      active.current = id;
      setComments((pending) =>
        startComment(pending, {
          id,
          nodeId,
          block,
          text,
          ...(anchor === undefined ? {} : { anchor }),
        }),
      );
    },
    [comments],
  );

  const backspaceComment = useCallback(() => {
    const current = active.current;
    if (current === undefined) return;
    const next = trimComment(comments, current);
    setComments(next);
    if (!next.some((comment) => comment.id === current)) {
      active.current = undefined;
    }
  }, [comments]);

  const discardPending = () => {
    setComments([]);
    setEdits({});
    active.current = undefined;
    // Sending discards the other pending work, including the draft's text, so
    // the document is re-seeded from its empty source.
    setDraftRun((run) => run + 1);
  };

  const send = async (
    request: (prompt: string) => Promise<unknown>,
    text: string,
  ): Promise<boolean> => {
    const prompt = composePrompt(text, comments);
    if (prompt.trim().length === 0) return false;
    setSending(true);
    setSendError(undefined);
    try {
      await request(prompt);
      discardPending();
      return true;
    } catch (reason) {
      setSendError(messageFrom(reason));
      return false;
    } finally {
      setSending(false);
    }
  };

  const notice = promptNotice(record.state, projectState);
  const stopped = notice !== undefined;

  return (
    <MessageScroller aria-label="Conversation" aria-live="off" role="log">
      {projection.turns.map((turn) => {
        const isTerminal = terminal(turn.status);
        const lastText = lastTextIndex(turn.segments);
        const activeCall = activeCallId(turn.segments, isTerminal);
        const reasoning = isReasoning(turn.segments, isTerminal);
        const prompt =
          turn.accepted && turn.delegated === undefined && turn.userMarkdown
            ? userNode(turn.promptId, turn.userMarkdown)
            : undefined;
        // Rows are siblings of the list, so one parent gap spaces every row —
        // a prompt and its answer are no closer than two separate turns.
        return (
          <Fragment key={turn.promptId}>
            {turn.accepted && turn.delegated === undefined && (
              <TurnRow raised role={turn.inputRole}>
                {prompt === undefined ? (
                  <p className="text-sm leading-7 text-muted-foreground">
                    This prompt’s text was not recorded.
                  </p>
                ) : (
                  <TurnNode
                    dimmed={dimmed.has(prompt.id)}
                    focused={focus?.id === prompt.id}
                    node={prompt}
                    onBlur={() => setFocus(undefined)}
                    onFocus={(edge) => focusNode(prompt.id, edge)}
                  >
                    <div className="flex flex-col gap-1">
                      <Document
                        className="font-serif text-sm leading-6 outline-none"
                        editable={focus?.id === prompt.id}
                        focusEdge={focusEdge(prompt.id)}
                        handlers={{
                          onChange: (text) =>
                            setEdits((current) => ({
                              ...current,
                              [prompt.id]: text,
                            })),
                          onNavigate: (key) => navigate(prompt.id, key),
                          onSubmit: (text) =>
                            send(
                              (value) =>
                                window.doric.threads.rewind(
                                  record.id,
                                  turn.promptId,
                                  value,
                                ),
                              text,
                            ).then((accepted) => {
                              if (accepted) setFocus(undefined);
                              return accepted;
                            }),
                        }}
                        mode="write"
                        text={turn.userMarkdown}
                      />
                      {focus?.id === prompt.id && (
                        <SendStatus error={sendError} sending={sending} />
                      )}
                    </div>
                  </TurnNode>
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
                      if (segment.text.length === 0) return null;
                      const node = agentNode(
                        turn.promptId,
                        index,
                        segment.text,
                      );
                      return (
                        <AnswerNode
                          key={index}
                          comments={commentsFor(comments, node.id)}
                          dimmed={dimmed.has(node.id)}
                          focusEdge={focusEdge(node.id)}
                          focused={focus?.id === node.id}
                          handlers={{
                            backspace: backspaceComment,
                            blur: () => setFocus(undefined),
                            focus: (edge) => focusNode(node.id, edge),
                            navigate: (key) => navigate(node.id, key),
                            removeComment: (id) => {
                              setComments((current) =>
                                removeComment(current, id),
                              );
                              if (active.current === id) {
                                active.current = undefined;
                              }
                            },
                            type: (text, anchor, blockIndex) =>
                              typeComment(node.id, text, blockIndex, anchor),
                          }}
                          live={
                            index === lastText && livePrompts.has(turn.promptId)
                          }
                          node={node}
                          status={turn.status}
                          text={segment.text}
                        />
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
        <TurnRow raised marker role="user">
          <TurnNode
            dimmed={false}
            focused={focus?.id === draftNodeId}
            node={draftNode}
            onBlur={() => setFocus(undefined)}
            onFocus={(edge) => focusNode(draftNodeId, edge)}
          >
            <div className="flex flex-col gap-1">
              <Document
                className="font-serif text-sm leading-6 outline-none"
                editable
                focusEdge={focusEdge(draftNodeId)}
                handlers={{
                  onNavigate: (key) => navigate(draftNodeId, key),
                  onSubmit: (text) =>
                    send(
                      (value) => window.doric.threads.prompt(record.id, value),
                      text,
                    ),
                }}
                mode="write"
                placeholder="Write a prompt…"
                resetToken={draftRun}
                text=""
              />
              <SendStatus error={sendError} sending={sending} />
            </div>
          </TurnNode>
        </TurnRow>
      )}
    </MessageScroller>
  );
}
