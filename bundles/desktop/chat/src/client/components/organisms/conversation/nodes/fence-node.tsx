/**
 * A fence of a registered tag in an agent's answer (openui.md D1): the node
 * holds the fence's tag, key and source; what it draws is the element the
 * tag's fence renderer names, created once per tag and key through `ui/v1` and
 * kept across the rebuilds a streaming turn takes, so a streaming fence never
 * remounts.
 */

import type { Ui } from 'bundle/contracts';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { createContext, useContext, useEffect, useRef } from 'react';
import type { JSX } from 'react/jsx-runtime';

import type {
  ChatFence,
  ChatFenceView,
} from '../../../../../contracts/index.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';

/** The node type of a fence. */
export const FENCE_NODE = 'chat-fence-node';

/**
 * The conversation's own key of one fence: its tag and its key, since two
 * tags' fences of one turn share a key (D2).
 */
export const fenceElementKey = (tag: string, key: string): string =>
  `${tag}\n${key}`;

interface Held {
  readonly element: object;
  count: number;
}

const sameFence = (one: ChatFence, other: ChatFence): boolean =>
  one.key === other.key &&
  one.state === other.state &&
  one.body === other.body &&
  one.info === other.info;

const sameView = (one: ChatFenceView, other: ChatFenceView): boolean =>
  one.origin === other.origin &&
  sameFence(one.fence, other.fence) &&
  one.fences.length === other.fences.length &&
  one.fences.every((fence, at) => {
    const that = other.fences[at];
    return that !== undefined && sameFence(fence, that);
  });

/**
 * The conversation's fence elements, one per tag and key, with the count of
 * the decorators that show each. A count that falls to 0 disposes the element
 * one microtask later unless a decorator took it again, which is what a
 * rebuilt fence node does within the same commit.
 */
export class FenceElements {
  readonly #held = new Map<string, Held>();
  readonly #ui: Pick<Ui, 'create' | 'dispose'>;
  readonly #threadId: string;
  readonly #elementTagOf: (tag: string) => string | undefined;
  #views: ReadonlyMap<string, ChatFenceView> = new Map();

  constructor(
    ui: Pick<Ui, 'create' | 'dispose'>,
    threadId: string,
    elementTagOf: (tag: string) => string | undefined,
  ) {
    this.#ui = ui;
    this.#threadId = threadId;
    this.#elementTagOf = elementTagOf;
  }

  /**
   * Takes the views of this flush, keyed by `fenceElementKey`: a view that
   * says what the last one said stays the same object, and each held element
   * whose view changed gets the new one.
   */
  update(views: ReadonlyMap<string, ChatFenceView>): void {
    const previous = this.#views;
    const next = new Map<string, ChatFenceView>();
    for (const [key, view] of views) {
      const before = previous.get(key);
      next.set(
        key,
        before !== undefined && sameView(before, view) ? before : view,
      );
    }
    this.#views = next;
    for (const [key, held] of this.#held) {
      const view = next.get(key);
      if (view !== undefined && view !== previous.get(key))
        (held.element as { view?: unknown }).view = view;
    }
  }

  /** The element of `tag` and `key`, created on the first take; `undefined` without a view or renderer. */
  take(tag: string, key: string): object | undefined {
    const at = fenceElementKey(tag, key);
    const held = this.#held.get(at);
    if (held !== undefined) {
      held.count += 1;
      return held.element;
    }
    const view = this.#views.get(at);
    const elementTag = this.#elementTagOf(tag);
    if (view === undefined || elementTag === undefined) return undefined;
    let element: object;
    try {
      element = this.#ui.create(elementTag, { view });
    } catch (error) {
      console.error(
        `Doric: the fence element <${elementTag}> of Thread ${this.#threadId} could not be created:`,
        error,
      );
      return undefined;
    }
    this.#held.set(at, { element, count: 1 });
    return element;
  }

  /** Gives back the element a decorator took. */
  give(tag: string, key: string): void {
    const at = fenceElementKey(tag, key);
    const held = this.#held.get(at);
    if (held === undefined) return;
    held.count -= 1;
    if (held.count > 0) return;
    queueMicrotask(() => {
      if (held.count > 0 || this.#held.get(at) !== held) return;
      this.#held.delete(at);
      this.#dispose(held.element);
    });
  }

  /** Disposes every element; the conversation unmounted or shows another Thread. */
  dispose(): void {
    for (const held of this.#held.values()) this.#dispose(held.element);
    this.#held.clear();
  }

  #dispose(element: object): void {
    (element as { remove?: () => void }).remove?.();
    try {
      this.#ui.dispose(element);
    } catch {
      // An element already disposed needs nothing more.
    }
  }
}

export const ChatFencesContext = createContext<FenceElements | null>(null);

/**
 * The host of one fence's element, taken on mount and given back on unmount.
 * No key typed inside it reaches the editor: the controls a renderer draws
 * take their own keys, and the turn around them stays as it was.
 */
function FenceHost({
  tag,
  fenceKey,
}: {
  readonly tag: string;
  readonly fenceKey: string;
}) {
  const elements = useContext(ChatFencesContext);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    const stop = (event: Event) => event.stopPropagation();
    host.addEventListener('keydown', stop);
    return () => host.removeEventListener('keydown', stop);
  }, []);

  useEffect(() => {
    const host = frame.current;
    if (host === null || elements === null) return;
    const element = elements.take(tag, fenceKey);
    if (element === undefined) return;
    host.replaceChildren(element as Node);
    return () => {
      if ((element as Node).parentNode === host) host.replaceChildren();
      elements.give(tag, fenceKey);
    };
  }, [elements, tag, fenceKey]);

  return <div ref={frame} />;
}

export type SerializedFenceNode = Spread<
  { tag: string; fenceKey: string; source: string },
  SerializedLexicalNode
>;

export class FenceNode extends DecoratorNode<JSX.Element> {
  __tag: string;
  __fenceKey: string;
  /** The fence as written, opener and closer included. */
  __source: string;

  constructor(tag: string, fenceKey: string, source: string, key?: NodeKey) {
    super(key);
    this.__tag = tag;
    this.__fenceKey = fenceKey;
    this.__source = source;
  }

  static override getType(): string {
    return FENCE_NODE;
  }

  getTag(): string {
    return this.getLatest().__tag;
  }

  getFenceKey(): string {
    return this.getLatest().__fenceKey;
  }

  /**
   * Takes the fence's new source in place: the node, its DOM and the element
   * its host shows stay, so a streaming fence's element is never detached.
   */
  setSource(source: string): void {
    if (this.getLatest().__source !== source)
      this.getWritable().__source = source;
  }

  static override clone(node: FenceNode): FenceNode {
    return new FenceNode(
      node.__tag,
      node.__fenceKey,
      node.__source,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'my-2 block w-full';
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /** Inline, inside its own paragraph, as an attachment image is. */
  override isInline(): boolean {
    return true;
  }

  /** Copying an answer copies the program. */
  override getTextContent(): string {
    return this.__source;
  }

  override decorate(): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {() => <FenceHost tag={this.__tag} fenceKey={this.__fenceKey} />}
      </WidgetFocus>
    );
  }

  override exportJSON(): SerializedFenceNode {
    return {
      ...super.exportJSON(),
      tag: this.__tag,
      fenceKey: this.__fenceKey,
      source: this.__source,
    };
  }

  static override importJSON(serialized: SerializedFenceNode): FenceNode {
    return $createFenceNode(
      serialized.tag,
      serialized.fenceKey,
      serialized.source,
    );
  }
}

export const $createFenceNode = (
  tag: string,
  fenceKey: string,
  source: string,
): FenceNode => new FenceNode(tag, fenceKey, source);

export const $isFenceNode = (
  node: LexicalNode | null | undefined,
): node is FenceNode => node instanceof FenceNode;
