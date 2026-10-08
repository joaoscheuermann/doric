/**
 * Enter in the prompt writes another line, rather than a block of its own.
 *
 * The prompt is the one editable block, and a block-level element has no block
 * to break into: the editor's default Enter would copy the prompt and place the
 * caret in the copy, which the sync that owns the conversation's blocks then
 * drops — so the reader's line would vanish as they typed it. What Enter does
 * here is what a reader expects of a message box: a line break inside it, which
 * the send then carries as the newline it is.
 *
 * Only the prompt is answered for. Every other block is read-only or a widget,
 * and a line break belongs to none of them.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
} from 'lexical';
import { useEffect } from 'react';

import { $isUserPromptNode } from '@/components/organisms/conversation/nodes/user-prompt-node';
import { $blockOf } from '@/components/organisms/conversation/plugins/blocks';

/** Whether the caret sits in the prompt. */
const $inPrompt = (): boolean => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;

  return $isUserPromptNode($blockOf(selection.anchor.getNode()));
};

export function PromptLineBreaks() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        () => {
          if (!$inPrompt()) return false;

          return editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );

  return null;
}
