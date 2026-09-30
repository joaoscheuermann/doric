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
  $createTurnAuthorNode,
  $isTurnAuthorNode,
  type AuthorRole,
  type TurnAuthorNode,
} from '@/components/organisms/conversation/nodes/turn-author-node';
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
import { AGENT_NAME, READER_NAME } from '@/domain/conversation-authors';
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
 * A turn as the editor holds it: the turn's block, and the author line that
 * trails it when it wears one — `null` for a turn without one.
 */
type TurnUnit = {
  author: TurnAuthorNode | null;
  block: TurnBlock;
};

// The reader and the agent are the two authors a turn can name; both names come
// from `domain/conversation-authors`, the one place they are fixed.

/** An author line as the sync builds it, before it is a node. */
type AuthorDraft = {
  role: AuthorRole;
  name: string;
  at: string | undefined;
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
 * The author line a turn trails, or `null` when it wears none. The reader's own
 * turn always wears one. So does the agent, but only on the last turn of its run
 * — the one before the next user turn — so the line trails the run's whole
 * reasoning, tool calls and answer rather than its first turn.
 */
const authorFor = (
  turns: readonly Turn[],
  index: number,
): AuthorDraft | null => {
  const turn = turns[index];
  const at = turn.events.at(-1)?.createdAt;
  if (turn.type === 'user') return { role: 'user', name: READER_NAME, at };
  const next = turns[index + 1];
  return next === undefined || next.type === 'user'
    ? { role: 'agent', name: AGENT_NAME, at }
    : null;
};

/**
 * Whether the turn trails the author line it should: a turn gains one it lacks
 * and loses one it should not wear. Its block stays where it is, so the line is
 * inserted after the block rather than regenerated with the root, and a line
 * that is only out of date keeps its element and takes the new time.
 */
const $syncAuthor = (unit: TurnUnit, draft: AuthorDraft | null): void => {
  const current = unit.author;
  if (draft === null) {
    current?.remove();
    return;
  }
  if (
    current !== null &&
    current.__role === draft.role &&
    current.__name === draft.name
  ) {
    current.setAuthor(draft.at);
    return;
  }
  current?.remove();
  unit.block.insertAfter(
    $createTurnAuthorNode(draft.role, draft.name, draft.at),
  );
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
      // An author line is read as the tail of the turn block before it. One that
      // no turn precedes is a leftover, so it is dropped rather than left behind.
      let trailing: TurnBlock | null = null;
      for (const node of root.getChildren()) {
        if (isTurnBlock(node)) {
          existing.set(node.__turnKey, { block: node, author: null });
          trailing = node;
          continue;
        }
        if ($isTurnAuthorNode(node)) {
          const unit =
            trailing === null ? undefined : existing.get(trailing.__turnKey);
          if (unit === undefined) node.remove();
          else unit.author = node;
          trailing = null;
          continue;
        }
        trailing = null;
      }

      const prompt = $settlePrompt();

      for (const [index, turn] of turns.entries()) {
        const key = turnKey(turn);
        const draft = authorFor(turns, index);

        const unit = existing.get(key);

        if (unit === undefined) {
          const block = $createBlock(turn);
          prompt.insertBefore(block);
          if (draft !== null) {
            block.insertAfter(
              $createTurnAuthorNode(draft.role, draft.name, draft.at),
            );
          }
        } else {
          $applyTurn(unit.block, turn);
          existing.delete(key);
          $syncAuthor(unit, draft);
        }
      }

      for (const { author, block } of existing.values()) {
        author?.remove();
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
