/**
 * The rule and icon that open a turn: the bot for the agent's turns, the
 * person for the reader's, then a line to the edge of the column.
 *
 * It is a widget of its own rather than a child of the turn, so the turn's text
 * stays the only thing the caret can cross — `$atBlockStart` keeps reading a
 * caret at the turn's edge correctly — and the two are siblings in the root.
 */
import { TURN_DIVIDER_BLOCK } from '@/domain/conversation-nodes';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { BotIcon, UserIcon } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

/** The side of the conversation a divider announces. */
export type DividerRole = 'agent' | 'user';

export type SerializedTurnDividerNode = Spread<
  { role: DividerRole },
  SerializedLexicalNode
>;

/** A read-only widget: the icon and rule that head a turn. */
export class TurnDividerNode extends DecoratorNode<JSX.Element> {
  __role: DividerRole;

  constructor(role: DividerRole, key?: NodeKey) {
    super(key);
    this.__role = role;
  }

  static override getType(): string {
    return TURN_DIVIDER_BLOCK;
  }

  static override clone(node: TurnDividerNode): TurnDividerNode {
    return new TurnDividerNode(node.__role, node.__key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `${CONVERSATION_FONT_CLASS} mt-6`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    const Icon = this.__role === 'agent' ? BotIcon : UserIcon;

    return (
      <div
        aria-hidden="true"
        className="flex items-center gap-2 text-muted-foreground"
      >
        <Icon className="size-4 shrink-0" />
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  override exportJSON(): SerializedTurnDividerNode {
    return {
      ...super.exportJSON(),
      role: this.__role,
    };
  }

  static override importJSON(
    serialized: SerializedTurnDividerNode,
  ): TurnDividerNode {
    return $createTurnDividerNode(serialized.role);
  }
}

export function $createTurnDividerNode(role: DividerRole): TurnDividerNode {
  return new TurnDividerNode(role);
}

export function $isTurnDividerNode(
  node: LexicalNode | null | undefined,
): node is TurnDividerNode {
  return node instanceof TurnDividerNode;
}
