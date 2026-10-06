import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { PromptAuthor } from '@/components/molecules/prompt-author';
import { type Chosen, settledOpenness } from '@/domain/collapsible';
import { QUEUED_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { QueuedTurn } from '@/domain/projector';
import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  SKIP_DOM_SELECTION_TAG,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

type SerializedQueuedTurn = Spread<
  {
    turnKey: string;
    promptId: string;
    items: QueuedTurn['items'];
  },
  SerializedLexicalNode
>;

/** An immutable submission receipt. Dispatch adds a separate UserTurnNode later. */
export class QueuedTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __items: QueuedTurn['items'];
  __chosen: Chosen = null;

  constructor(
    turnKey: string,
    promptId: string,
    items: QueuedTurn['items'],
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__items = items;
  }
  static override getType(): string {
    return QUEUED_TURN_BLOCK;
  }
  static override clone(node: QueuedTurnNode): QueuedTurnNode {
    return new QueuedTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__items,
      node.__key,
    );
  }
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.queuedPromptId = this.__promptId;
    dom.className = `my-6 ${CONVERSATION_FONT_CLASS}`;
    dom.contentEditable = 'false';
    return dom;
  }
  override updateDOM(): boolean {
    return false;
  }
  override afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__chosen = prevNode.__chosen;
  }
  override isInline(): boolean {
    return false;
  }
  override isKeyboardSelectable(): boolean {
    return false;
  }
  override decorate(editor: LexicalEditor): JSX.Element {
    const first = this.__items[0];
    const grouped = this.__items.length > 1;
    return (
      <div onKeyDown={(event) => event.stopPropagation()}>
        <CollapsibleBlock
          chosen={this.__chosen}
          openness={settledOpenness}
          onChosenChange={(chosen) =>
            editor.update(
              () => {
                const node = $getNodeByKey(this.__key);
                if ($isQueuedTurnNode(node)) node.setChosen(chosen);
              },
              { tag: SKIP_DOM_SELECTION_TAG },
            )
          }
          label={
            grouped
              ? `Queued ${this.__items.length} prompts`
              : first && (
                  <span className="inline-flex max-w-full items-center gap-2 align-middle [&>svg]:size-4.5">
                    <span className="shrink-0">Queued</span>
                    <PromptAuthor source={first.source} />
                    <span className="min-w-0 truncate">“{first.text}”</span>
                  </span>
                )
          }
        >
          {grouped ? (
            <ol className="flex flex-col gap-3">
              {this.__items.map((item) => (
                <li key={item.promptId}>
                  <div className="whitespace-pre-wrap break-words select-text">
                    {item.text}
                  </div>
                  <div className="mt-1 flex items-center gap-2 [&>svg]:size-4.5">
                    <PromptAuthor source={item.source} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="whitespace-pre-wrap break-words select-text">
              {first?.text}
            </div>
          )}
        </CollapsibleBlock>
      </div>
    );
  }
  setChosen(chosen: Chosen): void {
    if (this.__chosen !== chosen) this.getWritable().__chosen = chosen;
  }
  setTurn(turn: QueuedTurn): void {
    if (
      this.__items.length !== turn.items.length ||
      this.__items.some((item, index) => item !== turn.items[index])
    )
      this.getWritable().__items = turn.items;
  }
  override exportJSON(): SerializedQueuedTurn {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      items: this.__items,
    };
  }
  static override importJSON(value: SerializedQueuedTurn): QueuedTurnNode {
    return new QueuedTurnNode(value.turnKey, value.promptId, value.items);
  }
}

export const $isQueuedTurnNode = (
  node: LexicalNode | null | undefined,
): node is QueuedTurnNode => node instanceof QueuedTurnNode;
