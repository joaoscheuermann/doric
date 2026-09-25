import { useConversationActions } from '@/components/molecules/conversation-actions';
import { $turnOf } from '@/components/molecules/turn-node';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
} from 'lexical';
import { useEffect } from 'react';

/**
 * What Enter and Escape mean in a history nobody may write in.
 *
 * Enter in one of the person's own earlier turns does not insert a line: that turn
 * is not being written, it is being *rewritten* — so Enter opens it, and the turns
 * after it go translucent because a resubmit discards them. Escape puts it back.
 *
 * The refusal that seals those turns lets this Enter through, and the shortcut that
 * sends the conversation never sees it: Cmd+Enter is a command, not a line.
 */
export const useEditKeys = (editing: string | undefined): void => {
  const [editor] = useLexicalComposerContext();
  const actions = useConversationActions();

  useEffect(() => {
    if (actions === undefined) return;

    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event === null || event.metaKey || event.ctrlKey) return false;
        const promptId = editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return undefined;
          const turn = $turnOf(selection.anchor.getNode());
          if (
            turn === undefined ||
            turn.isWritable() ||
            turn.getTurnRole() !== 'user'
          ) {
            return undefined;
          }
          return turn.getPromptId();
        });
        if (promptId === undefined) return false;
        event.preventDefault();
        actions.beginEdit(promptId);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [actions, editor]);

  useEffect(() => {
    if (actions === undefined || editing === undefined) return;
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        actions.cancelEdit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [actions, editing, editor]);
};
