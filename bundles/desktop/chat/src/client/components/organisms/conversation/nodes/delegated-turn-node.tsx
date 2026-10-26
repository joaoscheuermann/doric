import { Button } from 'desktop/ui/button';
import { cn } from 'desktop/ui/utils';
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
import {
  type JSX,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import {
  type ChatBlockElement,
  DELEGATED_INPUT_BLOCK,
  type DelegatedInputBlock,
} from '../../../../../contracts/index.js';
import {
  blockToggled,
  type Chosen,
  settledOpenness,
} from '../../../../domain/collapsible.js';
import { DELEGATED_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { DelegatedInput } from '../../../../domain/delegated.js';
import type { UserTurn } from '../../../../domain/projector.js';
import { useDelegatedSource } from '../../../../hooks/use-delegated-source.js';
import {
  chatViewsRegistry,
  GENERIC_BLOCK_TAG,
} from '../../../../services/views.js';
import { CollapsibleBlock } from '../../../molecules/collapsible-block.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { ReadonlyMarkdown } from '../readonly-markdown.js';
import { ChatBlocksContext } from './chat-block-node.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

type DelegatedBlock = {
  readonly turnKey: string;
  readonly promptId: string;
  readonly input: DelegatedInput;
};
type SerializedDelegatedTurn = Spread<DelegatedBlock, SerializedLexicalNode>;

/**
 * Another Thread's input as one folded header and its text. The bot marks an
 * instruction handed down by the parent; a result wears no glyph of its own, so
 * a background agent's answer reads as where it came from and nothing more. The
 * sender's name follows the label bare, without quotes.
 */
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
  const instructed = input.kind === 'parent';
  return (
    <CollapsibleBlock
      label={
        <>
          {instructed ? (
            <BotIcon className="size-4.5 shrink-0" aria-hidden="true" />
          ) : null}
          <span className="font-normal">
            {instructed ? 'Instruction from:' : 'Result from:'}
          </span>
        </>
      }
      action={{
        toggleLabel: `Toggle ${input.kind === 'parent' ? 'instruction' : 'result'} from ${source.label.value}`,
        content: (
          <span
            role="none"
            className="inline-flex min-w-0 items-center"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
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

/** The element each hosted delegated block shows, by node key (R-9.7). */
const hostedElements = new Map<NodeKey, ChatBlockElement>();

const noRenderer = (): string => GENERIC_BLOCK_TAG;

/** The element tag a bundle registered for delegated inputs, if any. */
const useDelegatedRenderer = (): string | undefined => {
  const tag = useSyncExternalStore(
    (listener) => chatViewsRegistry()?.subscribe(listener) ?? (() => {}),
    () =>
      (chatViewsRegistry()?.rendererFor ?? noRenderer)(DELEGATED_INPUT_BLOCK),
  );
  return tag === GENERIC_BLOCK_TAG ? undefined : tag;
};

/**
 * R-9.7: hosts the registered element for a delegated input, handing it the
 * block and the focus, and lending it to the node so the toggle key reaches
 * it. The node keeps its own DOM, so `data-prompt-id` and the text stay.
 */
function HostedDelegated({
  tag,
  nodeKey,
  block,
  focused,
}: {
  readonly tag: string;
  readonly nodeKey: NodeKey;
  readonly block: DelegatedInputBlock;
  readonly focused: boolean;
}) {
  const { ui } = useContext(ChatBlocksContext);
  const frame = useRef<HTMLDivElement>(null);
  const element = useRef<ChatBlockElement | null>(null);
  const latest = useRef({ block, focused });
  latest.current = { block, focused };

  useEffect(() => {
    const host = frame.current;
    if (host === null || ui === null) return;
    let created: ChatBlockElement;
    try {
      created = ui.create(tag, {
        block: latest.current.block,
      }) as ChatBlockElement;
    } catch (error) {
      console.error(
        `Doric: the chat block <${tag}> could not be created:`,
        error,
      );
      return;
    }
    created.focused = latest.current.focused;
    element.current = created;
    hostedElements.set(nodeKey, created);
    host.replaceChildren(created as unknown as Node);
    return () => {
      if (hostedElements.get(nodeKey) === created)
        hostedElements.delete(nodeKey);
      element.current = null;
      host.replaceChildren();
      try {
        ui.dispose(created);
      } catch {
        // An element already disposed needs nothing more.
      }
    };
  }, [tag, ui, nodeKey]);

  useEffect(() => {
    const current = element.current;
    if (current === null) return;
    current.block = block;
    current.focused = focused;
  }, [block, focused]);

  return <div ref={frame} />;
}

/** The registered element when a bundle draws delegated inputs, else chat's own. */
function DelegatedSurface({
  nodeKey,
  block,
  focused,
  children,
}: {
  readonly nodeKey: NodeKey;
  readonly block: DelegatedInputBlock;
  readonly focused: boolean;
  readonly children: JSX.Element;
}) {
  const tag = useDelegatedRenderer();
  if (tag === undefined) return children;
  return (
    <HostedDelegated
      tag={tag}
      nodeKey={nodeKey}
      block={block}
      focused={focused}
    />
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
    const block: DelegatedInputBlock = {
      type: DELEGATED_INPUT_BLOCK,
      id: this.__turnKey,
      data: { promptId: this.__promptId, input: this.__input },
    };
    return (
      <WidgetFocus nodeKey={this.__key}>
        {(focused) => (
          <DelegatedSurface
            nodeKey={this.__key}
            block={block}
            focused={focused}
          >
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
          </DelegatedSurface>
        )}
      </WidgetFocus>
    );
  }
  setChosen(chosen: Chosen): void {
    if (this.__chosen !== chosen) this.getWritable().__chosen = chosen;
  }
  toggle(): void {
    // A registered element owns its open state (R-9.7).
    const hosted = hostedElements.get(this.__key);
    if (hosted !== undefined) {
      hosted.toggle();
      return;
    }
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
