import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  HISTORIC_TAG,
  type LexicalEditor,
  type LexicalNode,
  RootNode,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { type RefObject, useEffect, useRef } from 'react';

import {
  type AuthorDraft,
  READER_NAME,
} from '../../../../domain/conversation-authors.js';
import { scrollPlan } from '../../../../domain/conversation-scroll.js';
import {
  type SyncPlan,
  syncPlan,
} from '../../../../domain/conversation-sync.js';
import type { Turn } from '../../../../domain/projector.js';
import {
  $createActivityTurnNode,
  $isActivityTurnNode,
  type ActivityTurnNode,
} from '../nodes/activity-turn-node.js';
import {
  $createAgentTurnNode,
  $isAgentTurnNode,
  type AgentTurnNode,
} from '../nodes/agent-turn-node.js';
import {
  $createChatBlockNode,
  $isChatBlockNode,
  type ChatBlockNode,
} from '../nodes/chat-block-node.js';
import {
  $createCommentLinesNode,
  $isCommentLinesNode,
} from '../nodes/comment-lines-node.js';
import {
  $createCompactionTurnNode,
  $isCompactionTurnNode,
  type CompactionTurnNode,
} from '../nodes/compaction-turn-node.js';
import {
  $createComposerStackNode,
  $isComposerStackNode,
} from '../nodes/composer-stack-node.js';
import {
  $createDelegatedTurnNode,
  $isDelegatedTurnNode,
  type DelegatedTurnNode,
} from '../nodes/delegated-turn-node.js';
import {
  $createFailureTurnNode,
  $isFailureTurnNode,
  type FailureTurnNode,
} from '../nodes/failure-turn-node.js';
import {
  $createLifecycleTurnNode,
  $isLifecycleTurnNode,
  type LifecycleTurnNode,
  type ResumePrompt,
} from '../nodes/lifecycle-turn-node.js';
import {
  $isPromptEditNode,
  PromptEditNode,
} from '../nodes/prompt-edit-node.js';
import { $isQueueNode, QueueNode } from '../nodes/queue-node.js';
import {
  $isQueuedTurnNode,
  QueuedTurnNode,
} from '../nodes/queued-turn-node.js';
import {
  $createThinkingTurnNode,
  $isThinkingTurnNode,
  type ThinkingTurnNode,
} from '../nodes/thinking-turn-node.js';
import {
  $createToolTurnNode,
  $isToolTurnNode,
  type ToolTurnNode,
} from '../nodes/tool-turn-node.js';
import {
  $createTurnAuthorNode,
  $isTurnAuthorNode,
  type TurnAuthorNode,
} from '../nodes/turn-author-node.js';
import {
  $createUserPromptNode,
  $getUserPromptNode,
  $isUserPromptNode,
  type UserPromptNode,
} from '../nodes/user-prompt-node.js';
import {
  $createUserTurnNode,
  $isUserTurnNode,
  type UserTurnNode,
} from '../nodes/user-turn-node.js';
import { readScroll, settleScroll } from './scroll-position.js';

/** Any of the turn blocks, once it is in the editor. */
type TurnBlock =
  | QueuedTurnNode
  | UserTurnNode
  | DelegatedTurnNode
  | AgentTurnNode
  | ThinkingTurnNode
  | ToolTurnNode
  | ActivityTurnNode
  | LifecycleTurnNode
  | CompactionTurnNode
  | FailureTurnNode;

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

const isTurnBlock = (node: LexicalNode): node is TurnBlock =>
  $isQueuedTurnNode(node) ||
  $isUserTurnNode(node) ||
  $isDelegatedTurnNode(node) ||
  $isAgentTurnNode(node) ||
  $isThinkingTurnNode(node) ||
  $isToolTurnNode(node) ||
  $isActivityTurnNode(node) ||
  $isLifecycleTurnNode(node) ||
  $isCompactionTurnNode(node) ||
  $isFailureTurnNode(node);

/** The block a turn becomes: one node class per kind of turn. */
const $createBlock = (
  turn: Turn,
  key: string,
  onResume: ResumePrompt,
): TurnBlock => {
  switch (turn.type) {
    case 'queued':
      return new QueuedTurnNode(key, turn.promptId, turn.items);
    case 'user':
      if (turn.delegated !== undefined)
        return $createDelegatedTurnNode({
          turnKey: key,
          promptId: turn.promptId,
          input: turn.delegated,
        });
      return $createUserTurnNode(
        key,
        turn.promptId,
        turn.delegated,
        turn.text,
        turn.accepted,
      );
    case 'agent':
      return $createAgentTurnNode(key, turn.promptId, turn.status, turn.text);
    case 'thinking':
      return $createThinkingTurnNode(
        key,
        turn.promptId,
        turn.text,
        turn.streaming,
      );
    case 'activity':
      return $createActivityTurnNode(
        key,
        turn.promptId,
        turn.thoughts,
        turn.tools,
        turn.items,
      );
    case 'tool_call':
      return $createToolTurnNode(
        key,
        turn.promptId,
        turn.callId,
        turn.name,
        turn.args,
        turn.status,
        turn.result,
        turn.error,
      );
    case 'lifecycle':
      return $createLifecycleTurnNode(
        key,
        turn.promptId,
        turn.lifecycle,
        onResume,
      );
    case 'failure':
      return $createFailureTurnNode(key, turn.promptId, turn.failure);
    case 'compaction':
      return $createCompactionTurnNode(
        key,
        turn.promptId,
        turn.trigger,
        turn.status,
        turn.condensedMessages,
        turn.tokensFreed,
        turn.code,
        turn.summary,
      );
  }
};

/**
 * Whether the turn trails the author line it should: a turn gains one it lacks
 * and loses one it should not wear. Its block stays where it is, so the line is
 * inserted after the block rather than regenerated with the root, and a line
 * that is only out of date keeps its element and takes the new time. Returns the
 * line the turn now trails, so the sync can place the next block after it.
 */
const $syncAuthor = (
  unit: TurnUnit,
  draft: AuthorDraft | null,
): TurnAuthorNode | null => {
  const current = unit.author;
  if (draft === null) {
    current?.remove();
    return null;
  }
  if (
    current !== null &&
    current.__role === draft.role &&
    current.__name === draft.name
  ) {
    current.setAuthor(draft.at);
    return current;
  }
  current?.remove();
  const author = $createTurnAuthorNode(draft.role, draft.name, draft.at);
  unit.block.insertAfter(author);
  return author;
};

const turnEquals = (left: Turn, right: Turn): boolean => {
  if (left === right) return true;
  if (left.type !== right.type || left.promptId !== right.promptId)
    return false;
  switch (left.type) {
    case 'agent': {
      const other = right as Extract<Turn, { type: 'agent' }>;
      return left.status === other.status && left.text === other.text;
    }
    case 'thinking': {
      const other = right as Extract<Turn, { type: 'thinking' }>;
      return left.streaming === other.streaming && left.text === other.text;
    }
    case 'tool_call': {
      const other = right as Extract<Turn, { type: 'tool_call' }>;
      return (
        left.callId === other.callId &&
        left.name === other.name &&
        left.args === other.args &&
        left.status === other.status &&
        left.result === other.result &&
        left.error === other.error
      );
    }
    case 'user': {
      const other = right as Extract<Turn, { type: 'user' }>;
      return (
        left.accepted === other.accepted &&
        left.awaiting === other.awaiting &&
        left.text === other.text &&
        // The comments are the turn's margin: they change when the log writes
        // another one, so a new one repaints the block.
        left.comments.length === other.comments.length &&
        left.comments.every(
          (comment, index) =>
            comment.commentId === other.comments[index]?.commentId,
        ) &&
        left.delegated?.kind === other.delegated?.kind &&
        left.delegated?.threadId === other.delegated?.threadId &&
        left.delegated?.text === other.delegated?.text
      );
    }
    case 'activity': {
      const other = right as Extract<Turn, { type: 'activity' }>;
      if (
        left.thoughts !== other.thoughts ||
        left.tools !== other.tools ||
        left.items.length !== other.items.length
      )
        return false;
      for (let index = 0; index < left.items.length; index += 1) {
        const a = left.items[index];
        const b = other.items[index];
        if (a === b) continue;
        if (a === undefined || b === undefined || a.kind !== b.kind)
          return false;
        if (a.kind === 'thinking' && b.kind === 'thinking') {
          if (a.text !== b.text) return false;
          continue;
        }
        if (a.kind === 'tool' && b.kind === 'tool') {
          if (
            a.name !== b.name ||
            a.args !== b.args ||
            a.status !== b.status ||
            a.result !== b.result ||
            a.error !== b.error
          )
            return false;
        }
      }
      return true;
    }
    case 'lifecycle': {
      const other = right as Extract<Turn, { type: 'lifecycle' }>;
      return left.lifecycle === other.lifecycle;
    }
    case 'compaction': {
      const other = right as Extract<Turn, { type: 'compaction' }>;
      return (
        left.trigger === other.trigger &&
        left.status === other.status &&
        left.condensedMessages === other.condensedMessages &&
        left.tokensFreed === other.tokensFreed &&
        left.code === other.code &&
        left.summary === other.summary
      );
    }
    case 'failure': {
      const other = right as Extract<Turn, { type: 'failure' }>;
      return (
        left.failure.code === other.failure.code &&
        left.failure.message === other.failure.message &&
        left.failure.name === other.failure.name
      );
    }
    case 'queued': {
      const other = right as Extract<Turn, { type: 'queued' }>;
      return (
        left.items.length === other.items.length &&
        left.items.every((item, index) => item === other.items[index])
      );
    }
  }
};

/** Hands the block the chat's newest version of its turn. */
const $applyTurn = (block: TurnBlock, turn: Turn): void => {
  if (turn.type === 'queued' && $isQueuedTurnNode(block)) {
    block.setTurn(turn);
    return;
  }
  if (
    turn.type === 'user' &&
    ($isUserTurnNode(block) || $isDelegatedTurnNode(block))
  )
    block.setTurn(turn);
  else if (turn.type === 'agent' && $isAgentTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'thinking' && $isThinkingTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'tool_call' && $isToolTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'activity' && $isActivityTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'lifecycle' && $isLifecycleTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'compaction' && $isCompactionTurnNode(block))
    block.setTurn(turn);
  else if (turn.type === 'failure' && $isFailureTurnNode(block))
    block.setTurn(turn);
};

/**
 * Seats the comments a user turn wears — the `comments.added/v1` events the
 * send flushed just below its words — directly above the turn block, where
 * they read as the same lines the stack drew before the reader sent. A turn
 * without comments keeps none, and a block that is not a user turn wears
 * nothing.
 */
const $syncTurnComments = (block: LexicalNode, turn: Turn): void => {
  if (!$isUserTurnNode(block)) return;
  if (turn.type !== 'user') return;

  const comments = [...turn.comments] as const;
  const previous = block.getPreviousSibling();

  if (comments.length === 0) {
    if ($isCommentLinesNode(previous)) previous.remove();
    return;
  }

  const node = $isCommentLinesNode(previous)
    ? previous
    : $createCommentLinesNode(turn.promptId);
  if (node.getPreviousSibling() !== block) block.insertBefore(node);
  node.setComments(comments);
};

/**
 * The prompt and the reader's author line that trails it, kept as the
 * conversation's last two blocks whatever an update did to the root. Only one
 * prompt is ever in the editor.
 *
 * In the steady state, the root's tail is `[..., QueueNode,
 * ComposerStackNode, PromptEditNode, UserPromptNode, TurnAuthorNode('user')]`:
 * the queue and the draft comment stack both stand between the last turn and
 * the prompt block. Checking the last 4 siblings first avoids scanning
 * hundreds of historical turns on every RootNode transform.
 */
const $settlePrompt = (thread: {
  readonly id: string;
  readonly projectId: string;
}): UserPromptNode => {
  const threadId = thread.id;
  const root = $getRoot();
  const tailAuthor = root.getLastChild();
  const tailPrompt = tailAuthor?.getPreviousSibling() ?? null;
  const tailHeader = tailPrompt?.getPreviousSibling() ?? null;
  const tailStack = tailHeader?.getPreviousSibling() ?? null;
  const tailQueue = tailStack?.getPreviousSibling() ?? null;

  if (
    $isTurnAuthorNode(tailAuthor) &&
    tailAuthor.__role === 'user' &&
    $isUserPromptNode(tailPrompt) &&
    $isPromptEditNode(tailHeader) &&
    tailHeader.__threadId === threadId &&
    $isComposerStackNode(tailStack) &&
    tailStack.__thread.id === threadId &&
    $isQueueNode(tailQueue) &&
    tailQueue.__threadId === threadId
  ) {
    let hasDuplicateTailNodes = false;
    for (
      let cursor = tailQueue.getPreviousSibling();
      cursor !== null;
      cursor = cursor.getPreviousSibling()
    ) {
      if (
        $isUserPromptNode(cursor) ||
        $isPromptEditNode(cursor) ||
        $isQueueNode(cursor)
      ) {
        hasDuplicateTailNodes = true;
        break;
      }
    }
    if (!hasDuplicateTailNodes) {
      return tailPrompt;
    }
  }

  let prompt = $getUserPromptNode();
  for (const node of root.getChildren()) {
    if (!$isUserPromptNode(node)) continue;
    if (node !== prompt) node.remove();
  }
  if (prompt === undefined) {
    prompt = $createUserPromptNode();
    root.append(prompt);
  }

  // The reader's own line trails the prompt, the way a turn's trails a turn. A
  // line of another role there is a leftover, so it is replaced rather than
  // kept; the reader's has no time yet, because the prompt is not sent.
  let author = prompt.getNextSibling();
  if (!($isTurnAuthorNode(author) && author.__role === 'user')) {
    if ($isTurnAuthorNode(author)) author.remove();
    author = $createTurnAuthorNode('user', READER_NAME, undefined);
    prompt.insertAfter(author);
  }

  // The pair stays the conversation's tail, so nothing follows the author line.
  if (root.getLastChild() !== author) {
    prompt.remove();
    author.remove();
    root.append(prompt);
    root.append(author);
  }

  const children = root.getChildren();
  const queues = children.filter($isQueueNode);
  const queue =
    queues.find((node) => node.__threadId === threadId) ??
    new QueueNode(threadId);
  for (const node of queues) if (node !== queue) node.remove();
  const stacks = children.filter($isComposerStackNode);
  const stack =
    stacks.find((node) => node.__thread.id === threadId) ??
    $createComposerStackNode(thread);
  for (const node of stacks) if (node !== stack) node.remove();
  const headers = children.filter($isPromptEditNode);
  const header =
    headers.find((node) => node.__threadId === threadId) ??
    new PromptEditNode(threadId);
  for (const node of headers) if (node !== header) node.remove();
  if (prompt.getPreviousSibling() !== header) prompt.insertBefore(header);
  if (header.getPreviousSibling() !== stack) header.insertBefore(stack);
  if (stack.getPreviousSibling() !== queue) stack.insertBefore(queue);
  return prompt;
};

/** Where an external block stands: its id and the log position it follows. */
export type PlacedBlock = {
  readonly id: string;
  readonly sequence: number;
};

/** The sequence of the event that opened a turn, read back from its key. */
const turnSequence = (block: TurnBlock): number => {
  const sequence = Number(block.__turnKey.split(':').at(-1));
  return Number.isFinite(sequence) ? sequence : Number.POSITIVE_INFINITY;
};

/**
 * Seats the blocks other bundles' projectors made among the turns (§7.7): each
 * one before the first turn opened by a later event, else at the end of the
 * transcript, above the queue and the prompt. A block already where it belongs
 * is left alone, so its element is never rebuilt by a pass; one the chat no
 * longer holds is removed.
 */
const $placeBlocks = (
  blocks: readonly PlacedBlock[],
  children: readonly LexicalNode[],
): void => {
  const root = $getRoot();
  const held = new Map<string, ChatBlockNode>();
  for (const node of children) {
    if (!$isChatBlockNode(node)) continue;
    if (held.has(node.__blockId)) node.remove();
    else held.set(node.__blockId, node);
  }
  if (blocks.length === 0) {
    for (const node of held.values()) node.remove();
    return;
  }
  const wanted = new Set(blocks.map((block) => block.id));
  for (const [id, node] of held) {
    if (wanted.has(id)) continue;
    node.remove();
    held.delete(id);
  }

  const currentChildren = root.getChildren();
  const turnBlocks = currentChildren.filter(isTurnBlock);
  const tail =
    currentChildren.find((node) => $isQueueNode(node)) ??
    $getUserPromptNode() ??
    null;
  const anchorOf = (sequence: number): LexicalNode | null =>
    turnBlocks.find((block) => turnSequence(block) > sequence) ?? tail;

  const nodes = blocks.map((block) => {
    let node = held.get(block.id);
    if (node === undefined) {
      node = $createChatBlockNode(block.id);
      held.set(block.id, node);
    }
    return { node, anchor: anchorOf(block.sequence) };
  });
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const { node, anchor } = nodes[index];
    const following = nodes[index + 1];
    const next =
      following !== undefined && following.anchor === anchor
        ? following.node
        : anchor;
    if (next === null) {
      if (root.getLastChild() !== node) root.append(node);
      continue;
    }
    if (node.isAttached() && node.getNextSibling() === next) continue;
    next.insertBefore(node);
  }
};

/**
 * How many new blocks one pass creates while the transcript fills in: a long
 * thread arrives whole on opening, and creating every block at once is a freeze
 * while the editor draws them. One pass is one bounded batch of work, and
 * passes keep coming across frames until the transcript is whole.
 */
const FILL_BATCH = 40;

const noBlocks: readonly PlacedBlock[] = Object.freeze([]);

/**
 * Renders the chat's turns into the editor with no interaction: every turn is a
 * block, the prompt block and its author line are the last two, and the editor
 * is kept in step with the chat — a turn it updates is re-rendered where it
 * sits, one it adds is placed where it belongs in the transcript, and one it
 * drops is removed. The first sync also opens the surface, leaving the caret in
 * the prompt and the view on the input. That is the only pass that touches
 * focus or the caret: every later one keeps a reader who rests on the tail on
 * the input, and settles every other reader's scroll back to the place it found
 * them — `domain/conversation-scroll` decides which pass follows the tail.
 *
 * The first sync of a long transcript does not create every block at once. The
 * plan `domain/conversation-sync` makes bounds how many one pass takes — the
 * newest turns first, because the surface opens at the conversation's tail —
 * and further passes fill the older turns in above them across frames, until
 * the blocks stand exactly where a one-shot sync would have put them. Updates
 * that arrive meanwhile are applied at once: a turn whose block exists is
 * refreshed wherever it sits, and one still waiting for its pass is created
 * with its newest content when that pass comes.
 */
export function InsertThreadTurnNodes({
  thread,
  turns,
  onResume,
  navigating,
  following,
  blocks = noBlocks,
  autoFocus = true,
}: {
  /** The Thread whose transcript this is: its id and its Project's. */
  readonly thread: { readonly id: string; readonly projectId: string };
  readonly autoFocus?: boolean;
  readonly turns: readonly Turn[];
  /** Other bundles' blocks, in log order (`chat.views/v1`). */
  readonly blocks?: readonly PlacedBlock[];
  /** What a marker's Resume action asks the surface for. */
  readonly onResume: ResumePrompt;
  readonly navigating: RefObject<boolean>;
  /** Whether the reader asked to stay at the end of the conversation. */
  readonly following: RefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  const seated = useRef<LexicalEditor | null>(null);
  const frame = useRef<number | null>(null);
  const syncedTurns = useRef(
    new WeakMap<
      LexicalNode,
      {
        readonly turn: Turn;
        readonly authorAt: string | undefined;
        readonly authorRole: AuthorDraft['role'] | null;
      }
    >(),
  );

  useEffect(() => {
    const run = (): void => {
      frame.current = null;
      const opening = seated.current !== editor;
      // What this pass may do to the reader's view, decided from the facts
      // before it runs. Only the opener touches focus and the caret. Later
      // passes keep the end or the visible block in its place.
      const decision = scrollPlan({
        opening,
        navigating: navigating.current,
        following: following.current,
      });
      const scroll = readScroll(editor.getRootElement(), decision);
      let plan: SyncPlan = { steps: [], removals: [], pending: false };
      editor.update(
        () => {
          const root = $getRoot();
          const rootChildren = root.getChildren();
          const existing = new Map<string, TurnUnit>();
          // An author line is read as the tail of the block before it: a turn's for
          // a turn, and the reader's for the prompt. A line with neither before it is
          // a leftover, so it is dropped rather than left behind.
          let trailing: TurnBlock | null = null;
          for (const node of rootChildren) {
            if (isTurnBlock(node)) {
              existing.set(node.__turnKey, { block: node, author: null });
              trailing = node;
              continue;
            }
            if ($isTurnAuthorNode(node)) {
              if ($isUserPromptNode(node.getPreviousSibling())) {
                trailing = null;
                continue;
              }
              const unit =
                trailing === null
                  ? undefined
                  : existing.get(trailing.__turnKey);
              if (unit === undefined) node.remove();
              else unit.author = node;
              trailing = null;
              continue;
            }
            trailing = null;
          }

          plan = syncPlan([...existing.keys()], turns, FILL_BATCH);
          const prompt = $settlePrompt(thread);

          // The tail of every unit that stands as the pass runs — its author line
          // when it wears one — so a new block goes after the turn before it
          // rather than always above the prompt: a burst that closes becomes one
          // block where its steps were, in the middle of the transcript.
          const tails = new Map<string, LexicalNode>();
          for (const [key, unit] of existing) {
            tails.set(key, unit.author ?? unit.block);
          }

          for (const step of plan.steps) {
            if (step.kind === 'update') {
              const unit = existing.get(step.key);
              if (unit === undefined) continue;
              const last = syncedTurns.current.get(unit.block);
              const currentAuthorRole = unit.author?.__role ?? null;
              const nextAuthorRole = step.author?.role ?? null;
              const nextAuthorAt = step.author?.at;
              if (
                last !== undefined &&
                turnEquals(last.turn, step.turn) &&
                last.authorRole === nextAuthorRole &&
                last.authorAt === nextAuthorAt &&
                currentAuthorRole === nextAuthorRole
              ) {
                continue;
              }
              if (last === undefined || !turnEquals(last.turn, step.turn)) {
                $applyTurn(unit.block, step.turn);
              }
              const author = $syncAuthor(unit, step.author);
              $syncTurnComments(unit.block, step.turn);
              tails.set(step.key, author ?? unit.block);
              syncedTurns.current.set(unit.block.getLatest(), {
                turn: step.turn,
                authorRole: nextAuthorRole,
                authorAt: nextAuthorAt,
              });
              continue;
            }

            const block = $createBlock(step.turn, step.key, onResume);
            const after =
              step.after === null ? undefined : tails.get(step.after);
            if (after !== undefined) {
              after.insertAfter(block);
            } else {
              const before =
                step.before === null ? undefined : existing.get(step.before);
              if (before !== undefined) before.block.insertBefore(block);
              else {
                const first = root.getFirstChild();
                if (first === null) root.append(block);
                else first.insertBefore(block);
              }
            }
            const author = $syncAuthor({ author: null, block }, step.author);
            $syncTurnComments(block, step.turn);
            tails.set(step.key, author ?? block);
            syncedTurns.current.set(block, {
              turn: step.turn,
              authorRole: step.author?.role ?? null,
              authorAt: step.author?.at,
            });
          }

          for (const key of plan.removals) {
            const unit = existing.get(key);
            const comments =
              unit === undefined ? undefined : unit.block.getPreviousSibling();
            if ($isCommentLinesNode(comments)) comments.remove();
            unit?.author?.remove();
            unit?.block.remove();
          }

          $placeBlocks(blocks, rootChildren);

          // Seat the caret in the prompt before focusing the editor. Focusing an
          // empty root would park it above the transcript instead.
          if (decision === 'open' && autoFocus) prompt.select();
        },
        {
          // Transcript updates never move the caret. Reapplying its DOM selection
          // would scroll back to the input or dismiss a focused popover.
          // Host history is not a user edit: retaining each streamed snapshot
          // in undo history keeps old transcripts and tool payloads alive.
          tag:
            opening && autoFocus
              ? HISTORIC_TAG
              : [HISTORIC_TAG, SKIP_DOM_SELECTION_TAG],
          // Reconcile the viewport only after Lexical has committed its DOM.
          onUpdate: () => {
            const settle = (): void => {
              if (navigating.current) return;
              if (following.current) settleScroll(scroll, 'follow');
              else if (decision === 'hold') settleScroll(scroll, 'hold');
            };
            if (decision === 'open' && autoFocus) editor.focus(settle);
            settle();
          },
        },
      );

      if (opening) seated.current = editor;
      if (plan.pending) frame.current = requestAnimationFrame(run);
    };

    run();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [
    autoFocus,
    blocks,
    editor,
    following,
    navigating,
    onResume,
    thread,
    turns,
  ]);

  /**
   * The prompt cannot be deleted. The sync above runs when the chat changes; this
   * runs at the end of every update — Lexical applies a root transform last, as
   * a finalizer — so a backspace, a forward delete or a paste that drops the
   * prompt restores it in the same commit rather than leaving the surface
   * without one.
   */
  useEffect(
    () =>
      editor.registerNodeTransform(RootNode, () => {
        $settlePrompt(thread);
      }),
    [editor, thread],
  );

  return null;
}
