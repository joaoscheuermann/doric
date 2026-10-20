// The inline comment entry: what a selection in one of the agent's messages
// opens after the paragraph it starts in. It stands where the words were
// selected — not over the transcript, and not above the prompt — so the comment
// reads as a note about the paragraph beside it.
//
// The entry has three states. Empty, it is a lone field with a placeholder.
// From its first character it draws one line, the selection quoted on it, and
// puts one item on the composer's stack (`chat.composer/v1`), the note being
// what was typed — the item the send will flush. Enter commits: the entry
// closes with the line still standing and the prompt takes the caret, the item
// staying on the stack. Shift+Enter is the browser's newline, and leaving the
// field throws the draft away — the item leaves the stack, and the seat leaves
// the transcript when nothing was written at it.
//
// The entry is an editing host of its own inside the conversation's document,
// so every event that starts here is marked handled for the editor (`isolate`),
// the way the composer's stack notes are.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { cn } from 'desktop/ui/utils';
import {
  type FocusEvent,
  type KeyboardEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CHAT_COMMENT_LINE_TAG,
  MESSAGE_KIND,
} from '../../../contracts/index.js';
import { commentKeyAction } from '../../domain/comment-entry.js';
import { READER_NAME } from '../../domain/conversation-authors.js';
import { ConversationThreadContext } from '../../hooks/use-live-terminal.js';
import { composerStackStore } from '../../stores/composer-stack.js';
import { CommentLine, commentLineLabel } from '../molecules/comment-line.js';
import { StackNote } from '../molecules/stack-note.js';
import { isolate } from './composer-stack.js';
import type { CommentSeatBlock } from './conversation/nodes/comment-seat-node.js';
import { focusPrompt } from './conversation/plugins/stack-caret.js';

/**
 * The card the written comment draws: the reader's mark, the words they point
 * at and their note, framed by the primary rule — square corners, a hairline
 * around and the heavier one on the edge the quote hangs from.
 */
const COMMENT_CARD_CLASS =
  'rounded-none border border-primary border-l-[3px] bg-background px-2.5 py-1.5';

/**
 * The entry one seat draws: the field the note is written in, and — from the
 * first character — the line that quotes the selected words.
 */
export function CommentEntry({ seat }: { readonly seat: CommentSeatBlock }) {
  const [editor] = useLexicalComposerContext();
  const thread = useContext(ConversationThreadContext);
  const [text, setText] = useState('');
  const host = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLSpanElement | null>(null);
  /** The stack item this entry put there, once the service assigned its id. */
  const item = useRef<string | undefined>(undefined);
  /** Whether an add is out, so the first keystrokes never add twice. */
  const adding = useRef(false);
  /** Set when the entry closed itself, so the blur it causes discards nothing. */
  const closed = useRef(false);

  useEffect(() => isolate(host.current), []);

  const threadScope = useMemo(
    () =>
      thread === null
        ? undefined
        : { id: thread.threadId, projectId: thread.projectId },
    [thread],
  );

  const target = useMemo(
    () => ({
      kind: MESSAGE_KIND,
      id: seat.promptId,
      anchor: {
        form: 'range' as const,
        text: seat.quote,
        turn: seat.turn,
        block: seat.block,
      },
    }),
    [seat.promptId, seat.quote, seat.turn, seat.block],
  );
  const label = commentLineLabel({ note: text, target });

  /** Reports the field's words: the first ones put the item on the stack. */
  const onText = (value: string): void => {
    setText(value);

    if (threadScope === undefined) return;
    if (item.current !== undefined) {
      composerStackStore.getState().note(threadScope, item.current, value);
      return;
    }
    if (adding.current) return;

    adding.current = true;
    void composerStackStore
      .getState()
      .add(threadScope, {
        kind: MESSAGE_KIND,
        elementTag: CHAT_COMMENT_LINE_TAG,
        data: { target, seat: { turn: seat.turn, block: seat.block } },
        author: READER_NAME,
        note: value,
      })
      .then((added) => {
        adding.current = false;
        if (added === undefined) return;
        item.current = added.id;
      });
  };

  /** Enter: the item stays on the stack, the entry closes, the prompt follows. */
  const commit = (): void => {
    const value = field.current?.textContent ?? text;
    closed.current = true;
    if (threadScope !== undefined && item.current !== undefined) {
      composerStackStore.getState().note(threadScope, item.current, value);
    }
    editor.update(() => seat.onCommit());
    focusPrompt(editor, true);
  };

  /** Leaving the field: the draft leaves the stack, and the seat with it. */
  const discard = (): void => {
    if (closed.current) return;
    closed.current = true;
    if (threadScope !== undefined && item.current !== undefined) {
      composerStackStore.getState().remove(threadScope, item.current);
    }
    item.current = undefined;
    editor.update(() => seat.onDiscard());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = commentKeyAction(
      { key: event.key, shift: event.shiftKey },
      {
        empty: (field.current?.textContent ?? text).length === 0,
        composing: event.nativeEvent.isComposing,
      },
    );
    if (action !== 'send') return;

    event.preventDefault();
    commit();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    discard();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the press and the keys act on the field, the entry's own textbox
    <div
      ref={host}
      data-comment-seat=""
      className="mt-2 flex flex-col gap-1 font-conversation text-sm font-light"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {text.length > 0 ? (
        <div
          data-composer-stack=""
          className={cn('-mx-2.5', COMMENT_CARD_CLASS)}
        >
          <CommentLine
            className="rounded-none px-0 py-0"
            item={{
              author: READER_NAME,
              note: text,
              target,
              quote: seat.quote,
            }}
          />
        </div>
      ) : null}
      {seat.open ? (
        <div className="rounded-md border border-border bg-background px-2.5 py-1.5">
          <StackNote
            id={`${seat.turn}:${seat.block}`}
            ref={field}
            note={text}
            label={label}
            onText={onText}
            onKeyDown={() => undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
