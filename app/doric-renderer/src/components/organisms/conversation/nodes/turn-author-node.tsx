/**
 * The author line that trails a turn: a small avatar, the name and, when the
 * turn has a time, how long ago it was. The reader wears a jdenticon of their
 * name; the agent wears the bot icon.
 *
 * It is a widget of its own rather than a child of the turn, so the turn's text
 * stays the only thing the caret can cross, and the two are siblings in the
 * root — the line trails the block the sync holds it against, and moves with it
 * as an agent run grows.
 */
import { ReaderAvatar } from '@/components/molecules/reader-avatar';
import { TURN_AUTHOR_BLOCK } from '@/domain/conversation-nodes';
import { relativeTime } from '@/utility/relative-time';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { BotIcon } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

/** The side of the conversation a line names. */
export type AuthorRole = 'agent' | 'user';

export type SerializedTurnAuthorNode = Spread<
  { role: AuthorRole; name: string; at?: string },
  SerializedLexicalNode
>;

/** A read-only widget: who wrote the turn above it, and when. */
export class TurnAuthorNode extends DecoratorNode<JSX.Element> {
  __role: AuthorRole;
  __name: string;
  __at?: string;

  constructor(role: AuthorRole, name: string, at?: string, key?: NodeKey) {
    super(key);
    this.__role = role;
    this.__name = name;
    this.__at = at;
  }

  static override getType(): string {
    return TURN_AUTHOR_BLOCK;
  }

  static override clone(node: TurnAuthorNode): TurnAuthorNode {
    return new TurnAuthorNode(node.__role, node.__name, node.__at, node.__key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `${CONVERSATION_FONT_CLASS} mt-2 mb-6`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  /** The time the turn above was last written; the run keeps it current. */
  setAuthor(at: string | undefined): void {
    if (this.__at !== at) this.getWritable().__at = at;
  }

  override decorate(): JSX.Element {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {this.__role === 'agent' ? (
          <BotIcon className="size-4.5 shrink-0" />
        ) : (
          <ReaderAvatar name={this.__name} />
        )}
        <span className="truncate">{this.__name}</span>
        {this.__at === undefined ? null : (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{relativeTime(this.__at)}</span>
          </>
        )}
      </div>
    );
  }

  override exportJSON(): SerializedTurnAuthorNode {
    return {
      ...super.exportJSON(),
      role: this.__role,
      name: this.__name,
      ...(this.__at === undefined ? {} : { at: this.__at }),
    };
  }

  static override importJSON(
    serialized: SerializedTurnAuthorNode,
  ): TurnAuthorNode {
    return $createTurnAuthorNode(
      serialized.role,
      serialized.name,
      serialized.at,
    );
  }
}

export function $createTurnAuthorNode(
  role: AuthorRole,
  name: string,
  at: string | undefined,
): TurnAuthorNode {
  return new TurnAuthorNode(role, name, at);
}

export function $isTurnAuthorNode(
  node: LexicalNode | null | undefined,
): node is TurnAuthorNode {
  return node instanceof TurnAuthorNode;
}
