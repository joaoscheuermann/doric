// The comment's pin at the end of an agent's reply row: the same pin the canvas
// wears (`desktop/ui/comment-pin`), numbered and coloured by the thread's state.
// Unlike the canvas, pressing it does **not** jump to the comment: it opens a
// popover with the thread (`comment_reply`'s answers) and, in the thread's
// header, the button that takes the reader to the comment on the target's
// latest drawing (`COMMENT_THREAD_OPEN_EVENT`, the event a user-turn line
// dispatches too).
//
// The thread it shows is the conversation's now — the same `CommentThread` a
// row reads for its state — so a later reply or resolution changes the popover
// in place.

import { Button } from 'desktop/ui/button';
import { CommentPin, commentPinVariants } from 'desktop/ui/comment-pin';
import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';
import { cn } from 'desktop/ui/utils';
import { ArrowUpLeftIcon, BotIcon } from 'lucide-react';
import { useState } from 'react';

import type {
  CommentThread,
  CommentThreadState,
} from '../../domain/comment-threads.js';
import { anchorLabel } from '../../domain/composer-stack.js';
import { AGENT_NAME, READER_NAME } from '../../domain/conversation-authors.js';
import { openCommentThread } from '../../utility/comment-thread.js';
import { ReaderAvatar } from './reader-avatar.js';

/** The thread's state in words, for the pin's label. */
const STATE_LABEL: Readonly<Record<CommentThreadState, string>> = {
  done: 'resolved',
  await: 'waiting on you',
  open: 'open',
};

/** The name one message's author wears. */
const authorName = (author: string | undefined): string =>
  author === 'agent' ? AGENT_NAME : READER_NAME;

/**
 * The comment's pin of one agent reply: pressing it opens the thread instead of
 * jumping to the canvas, and the popover's header carries the jump. `thread` is
 * the conversation's current thread, so the pin's colour and the messages it
 * shows follow later replies and resolutions.
 */
export function CommentThreadPin({
  pin,
  state,
  thread,
  target,
  rootId,
}: {
  readonly pin: number;
  readonly state: CommentThreadState;
  readonly thread: CommentThread | undefined;
  /** The root's target, as `comments.added/v1` carried it. */
  readonly target: unknown;
  /** The thread's root comment id. */
  readonly rootId: string;
}) {
  const [open, setOpen] = useState(false);
  const messages = thread?.messages ?? [];
  const label = anchorLabel(target);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<CommentPin state={state} size="sm" />}
        data-comment-pin={pin}
        data-comment-state={state}
        title="Open comment"
        aria-label={`Open comment ${String(pin)} (${STATE_LABEL[state]})`}
      >
        {pin}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-comment-thread={rootId}
        className="w-80 gap-0 overflow-hidden p-0"
      >
        <header className="flex items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
          <span
            aria-hidden="true"
            className={cn(
              commentPinVariants({ state, size: 'sm' }),
              'pointer-events-none',
            )}
          >
            {pin}
          </span>
          <span
            className="mr-auto min-w-0 truncate text-sm font-medium"
            title={label ?? undefined}
          >
            {label ?? 'Comment'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-comment-jump=""
            aria-label="Show comment in the preview"
            title="Show comment in the preview"
            onClick={(event) => {
              openCommentThread(event.currentTarget, {
                commentId: rootId,
                target,
              });
              setOpen(false);
            }}
          >
            <ArrowUpLeftIcon aria-hidden="true" />
          </Button>
        </header>
        <ul className="flex max-h-80 flex-col gap-3 overflow-y-auto p-3">
          {messages.length === 0 ? (
            <li className="text-sm text-muted-foreground">No messages yet.</li>
          ) : (
            messages.map((message) => (
              <li key={message.commentId} className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs">
                  {message.author === 'agent' ? (
                    <BotIcon className="size-4.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <ReaderAvatar name={message.author ?? READER_NAME} />
                  )}
                  <span className="shrink-0 font-medium">
                    {authorName(message.author)}
                  </span>
                </span>
                <p className="break-words whitespace-pre-wrap text-sm">
                  {message.text}
                </p>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
