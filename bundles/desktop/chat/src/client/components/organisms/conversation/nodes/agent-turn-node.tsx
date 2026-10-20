import {
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

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

/** The seats a turn holds, in the order they stand. */
const $seatsOf = (turn: AgentTurnNode): CommentSeatNode[] =>
  turn.getChildren().filter($isCommentSeatNode);

/**
 * Puts each seat back after the block it belongs to: the blocks are the turn's
 * markdown children, so the seat after block `n` follows the `n`-th of them.
 */
const $placeSeats = (
  turn: AgentTurnNode,
  seats: readonly CommentSeatNode[],
): void => {
  const blocks = turn
    .getChildren()
    .filter((child) => !$isCommentSeatNode(child));

  for (const seat of seats) {
    seat.setOwner(turn);
    const after = blocks[seat.block];
    if (after === undefined) turn.append(seat);
    else after.insertAfter(seat);
  }
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
  /** The children the block last read while an editor state answered. */
  __held: LexicalNode[] = [];

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
    // `mt-10`: the gap a turn stands from the one before it. The author line's
    // bottom margin gives every other case, but a reader's prompt and an answer
    // are the pair the transcript reads as an exchange, so the answer stands
    // further from the prompt than one step stands from the next.
    dom.className = `mt-10 ${CONVERSATION_FONT_CLASS}`;
    applyTurnAvatar(dom, this.__avatar);
    return dom;
  }

  /**
   * The mark is attributes and custom properties on the element the block
   * already drew, so it is written again in place and the element is kept: the
   * markdown children are never rebuilt to repaint a gutter.
   */
  override updateDOM(_prevNode: this, dom: HTMLElement): boolean {
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
   * The answer's blocks and seats. The editor's own walk reads the node map,
   * which only answers inside a read; outside one — a replay's check of what
   * the block holds — the children it last read while the state answered.
   */
  override getChildren<T extends LexicalNode>(): T[] {
    try {
      const children = super.getChildren<T>();
      this.__held = children;
      return children;
    } catch {
      return this.__held as T[];
    }
  }

  /** The seat standing after one of the answer's blocks, when one does. */
  seat(block: number): CommentSeatNode | undefined {
    return $seatsOf(this).find((seat) => seat.block === block);
  }

  /**
   * Opens the seat after `block`, quoting `quote`: the one already standing
   * there is reopened with the new words, else a seat is created right after
   * that block.
   */
  openSeat(block: number, quote: string): CommentSeatNode {
    const existing = this.seat(block);
    if (existing !== undefined) {
      existing.setQuote(quote);
      existing.setTurn(this.__turnKey);
      existing.setOpen(true);

      return existing;
    }

    const seat = $createCommentSeatNode(this.__promptId, block, quote);
    seat.setTurn(this.__turnKey);
    $placeSeats(this, [seat]);

    return seat;
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
