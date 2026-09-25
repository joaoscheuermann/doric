import { $turnOf } from '@/components/molecules/turn-node';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_BEFORE_CRITICAL,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  CUT_COMMAND,
  DROP_COMMAND,
  FORMAT_TEXT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  INSERT_TAB_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalNode,
  mergeRegister,
  PASTE_COMMAND,
  REMOVE_TEXT_COMMAND,
} from 'lexical';
import { useEffect } from 'react';

/**
 * The one rule about writing in the conversation: **only the composer takes
 * words**. Every other turn is a rendering of durable history, so the editor
 * refuses every edit that would land in one — typing, deleting, pasting, cutting,
 * formatting, dropping, and the browser's own `beforeinput`, which is the event a
 * keyboard, an IME or dictation actually delivers.
 *
 * Refusing is what a person notices; it is not what makes the rule true. Anything
 * that gets past these refusals — a deletion the browser runs across a turn
 * boundary, a paste, a composition — is put back by the invariant in
 * `use-conversation-document`. This hook is the first line, that one is the
 * guarantee.
 *
 * Selection is deliberately untouched: the caret must travel an agent's answer
 * and its words must stay copyable, which is exactly what a comment is made of.
 */

const sealed = (node: LexicalNode): boolean => {
  const turn = $turnOf(node);
  return turn === undefined || !turn.isWritable();
};

/**
 * Whether either end of the selection sits in a turn nobody may write in. Both
 * ends are read so a selection dragged out of the composer into an answer is
 * refused too — that is the drag that would delete the model's words.
 */
const $selectionIsSealed = (): boolean => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  return (
    sealed(selection.anchor.getNode()) || sealed(selection.focus.getNode())
  );
};

export const useSealedTurns = (): void => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const refuse = (): boolean => $selectionIsSealed();

    const refuseKey = (event: KeyboardEvent | null): boolean => {
      if (!$selectionIsSealed()) return false;
      event?.preventDefault();
      return true;
    };

    /**
     * Enter in a sealed turn would only ever insert, so it is refused — but a
     * modified Enter is a command for the surface to act on (submitting the
     * conversation), not a word to write, so it is left alone.
     */
    const refuseEnter = (event: KeyboardEvent | null): boolean => {
      if (event !== null && (event.metaKey || event.ctrlKey)) return false;
      return refuseKey(event);
    };

    const element = editor.getRootElement();
    // Lexical turns the native event into `BEFORE_INPUT_COMMAND`, and refusing
    // the command stops the edit inside the editor; preventing the event stops
    // the browser from writing into the contenteditable behind the editor's back.
    const onBeforeInput = (event: Event): void => {
      const isSealed = editor.getEditorState().read($selectionIsSealed);
      if (isSealed) event.preventDefault();
    };
    element?.addEventListener('beforeinput', onBeforeInput, true);

    return mergeRegister(
      editor.registerCommand(
        BEFORE_INPUT_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        REMOVE_TEXT_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        INSERT_LINE_BREAK_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        INSERT_TAB_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        FORMAT_TEXT_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        refuse,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        refuseKey,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        refuseKey,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        refuseEnter,
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      // A cut only removes text when the selection is not collapsed, so a
      // collapsed caret still copies out of the answer it stands in.
      editor.registerCommand(
        CUT_COMMAND,
        () => {
          const selection = $getSelection();
          return (
            $isRangeSelection(selection) &&
            !selection.isCollapsed() &&
            $selectionIsSealed()
          );
        },
        COMMAND_PRIORITY_BEFORE_CRITICAL,
      ),
      () => element?.removeEventListener('beforeinput', onBeforeInput, true),
    );
  }, [editor]);
};
