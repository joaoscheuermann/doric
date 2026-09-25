import {
  $applyCommentCards,
  $applyCommentMarks,
  $isCommentNode,
  cardsSignature,
  marksSignature,
} from '@/components/molecules/comment-marks';
import { $setMarkdown } from '@/components/molecules/markdown-blocks';
import {
  paintTurnChrome,
  turnChromeOf,
} from '@/components/molecules/turn-chrome';
import {
  $createAgentTurnNode,
  $createUserTurnNode,
  $isTurnNode,
  turnChromeShapeOf,
  type TurnNode,
} from '@/components/molecules/turn-node';
import {
  $createTurnPartNode,
  $isTurnPartNode,
  partHeadOf,
  type TurnPartNode,
} from '@/components/molecules/turn-part-node';
import {
  agentParts,
  type ConversationState,
  type ConversationTurn,
  documentSignature,
  partSignature,
  partsSignature,
  type TurnPart,
} from '@/domain/conversation';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $addUpdateTag,
  $getNodeByKey,
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
  // A dimmed turn waits in a history a resubmit replaces, so nothing writes
  // there — not even the composer, which is a place until an edit begins.
  const writable = turn.writable && !turn.dimmed;
  if (node.isWritable() !== writable) node.setWritable(writable);
  if (node.getStatus() !== turn.status) node.setStatus(turn.status);
  if (node.getLabel() !== turn.label) node.setLabel(turn.label);
  if (node.isDimmed() !== turn.dimmed) node.setDimmed(turn.dimmed);
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
 * A closed fold holds nothing: its content is not in the document at all, which is
 * why closing one is a write and not a hidden block. Only the last part of a
 * still-streaming turn is healed — that is the one the model may have left
 * half-written (`**bold`), and the only one where a missing closing marker is what
 * it is rather than what it means.
 */
const $applyParts = (
  editor: LexicalEditor,
  turn: TurnNode,
  derived: readonly TurnPart[],
): boolean => {
  const existing = new Map<string, TurnPartNode>();
  for (const child of turn.getChildren()) {
    if (!$isTurnPartNode(child)) continue;
    // A part whose own control is gone is not the part's DOM any more, so it is
    // rebuilt rather than kept: a fold nobody can open is a fold that failed.
    if (
      child.getPartKind() !== 'text' &&
      partHeadOf(editor.getElementByKey(child.getKey())) === null
    ) {
      continue;
    }
    existing.set(child.getPartKey(), child);
  }

  const streaming = turn.getStatus() === 'streaming';
  let rewrote = false;
  const wanted = derived.map((part, index) => {
    const node =
      existing.get(part.key) ??
      $createTurnPartNode({ key: part.key, kind: part.kind });
    $applyPartFields(node, part);
    if (node.isOpen() !== isOpenPart(part)) node.setOpen(isOpenPart(part));
    const signature = `${partSignature(part)}#${isOpenPart(part) ? 'open' : 'closed'}`;
    if (node.getApplied() !== signature) {
      const heal =
        streaming && part.kind !== 'tool' && index === derived.length - 1;
      const content =
        part.kind !== 'text' && part.open !== true ? '' : part.markdown;
      $setMarkdown(node, content, { heal, keep: $isCommentNode });
      node.setApplied(signature);
      rewrote = true;
    }
    return node;
  });

  const children = turn.getChildren();
  const keys = wanted.map((node) => node.getKey());
  // Identity is the node's key, not the object: writing any field gives the node
  // a new instance with the same key, so comparing instances would call every
  // write a change of structure and move the DOM — and the caret inside it.
  const same =
    children.length === keys.length &&
    children.every((child, index) => child.getKey() === keys[index]);
  if (same) return rewrote;

  const ordered = keys.flatMap((key) => {
    const node = $getNodeByKey(key);
    return node !== null && $isTurnPartNode(node) ? [node] : [];
  });

  for (const node of ordered) {
    if (node.getParent() !== null) node.remove();
  }
  for (const child of children) {
    if (
      child.getParent() !== null &&
      !ordered.includes(child as TurnPartNode)
    ) {
      child.remove();
    }
  }
  turn.splice(0, 0, ordered);
  return rewrote;
};

/**
 * Writes one turn, and only what it states differently. A person's turn renders
 * its words and the comments it carried; an agent's turn renders its parts and the
 * comments the words are about; the composer's content is the person's own, so the
 * document writes in it only to clear it once a prompt was accepted.
 */
const $applyTurn = (
  editor: LexicalEditor,
  node: TurnNode,
  turn: ConversationTurn,
  state: ConversationState,
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
    const rewrote = $applyParts(editor, node, agentParts(turn, state.open));
    const fields = turn.fields ?? [];
    const marks = marksSignature(turn.marks ?? [], fields);
    // Marks are found in the answer's own words, so a write of those words takes
    // them with it: every rewrite re-marks, in the same update, and only a turn
    // whose words were left alone can keep the marks it already has.
    if (rewrote || node.getAppliedMarks() !== marks) {
      $applyCommentMarks(node, turn.marks ?? [], fields);
      node.setAppliedMarks(marks);
    }
  } else {
    const comments = turn.comments ?? [];
    const signature = `${turn.markdown}#${cardsSignature(comments)}`;
    if (node.getApplied() !== signature) {
      $setMarkdown(node, turn.markdown, { keep: $isCommentNode });
      $applyCommentCards(node, comments);
      node.setApplied(signature);
    }
  }

  node.setAppliedText(node.getTextContent());
};

/** Whether a part states that its content is shown; a text run has no fold. */
const isOpenPart = (part: TurnPart): boolean =>
  part.kind === 'text' ? true : part.open;

const createTurnNode = (turn: ConversationTurn): TurnNode => {
  const shape = {
    key: turn.key,
    promptId: turn.promptId,
    draft: turn.draft,
    writable: turn.writable,
    status: turn.status,
    dimmed: turn.dimmed,
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
 *
 * `repair` says this write is putting a turn back rather than following the log, so
 * every turn nobody may write in is written out again from what the log says, even
 * where its own signature says it already matches. That is the whole point of the
 * invariant: the words on screen may have been changed without the log changing,
 * and only a write can take them back. The composer is left alone — its words are
 * the person's, and a repair is not a reason to empty them.
 */
const $reconcile = (
  editor: LexicalEditor,
  root: RootNode,
  turns: readonly ConversationTurn[],
  state: ConversationState,
  clear: number,
  repair = false,
): void => {
  const existing = new Map<string, TurnNode>();
  for (const child of root.getChildren()) {
    if (!$isTurnNode(child)) continue;
    const dom = editor.getElementByKey(child.getKey());
    if (turnChromeOf(dom) === null) {
      // A row that lost its chrome is not the row the log built, so it is rebuilt
      // from the log — except the composer, whose words are the person's: its
      // chrome is put back where it stands instead.
      if (child.isDraft() && dom !== null) {
        paintTurnChrome(dom, turnChromeShapeOf(child));
      } else {
        continue;
      }
    }
    existing.set(child.getTurnKey(), child);
  }

  const wanted = turns.map((turn) => {
    const node = existing.get(turn.key) ?? createTurnNode(turn);
    if (repair && !turn.draft && !turn.writable) {
      node.setApplied(null);
      node.setAppliedMarks(null);
      // An agent turn's words live in its parts, and each part is written only
      // when the signature it was built from changed. Repairing therefore has to
      // say that no part matches any more — otherwise the repair would leave the
      // answer as the browser left it and bless that as what the log says.
      for (const child of node.getChildren()) {
        if ($isTurnPartNode(child)) child.setApplied('');
      }
    }
    $applyTurn(editor, node, turn, state, clear);
    return node;
  });

  const children = root.getChildren();
  const keys = wanted.map((node) => node.getKey());
  // Identity is the node's key, not the object: writing any field gives the node
  // a new instance with the same key, so comparing instances would call every
  // write a change of structure, re-insert every turn, and take the caret with it.
  const same =
    children.length === keys.length &&
    children.every((child, index) => child.getKey() === keys[index]);
  if (same) return;

  const ordered = keys.flatMap((key) => {
    const node = $getNodeByKey(key);
    return node !== null && $isTurnNode(node) ? [node] : [];
  });

  for (const node of ordered) {
    if (node.getParent() !== null) node.remove();
  }
  for (const child of children) {
    if (child.getParent() !== null && !ordered.includes(child as TurnNode)) {
      child.remove();
    }
  }
  root.splice(0, 0, ordered);
};

/**
 * Whether the document still holds what the log states: the same turns, in the
 * same order, each still carrying the text the surface built into it, the chrome
 * that is not content at all, the parts the log gives it — a closed fold holds no
 * words, so a deleted fold would otherwise look intact — and, for the parts that
 * announce themselves, the head their own control lives on.
 *
 * The composer's words are not compared: they are the person's, never a rendering
 * of the log, so there is nothing to compare them to. Its chrome is checked, and a
 * repair puts that back in place without touching what the person wrote.
 */
const documentIsIntact = (
  editor: LexicalEditor,
  turns: readonly ConversationTurn[],
  open: ReadonlySet<string>,
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
    if (child.isDraft()) continue;
    const turn = turns.find((entry) => entry.key === child.getTurnKey());
    if (turn === undefined) return false;
    // Only an agent turn has parts: a person's turn holds its words directly, and
    // the comparison below covers those.
    if (turn.role === 'agent') {
      const parts = child
        .getChildren()
        .flatMap((part) => ($isTurnPartNode(part) ? [part] : []));
      const held = parts
        .map((part) => `${part.getPartKind()}:${part.getPartKey()}`)
        .join('\u0000');
      if (held !== partsSignature(turn, open)) return false;
      for (const part of parts) {
        if (part.getPartKind() === 'text') continue;
        if (partHeadOf(editor.getElementByKey(part.getKey())) === null) {
          return false;
        }
      }
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
  state: ConversationState,
  clear: number,
): void => {
  const [editor] = useLexicalComposerContext();
  const latest = useRef({ clear, state, turns });
  latest.current = { clear, state, turns };
  /** Whether an edit was in progress, so its end can put the turn back. */
  const wasEditing = useRef(state.editing !== undefined);

  useEffect(() => {
    const editing = state.editing !== undefined;
    // An edit that ended puts its turn back to being a rendering of the log, and
    // whatever was typed into it has to go back with it: nothing else would ever
    // write in a turn that just became sealed again.
    const restore = wasEditing.current && !editing;
    wasEditing.current = editing;
    editor.update(() => {
      $addUpdateTag(WRITE_TAG);
      $reconcile(editor, $getRoot(), turns, state, clear, restore);
    });
  }, [clear, editor, state, turns]);

  useEffect(() => {
    const inspect = (payload: UpdateListenerPayload): void => {
      if (payload.tags.has(WRITE_TAG)) return;
      const { clear: epoch, state: current, turns: derived } = latest.current;
      const intact = payload.editorState.read(() =>
        documentIsIntact(editor, derived, current.open),
      );
      if (intact) return;
      editor.update(() => {
        $addUpdateTag(WRITE_TAG);
        $reconcile(editor, $getRoot(), derived, current, epoch, true);
      });
    };
    return editor.registerUpdateListener(inspect);
  }, [editor]);
};
