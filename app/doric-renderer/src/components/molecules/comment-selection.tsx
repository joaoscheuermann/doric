import { SelectionToolbar } from '@/components/molecules/selection-toolbar';
import { $isTurnNode, $turnOf } from '@/components/molecules/turn-node';
import { type PromptComment, quoteOf } from '@/domain/comments';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  getDOMSelection,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { useEffect, useState } from 'react';

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
    const $lastAnswer = (): string | undefined => {
      let key: string | undefined;
      for (const child of $getRoot().getChildren()) {
        if ($isTurnNode(child) && child.getTurnRole() === 'agent') {
          key = child.getKey();
        }
      }
      return key;
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
      const quote = editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          return undefined;
        }
        const turn = $turnOf(selection.focus.getNode());
        if (
          turn === undefined ||
          turn.getTurnRole() !== 'agent' ||
          turn.getKey() !== $lastAnswer()
        ) {
          return undefined;
        }
        const text = quoteOf(selection.getTextContent());
        return text.length === 0 ? undefined : text;
      });
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
