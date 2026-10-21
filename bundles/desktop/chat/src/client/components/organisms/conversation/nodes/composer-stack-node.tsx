// The composer's stack as one stable, non-editable furniture of the
// conversation's tail: the top of the block the reader writes in, right below
// the queue (`$settlePrompt` keeps the tail as `[..., QueueNode,
// ComposerStackNode, PromptEditNode, UserPromptNode, TurnAuthorNode]`). While
// it holds a comment it opens the prompt's block: it wears the reader's mark in
// the gutter beside its header, and the prompt below it wears none
// (`styles.css`), so the comments and the words read as one block. Empty, it
// draws nothing, and its mark with it. The node holds only the Thread it draws;
// what it draws comes from the stack store, which watches the same service the
// stack state lives in.

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';

import { COMPOSER_STACK_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { StackThread } from '../../../../hooks/use-composer-stack.js';
import { ComposerStack } from '../../composer-stack.js';
import { applyTurnAvatar, READER_AVATAR } from './turn-avatar.js';

type SerializedComposerStackNode = Spread<
  { threadId: string; projectId: string },
  SerializedLexicalNode
>;

/** The draft stack that opens the prompt's block, one per conversation. */
export class ComposerStackNode extends DecoratorNode<JSX.Element> {
  __thread: StackThread;

  constructor(thread: StackThread, key?: NodeKey) {
    super(key);
    this.__thread = thread;
  }

  static override getType(): string {
    return COMPOSER_STACK_BLOCK;
  }

  static override clone(node: ComposerStackNode): ComposerStackNode {
    return new ComposerStackNode(node.__thread, node.__key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.composerStack = '';
    dom.contentEditable = 'false';
    // The prompt is the reader's, and so is the stack that opens it.
    applyTurnAvatar(dom, READER_AVATAR);
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  override isKeyboardSelectable(): boolean {
    // The stack's notes are editing hosts of their own, which the caret
    // enters from the prompt (`StackCaret`), never as a stop of the editor.
    return false;
  }

  override decorate(): JSX.Element {
    return <ComposerStack key={this.__thread.id} thread={this.__thread} />;
  }

  override exportJSON(): SerializedComposerStackNode {
    return {
      ...super.exportJSON(),
      threadId: this.__thread.id,
      projectId: this.__thread.projectId,
    };
  }

  static override importJSON(
    value: SerializedComposerStackNode,
  ): ComposerStackNode {
    return $createComposerStackNode({
      id: value.threadId,
      projectId: value.projectId,
    });
  }
}

export function $createComposerStackNode(
  thread: StackThread,
): ComposerStackNode {
  return new ComposerStackNode(thread);
}

export function $isComposerStackNode(
  node: LexicalNode | null | undefined,
): node is ComposerStackNode {
  return node instanceof ComposerStackNode;
}
