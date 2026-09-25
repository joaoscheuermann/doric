import { $setMarkdown } from '@/components/molecules/markdown-blocks';
import {
  $createAgentTurnNode,
  $createUserTurnNode,
  $isTurnNode,
  turnChromeOf,
  type TurnNode,
} from '@/components/molecules/turn-node';
import {
  $createTurnPartNode,
  $isTurnPartNode,
  type TurnPartNode,
} from '@/components/molecules/turn-part-node';
import {
  agentParts,
  type ConversationTurn,
  documentSignature,
  partSignature,
  type TurnPart,
} from '@/domain/conversation';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $addUpdateTag,
  $getRoot,
  type LexicalEditor,
  type RootNode,
  type UpdateListenerPayload,
} from 'lexical';
import { useEffect, useRef } from 'react';

/**
 * Keeps the editor holding exactly what the log and the surface state describe —
 * and puts it back when anything else changes it.
 *
 * Two things happen here, and they are not the same job:
 *
 * 1. `$reconcile` writes the derived turns into the document, in place. A turn
 *    keeps its node, a part keeps its node, and a part is only rebuilt when the
 *    signature it was built from changed — so an answer that grows rewrites the
 *    run it is still appending to and leaves every other node, and the caret
 *    sitting in one of them, exactly where they were.
 *
 * 2. The invariant. The document is a rendering of durable history, so a turn a
 *    person may not write in must equal what the log says — and if an edit got
 *    through anyway (a native deletion across a turn boundary, a paste, an IME, a
 *    browser quirk no refused command covers), that turn is rebuilt from the log
 *    instead of being left wrong on screen. The refusals in `use-sealed-turns`
 *    stop the edits a person can make on purpose; this is what stops the ones a
 *    browser makes behind their back.
 */

/** Marks the writes this hook makes, so the invariant never answers its own. */
const WRITE_TAG = 'doric-conversation-write';

const $applyTurnFields = (node: TurnNode, turn: ConversationTurn): void => {
  if (node.getTurnKey() !== turn.key) node.setTurnKey(turn.key);
  if (node.getPromptId() !== turn.promptId) node.setPromptId(turn.promptId);
  if (node.getTurnRole() !== turn.role) node.setTurnRole(turn.role);
  if (node.isDraft() !== turn.draft) node.setDraft(turn.draft);
  if (node.isWritable() !== turn.writable) node.setWritable(turn.writable);
  if (node.getStatus() !== turn.status) node.setStatus(turn.status);
  if (node.getLabel() !== turn.label) node.setLabel(turn.label);
};

const $applyPartFields = (node: TurnPartNode, part: TurnPart): void => {
  if (node.getPartKey() !== part.key) node.setPartKey(part.key);
  if (node.getPartKind() !== part.kind) node.setPartKind(part.kind);
  if (part.kind !== 'tool') return;
  if (node.getName() !== part.name) node.setName(part.name);
  if (node.getCallId() !== part.callId) node.setCallId(part.callId);
  if (node.getStatus() !== part.status) node.setStatus(part.status);
};

/**
 * Writes one agent turn's parts: each one keeps its node, and only a part whose
 * signature changed is rebuilt — the trailing run while an answer streams, and
 * nothing else.
 *
 * Only the last part of a still-streaming turn is healed: that is the one the
 * model may have left half-written (`**bold`), and the only one where a missing
 * closing marker is what it is rather than what it means.
 */
const $applyParts = (turn: TurnNode, derived: readonly TurnPart[]): void => {
  const existing = new Map<string, TurnPartNode>();
  for (const child of turn.getChildren()) {
    if ($isTurnPartNode(child)) existing.set(child.getPartKey(), child);
  }

  const streaming = turn.getStatus() === 'streaming';
  const wanted = derived.map((part, index) => {
    const node =
      existing.get(part.key) ??
      $createTurnPartNode({ key: part.key, kind: part.kind });
    $applyPartFields(node, part);
    const signature = partSignature(part);
    if (node.getApplied() !== signature) {
      const heal =
        streaming && part.kind !== 'tool' && index === derived.length - 1;
      $setMarkdown(node, part.markdown, heal);
      node.setApplied(signature);
    }
    return node;
  });

  const children = turn.getChildren();
  const same =
    children.length === wanted.length &&
    children.every((child, index) => child === wanted[index]);
  if (same) return;

  for (const node of wanted) {
    if (node.getParent() !== null) node.remove();
  }
  for (const child of children) {
    if (child.getParent() !== null && !wanted.includes(child as TurnPartNode)) {
      child.remove();
    }
  }
  turn.splice(0, 0, wanted);
};

/**
 * Writes one turn, and only what it states differently. A person's turn renders
 * its words; an agent's turn renders its parts; the composer's content is the
 * person's own, so the document writes in it only to clear it once a prompt was
 * accepted.
 */
const $applyTurn = (
  node: TurnNode,
  turn: ConversationTurn,
  clear: number,
): void => {
  $applyTurnFields(node, turn);

  if (turn.draft) {
    const applied = `cleared:${String(clear)}`;
    if (node.getApplied() !== applied) {
      $setMarkdown(node, '');
      node.setApplied(applied);
    }
  } else if (turn.role === 'agent') {
    $applyParts(node, agentParts(turn));
  } else if (node.getApplied() !== turn.markdown) {
    $setMarkdown(node, turn.markdown);
    node.setApplied(turn.markdown);
  }

  node.setAppliedText(node.getTextContent());
};

const createTurnNode = (turn: ConversationTurn): TurnNode => {
  const shape = {
    key: turn.key,
    promptId: turn.promptId,
    draft: turn.draft,
    writable: turn.writable,
    status: turn.status,
    ...(turn.label === undefined ? {} : { label: turn.label }),
  };
  return turn.role === 'user'
    ? $createUserTurnNode(shape)
    : $createAgentTurnNode(shape);
};

/**
 * Brings the document to the turns a log states, in place. Membership and order
 * are the only things that move nodes: every node that stays keeps its DOM, which
 * is what leaves the caret and the selection where the person put them.
 *
 * A row whose chrome is gone is not reused — its words may be intact but its
 * avatar and its status are not — so the turn is rebuilt from the log instead.
 */
const $reconcile = (
  editor: LexicalEditor,
  root: RootNode,
  turns: readonly ConversationTurn[],
  clear: number,
): void => {
  const existing = new Map<string, TurnNode>();
  for (const child of root.getChildren()) {
    if (!$isTurnNode(child)) continue;
    const chrome = turnChromeOf(editor.getElementByKey(child.getKey()));
    if (chrome !== null) existing.set(child.getTurnKey(), child);
  }

  const wanted = turns.map((turn) => {
    const node = existing.get(turn.key) ?? createTurnNode(turn);
    $applyTurn(node, turn, clear);
    return node;
  });

  const children = root.getChildren();
  const same =
    children.length === wanted.length &&
    children.every((child, index) => child === wanted[index]);
  if (same) return;

  for (const node of wanted) {
    if (node.getParent() !== null) node.remove();
  }
  for (const child of children) {
    if (child.getParent() !== null && !wanted.includes(child as TurnNode)) {
      child.remove();
    }
  }
  root.splice(0, 0, wanted);
};

/**
 * Whether the document still holds what the log states: the same turns, in the
 * same order, each still carrying the text the surface built into it and the
 * chrome that is not content at all.
 */
const documentIsIntact = (
  editor: LexicalEditor,
  turns: readonly ConversationTurn[],
): boolean => {
  const children = $getRoot().getChildren();
  const held = children
    .map((child) =>
      $isTurnNode(child)
        ? `${child.getTurnRole()}:${child.getTurnKey()}:${child.isDraft() ? 'draft' : 'log'}`
        : '?',
    )
    .join('\u0000');
  if (held !== documentSignature(turns)) return false;

  for (const child of children) {
    if (!$isTurnNode(child)) return false;
    if (turnChromeOf(editor.getElementByKey(child.getKey())) === null) {
      return false;
    }
    // A turn nobody may write in must still hold the words the log gave it.
    if (
      !child.isWritable() &&
      child.getAppliedText() !== child.getTextContent()
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Keeps the document equal to the turns it is given, and equal to them again
 * whenever anything else changes it.
 */
export const useConversationDocument = (
  turns: readonly ConversationTurn[],
  clear: number,
): void => {
  const [editor] = useLexicalComposerContext();
  const latest = useRef({ clear, turns });
  latest.current = { clear, turns };

  useEffect(() => {
    editor.update(() => {
      $addUpdateTag(WRITE_TAG);
      $reconcile(editor, $getRoot(), turns, clear);
    });
  }, [clear, editor, turns]);

  useEffect(() => {
    const inspect = (payload: UpdateListenerPayload): void => {
      if (payload.tags.has(WRITE_TAG)) return;
      const { clear: epoch, turns: derived } = latest.current;
      const intact = payload.editorState.read(() =>
        documentIsIntact(editor, derived),
      );
      if (intact) return;
      editor.update(() => {
        $addUpdateTag(WRITE_TAG);
        $reconcile(editor, $getRoot(), derived, epoch);
      });
    };
    return editor.registerUpdateListener(inspect);
  }, [editor]);
};
