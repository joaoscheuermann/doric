/**
 * Paste into the prompt keeps the prompt one block: the clipboard's
 * paragraphs become lines of it, not blocks of their own.
 *
 * The core paste inserts the clipboard's paragraphs as blocks, which would
 * split the prompt — the conversation's one editable block: the lines after
 * the first land as loose paragraphs at the root, which read as another
 * input box, and a paste into an empty prompt can replace it with the pasted
 * blocks, so the transcript ends in a bare box the send cannot read. What a
 * reader pastes in the prompt is what they would get pasting into a message
 * box: text, with the clipboard's line breaks as the prompt's own line
 * breaks, the way Enter writes them (`prompt-line-breaks`).
 *
 * Only a selection wholly inside the prompt is answered for; anything else
 * keeps the editor's own paste.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  INSERT_LINE_BREAK_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
  type PasteCommandType,
} from 'lexical';
import { useEffect } from 'react';

import { $isUserPromptNode } from '../nodes/user-prompt-node.js';
import { $blockOf } from './blocks.js';

/** Whether the selection lies wholly inside the prompt. */
export const $inPrompt = (): boolean => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const anchor = $blockOf(selection.anchor.getNode());
  const focus = $blockOf(selection.focus.getNode());
  return (
    anchor !== null &&
    focus !== null &&
    $isUserPromptNode(anchor) &&
    $isUserPromptNode(focus)
  );
};

/**
 * Writes the pasted text in the prompt, as its lines. The command listener
 * runs inside the editor's own update — the same context the core paste
 * handlers write in — so the dollar functions work here without opening
 * another.
 */
const $writeLines = (editor: LexicalEditor, text: string): void => {
  const parts = text.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < parts.length; index += 1) {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    selection.insertText(parts[index]);
    if (index < parts.length - 1) {
      editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
    }
  }
};

export function PasteIntoPrompt() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event: PasteCommandType) => {
          // A paste the window hands the editor carries the clipboard's
          // DataTransfer; a synthetic input or key carries none.
          const clipboardData =
            'clipboardData' in event ? event.clipboardData : null;
          if (clipboardData === null) return false;
          if (!$inPrompt()) return false;
          const text = clipboardData.getData('text/plain');
          if (text.trim().length === 0) return false;
          event.preventDefault();
          $writeLines(editor, text);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );

  return null;
}
