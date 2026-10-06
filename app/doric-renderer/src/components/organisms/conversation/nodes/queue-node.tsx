import { ThreadQueue } from '@/components/organisms/thread-queue';
import { QUEUE_BLOCK } from '@/domain/conversation-nodes';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';

type SerializedQueueNode = Spread<{ threadId: string }, SerializedLexicalNode>;

/** Stable, non-editable furniture immediately before the one editable prompt. */
export class QueueNode extends DecoratorNode<JSX.Element> {
  __threadId: string;
  __items: readonly string[] = [];
  __focus: string | undefined;
  constructor(threadId: string, key?: NodeKey) {
    super(key);
    this.__threadId = threadId;
  }
  static override getType(): string {
    return QUEUE_BLOCK;
  }
  static override clone(node: QueueNode): QueueNode {
    return new QueueNode(node.__threadId, node.__key);
  }
  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__items = previous.__items;
    this.__focus = previous.__focus;
  }
  items(): readonly string[] {
    return this.getLatest().__items;
  }
  focused(): string | undefined {
    return this.getLatest().__focus;
  }
  focusItem(id: string | undefined): void {
    this.getWritable().__focus = id;
  }
  setItems(items: readonly string[]): void {
    const previous = this.getLatest();
    if (
      items.length === previous.__items.length &&
      items.every((id, index) => id === previous.__items[index])
    )
      return;
    const node = this.getWritable();
    node.__items = items;
    if (!items.includes(previous.__focus ?? '')) {
      node.__focus =
        items[
          Math.min(
            Math.max(previous.__items.indexOf(previous.__focus ?? ''), 0),
            items.length - 1,
          )
        ];
    }
  }
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.promptQueue = '';
    dom.contentEditable = 'false';
    return dom;
  }
  override updateDOM(): boolean {
    return false;
  }
  override isInline(): boolean {
    return false;
  }
  override isKeyboardSelectable(): boolean {
    return true;
  }
  override decorate(): JSX.Element {
    return (
      <ThreadQueue
        key={this.__threadId}
        threadId={this.__threadId}
        nodeKey={this.__key}
        focusedId={this.__focus}
      />
    );
  }
  override exportJSON(): SerializedQueueNode {
    return { ...super.exportJSON(), threadId: this.__threadId };
  }
  static override importJSON(value: SerializedQueueNode): QueueNode {
    return new QueueNode(value.threadId);
  }
}

export const $isQueueNode = (
  node: LexicalNode | null | undefined,
): node is QueueNode => node instanceof QueueNode;
