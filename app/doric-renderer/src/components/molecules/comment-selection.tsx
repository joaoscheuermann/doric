import { type PromptComment, quoteOf } from '@/domain/comments';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  getDOMSelection,
  type LexicalNode,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { useEffect, useState } from 'react';

import { SelectionToolbar } from './selection-toolbar';
import { $isTurnNode, $turnOf, type TurnNode } from './turn-node';
import { $isTurnPartNode } from './turn-part-node';

/**
 * Whether a node's words are the answer's own prose: outside every part, or inside
 * one that is a run of text. An opened fold's reasoning and a tool's payload are
 * read, not commented on, so a selection that reaches into one is not a comment's
 * business.
 */
const $inAnswerProse = (node: LexicalNode): boolean => {
  let current: LexicalNode | null = node;
  while (current !== null) {
    if ($isTurnPartNode(current)) return current.getPartKind() === 'text';
    if ($isTurnNode(current)) return true;
    current = current.getParent();
  }
  return false;
};

/** Where the button that comments on a selection stands, and what it would say. */
type CommentTarget = {
  readonly quote: string;
  readonly top: number;
  readonly left: number;
};

/**
 * The one thing a span of an answer can do: be commented on.
 *
 * It shows nothing until a person selects words in the answer they are *answering*
 * — the last one — because a comment is sent with the next prompt and says what
 * that prompt is about. Words in their own turn, in reasoning, or in an answer
 * already left behind offer nothing: history is not what a comment corrects. And
 * then it stands its button beside the selection; pressing it writes the comment
 * and drops the button, because the comment remembers the words it was taken from
 * and the document puts the field that holds it below the line they end on. That
 * is why nothing about the selection has to survive the click.
 *
 * The selection is read from the editor, and its place on screen from the browser's
 * own range: the two questions are different ones, and only the browser knows where
 * a selection ended up once the document has laid itself out.
 */
export function CommentSelection({
  addComment,
}: {
  readonly addComment: (quote: string) => PromptComment;
}) {
  const [editor] = useLexicalComposerContext();
  const [target, setTarget] = useState<CommentTarget>();

  useEffect(() => {
    /** The answer being answered: the last one in the document. */
    const $lastAnswer = (): TurnNode | undefined => {
      let last: TurnNode | undefined;
      for (const child of $getRoot().getChildren()) {
        if ($isTurnNode(child) && child.getTurnRole() === 'agent') last = child;
      }
      return last;
    };

    /**
     * The quote this selection would comment on, or nothing when it is not a
     * comment's business.
     *
     * The whole selection has to be in the answer being answered and in the words
     * it actually says: a selection that reaches into the person's own turn, into
     * an earlier answer, or into a fold's reasoning or a tool's payload cannot be
     * found in the answer's prose, and a comment about it would have nothing to
     * point at.
     */
    const $quoted = (): string | undefined => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) {
        return undefined;
      }
      const answer = $lastAnswer();
      if (answer === undefined) return undefined;
      const anchor = $turnOf(selection.anchor.getNode());
      const focus = $turnOf(selection.focus.getNode());
      if (anchor?.getKey() !== answer.getKey()) return undefined;
      if (focus?.getKey() !== answer.getKey()) return undefined;
      for (const node of selection.getNodes()) {
        if (!$inAnswerProse(node)) return undefined;
      }
      const text = quoteOf(selection.getTextContent());
      return text.length === 0 ? undefined : text;
    };

    const measure = (): void => {
      const active = document.activeElement;
      // A comment's own field is where the person is typing; a comment being
      // written is not a selection in the answer, and must not offer to comment.
      if (
        active instanceof HTMLElement &&
        active.closest('input, textarea, select') !== null
      ) {
        setTarget(undefined);
        return;
      }
      const dom = getDOMSelection(window);
      const range =
        dom !== null && dom.rangeCount > 0 ? dom.getRangeAt(0) : null;
      if (range === null || range.collapsed) {
        setTarget(undefined);
        return;
      }
      const quote = editor.getEditorState().read($quoted);
      if (quote === undefined) {
        setTarget(undefined);
        return;
      }
      const box = range.getBoundingClientRect();
      setTarget({
        left: box.left + box.width / 2,
        quote,
        top: box.top - 8,
      });
    };

    const stop = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        measure();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    // The browser's own signal is what moves a selection while a drag is still in
    // flight, before any of it has reached the document.
    document.addEventListener('selectionchange', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      stop();
      document.removeEventListener('selectionchange', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [editor]);

  if (target === undefined) return null;
  return (
    <SelectionToolbar
      left={target.left}
      onComment={() => {
        addComment(target.quote);
        setTarget(undefined);
      }}
      top={target.top}
    />
  );
}
