/**
 * One compaction of the thread's history as a block of the transcript: a quiet
 * row between the blocks the event sits between, stating what the bracket's
 * closing half reported, or why the attempt failed. The caret skips this
 * informational block; nothing in it acts.
 */

import { Marker, MarkerContent } from 'desktop/ui/marker';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react/jsx-runtime';

import { COMPACTION_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { CompactionTurn } from '../../../../domain/projector.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

export type SerializedCompactionTurnNode = Spread<
  {
    turnKey: string;
    promptId: string;
    trigger: CompactionTurn['trigger'];
    status: CompactionTurn['status'];
    condensedMessages: CompactionTurn['condensedMessages'];
    tokensFreed: CompactionTurn['tokensFreed'];
    code: CompactionTurn['code'];
  },
  SerializedLexicalNode
>;

/** The line the row reads: what the compaction did, or why it failed. */
const rowLine = (
  status: CompactionTurn['status'],
  condensedMessages: CompactionTurn['condensedMessages'],
  tokensFreed: CompactionTurn['tokensFreed'],
  code: CompactionTurn['code'],
): string => {
  if (status === 'failed') return `Compactação de contexto falhou (${code})`;
  // The closing half carries the counts; a report that names none of them
  // still reads as a compaction that happened.
  if (condensedMessages === undefined || tokensFreed === undefined)
    return 'Contexto compactado';
  return `Contexto compactado · ${condensedMessages} mensagens → resumo (${tokensFreed} tokens liberados)`;
};

export class CompactionTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __trigger: CompactionTurn['trigger'];
  __status: CompactionTurn['status'];
  __condensedMessages: CompactionTurn['condensedMessages'];
  __tokensFreed: CompactionTurn['tokensFreed'];
  __code: CompactionTurn['code'];

  constructor(
    turnKey: string,
    promptId: string,
    trigger: CompactionTurn['trigger'],
    status: CompactionTurn['status'],
    condensedMessages: CompactionTurn['condensedMessages'],
    tokensFreed: CompactionTurn['tokensFreed'],
    code: CompactionTurn['code'],
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__trigger = trigger;
    this.__status = status;
    this.__condensedMessages = condensedMessages;
    this.__tokensFreed = tokensFreed;
    this.__code = code;
  }

  static override getType(): string {
    return COMPACTION_TURN_BLOCK;
  }

  static override clone(node: CompactionTurnNode): CompactionTurnNode {
    return new CompactionTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__trigger,
      node.__status,
      node.__condensedMessages,
      node.__tokensFreed,
      node.__code,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `my-4 select-none ${CONVERSATION_FONT_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block, not an inline widget. `DecoratorNode` reports inline by default,
   * and the rich-text root then wraps an inline child in a `ParagraphNode` —
   * which hides this row from the sync that keeps the transcript in step.
   */
  override isInline(): boolean {
    return false;
  }

  override isKeyboardSelectable(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <Marker variant="separator" className="gap-1.5 text-xs">
        <MarkerContent>
          {rowLine(
            this.__status,
            this.__condensedMessages,
            this.__tokensFreed,
            this.__code,
          )}
        </MarkerContent>
      </Marker>
    );
  }

  /**
   * Take the chat's latest reading of the bracket. The projection rebuilds the
   * turn once its closing half arrives and never changes it afterwards, so an
   * equal row is not drawn again — the comparison keeps that guarantee local
   * instead of leaning on the reading's object identity.
   */
  setTurn(turn: CompactionTurn): void {
    if (
      this.__status === turn.status &&
      this.__trigger === turn.trigger &&
      this.__condensedMessages === turn.condensedMessages &&
      this.__tokensFreed === turn.tokensFreed &&
      this.__code === turn.code
    )
      return;
    const writable = this.getWritable();
    writable.__trigger = turn.trigger;
    writable.__status = turn.status;
    writable.__condensedMessages = turn.condensedMessages;
    writable.__tokensFreed = turn.tokensFreed;
    writable.__code = turn.code;
  }

  override exportJSON(): SerializedCompactionTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      trigger: this.__trigger,
      status: this.__status,
      condensedMessages: this.__condensedMessages,
      tokensFreed: this.__tokensFreed,
      code: this.__code,
    };
  }

  static override importJSON(
    serialized: SerializedCompactionTurnNode,
  ): CompactionTurnNode {
    return $createCompactionTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.trigger,
      serialized.status,
      serialized.condensedMessages,
      serialized.tokensFreed,
      serialized.code,
    );
  }
}

export function $createCompactionTurnNode(
  turnKey: string,
  promptId: string,
  trigger: CompactionTurn['trigger'],
  status: CompactionTurn['status'],
  condensedMessages: CompactionTurn['condensedMessages'],
  tokensFreed: CompactionTurn['tokensFreed'],
  code: CompactionTurn['code'],
): CompactionTurnNode {
  return new CompactionTurnNode(
    turnKey,
    promptId,
    trigger,
    status,
    condensedMessages,
    tokensFreed,
    code,
  );
}

export function $isCompactionTurnNode(
  node: LexicalNode | null | undefined,
): node is CompactionTurnNode {
  return node instanceof CompactionTurnNode;
}
