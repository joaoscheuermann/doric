import { useConversationActions } from '@/components/molecules/conversation-actions';
import { $turnOf } from '@/components/molecules/turn-node';
import {
  $isTurnPartNode,
  TOGGLE_FOLD_COMMAND,
} from '@/components/molecules/turn-part-node';
import { foldKey } from '@/domain/conversation';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, COMMAND_PRIORITY_LOW } from 'lexical';
import { useEffect } from 'react';

/**
 * Answers a part's head: the head names its node, and this is what turns that node
 * into the fold the surface opens or closes. The mapping lives here because a part
 * knows its own key but not which turn holds it, and only inside an editor read can
 * that be asked.
 */
export const useFoldCommand = (): void => {
  const [editor] = useLexicalComposerContext();
  const actions = useConversationActions();

  useEffect(() => {
    if (actions === undefined) return;
    return editor.registerCommand(
      TOGGLE_FOLD_COMMAND,
      (key) => {
        const fold = editor.getEditorState().read(() => {
          const part = $getNodeByKey(key);
          if (!$isTurnPartNode(part)) return undefined;
          const turn = $turnOf(part);
          return turn === undefined
            ? undefined
            : foldKey(turn.getTurnKey(), part.getPartKey());
        });
        if (fold === undefined) return false;
        actions.toggleFold(fold);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [actions, editor]);
};
