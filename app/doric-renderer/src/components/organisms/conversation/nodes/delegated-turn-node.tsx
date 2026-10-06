import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { BotIcon } from 'lucide-react';
import type { JSX } from 'react';

import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { WidgetFocus } from '@/components/molecules/widget-focus';
import { ReadonlyMarkdown } from '@/components/organisms/conversation/readonly-markdown';
import { Button } from '@/components/ui/button';
import {
  blockToggled,
  type Chosen,
  settledOpenness,
} from '@/domain/collapsible';
import { DELEGATED_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { DelegatedInput } from '@/domain/delegated';
import type { UserTurn } from '@/domain/projector';
import { useDelegatedSource } from '@/hooks/use-delegated-source';
import { cn } from '@/utility/utils';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

type DelegatedBlock = {
  readonly turnKey: string;
  readonly promptId: string;
  readonly input: DelegatedInput;
};
type SerializedDelegatedTurn = Spread<DelegatedBlock, SerializedLexicalNode>;

function DelegatedTurn({
  input,
  chosen,
  focused,
  onChosenChange,
}: {
  readonly input: DelegatedInput;
  readonly chosen: Chosen;
  readonly focused: boolean;
  readonly onChosenChange: (chosen: boolean) => void;
}) {
  const source = useDelegatedSource(input.threadId);
  return (
    <CollapsibleBlock
      label={
        <>
          <BotIcon className="size-4.5 shrink-0" aria-hidden="true" />
          <span>
            {input.kind === 'parent' ? 'Instruction from:' : 'Result from:'}
          </span>
        </>
      }
      action={{
        toggleLabel: `Toggle ${input.kind === 'parent' ? 'instruction' : 'result'} from ${source.label.value}`,
        content: (
          <span
            className="inline-flex min-w-0 items-center"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span className="shrink-0">&quot;</span>
            {source.open === undefined ? (
              <span
                className={cn('truncate', source.label.mono && 'font-mono')}
                title={input.threadId}
              >
                {source.label.value}
              </span>
            ) : (
              <Button
                variant="link"
                size="sm"
                className="h-auto min-w-0 shrink px-0 py-0"
                title={input.threadId}
                onClick={source.open}
              >
                <span className="truncate">{source.label.value}</span>
              </Button>
            )}
            <span className="shrink-0">&quot;</span>
          </span>
        ),
      }}
      chosen={chosen}
      focused={focused}
      onChosenChange={onChosenChange}
      openness={settledOpenness}
    >
      {input.status === undefined ? null : (
        <div className="mb-2">Status: {input.status}</div>
      )}
      <ReadonlyMarkdown text={input.text} />
    </CollapsibleBlock>
  );
}

/** Another Thread's input is a settled widget; the reader owns its open state. */
export class DelegatedTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __input: DelegatedInput;
  __chosen: Chosen = null;

  constructor(block: DelegatedBlock, key?: NodeKey) {
    super(key);
    this.__turnKey = block.turnKey;
    this.__promptId = block.promptId;
    this.__input = block.input;
    this.__chosen = block.input.kind === 'parent';
  }
  static override getType(): string {
    return DELEGATED_TURN_BLOCK;
  }
  static override clone(node: DelegatedTurnNode): DelegatedTurnNode {
    return new DelegatedTurnNode(
      {
        turnKey: node.__turnKey,
        promptId: node.__promptId,
        input: node.__input,
      },
      node.__key,
    );
  }
  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__chosen = previous.__chosen;
  }
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    dom.dataset.promptId = this.__promptId;
    if (this.__input.kind === 'result')
      dom.dataset.resultPromptId = this.__promptId;
    return dom;
  }
  override updateDOM(): boolean {
    return false;
  }
  override isInline(): boolean {
    return false;
  }
  override getTextContent(): string {
    return this.__input.text;
  }
  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {(focused) => (
          <DelegatedTurn
            input={this.__input}
            chosen={this.__chosen}
            focused={focused}
            onChosenChange={(chosen) =>
              editor.update(() => {
                const node = $getNodeByKey(this.__key);
                if ($isDelegatedTurnNode(node)) node.setChosen(chosen);
              })
            }
          />
        )}
      </WidgetFocus>
    );
  }
  setChosen(chosen: Chosen): void {
    if (this.__chosen !== chosen) this.getWritable().__chosen = chosen;
  }
  toggle(): void {
    this.setChosen(blockToggled(this.__chosen, settledOpenness));
  }
  setTurn(turn: UserTurn): void {
    const input = turn.delegated;
    if (input === undefined) return;
    const current = this.__input;
    if (
      current.text === input.text &&
      current.kind === input.kind &&
      current.threadId === input.threadId &&
      current.status === input.status
    )
      return;
    this.getWritable().__input = input;
  }
  override exportJSON(): SerializedDelegatedTurn {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      input: this.__input,
    };
  }
  static override importJSON(
    value: SerializedDelegatedTurn,
  ): DelegatedTurnNode {
    return new DelegatedTurnNode(value);
  }
}

export function $createDelegatedTurnNode(
  block: DelegatedBlock,
): DelegatedTurnNode {
  return new DelegatedTurnNode(block);
}
export function $isDelegatedTurnNode(
  node: LexicalNode | null | undefined,
): node is DelegatedTurnNode {
  return node instanceof DelegatedTurnNode;
}
