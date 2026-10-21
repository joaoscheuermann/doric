import { $isListNode } from '@lexical/list';
import {
  $getRoot,
  $isElementNode,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import type { AnchorBlock } from '../../../../domain/comment-excerpt.js';
import { bySeatPlace } from '../../../../domain/comment-seats.js';
import { AGENT_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { AgentTurn, PromptStatus } from '../../../../domain/projector.js';
import {
  $createCommentSeatNode,
  $isCommentSeatNode,
  type CommentSeatNode,
} from './comment-seat-node.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';
import { $appendMarkdown, $setMarkdown } from './markdown-blocks.js';
import {
  applyTurnAvatar,
  sameTurnAvatar,
  type TurnAvatar,
} from './turn-avatar.js';

/**
 * The seats a turn holds, in the order they stand: after its blocks, or at the
 * end of one of its lists' items.
 */
const $seatsOf = (turn: AgentTurnNode): CommentSeatNode[] =>
  turn.getChildren().flatMap((child) => {
    if ($isCommentSeatNode(child)) return [child];
    if (!$isListNode(child)) return [];
    return child
      .getChildren()
      .flatMap((item) =>
        $isElementNode(item)
          ? item.getChildren().filter($isCommentSeatNode)
          : [],
      );
  });

/**
 * Puts the seats where they stand, none of them in the turn yet. A seat stands
 * in the innermost block that holds the end of its words: the `after`-th of
 * the turn's markdown children, or — when that block is a list — the end of its
 * `item`-th item, so a comment on a list item closes that item, before the
 * next one. The seats of one place stand in the order of the passages they are
 * about (`bySeatPlace`). An item that is gone puts the seat after its list, and
 * a block that is gone puts it at the turn's end.
 */
const $placeSeats = (
  turn: AgentTurnNode,
  seats: readonly CommentSeatNode[],
): void => {
  const blocks = turn.blocks();
  const last = new Map<number, LexicalNode>();

  for (const seat of [...seats].sort(bySeatPlace)) {
    const block = blocks[seat.after];
    const item =
      seat.item === undefined || !$isListNode(block)
        ? undefined
        : block.getChildren()[seat.item];
    if ($isElementNode(item)) {
      item.append(seat);
      continue;
    }
    const previous = last.get(seat.after) ?? block;
    if (previous === undefined) turn.append(seat);
    else previous.insertAfter(seat);
    last.set(seat.after, seat);
  }
};

/**
 * Puts one new seat where `$placeSeats` would put it among the seats the turn
 * already holds, which stay where they stand, untouched: at the end of its
 * list item, among that item's seats, or among the seats that follow its
 * block, in passage order. A seat after a block that is gone takes the whole
 * placement again.
 */
const $placeSeat = (turn: AgentTurnNode, seat: CommentSeatNode): void => {
  const block = turn.blocks()[seat.after];
  if (block === undefined) {
    const seats = $seatsOf(turn);
    for (const standing of seats) standing.remove();
    $placeSeats(turn, [...seats, seat]);
    return;
  }
  const item =
    seat.item === undefined || !$isListNode(block)
      ? undefined
      : block.getChildren()[seat.item];
  if ($isElementNode(item)) {
    const next = item
      .getChildren()
      .find(
        (child) => $isCommentSeatNode(child) && bySeatPlace(seat, child) < 0,
      );
    if (next === undefined) item.append(seat);
    else next.insertBefore(seat);
    return;
  }
  let previous: LexicalNode = block;
  for (
    let next = block.getNextSibling();
    $isCommentSeatNode(next) &&
    next.after === seat.after &&
    bySeatPlace(next, seat) < 0;
    next = next.getNextSibling()
  )
    previous = next;
  previous.insertAfter(seat);
};

export type SerializedAgentTurnNode = Spread<
  {
    turnKey: string;
    promptId: string;
    status: PromptStatus;
    avatar?: TurnAvatar;
  },
  SerializedElementNode
>;

/**
 * A run of the agent's answer as a block the reader can read and move the caret
 * through, but not edit: the chat owns the text. Its text lives as child nodes
 * so the caret reaches it like any other rich text, and those children are the
 * markdown the answer was written in — read as blocks, with every marker kept,
 * so the transcript styles what the model wrote instead of replacing it.
 *
 * Because the block is read-only, a sync never has a reader's edit to protect: it
 * always takes the chat's latest markdown. That is not a detail — the editor
 * normalizes the tree a build produces (a table pads its short rows), so the text
 * a block holds after a build is not the text it held in the same update. A guard
 * that compared the two would refuse every later sync and freeze the answer at
 * whatever a stream had built so far.
 */
export class AgentTurnNode extends ElementNode {
  __turnKey: string;
  __promptId: string;
  __status: PromptStatus;
  /** The markdown the chat last wrote, so a sync that changed nothing is a no-op. */
  __synced: string;
  /** The mark the block draws in the gutter, or `null` for none. */
  __avatar: TurnAvatar;

  constructor(
    turnKey: string,
    promptId: string,
    status: PromptStatus,
    text: string,
    avatar: TurnAvatar = null,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__status = status;
    this.__synced = text.trim();
    this.__avatar = avatar;
  }

  static override getType(): string {
    return AGENT_TURN_BLOCK;
  }

  static override clone(node: AgentTurnNode): AgentTurnNode {
    return new AgentTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__status,
      node.__synced,
      node.__avatar,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap a turn stands from the one before it, the same as the
    // author line's bottom margin gives a reader's turn, so every turn's mark
    // stands as far from the block above it. A summary before this answer
    // carries no bottom margin of its own, so the gap has to be stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    applyTurnAvatar(dom, this.__avatar);
    return dom;
  }

  /**
   * The mark is attributes and custom properties on the element the block
   * already drew, so it is written again in place and the element is kept: the
   * markdown children are never rebuilt to repaint a gutter. A block made dirty
   * by anything else — a streamed delta, a keystroke — keeps the mark it wears
   * untouched, so its subtree is not restyled for nothing.
   */
  override updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (!sameTurnAvatar(prevNode.__avatar, this.__avatar))
      applyTurnAvatar(dom, this.__avatar);
    return false;
  }

  /** The mark the block wears in the gutter; the sync sets it, the block draws it. */
  setAvatar(avatar: TurnAvatar): void {
    if (sameTurnAvatar(this.__avatar, avatar)) return;
    this.getWritable().__avatar = avatar;
  }

  override isInline(): boolean {
    return false;
  }

  /**
   * Opens a new comment's seat quoting `quote`, which starts `at` characters
   * (whitespace aside) into block `block`. It stands after block `after`
   * (`block` when not given) or, when `item` names one of that list's items,
   * at the end of the item. The other seats stay where they stand, untouched,
   * and the new one stands among those of its place in passage order.
   */
  openSeat(seat: {
    readonly id: string;
    readonly block: number;
    readonly quote: string;
    readonly at: number;
    readonly after?: number;
    readonly item?: number;
    readonly startItem?: number;
  }): CommentSeatNode {
    const opened = $createCommentSeatNode({
      ...seat,
      promptId: this.__promptId,
      turn: this.__turnKey,
    });
    $placeSeat(this, opened);

    return opened;
  }

  /**
   * Draws the chat's markdown again, whatever the DOM made of the block's text,
   * keeping its comments where they stand. An input method's composition is
   * the one change no command refuses: the browser writes it into the DOM and
   * the editor reads it back.
   */
  restore(): void {
    const writable = this.getWritable();
    const seats = $seatsOf(writable);
    for (const seat of seats) seat.remove();
    writable.clear();
    if (writable.__synced.length > 0)
      $appendMarkdown(writable, writable.__synced);
    $placeSeats(writable, seats);
  }

  /** The answer's markdown blocks, in order: its children, its seats aside. */
  blocks(): LexicalNode[] {
    return this.getChildren().filter((child) => !$isCommentSeatNode(child));
  }

  /** The seats this turn holds, in the order they stand. */
  seats(): readonly CommentSeatNode[] {
    return $seatsOf(this);
  }

  /** Record the job's lifecycle; the status never depends on the reader. */
  setStatus(status: PromptStatus): void {
    if (this.__status === status) return;
    this.getWritable().__status = status;
  }

  /**
   * Take the chat's latest markdown. The children the new source still starts
   * with stay where they are and only the tail the source outgrew is built
   * again — a sync that says nothing new touches nothing, and a sync that adds
   * a delta to a streamed answer pays for the delta, not the answer. The source
   * is read, never rewritten: what the block holds is still what the model
   * wrote, and the reader keeps the caret where it was.
   */
  setTurn(turn: AgentTurn): void {
    const value = turn.text.trim();
    const textChanged = value !== this.__synced;
    if (!textChanged && this.__status === turn.status) return;

    const writable = this.getWritable();
    if (writable.__status !== turn.status) writable.__status = turn.status;
    if (!textChanged) return;

    const previous = writable.__synced;
    writable.__synced = value;
    // The seats are not part of the markdown: they leave the children while the
    // source rebuilds it, and come back after their own blocks, so the answer's
    // text children stay the source's and each seat keeps its place.
    const seats = $seatsOf(writable);
    for (const seat of seats) seat.remove();
    if (value.length > 0) $setMarkdown(writable, value, previous);
    else writable.clear();
    $placeSeats(writable, seats);
  }

  override exportJSON(): SerializedAgentTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      status: this.__status,
      ...(this.__avatar === null ? {} : { avatar: this.__avatar }),
    };
  }

  static override importJSON(
    serialized: SerializedAgentTurnNode,
  ): AgentTurnNode {
    return $createAgentTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.status,
      '',
      serialized.avatar ?? null,
    );
  }
}

export function $createAgentTurnNode(
  turnKey: string,
  promptId: string,
  status: PromptStatus,
  text: string,
  avatar: TurnAvatar = null,
): AgentTurnNode {
  const value = text.trim();
  const node = new AgentTurnNode(turnKey, promptId, status, value, avatar);
  if (value.length > 0) $appendMarkdown(node, value);
  return node;
}

export function $isAgentTurnNode(
  node: LexicalNode | null | undefined,
): node is AgentTurnNode {
  return node instanceof AgentTurnNode;
}

/** The agent turn a node stands in, itself included, else `undefined`. */
export const $turnOf = (node: LexicalNode): AgentTurnNode | undefined => {
  for (let at: LexicalNode | null = node; at !== null; at = at.getParent()) {
    if ($isAgentTurnNode(at)) return at;
  }
  return undefined;
};

/** The agent turns the transcript shows, in order. */
export const $agentTurns = (): AgentTurnNode[] =>
  $getRoot().getChildren().filter($isAgentTurnNode);

/** The agent turn keyed `key`, else `undefined`. */
export const $agentTurn = (key: string): AgentTurnNode | undefined =>
  $agentTurns().find((turn) => turn.__turnKey === key);

/**
 * Block `block` of the agent turn keyed `turn` — or, when the anchor names one
 * of that list's items, the item — else `undefined`.
 */
export const $anchorBlockNode = ({
  turn,
  block,
  item,
}: AnchorBlock): LexicalNode | undefined => {
  const node = $agentTurn(turn)?.blocks()[block];
  if (item === undefined || !$isListNode(node)) return node;
  return node.getChildren()[item] ?? node;
};
