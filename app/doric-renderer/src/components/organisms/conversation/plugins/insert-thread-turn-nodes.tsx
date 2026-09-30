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
  $createTurnDividerNode,
  $isTurnDividerNode,
  type DividerRole,
  type TurnDividerNode,
} from '@/components/organisms/conversation/nodes/turn-divider-node';
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
import {
  $getRoot,
  type LexicalEditor,
  type LexicalNode,
  RootNode,
} from 'lexical';
import { useEffect, useRef } from 'react';

/** Any of the four turn blocks, once it is in the editor. */
type TurnBlock = UserTurnNode | AgentTurnNode | ThinkingTurnNode | ToolTurnNode;

/**
 * A turn as the editor holds it: the turn's block, and the divider that heads it
 * when the turn is the agent's or the reader's — `null` for a turn without one.
 */
type TurnUnit = {
  divider: TurnDividerNode | null;
  block: TurnBlock;
};

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

/**
 * The divider that heads a turn, or `null` when it has none. The reader's own
 * turn wears the person; an agent run — its reasoning, its tool calls and its
 * answer alike — opens on its first turn with the bot, so a thinking turn right
 * after the prompt is what wears it, not only a later answer.
 */
const dividerRole = (
  turns: readonly Turn[],
  index: number,
): DividerRole | null => {
  const turn = turns[index];
  if (turn.type === 'user') return 'user';
  const previous = index === 0 ? null : turns[index - 1];
  return previous === null || previous.type === 'user' ? 'agent' : null;
};

/**
 * Whether the turn wears the divider it should: a turn gains one it lacks, and
 * loses or replaces one it should not wear. Its block stays where it is, so the
 * divider is inserted before the block rather than regenerated with the root.
 */
const $syncDivider = (unit: TurnUnit, role: DividerRole | null): void => {
  if (role === null) {
    unit.divider?.remove();
    return;
  }
  if (unit.divider?.__role === role) return;
  unit.divider?.remove();
  unit.block.insertBefore($createTurnDividerNode(role));
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

/** The one prompt block. Only one is ever in the editor. */
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

/** The prompt exists and is the last block, whatever an update did to the root. */
const $settlePrompt = (): UserPromptNode => {
  const prompt = $ensurePrompt();
  const root = $getRoot();
  if (root.getLastChild() !== prompt) {
    prompt.remove();
    root.append(prompt);
  }
  return prompt;
};

/**
 * Renders the chat's turns into the editor with no interaction: every turn is a
 * block, the prompt block is the last one, and the editor is kept in step with
 * the chat — a turn it updates is re-rendered where it sits, one it adds is
 * inserted above the prompt, and one it drops is removed. The first sync also
 * opens the surface, leaving the caret in the prompt.
 */
export function InsertThreadTurnNodes({
  turns,
}: {
  readonly turns: readonly Turn[];
}) {
  const [editor] = useLexicalComposerContext();
  const seated = useRef<LexicalEditor | null>(null);

  useEffect(() => {
    const opening = seated.current !== editor;

    editor.update(() => {
      const root = $getRoot();
      const existing = new Map<string, TurnUnit>();
      // A divider is read as the head of the turn that follows it. One that no
      // turn follows is a leftover, so it is dropped rather than left behind.
      let pending: TurnDividerNode | null = null;
      for (const node of root.getChildren()) {
        if ($isTurnDividerNode(node)) {
          pending?.remove();
          pending = node;
          continue;
        }
        if (isTurnBlock(node)) {
          existing.set(node.__turnKey, { block: node, divider: pending });
          pending = null;
        }
      }
      pending?.remove();

      const prompt = $settlePrompt();

      for (const [index, turn] of turns.entries()) {
        const key = turnKey(turn);
        const role = dividerRole(turns, index);

        const unit = existing.get(key);

        if (unit === undefined) {
          if (role !== null) prompt.insertBefore($createTurnDividerNode(role));
          prompt.insertBefore($createBlock(turn));
        } else {
          $applyTurn(unit.block, turn);
          existing.delete(key);
          $syncDivider(unit, role);
        }
      }

      for (const { divider, block } of existing.values()) {
        divider?.remove();
        block.remove();
      }

      // Seat the caret in the prompt as the surface opens. The editor is focused
      // before the first turn is in, when the root is still empty, so the
      // browser parks the caret on a line of its own above the transcript; a
      // selection in the prompt is what keeps that line from existing.
      if (opening) prompt.select();
    });

    if (opening) {
      seated.current = editor;
      editor.focus();
    }
  }, [editor, turns]);

  /**
   * The prompt cannot be deleted. The sync above runs when the chat changes; this
   * runs at the end of every update — Lexical applies a root transform last, as
   * a finalizer — so a backspace, a forward delete or a paste that drops the
   * prompt restores it in the same commit rather than leaving the surface
   * without one.
   */
  useEffect(
    () => editor.registerNodeTransform(RootNode, $settlePrompt),
    [editor],
  );

  return null;
}
