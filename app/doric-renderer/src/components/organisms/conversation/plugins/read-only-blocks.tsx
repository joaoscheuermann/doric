/**
 * Lets the caret move through a read-only block's text while no editing command
 * changes it.
 *
 * The block stays editable in the DOM on purpose: a text that is not editable
 * becomes an island the arrow keys skip over, and the caret could never enter a
 * turn to read it. What is refused instead is every command that would change
 * the text, answered above the editor's own handlers (`COMMAND_PRIORITY_EDITOR`)
 * so the selection still moves normally — selection is not an edit.
 *
 * The commands are the ones a keystroke does not route through `beforeinput`
 * (Enter and its line break, a formatting shortcut, paste, indent) plus
 * `beforeinput` itself: typing into a plain, unformatted text node takes the
 * editor's uncontrolled path, where the browser edits the DOM and the editor
 * reads it back — `CONTROLLED_TEXT_INSERTION_COMMAND` is never dispatched, so
 * only `beforeinput` can refuse it. The deletion commands are here too, for the
 * other half of that: a Backspace in a read-only block is prevented on keydown
 * and never becomes a `beforeinput`.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  INSERT_TAB_COMMAND,
  mergeRegister,
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  REMOVE_TEXT_COMMAND,
  SET_TEXT_FORMAT_COMMAND,
} from 'lexical';
import { useEffect } from 'react';

import { $selectedBlocks } from './blocks';

type ReadOnlyBlocksProps = {
  /** Whether a block of this node type refuses text edits. */
  readonly isReadOnly: (nodeType: string) => boolean;
};

/**
 * Whether every block the selection covers is read-only. A selection that also
 * covers an editable block is not this plugin's — the deletion plugin removes
 * the text of the parts that may change and leaves the read-only ones.
 */
const $coversOnlyReadOnly = (
  isReadOnly: (nodeType: string) => boolean,
): boolean => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) && !$isNodeSelection(selection)) {
    return false;
  }
  const blocks = $selectedBlocks(selection);
  return blocks.length > 0 && blocks.every((b) => isReadOnly(b.getType()));
};

export function ReadOnlyBlocksPlugin({ isReadOnly }: ReadOnlyBlocksProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const refuse = (): boolean => $coversOnlyReadOnly(isReadOnly);

    return mergeRegister(
      editor.registerCommand(
        BEFORE_INPUT_COMMAND,
        (event) => {
          // Undo and redo restore a whole state rather than edit this block.
          if (
            event.inputType === 'historyUndo' ||
            event.inputType === 'historyRedo'
          ) {
            return false;
          }
          if (!$coversOnlyReadOnly(isReadOnly)) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        INSERT_LINE_BREAK_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        INSERT_TAB_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        FORMAT_TEXT_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        FORMAT_ELEMENT_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        SET_TEXT_FORMAT_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        INDENT_CONTENT_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        OUTDENT_CONTENT_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(PASTE_COMMAND, refuse, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        DELETE_WORD_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        DELETE_LINE_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        REMOVE_TEXT_COMMAND,
        refuse,
        COMMAND_PRIORITY_CRITICAL,
      ),
    );
  }, [editor, isReadOnly]);

  return null;
}
