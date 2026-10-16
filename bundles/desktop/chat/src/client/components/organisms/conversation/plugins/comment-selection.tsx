// The `message` comment gesture: selecting text in one of the agent's messages
// and leaving a comment about it. The chat owns the kind — the second consumer
// of the composer's stack, the proof that the stack is not the preview's — so
// this is the one place that writes its target: the prompt that produced the
// message, and the range the reader selected, as one `comments/v1` `range`
// anchor (`docs/architecture/bundles/comments.md`, "A âncora").
//
// The comment rides the same stack the preview's does, drawn above the prompt,
// and it flushes with the same send — nothing here writes an event.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalNode,
} from 'lexical';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHAT_COMMENT_LINE_TAG,
  MESSAGE_KIND,
} from '../../../../../contracts/index.js';
import { READER_NAME } from '../../../../domain/conversation-authors.js';
import { composerStackStore } from '../../../../stores/composer-stack.js';
import { $isAgentTurnNode } from '../nodes/agent-turn-node.js';

type Thread = { readonly id: string; readonly projectId: string };

/** What one selected range of an agent message carries. */
interface SelectedRange {
  readonly promptId: string;
  readonly text: string;
}

/**
 * Reads the reader's selection in the transcript, while it names text of one
 * of the agent's messages — the prompt that produced it and the words it
 * holds.
 */
const $selectedRange = (): SelectedRange | undefined => {
  const selection = $getSelection();

  if (
    !$isRangeSelection(selection) ||
    selection.isCollapsed() ||
    selection.getTextContent().trim().length === 0
  ) {
    return undefined;
  }

  // The transcript is the same editing host as the prompt, so the selection
  // only names a message while the block it starts in is an agent turn.
  const anchor = selection.anchor.getNode();
  const block = $getRoot()
    .getChildren()
    .find((child) => {
      let node: LexicalNode | null = anchor;
      while (node !== null) {
        if (node === child) return true;
        node = node.getParent();
      }
      return false;
    });

  if (block === undefined || !$isAgentTurnNode(block)) return undefined;

  return {
    promptId: block.__promptId,
    text: selection.getTextContent().trim(),
  };
};

/**
 * The `message` comment gesture: a floating `Comment` control beside the
 * reader's selection in one of the agent's messages, which adds the comment to
 * the composer's stack — where it is drawn as a line, the note is written, and
 * the send flushes it with the prompt.
 */
export function CommentSelection({ thread }: { readonly thread: Thread }) {
  const [editor] = useLexicalComposerContext();
  const [selected, setSelected] = useState<SelectedRange | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const read = (): void => {
      setSelected(editor.read(() => $selectedRange()));
    };

    const unregister = editor.registerUpdateListener(() => {
      // A selection changes with every keystroke and every drag; one read per
      // settle is what the floating control needs, not one per move.
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(read, 150);
    });
    read();

    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      unregister();
    };
  }, [editor]);

  const comment = useCallback(async () => {
    if (selected === undefined) return;
    const item = await composerStackStore.getState().add(thread, {
      kind: MESSAGE_KIND,
      elementTag: CHAT_COMMENT_LINE_TAG,
      data: {
        target: {
          kind: MESSAGE_KIND,
          id: selected.promptId,
          anchor: { form: 'range', text: selected.text },
        },
      },
      author: READER_NAME,
      note: '',
    });
    if (item === undefined) return;
    // The note is written where the stack writes it, in the line itself: the
    // new line's note takes the caret as soon as the line stands.
    composerStackStore.getState().focus(item.id);
  }, [selected, thread]);

  return (
    <div
      aria-hidden={selected === undefined}
      className="pointer-events-none sticky inset-x-0 top-0 z-10 flex justify-end pr-1"
      data-comment-selection={selected === undefined ? undefined : ''}
    >
      {selected !== undefined && (
        <button
          type="button"
          className="pointer-events-auto m-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-light shadow-sm"
          onClick={() => void comment()}
        >
          Comment
        </button>
      )}
    </div>
  );
}
