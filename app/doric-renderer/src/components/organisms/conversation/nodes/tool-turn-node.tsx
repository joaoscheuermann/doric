import { TOOL_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { ToolTurn } from '@/domain/projector';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

export type SerializedToolTurnNode = Spread<
  {
    turnKey: string;
    promptId: string;
    callId: string;
    name: string;
    args: string;
    status: ToolTurn['status'];
    result?: string;
    error?: string;
  },
  SerializedLexicalNode
>;

/** One tool call: a read-only widget named by the tool it ran. */
export class ToolTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __callId: string;
  __name: string;
  __args: string;
  __status: ToolTurn['status'];
  __result?: string;
  __error?: string;

  constructor(
    turnKey: string,
    promptId: string,
    callId: string,
    name: string,
    args: string,
    status: ToolTurn['status'],
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__callId = callId;
    this.__name = name.trim();
    this.__args = args.trim();
    this.__status = status;
  }

  static override getType(): string {
    return TOOL_TURN_BLOCK;
  }

  static override clone(node: ToolTurnNode): ToolTurnNode {
    return new ToolTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__callId,
      node.__name,
      node.__args,
      node.__status,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = CONVERSATION_FONT_CLASS;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block, not an inline widget. `DecoratorNode` reports inline by default,
   * and the rich-text root then wraps an inline child in a `ParagraphNode` —
   * which hides this turn from the sync that keeps the transcript in step, so
   * it is re-created on every update and the author line that should trail the
   * run lands on the wrong turn.
   */
  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <div>
        {this.__name} · {this.__status}
      </div>
    );
  }

  setTurn(turn: ToolTurn): void {
    const writable = this.getWritable();
    writable.__name = turn.name.trim();
    writable.__args = turn.args.trim();
    writable.__status = turn.status;
    writable.__result = turn.result?.trim();
    writable.__error = turn.error?.trim();
  }

  override exportJSON(): SerializedToolTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      callId: this.__callId,
      name: this.__name,
      args: this.__args,
      status: this.__status,
      ...(this.__result === undefined ? {} : { result: this.__result }),
      ...(this.__error === undefined ? {} : { error: this.__error }),
    };
  }

  static override importJSON(serialized: SerializedToolTurnNode): ToolTurnNode {
    return $createToolTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.callId,
      serialized.name,
      serialized.args,
      serialized.status,
    );
  }
}

export function $createToolTurnNode(
  turnKey: string,
  promptId: string,
  callId: string,
  name: string,
  args: string,
  status: ToolTurn['status'],
): ToolTurnNode {
  return new ToolTurnNode(turnKey, promptId, callId, name, args, status);
}

export function $isToolTurnNode(
  node: LexicalNode | null | undefined,
): node is ToolTurnNode {
  return node instanceof ToolTurnNode;
}
