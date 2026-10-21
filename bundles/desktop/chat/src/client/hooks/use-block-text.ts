// The text of one block of an agent's answer, as the transcript draws it: the
// paragraph a comment's words were selected from, which its line shows as the
// comment's context. It is read from the conversation's own editor state — no
// host call — and follows it, so a turn redrawn from the log (or one that
// leaves the transcript) changes what the line shows.
//
// It is read again only when that can change it: the anchored turn was written
// or left (its markdown is only ever replaced through the turn itself), or a
// turn drawn for the anchor's turn came. A keystroke in the prompt, a caret
// move, a delta streamed into another turn or another turn coming or going
// reads nothing.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, type NodeKey } from 'lexical';
import { useEffect, useState } from 'react';

import {
  $agentTurn,
  $anchorBlockNode,
  $isAgentTurnNode,
  AgentTurnNode,
} from '../components/organisms/conversation/nodes/agent-turn-node.js';
import type { AnchorBlock } from '../domain/comment-excerpt.js';

/** The text the transcript draws for an anchor's block, else `undefined`. */
export const useBlockText = (
  at: AnchorBlock | undefined,
): string | undefined => {
  const [editor] = useLexicalComposerContext();
  const turn = at?.turn;
  const block = at?.block;
  const [text, setText] = useState<string | undefined>(() =>
    turn === undefined || block === undefined
      ? undefined
      : editor
          .getEditorState()
          .read(() => $anchorBlockNode({ turn, block })?.getTextContent()),
  );

  useEffect(() => {
    if (turn === undefined || block === undefined) {
      setText(undefined);
      return undefined;
    }
    // The anchored turn's key, so a write to another turn is told apart.
    let key: NodeKey | undefined;
    const read = (): void => {
      setText(
        editor.getEditorState().read(() => {
          const node = $agentTurn(turn);
          key = node?.getKey();
          return node?.blocks()[block]?.getTextContent();
        }),
      );
    };
    read();
    return editor.registerMutationListener(
      AgentTurnNode,
      (mutations) => {
        const touched = editor.getEditorState().read(() => {
          for (const [changed, mutation] of mutations) {
            // The anchored turn itself, written or gone.
            if (changed === key) return true;
            // A turn drawn for the anchor's turn: the first, or a remount.
            if (mutation !== 'created') continue;
            const node = $getNodeByKey(changed);
            if ($isAgentTurnNode(node) && node.__turnKey === turn) return true;
          }
          return false;
        });
        if (touched) read();
      },
      { skipInitialization: true },
    );
  }, [editor, turn, block]);

  return text;
};
