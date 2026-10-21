// Where a comment card's "go to" takes the reader: the passage the comment is
// about.
//
// - A `message` comment still written inline in the answer: its inline note
//   takes the caret (scrolled into view), beside the words it keeps
//   highlighted.
// - A `message` comment whose inline note is gone (a sent one): the answer's
//   paragraph its anchor names (`turn`, `block`) is scrolled to the middle of
//   the view and flashed, the way a revealed target block is.
// - Any other target (a Papercraft preview, …), or a passage the transcript no
//   longer draws: the comment's thread is opened on the latest drawing of its
//   target (`openCommentThread`).

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useCallback } from 'react';

import { MESSAGE_KIND } from '../../contracts/index.js';
import { STACK_NOTE_ATTRIBUTE } from '../components/molecules/stack-note.js';
import { $anchorBlockNode } from '../components/organisms/conversation/nodes/agent-turn-node.js';
import type { AnchorBlock } from '../domain/comment-excerpt.js';
import { targetKey } from '../domain/composer-stack.js';
import { openCommentThread, reveal } from '../utility/comment-thread.js';
import { placeCaret } from '../utility/note-caret.js';

/** What "go to" needs to know of one comment. */
export interface CommentPlace {
  /** The comment's own id: an inline note carries it. */
  readonly id: string;
  /** The thread the comment belongs to: its root's id. */
  readonly thread: string;
  readonly target: unknown;
  /** The answer's block the comment's words were selected in, when known. */
  readonly block?: AnchorBlock;
}

/** The inline note of a comment written in the answer, else `undefined`. */
const inlineNote = (from: Element, id: string): HTMLElement | undefined =>
  [
    ...(from
      .closest('[data-lexical-editor]')
      ?.querySelectorAll<HTMLElement>(
        `[data-comment-seat] [${STACK_NOTE_ATTRIBUTE}]`,
      ) ?? []),
  ].find((note) => note.getAttribute(STACK_NOTE_ATTRIBUTE) === id);

/** Takes the reader to the passage a comment is about (see the file's head). */
export const useGoToComment = (): ((
  from: HTMLElement,
  place: CommentPlace,
) => void) => {
  const [editor] = useLexicalComposerContext();

  return useCallback(
    (from, place) => {
      if (targetKey(place.target)?.kind === MESSAGE_KIND) {
        const note = inlineNote(from, place.id);
        if (note !== undefined) {
          placeCaret(note, true);
          note.scrollIntoView?.({ block: 'center' });
          return;
        }
        const at = place.block;
        const paragraph =
          at === undefined
            ? null
            : editor.getEditorState().read(() => {
                const node = $anchorBlockNode(at);
                return node === undefined
                  ? null
                  : editor.getElementByKey(node.getKey());
              });
        if (paragraph !== null) {
          reveal(paragraph);
          return;
        }
      }
      openCommentThread(from, {
        commentId: place.thread,
        target: place.target,
      });
    },
    [editor],
  );
};
