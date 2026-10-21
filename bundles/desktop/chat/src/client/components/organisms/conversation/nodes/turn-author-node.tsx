/**
 * The footer that trails a turn: how long ago it was written and, for a screen
 * reader only, who wrote it. The turn's mark — the reader's initials or the
 * agent's glyph — is drawn by the turn block itself, in the column's left
 * gutter, so the line itself carries only the time.
 *
 * It is a widget of its own rather than a child of the turn, so the turn's text
 * stays the only thing the caret can cross, and the two are siblings in the
 * root — the line trails the block the sync holds it against, and moves with it
 * as an agent run grows. The reader's prompt wears one the same way, below it
 * and without a time, because it is the turn the reader is writing.
 */

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react/jsx-runtime';

import type { AuthorRole } from '../../../../domain/conversation-authors.js';
import { TURN_AUTHOR_BLOCK } from '../../../../domain/conversation-nodes.js';
import { relativeTime } from '../../../../utility/relative-time.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

/** The side of the conversation a line names, fixed in the domain vocabulary. */
export type { AuthorRole };

export type SerializedTurnAuthorNode = Spread<
  { role: AuthorRole; name: string; at?: string },
  SerializedLexicalNode
>;

/** A read-only widget: when the turn above it was last written, and who by. */
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
    // `select-none`: the line is the conversation's furniture, not its text, and
    // the editing host makes everything inside it selectable by default — so a
    // reader dragging over a turn would otherwise carry "now" out with it.
    dom.className = `${CONVERSATION_FONT_CLASS} mt-2 mb-6 select-none`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  /**
   * Furniture, not a caret stop: the caret skips this line entirely — keyboard
   * navigation passes from the block before it to the block after it — and a
   * click on it never selects it as a node. It stays visible and moves with its
   * turn; it just has nothing for a caret to rest on.
   */
  override isKeyboardSelectable(): boolean {
    return false;
  }

  /** The time the turn above was last written; the run keeps it current. */
  setAuthor(at: string | undefined): void {
    if (this.__at !== at) this.getWritable().__at = at;
  }

  override decorate(): JSX.Element {
    return (
      <div className="flex items-center gap-1.5 text-[0.625rem] text-muted-foreground">
        <span className="sr-only">{this.__name}</span>
        {this.__at === undefined ? null : (
          <span className="shrink-0">{relativeTime(this.__at)}</span>
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
