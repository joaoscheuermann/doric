import type { TurnPart } from '@/domain/conversation';
import {
  createCommand,
  type ElementDOMSlot,
  ElementNode,
  getNearestEditorFromDOMNode,
  type LexicalCommand,
  type NodeKey,
  type SerializedElementNode,
  setDOMUnmanaged,
  type Spread,
} from 'lexical';

import { lucideIcon, type LucideShape } from './turn-chrome';

/**
 * The command a part's own head sends when it is clicked. A head is chrome — DOM
 * the node owns outside the range Lexical manages — so it cannot read the
 * surface's actions the way a React-rendered block does; it names the part by its
 * node key instead, and the surface answers with the fold that key means.
 */
export const TOGGLE_FOLD_COMMAND: LexicalCommand<string> = createCommand(
  'TOGGLE_FOLD_COMMAND',
);

/**
 * One piece of a turn: a run of the answer, a run of the model's reasoning, or a
 * tool call. It is the unit a streaming answer rewrites — the run it is still
 * appending to — so every other part keeps its nodes, its DOM and the caret.
 *
 * Its head (`Thinking`, `Call write`) is chrome, exactly like a turn's avatar: DOM
 * the part owns outside the range Lexical manages, so it is not a node, cannot be
 * deleted or selected, and holds no caret position. Only the part's content lives
 * in the managed range.
 */

export type PartKind = TurnPart['kind'];

/** How a tool call reads while it runs, and after. */
export type PartStatus = 'running' | 'finished' | 'failed';

export type SerializedTurnPartNode = Spread<
  {
    applied: string;
    callId: string;
    kind: PartKind;
    name: string;
    partKey: string;
    status: PartStatus;
  },
  SerializedElementNode
>;

export type PartShape = {
  readonly key: string;
  readonly kind: PartKind;
  readonly name?: string;
  readonly status?: PartStatus;
  readonly callId?: string;
  readonly open?: boolean;
};

/** Where each part's managed children live, keyed by the part's own DOM. */
const bodies = new WeakMap<HTMLElement, HTMLElement>();

const BODY = 'data-doric-body';
const HEAD = 'data-doric-head';

/**
 * Which icon a part's head announces itself with. The value is also the head's
 * `data-doric-icon`, so it is the one contract with `styles.css`: that sheet
 * paints `[data-doric-icon='thinking']` and `[data-doric-icon='tool']`
 * differently, and every icon the head draws wears `doric-icon` for its size.
 */
export type PartHeadIcon = 'thinking' | 'tool';

/** Reasoning, a brain. The geometry is lucide's, copied as a `LucideShape`. */
const BRAIN: readonly LucideShape[] = [
  ['path', { d: 'M12 18V5' }],
  ['path', { d: 'M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4' }],
  ['path', { d: 'M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5' }],
  ['path', { d: 'M17.997 5.125a4 4 0 0 1 2.526 5.77' }],
  ['path', { d: 'M18 18a4 4 0 0 0 2-7.464' }],
  ['path', { d: 'M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517' }],
  ['path', { d: 'M6 18a4 4 0 0 1-2-7.464' }],
  ['path', { d: 'M6.003 5.125a4 4 0 0 0-2.526 5.77' }],
];

/** A tool call, a wrench. */
const WRENCH: readonly LucideShape[] = [
  [
    'path',
    {
      d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z',
    },
  ],
];

/** The fold's chevron; the head's own `data-open` turns it. */
const CHEVRON: readonly LucideShape[] = [['path', { d: 'm9 18 6-6-6-6' }]];

/** The icon each kind of head wears. */
const HEAD_ICON: Readonly<Record<PartHeadIcon, readonly LucideShape[]>> = {
  thinking: BRAIN,
  tool: WRENCH,
};

/** The sentence a part's head shows, and whether it says anything at all. */
const headText = (part: TurnPartNode): string | undefined => {
  if (part.getPartKind() === 'thinking') return 'Thinking';
  if (part.getPartKind() === 'tool') {
    const name = part.getName();
    return name.length === 0 ? 'Call' : `Call ${name}`;
  }
  return undefined;
};

const buildPartDOM = (part: TurnPartNode): HTMLElement => {
  const dom = document.createElement('div');
  dom.className = 'doric-part';
  dom.dataset.part = part.getPartKind();

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'doric-part-head';
  head.setAttribute(HEAD, '');
  head.contentEditable = 'false';
  head.style.userSelect = 'none';
  setDOMUnmanaged(head);

  const body = document.createElement('div');
  body.className = 'doric-part-body';
  body.setAttribute(BODY, '');

  dom.append(head, body);
  bodies.set(dom, body);
  paintHead(dom, part);
  return dom;
};

/**
 * Writes a part's head: the icon it is, what it announces, and the chevron that
 * folds it. A text part announces nothing and so keeps no head at all — which is
 * what leaves a run of prose reading as the paragraphs it is.
 */
const paintHead = (dom: HTMLElement, part: TurnPartNode): void => {
  const head = dom.querySelector<HTMLElement>(`[${HEAD}]`);
  if (head === null) return;
  const kind = part.getPartKind();
  if (kind === 'text') {
    head.remove();
    return;
  }
  const title = document.createElement('span');
  title.textContent = headText(part) ?? '';
  head.dataset.doricIcon = kind;
  head.replaceChildren(
    lucideIcon(HEAD_ICON[kind], 'doric-icon', '0.875rem'),
    title,
    lucideIcon(CHEVRON, 'doric-icon doric-part-chevron', '0.75rem'),
  );
  head.dataset.open = String(part.isOpen());
  head.setAttribute('aria-expanded', String(part.isOpen()));
};

/** The head of a part's DOM, when it still has one. */
const headOf = (dom: HTMLElement): HTMLElement | null =>
  dom.querySelector<HTMLElement>(`[${HEAD}]`);

/**
 * The head a part's row carries, or `null` when its DOM no longer has one. The
 * surface reads it to decide whether a part on screen is still the part the log
 * built — a part that announces itself has one control, and losing it would leave
 * a fold nobody can open.
 */
export const partHeadOf = (dom: HTMLElement | null): HTMLElement | null =>
  dom === null ? null : headOf(dom);

export class TurnPartNode extends ElementNode {
  __partKey: string;
  __partKind: PartKind;
  __name: string;
  __status: PartStatus;
  __callId: string;
  /** Whether the person unfolded this part's content. */
  __open: boolean;
  /** The signature whose blocks this part currently holds; `''` never built. */
  __applied: string;

  static override getType(): string {
    return 'doric-part';
  }

  static override clone(node: TurnPartNode): TurnPartNode {
    const copy = new TurnPartNode(
      {
        key: node.__partKey,
        kind: node.__partKind,
        name: node.__name,
        status: node.__status,
        callId: node.__callId,
      },
      node.__key,
    );
    copy.__applied = node.__applied;
    copy.__open = node.__open;
    return copy;
  }

  /** A part from JSON carries no log data: the surface rebuilds it. */
  static override importJSON(): TurnPartNode {
    return new TurnPartNode({ key: '', kind: 'text' });
  }

  constructor(shape: PartShape, key?: NodeKey) {
    super(key);
    this.__partKey = shape.key;
    this.__partKind = shape.kind;
    this.__name = shape.name ?? '';
    this.__status = shape.status ?? 'running';
    this.__callId = shape.callId ?? '';
    this.__open = shape.open ?? false;
    this.__applied = '';
  }

  override exportJSON(): SerializedTurnPartNode {
    return {
      ...super.exportJSON(),
      applied: this.__applied,
      callId: this.__callId,
      kind: this.__partKind,
      name: this.__name,
      partKey: this.__partKey,
      status: this.__status,
    };
  }

  getPartKey(): string {
    return this.getLatest().__partKey;
  }

  setPartKey(value: string): this {
    const node = this.getWritable();
    node.__partKey = value;
    return node;
  }

  getPartKind(): PartKind {
    return this.getLatest().__partKind;
  }

  setPartKind(value: PartKind): this {
    const node = this.getWritable();
    node.__partKind = value;
    return node;
  }

  getName(): string {
    return this.getLatest().__name;
  }

  setName(value: string): this {
    const node = this.getWritable();
    node.__name = value;
    return node;
  }

  getStatus(): PartStatus {
    return this.getLatest().__status;
  }

  setStatus(value: PartStatus): this {
    const node = this.getWritable();
    node.__status = value;
    return node;
  }

  getCallId(): string {
    return this.getLatest().__callId;
  }

  setCallId(value: string): this {
    const node = this.getWritable();
    node.__callId = value;
    return node;
  }

  isOpen(): boolean {
    return this.getLatest().__open;
  }

  setOpen(value: boolean): this {
    const node = this.getWritable();
    node.__open = value;
    return node;
  }

  getApplied(): string {
    return this.getLatest().__applied;
  }

  setApplied(value: string): this {
    const node = this.getWritable();
    node.__applied = value;
    return node;
  }

  override createDOM(): HTMLElement {
    const dom = buildPartDOM(this);
    // The head reports the click and nothing else: which part it belongs to is
    // the node's own key, so the surface never has to trust a stale reference.
    headOf(dom)?.addEventListener('click', () => {
      // A DOM handler runs outside any editor context, so the editor is found
      // from the DOM the head belongs to rather than carried in a field.
      getNearestEditorFromDOMNode(dom)?.dispatchCommand(
        TOGGLE_FOLD_COMMAND,
        this.getKey(),
      );
    });
    return dom;
  }

  /**
   * Repaints the head in place; the part's content DOM is never rebuilt. The
   * comparison reads the previous node's own fields, because every getter here
   * answers with the latest node — which is this one.
   */
  override updateDOM(previous: TurnPartNode, dom: HTMLElement): boolean {
    if (
      previous.__partKind !== this.__partKind ||
      previous.__name !== this.__name ||
      previous.__status !== this.__status ||
      previous.__open !== this.__open
    ) {
      paintHead(dom, this);
    }
    dom.dataset.status = this.getStatus();
    dom.dataset.open = String(this.isOpen());
    return false;
  }

  /** The part's content lives in its body, beside the head it announces itself in. */
  override getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const body = bodies.get(element);
    if (body === undefined) return super.getDOMSlot(element);
    return super.getDOMSlot(element).withElement(body);
  }

  override canBeEmpty(): boolean {
    return true;
  }
}

export const $createTurnPartNode = (shape: PartShape): TurnPartNode =>
  new TurnPartNode(shape);

export const $isTurnPartNode = (node: unknown): node is TurnPartNode =>
  node instanceof TurnPartNode;
