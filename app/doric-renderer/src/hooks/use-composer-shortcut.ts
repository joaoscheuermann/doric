import { useConversationActions } from '@/components/molecules/conversation-actions';
import { $markdownOf } from '@/components/molecules/markdown-blocks';
import { $isTurnNode, type TurnNode } from '@/components/molecules/turn-node';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from 'lexical';
import { useEffect } from 'react';

/**
 * The composer: the one turn a person writes in, which is the only one that has
 * words to send. It is found by what it is — the draft — rather than by being
 * last, so a document whose order ever changed still sends the right words.
 */
const $composer = (): TurnNode | undefined => {
  for (const child of $getRoot().getChildren()) {
    if ($isTurnNode(child) && child.isDraft()) return child;
  }
  return undefined;
};

/**
 * The turn being rewritten: the person's own earlier prompt, which is the words
 * Cmd+Enter replaces when an edit is in progress rather than a draft.
 */
const $edited = (promptId: string): TurnNode | undefined => {
  for (const child of $getRoot().getChildren()) {
    if (!$isTurnNode(child)) continue;
    if (child.getTurnRole() === 'user' && child.getPromptId() === promptId) {
      return child;
    }
  }
  return undefined;
};

/**
 * Cmd+Enter sends the conversation, wherever the caret happens to be: the words
 * being sent are read from the document — the composer's, or the edited prompt's
 * when one is being rewritten — because the document is what holds them.
 */
export const useComposerShortcut = (editing: string | undefined): void => {
  const [editor] = useLexicalComposerContext();
  const actions = useConversationActions();

  useEffect(() => {
    if (actions === undefined) return;
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event === null || !(event.metaKey || event.ctrlKey)) return false;
        event.preventDefault();
        const markdown = editor.getEditorState().read(() => {
          const target = editing === undefined ? $composer() : $edited(editing);
          return target === undefined ? '' : $markdownOf(target).trim();
        });
        if (editing === undefined) actions.submit(markdown);
        else actions.rewind(editing, markdown);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [actions, editing, editor]);
};
