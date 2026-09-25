import type { TurnRole } from '@/domain/conversation';
import type { PromptStatus } from '@/domain/projector';
import {
  $createParagraphNode,
  type ElementDOMSlot,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type ParagraphNode,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import {
  buildTurnDOM,
  paintTurnChrome,
  turnBodyOf,
  type TurnChromeShape,
} from './turn-chrome';

/**
 * A turn of the conversation, as the document holds it: one block whose children
 * are the pieces the log states, whatever its author. What it wears — its avatar,
 * its author label, its state cue — is chrome, and lives in `turn-chrome.ts`.
 */

export type SerializedTurnNode = Spread<
  {
    role: TurnRole;
    turnKey: string;
    promptId: string;
    draft: boolean;
    writable: boolean;
    dimmed: boolean;
    status: PromptStatus;
    label?: string;
  },
  SerializedElementNode
>;

export type TurnShape = {
  readonly key: string;
  readonly promptId: string;
  readonly role: TurnRole;
  readonly draft: boolean;
  readonly writable: boolean;
  readonly status: PromptStatus;
  readonly label?: string;
  readonly dimmed?: boolean;
};

/**
 * The chrome a turn's own fields describe, in the shape the chrome draws from. The
 * surface reads it too, to put a turn's chrome back where it stands.
 */
export const turnChromeShapeOf = (turn: TurnNode): TurnChromeShape => ({
  dimmed: turn.isDimmed(),
  draft: turn.isDraft(),
  role: turn.getTurnRole(),
  status: turn.getStatus(),
  ...(turn.getLabel() === undefined ? {} : { label: turn.getLabel() }),
});

const emptyTurnShape = (): TurnShape => ({
  key: '',
  promptId: '',
  role: 'agent',
  draft: false,
  writable: false,
  status: 'completed',
});

/** The shape a node states, so a clone can be built from any turn node. */
const turnShapeOf = (node: TurnNode): TurnShape => ({
  key: node.__turnKey,
  promptId: node.__promptId,
  role: node.__role,
  draft: node.__draft,
  writable: node.__writable,
  status: node.__status,
  dimmed: node.__dimmed,
  ...(node.__label === undefined ? {} : { label: node.__label }),
});

/**
 * Carries what Lexical's own clone does not know about. A clone exists so a setter
 * can write without touching the version another reference holds, so it has to
 * bring every field of this node — a clone that dropped them would be a node that
 * had silently forgotten which turn it is.
 */
const carryTurnState = <Node extends TurnNode>(from: Node, to: Node): Node => {
  to.__applied = from.__applied;
  to.__appliedMarks = from.__appliedMarks;
  to.__appliedText = from.__appliedText;
  return to;
};

export class TurnNode extends ElementNode {
  __turnKey: string;
  __promptId: string;
  __role: TurnRole;
  __draft: boolean;
  __writable: boolean;
  __status: PromptStatus;
  __label?: string;
  /** Set while this turn waits in a history a resubmit will discard. */
  __dimmed: boolean;
  /** The signature this turn's own children were built from; `null` never built. */
  __applied: string | null;
  /** The signature of the comment marks this turn carries; `null` never built. */
  __appliedMarks: string | null;
  /** The text the turn held when it was last built, checked for tampering. */
  __appliedText: string;

  static override getType(): string {
    return 'doric-turn';
  }

  /**
   * Every class that extends this one declares its own `clone`: Lexical
   * synthesizes one for a class that does not, and the synthesized clone builds
   * the node with no shape at all (`new Klass()`), which would lose every field a
   * turn is made of.
   */
  static override clone(node: TurnNode): TurnNode {
    return carryTurnState(node, new TurnNode(turnShapeOf(node), node.__key));
  }

  /**
   * The document is rebuilt from the log every time the log arrives, so a node
   * deserialized from JSON (copy, undo, paste) only has to exist: the surface
   * fills it from the log on the next reconcile. Nothing here is read.
   */
  static override importJSON(): TurnNode {
    return $createTurnNode(emptyTurnShape());
  }

  constructor(shape: TurnShape = emptyTurnShape(), key?: NodeKey) {
    super(key);
    this.__turnKey = shape.key;
    this.__promptId = shape.promptId;
    this.__role = shape.role;
    this.__draft = shape.draft;
    this.__writable = shape.writable;
    this.__status = shape.status;
    this.__label = shape.label;
    this.__dimmed = shape.dimmed ?? false;
    this.__applied = null;
    this.__appliedMarks = null;
    this.__appliedText = '';
  }

  override exportJSON(): SerializedTurnNode {
    return {
      ...super.exportJSON(),
      draft: this.__draft,
      dimmed: this.__dimmed,
      promptId: this.__promptId,
      role: this.__role,
      status: this.__status,
      turnKey: this.__turnKey,
      writable: this.__writable,
      ...(this.__label === undefined ? {} : { label: this.__label }),
    };
  }

  getTurnKey(): string {
    return this.getLatest().__turnKey;
  }

  setTurnKey(value: string): this {
    const node = this.getWritable();
    node.__turnKey = value;
    return node;
  }

  getPromptId(): string {
    return this.getLatest().__promptId;
  }

  setPromptId(value: string): this {
    const node = this.getWritable();
    node.__promptId = value;
    return node;
  }

  getTurnRole(): TurnRole {
    return this.getLatest().__role;
  }

  setTurnRole(value: TurnRole): this {
    const node = this.getWritable();
    node.__role = value;
    return node;
  }

  isDraft(): boolean {
    return this.getLatest().__draft;
  }

  setDraft(value: boolean): this {
    const node = this.getWritable();
    node.__draft = value;
    return node;
  }

  /** Whether the person may write here; the one rule the seal reads. */
  isWritable(): boolean {
    return this.getLatest().__writable;
  }

  setWritable(value: boolean): this {
    const node = this.getWritable();
    node.__writable = value;
    return node;
  }

  getStatus(): PromptStatus {
    return this.getLatest().__status;
  }

  setStatus(value: PromptStatus): this {
    const node = this.getWritable();
    node.__status = value;
    return node;
  }

  getLabel(): string | undefined {
    return this.getLatest().__label;
  }

  setLabel(value: string | undefined): this {
    const node = this.getWritable();
    node.__label = value;
    return node;
  }

  /**
   * Whether this turn waits in a history a resubmit discards. The surface shows it
   * translucent: those words are still there, but they are not what is being said.
   */
  isDimmed(): boolean {
    return this.getLatest().__dimmed;
  }

  setDimmed(value: boolean): this {
    const node = this.getWritable();
    node.__dimmed = value;
    return node;
  }

  getAppliedMarks(): string | null {
    return this.getLatest().__appliedMarks;
  }

  setAppliedMarks(value: string | null): this {
    const node = this.getWritable();
    node.__appliedMarks = value;
    return node;
  }

  getApplied(): string | null {
    return this.getLatest().__applied;
  }

  setApplied(value: string | null): this {
    const node = this.getWritable();
    node.__applied = value;
    return node;
  }

  getAppliedText(): string {
    return this.getLatest().__appliedText;
  }

  /** Records what the turn holds right now, as the log describes it. */
  setAppliedText(value: string): this {
    const node = this.getWritable();
    node.__appliedText = value;
    return node;
  }

  override createDOM(): HTMLElement {
    return buildTurnDOM(turnChromeShapeOf(this));
  }

  /**
   * Repaints the chrome and never rebuilds the element: rebuilding it would take
   * the turn's content DOM, and the caret inside it, down with it. Fields that
   * changed are written by hand; the DOM is Lexical's to leave alone.
   */
  /**
   * Repaints the chrome and never rebuilds the element: rebuilding it would take
   * the turn's content DOM, and the caret inside it, down with it. Fields that
   * changed are written by hand; the DOM is Lexical's to leave alone.
   *
   * The comparison reads the *previous* node's own fields rather than through its
   * getters: every getter here answers with `getLatest()`, which is this node, so
   * asking the previous node what it held would only ever repeat the answer this
   * one gives — and a chrome that never repainted is exactly what that looks like.
   */
  override updateDOM(previous: TurnNode, dom: HTMLElement): boolean {
    if (
      previous.__role !== this.__role ||
      previous.__status !== this.__status ||
      previous.__label !== this.__label ||
      previous.__draft !== this.__draft ||
      previous.__dimmed !== this.__dimmed
    ) {
      paintTurnChrome(dom, turnChromeShapeOf(this));
    }
    return false;
  }

  /**
   * Where Lexical puts this turn's children: the body element, not the row. The
   * chrome and the label are therefore outside the managed range, and the slot's
   * element is what a DOM caret maps against — so an offset in the body counts
   * content children only.
   */
  override getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const body = turnBodyOf(element);
    if (body === undefined) return super.getDOMSlot(element);
    return super.getDOMSlot(element).withElement(body);
  }

  /** A turn with no content still keeps a line for the caret to rest in. */
  override canBeEmpty(): boolean {
    return true;
  }

  /**
   * Enter inside a turn makes another line of that turn, never another turn: a
   * cloned turn would duplicate an avatar and orphan the words inside it. Lexical
   * only asks the turn to split when the turn itself is the block the caret sits
   * in — an empty turn — because a block inside it (a paragraph, and every one a
   * part holds) answers the split itself, in place.
   */
  override insertNewAfter(): ParagraphNode {
    const paragraph = $createParagraphNode();
    this.append(paragraph);
    return paragraph;
  }
}

export const $createTurnNode = (shape: TurnShape): TurnNode =>
  new TurnNode(shape);

export const $isTurnNode = (node: LexicalNode): node is TurnNode =>
  node instanceof TurnNode;

/**
 * The turn a node belongs to, however deep it sits: a paragraph, a part and the
 * runs inside them all answer with the same turn.
 */
export const $turnOf = (node: LexicalNode): TurnNode | undefined => {
  let current: LexicalNode | null = node;
  while (current !== null) {
    if (current instanceof TurnNode) return current;
    current = current.getParent();
  }
  return undefined;
};

/**
 * The turn a person's own words live in, and the turn the agent answers with.
 * They hold the same kind of children and wear the same chrome: only the role
 * they were created with, and what the log fills them with, differ.
 */
export class UserTurnNode extends TurnNode {
  static override getType(): string {
    return 'doric-user-turn';
  }

  static override clone(node: UserTurnNode): UserTurnNode {
    return carryTurnState(
      node,
      new UserTurnNode(turnShapeOf(node), node.__key),
    );
  }

  static override importJSON(): UserTurnNode {
    return new UserTurnNode(emptyTurnShape());
  }
}

export class AgentTurnNode extends TurnNode {
  static override getType(): string {
    return 'doric-agent-turn';
  }

  static override clone(node: AgentTurnNode): AgentTurnNode {
    return carryTurnState(
      node,
      new AgentTurnNode(turnShapeOf(node), node.__key),
    );
  }

  static override importJSON(): AgentTurnNode {
    return new AgentTurnNode(emptyTurnShape());
  }
}

/** The turn a person writes in, or the turn another Thread wrote in for them. */
export const $createUserTurnNode = (
  shape: Omit<TurnShape, 'role'>,
): UserTurnNode => new UserTurnNode({ ...shape, role: 'user' });

/** The turn the model answered in. */
export const $createAgentTurnNode = (
  shape: Omit<TurnShape, 'role'>,
): AgentTurnNode => new AgentTurnNode({ ...shape, role: 'agent' });
