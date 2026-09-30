import {
  $createAgentTurnNode,
  $isAgentTurnNode,
  type AgentTurnNode,
} from '@/components/organisms/conversation/nodes/agent-turn-node';
import {
  $createThinkingTurnNode,
  $isThinkingTurnNode,
  type ThinkingTurnNode,
} from '@/components/organisms/conversation/nodes/thinking-turn-node';
import {
  $createToolTurnNode,
  $isToolTurnNode,
  type ToolTurnNode,
} from '@/components/organisms/conversation/nodes/tool-turn-node';
import {
  $createUserPromptNode,
  $isUserPromptNode,
  type UserPromptNode,
} from '@/components/organisms/conversation/nodes/user-prompt-node';
import {
  $createUserTurnNode,
  $isUserTurnNode,
  type UserTurnNode,
} from '@/components/organisms/conversation/nodes/user-turn-node';
import { type Turn } from '@/domain/projector';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, type LexicalNode } from 'lexical';
import { useEffect } from 'react';

/** Any of the four turn blocks, once it is in the editor. */
type TurnBlock = UserTurnNode | AgentTurnNode | ThinkingTurnNode | ToolTurnNode;

const isTurnBlock = (node: LexicalNode): node is TurnBlock =>
  $isUserTurnNode(node) ||
  $isAgentTurnNode(node) ||
  $isThinkingTurnNode(node) ||
  $isToolTurnNode(node);

/**
 * A turn's identity across updates: the event that opened it. A run that keeps
 * streaming keeps its first event, so its key is stable while its text grows,
 * which is what lets an update land on the block already in the editor.
 */
const turnKey = (turn: Turn): string =>
  `${turn.promptId}:${turn.events[0]?.sequence ?? 0}`;

/** The block a turn becomes: one node class per kind of turn. */
const $createBlock = (turn: Turn): TurnBlock => {
  const key = turnKey(turn);
  switch (turn.type) {
    case 'user':
      return $createUserTurnNode(key, turn.promptId, turn.delegated, turn.text);
    case 'agent':
      return $createAgentTurnNode(key, turn.promptId, turn.status, turn.text);
    case 'thinking':
      return $createThinkingTurnNode(key, turn.promptId, turn.text);
    case 'tool_call':
      return $createToolTurnNode(
        key,
        turn.promptId,
        turn.callId,
        turn.name,
        turn.args,
        turn.status,
      );
  }
};

/** Hands the block the chat's newest version of its turn. */
const $applyTurn = (block: TurnBlock, turn: Turn): void => {
  if (turn.type === 'user' && $isUserTurnNode(block)) block.setTurn(turn);
  else if (turn.type === 'agent' && $isAgentTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'thinking' && $isThinkingTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'tool_call' && $isToolTurnNode(block))
    block.setTurn(turn);
};

/** The one prompt block, kept last. Only one is ever in the editor. */
const $ensurePrompt = (): UserPromptNode => {
  const root = $getRoot();
  let prompt: UserPromptNode | undefined;
  for (const node of root.getChildren()) {
    if (!$isUserPromptNode(node)) continue;
    if (prompt === undefined) prompt = node;
    else node.remove();
  }
  if (prompt === undefined) {
    prompt = $createUserPromptNode();
    root.append(prompt);
  }
  return prompt;
};

/**
 * Renders the chat's turns into the editor with no interaction: every turn is a
 * block, the prompt block is the last one, and the editor is kept in step with
 * the chat — a turn it updates is re-rendered where it sits, one it adds is
 * inserted above the prompt, and one it drops is removed.
 */
export function InsertThreadTurnNodes({
  turns,
}: {
  readonly turns: readonly Turn[];
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.update(() => {
      const root = $getRoot();
      const existing = new Map<string, TurnBlock>();
      for (const node of root.getChildren()) {
        if (isTurnBlock(node)) existing.set(node.__turnKey, node);
      }

      const prompt = $ensurePrompt();

      for (const turn of turns) {
        const key = turnKey(turn);

        const block = existing.get(key);

        if (block === undefined) {
          prompt.insertBefore($createBlock(turn));
        } else {
          $applyTurn(block, turn);
          existing.delete(key);
        }
      }

      for (const stale of existing.values()) stale.remove();

      if (root.getLastChild() !== prompt) {
        prompt.remove();
        root.append(prompt);
      }
    });
  }, [editor, turns]);

  return null;
}
