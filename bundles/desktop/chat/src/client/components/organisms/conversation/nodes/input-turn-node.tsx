/**
 * An input whose source a bundle draws (`chat.views/v1` 1.2.0): one block that
 * hosts the bundle's element with the prompt's `view`, in place of the chat's
 * own drawing of that source. The sync creates it for a user turn that carries
 * `element`, and replaces it with the chat's own block when the registration
 * leaves, since such a turn has its own key.
 */

import { blockToggled, type Chosen } from 'desktop/ui/collapsible-block';
import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { type JSX, useContext, useMemo } from 'react';

import type { ChatInputView } from '../../../../../contracts/index.js';
import { settledOpenness } from '../../../../domain/collapsible.js';
import { INPUT_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { UserTurn } from '../../../../domain/projector.js';
import {
  toggleHostedView,
  ViewElement,
} from '../../../molecules/view-element.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { ChatBlocksContext } from './chat-block-node.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

type InputBlock = {
  readonly turnKey: string;
  readonly promptId: string;
  readonly input: NonNullable<UserTurn['input']>;
  readonly element: string;
};
type SerializedInputTurn = Spread<InputBlock, SerializedLexicalNode>;

/** The registered element of one input, with the view the chat keeps current. */
function InputSurface({
  block,
  chosen,
  focused,
  toggleKey,
  onChosen,
}: {
  readonly block: InputBlock;
  readonly chosen: Chosen;
  readonly focused: boolean;
  readonly toggleKey: string;
  readonly onChosen: (chosen: boolean) => void;
}) {
  const { projectId, threadId } = useContext(ChatBlocksContext);
  const { promptId, input } = block;
  const view = useMemo<ChatInputView>(
    () => ({
      projectId: projectId ?? '',
      threadId: threadId ?? '',
      promptId,
      source: input.source,
      text: input.text,
      chosen,
      focused,
    }),
    [projectId, threadId, promptId, input, chosen, focused],
  );
  return (
    <ViewElement
      tag={block.element}
      view={view}
      toggleKey={toggleKey}
      onChosen={onChosen}
    />
  );
}

/** An input a bundle draws is a settled widget; the reader owns its open state. */
export class InputTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __input: InputBlock['input'];
  __element: string;
  /** The reader's choice of open/closed; `null` until they make one. */
  __chosen: Chosen = null;

  constructor(block: InputBlock, key?: NodeKey) {
    super(key);
    this.__turnKey = block.turnKey;
    this.__promptId = block.promptId;
    this.__input = block.input;
    this.__element = block.element;
  }
  static override getType(): string {
    return INPUT_TURN_BLOCK;
  }
  static override clone(node: InputTurnNode): InputTurnNode {
    return new InputTurnNode(
      {
        turnKey: node.__turnKey,
        promptId: node.__promptId,
        input: node.__input,
        element: node.__element,
      },
      node.__key,
    );
  }
  /** The reader's choice travels with the block through every sync. */
  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__chosen = previous.__chosen;
  }
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    dom.dataset.promptId = this.__promptId;
    if (this.__input.source.kind === 'result')
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
          <InputSurface
            block={{
              turnKey: this.__turnKey,
              promptId: this.__promptId,
              input: this.__input,
              element: this.__element,
            }}
            chosen={this.__chosen}
            focused={focused}
            toggleKey={this.__key}
            onChosen={(chosen) =>
              editor.update(() => {
                const node = $getNodeByKey(this.__key);
                if ($isInputTurnNode(node)) node.setChosen(chosen);
              })
            }
          />
        )}
      </WidgetFocus>
    );
  }
  /** Write the reader's choice of open/closed. */
  setChosen(chosen: Chosen): void {
    if (this.__chosen !== chosen) this.getWritable().__chosen = chosen;
  }
  /**
   * The reader opens or closes the block: an element that defines `toggle()`
   * answers for itself (O2); otherwise the opposite of a block folded once
   * settled.
   */
  toggle(): void {
    if (toggleHostedView(this.__key)) return;
    this.setChosen(blockToggled(this.__chosen, settledOpenness));
  }
  setTurn(turn: UserTurn): void {
    const input = turn.input;
    const element = turn.element;
    if (input === undefined || element === undefined) return;
    const current = this.__input;
    if (
      this.__element === element &&
      current.text === input.text &&
      current.source.kind === input.source.kind &&
      current.source.threadId === input.source.threadId &&
      current.source.terminalId === input.source.terminalId &&
      current.source.bundleId === input.source.bundleId &&
      current.source.reason === input.source.reason
    )
      return;
    const writable = this.getWritable();
    writable.__input = input;
    writable.__element = element;
  }
  override exportJSON(): SerializedInputTurn {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      input: this.__input,
      element: this.__element,
    };
  }
  static override importJSON(value: SerializedInputTurn): InputTurnNode {
    return new InputTurnNode(value);
  }
}

export function $createInputTurnNode(block: InputBlock): InputTurnNode {
  return new InputTurnNode(block);
}

export function $isInputTurnNode(
  node: LexicalNode | null | undefined,
): node is InputTurnNode {
  return node instanceof InputTurnNode;
}
