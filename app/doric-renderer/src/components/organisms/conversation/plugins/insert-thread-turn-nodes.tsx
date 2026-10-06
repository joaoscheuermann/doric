import {
  $createActivityTurnNode,
  $isActivityTurnNode,
  type ActivityTurnNode,
} from '@/components/organisms/conversation/nodes/activity-turn-node';
import {
  $createAgentTurnNode,
  $isAgentTurnNode,
  type AgentTurnNode,
} from '@/components/organisms/conversation/nodes/agent-turn-node';
import {
  $createDelegatedTurnNode,
  $isDelegatedTurnNode,
  type DelegatedTurnNode,
} from '@/components/organisms/conversation/nodes/delegated-turn-node';
import {
  $createFailureTurnNode,
  $isFailureTurnNode,
  type FailureTurnNode,
} from '@/components/organisms/conversation/nodes/failure-turn-node';
import {
  $createLifecycleTurnNode,
  $isLifecycleTurnNode,
  type LifecycleTurnNode,
  type ResumePrompt,
} from '@/components/organisms/conversation/nodes/lifecycle-turn-node';
import {
  $isPromptEditNode,
  PromptEditNode,
} from '@/components/organisms/conversation/nodes/prompt-edit-node';
import {
  $isQueueNode,
  QueueNode,
} from '@/components/organisms/conversation/nodes/queue-node';
import {
  $isQueuedTurnNode,
  QueuedTurnNode,
} from '@/components/organisms/conversation/nodes/queued-turn-node';
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
  type TurnAuthorNode,
} from '@/components/organisms/conversation/nodes/turn-author-node';
import {
  $createUserPromptNode,
  $getUserPromptNode,
  $isUserPromptNode,
  type UserPromptNode,
} from '@/components/organisms/conversation/nodes/user-prompt-node';
import {
  $createUserTurnNode,
  $isUserTurnNode,
  type UserTurnNode,
} from '@/components/organisms/conversation/nodes/user-turn-node';
import { type AuthorDraft, READER_NAME } from '@/domain/conversation-authors';
import { scrollPlan } from '@/domain/conversation-scroll';
import { type SyncPlan, syncPlan } from '@/domain/conversation-sync';
import { type Turn } from '@/domain/projector';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  type LexicalEditor,
  type LexicalNode,
  RootNode,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { type RefObject, useEffect, useRef } from 'react';

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
  else if (turn.type === 'failure' && $isFailureTurnNode(block))
    block.setTurn(turn);
};

/**
 * The prompt and the reader's author line that trails it, kept as the
 * conversation's last two blocks whatever an update did to the root. Only one
 * prompt is ever in the editor.
 */
const $settlePrompt = (threadId: string): UserPromptNode => {
  const root = $getRoot();

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

  const queues = root.getChildren().filter($isQueueNode);
  const queue =
    queues.find((node) => node.__threadId === threadId) ??
    new QueueNode(threadId);
  for (const node of queues) if (node !== queue) node.remove();
  const headers = root.getChildren().filter($isPromptEditNode);
  const header =
    headers.find((node) => node.__threadId === threadId) ??
    new PromptEditNode(threadId);
  for (const node of headers) if (node !== header) node.remove();
  if (prompt.getPreviousSibling() !== header) prompt.insertBefore(header);
  if (header.getPreviousSibling() !== queue) header.insertBefore(queue);
  return prompt;
};

/**
 * How many new blocks one pass creates while the transcript fills in: a long
 * thread arrives whole on opening, and creating every block at once is a freeze
 * while the editor draws them. One pass is one bounded batch of work, and
 * passes keep coming across frames until the transcript is whole.
 */
const FILL_BATCH = 40;

/** Where the reader sits in the surface's scroll, as a pass finds them. */
type ScrollReading = {
  /** The element the conversation scrolls in. */
  readonly element: HTMLElement;
  /** The reader's place in it before the pass runs. */
  readonly scrollTop: number;
  /** Whether that place is the conversation's tail. */
  readonly atBottom: boolean;
};

/**
 * The conversation's scroll and the reader's place in it: the first ancestor
 * of the editor that actually scrolls, and "at the bottom" leaves room for the
 * rounding a layout can leave behind. `null` when the surface has nothing to
 * scroll.
 */
const readScroll = (editor: LexicalEditor): ScrollReading | null => {
  const root = editor.getRootElement();
  let element: HTMLElement | null = root?.parentElement ?? null;
  while (element !== null && element.scrollHeight <= element.clientHeight) {
    element = element.parentElement;
  }
  if (element === null) return null;
  return {
    element,
    scrollTop: element.scrollTop,
    atBottom:
      element.scrollHeight - element.scrollTop - element.clientHeight <= 2,
  };
};

/**
 * Renders the chat's turns into the editor with no interaction: every turn is a
 * block, the prompt block and its author line are the last two, and the editor
 * is kept in step with the chat — a turn it updates is re-rendered where it
 * sits, one it adds is placed where it belongs in the transcript, and one it
 * drops is removed. The first sync also opens the surface, leaving the caret in
 * the prompt and the view on the input. That is the only pass that touches
 * focus or the caret: every later one settles the reader's scroll back to the
 * place it found them — `domain/conversation-scroll` decides which pass may
 * pin the tail instead.
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
  threadId,
  turns,
  onResume,
  navigating,
}: {
  readonly threadId: string;
  readonly turns: readonly Turn[];
  /** What a marker's Resume action asks the surface for. */
  readonly onResume: ResumePrompt;
  readonly navigating: RefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  const seated = useRef<LexicalEditor | null>(null);
  const filling = useRef(false);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const run = (): void => {
      frame.current = null;
      const opening = seated.current !== editor;
      // What this pass may do to the reader's view, decided from the facts
      // before it runs. The pass itself keeps out of the reader's way: only
      // the opener touches focus and the caret, and every later pass settles
      // the scroll back to the place it found.
      const scroll = readScroll(editor);
      const decision = scrollPlan({
        opening,
        filling: filling.current,
        atBottom: scroll?.atBottom ?? true,
        navigating: navigating.current,
      });
      let plan: SyncPlan = { steps: [], removals: [], pending: false };
      const element = editor.getRootElement();
      const ownsFocus = element?.contains(element.ownerDocument.activeElement);

      editor.update(
        () => {
          const root = $getRoot();
          const existing = new Map<string, TurnUnit>();
          // An author line is read as the tail of the block before it: a turn's for
          // a turn, and the reader's for the prompt. A line with neither before it is
          // a leftover, so it is dropped rather than left behind.
          let trailing: TurnBlock | null = null;
          for (const node of root.getChildren()) {
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
          const prompt = $settlePrompt(threadId);

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
              $applyTurn(unit.block, step.turn);
              tails.set(step.key, $syncAuthor(unit, step.author) ?? unit.block);
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
            tails.set(
              step.key,
              $syncAuthor({ author: null, block }, step.author) ?? block,
            );
          }

          for (const key of plan.removals) {
            const unit = existing.get(key);
            unit?.author?.remove();
            unit?.block.remove();
          }

          // Seat the caret in the prompt as the surface opens. The editor is focused
          // before the first turn is in, when the root is still empty, so the
          // browser parks the caret on a line of its own above the transcript; a
          // selection in the prompt is what keeps that line from existing.
          if (decision === 'open') prompt.select();
        },
        {
          // Preserve focus and search text in popovers during background streaming.
          // Reapplying Lexical's saved selection would dismiss them via focus-outside.
          tag:
            opening || (ownsFocus && !navigating.current)
              ? undefined
              : SKIP_DOM_SELECTION_TAG,
          // The commit that lands after this update re-applies the caret's
          // selection and the browser scrolls it into view — back to the input
          // the reader just left — and a settled prompt can re-append the tail.
          // The reader's scroll is owned here instead, after all of that: a
          // fill pass pins the tail the blocks grow above, and every other pass
          // returns the reader to the place it found them. 'open' leaves the
          // scroll to the opener, which scrolls to the input.
          onUpdate: () => {
            if (scroll === null) return;
            if (decision === 'pin')
              scroll.element.scrollTop = scroll.element.scrollHeight;
            else if (decision === 'hold')
              scroll.element.scrollTop = scroll.scrollTop;
          },
        },
      );

      if (opening) {
        seated.current = editor;
        editor.focus();
      }
      filling.current = plan.pending;
      if (plan.pending) frame.current = requestAnimationFrame(run);
    };

    run();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [editor, navigating, onResume, threadId, turns]);

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
        $settlePrompt(threadId);
      }),
    [editor, threadId],
  );

  return null;
}
