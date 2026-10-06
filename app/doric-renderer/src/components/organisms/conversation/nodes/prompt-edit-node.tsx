import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';
import { useStore } from 'zustand/react';

import { PromptAuthor } from '@/components/molecules/prompt-author';
import { PROMPT_EDIT_BLOCK } from '@/domain/conversation-nodes';
import { queueEditStore } from '@/stores/queue-edit';

function Heading({ threadId }: { readonly threadId: string }) {
  const edit = useStore(queueEditStore, (state) => state.edits[threadId]);
  if (edit === undefined) return null;
  return (
    <div className="queue-edit-heading font-conversation">
      <div
        className="flex min-w-0 items-center gap-2 text-xs"
        title="Esc cancels editing · Cmd/Ctrl+Enter saves"
      >
        <span className="shrink-0 font-normal text-muted-foreground">
          Editing:
        </span>
        <PromptAuthor source={edit.item.source} label={edit.item.label} />
        <span className="min-w-0 truncate text-muted-foreground">
          “{edit.original.replace(/\s+/g, ' ')}”
        </span>
      </div>
      {edit.error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {edit.error}
        </p>
      )}
    </div>
  );
}

type SerializedPromptEdit = Spread<{ threadId: string }, SerializedLexicalNode>;
export class PromptEditNode extends DecoratorNode<JSX.Element> {
  __threadId: string;
  constructor(threadId: string, key?: NodeKey) {
    super(key);
    this.__threadId = threadId;
  }
  static override getType(): string {
    return PROMPT_EDIT_BLOCK;
  }
  static override clone(node: PromptEditNode): PromptEditNode {
    return new PromptEditNode(node.__threadId, node.__key);
  }
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
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
    return false;
  }
  override decorate(): JSX.Element {
    return <Heading threadId={this.__threadId} />;
  }
  override exportJSON(): SerializedPromptEdit {
    return { ...super.exportJSON(), threadId: this.__threadId };
  }
  static override importJSON(value: SerializedPromptEdit): PromptEditNode {
    return new PromptEditNode(value.threadId);
  }
}
export const $isPromptEditNode = (
  node: LexicalNode | null | undefined,
): node is PromptEditNode => node instanceof PromptEditNode;
