/**
 * A block another bundle's projector made (§7.4, §7.7), as one stable block of
 * the transcript. The node holds only the block's identity; what it draws is
 * the element `chat.views/v1` names for the block's type (`<chat-block>` when
 * no renderer claims it), created once through `ui/v1` and handed each newer
 * version of the block as its `block` property.
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

import type { RenderBlock } from '../../../../../contracts/index.js';
import { CHAT_BLOCK_ID_ATTRIBUTE } from '../../../../utility/comment-thread.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

/** The node type of an external block. */
export const CHAT_BLOCK_NODE = 'chat-block-node';

/** One external block as the surface draws it: the block and its element. */
export interface DrawnBlock {
  readonly block: RenderBlock;
  readonly tag: string;
}

/** What the decorators read: the conversation's drawn blocks, and how to make an element. */
export interface ChatBlocksSource {
  readonly blocks: ReadonlyMap<string, DrawnBlock>;
  readonly ui: Pick<Ui, 'create' | 'dispose'> | null;
}

export const ChatBlocksContext = createContext<ChatBlocksSource>({
  blocks: new Map(),
  ui: null,
});

/** The host element of one block, kept while its tag stays the same. */
function BlockHost({ blockId }: { readonly blockId: string }) {
  const { blocks, ui } = useContext(ChatBlocksContext);
  const drawn = blocks.get(blockId);
  const frame = useRef<HTMLDivElement>(null);
  const element = useRef<{ tag: string; node: object } | null>(null);
  const tag = drawn?.tag;
  // The block the element starts with; newer versions are set below.
  const latest = useRef(drawn?.block);
  latest.current = drawn?.block;

  // The element is made once per tag.
  useEffect(() => {
    const host = frame.current;
    if (host === null || ui === null || tag === undefined) return;
    let created: object;
    try {
      created = ui.create(tag, { block: latest.current });
    } catch (error) {
      console.error(
        `Doric: the chat block <${tag}> could not be created:`,
        error,
      );
      return;
    }
    element.current = { tag, node: created };
    host.replaceChildren();
    host.appendChild(created as Node);
    return () => {
      element.current = null;
      host.replaceChildren();
      try {
        ui.dispose(created);
      } catch {
        // An element already disposed needs nothing more.
      }
    };
  }, [tag, ui]);

  useEffect(() => {
    const current = element.current;
    if (current === null || drawn === undefined) return;
    (current.node as { block?: unknown }).block = drawn.block;
  }, [drawn]);

  return <div ref={frame} />;
}

export type SerializedChatBlockNode = Spread<
  { blockId: string },
  SerializedLexicalNode
>;

export class ChatBlockNode extends DecoratorNode<JSX.Element> {
  __blockId: string;

  constructor(blockId: string, key?: NodeKey) {
    super(key);
    this.__blockId = blockId;
  }

  static override getType(): string {
    return CHAT_BLOCK_NODE;
  }

  static override clone(node: ChatBlockNode): ChatBlockNode {
    return new ChatBlockNode(node.__blockId, node.__key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // The gap the conversation's blocks stand apart by, as a failure states it.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    // The block's id names what it draws (an artifact's frame names the
    // artifact), so a comment's thread can find the block of its target.
    dom.setAttribute(CHAT_BLOCK_ID_ATTRIBUTE, this.__blockId);
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /** A block, not an inline widget (see `FailureTurnNode.isInline`). */
  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {() => <BlockHost blockId={this.__blockId} />}
      </WidgetFocus>
    );
  }

  override exportJSON(): SerializedChatBlockNode {
    return { ...super.exportJSON(), blockId: this.__blockId };
  }

  static override importJSON(
    serialized: SerializedChatBlockNode,
  ): ChatBlockNode {
    return $createChatBlockNode(serialized.blockId);
  }
}

export const $createChatBlockNode = (blockId: string): ChatBlockNode =>
  new ChatBlockNode(blockId);

export const $isChatBlockNode = (
  node: LexicalNode | null | undefined,
): node is ChatBlockNode => node instanceof ChatBlockNode;
