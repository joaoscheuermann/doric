/**
 * A prompt the host closed as a failure, as a block of the transcript: the run's
 * own words for why it stopped, at the point in the log it stopped at.
 *
 * Whether the block reads as a failure or as a warning is the chat's error
 * catalog's business (`chatErrorCatalog`); this only draws it where the log put
 * it.
 */

import { type ErrorInfo, sameErrorInfo } from 'desktop/reads';
import { ErrorNotice } from 'desktop/ui/error-notice';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { createContext, useContext } from 'react';
import type { JSX } from 'react/jsx-runtime';

import { FAILURE_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import { chatErrorCatalog } from '../../../../domain/error-catalog.js';
import type { FailureTurn } from '../../../../domain/projector.js';
import { ConversationThreadContext } from '../../../../hooks/use-live-terminal.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

/**
 * What the failed-prompt block needs to offer Retry (§5.1, §6.1).
 *
 * `promptId` is the prompt whose failure block may show Retry: the last
 * `FailureTurn`'s prompt while the agent controls answer `status: 'failed'`
 * and `canRetry`; undefined otherwise, and then no block shows Retry. A block
 * passes `retry` and `retrying` to its notice only when its own `promptId`
 * equals this one. `retrying` is true while the retry runs. `retry` starts the
 * retry and returns at once; it never throws, and a failure of the retry shows
 * where a send failure shows. The Thread is the one `ConversationThreadContext`
 * names, so this context carries no Thread id.
 */
export interface FailureRetry {
  readonly promptId?: string;
  readonly retrying: boolean;
  retry(): void;
}

/**
 * Provided by the conversation around its editor. The default, used outside
 * a provider, offers Retry on no block: no `promptId`, not retrying, and a
 * `retry` that does nothing.
 */
export const FailureRetryContext = createContext<FailureRetry>({
  retrying: false,
  retry: () => undefined,
});

export type SerializedFailureTurnNode = Spread<
  { turnKey: string; promptId: string; failure: ErrorInfo },
  SerializedLexicalNode
>;

/** The failed-prompt block: a block notice, with Retry on the prompt it names. */
function FailureBlock({
  failure,
  promptId,
}: {
  readonly failure: ErrorInfo;
  readonly promptId: string;
}) {
  const thread = useContext(ConversationThreadContext);
  const {
    promptId: retryable,
    retrying,
    retry,
  } = useContext(FailureRetryContext);
  const offers = retryable !== undefined && retryable === promptId;
  return (
    <ErrorNotice
      error={failure}
      catalog={chatErrorCatalog}
      fallbackCode="prompt_failed"
      context={{
        ...(thread === null ? {} : { Thread: thread.threadId }),
        Prompt: promptId,
      }}
      {...(offers ? { onRetry: retry, retrying } : {})}
    />
  );
}

export class FailureTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __failure: ErrorInfo;

  constructor(
    turnKey: string,
    promptId: string,
    failure: ErrorInfo,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__failure = failure;
  }

  static override getType(): string {
    return FAILURE_TURN_BLOCK;
  }

  static override clone(node: FailureTurnNode): FailureTurnNode {
    return new FailureTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__failure,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap the conversation's blocks stand apart by, which the author
    // line's bottom margin gives every other case. A failure follows a run that
    // carries no such line, so the gap is stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block, not an inline widget. `DecoratorNode` reports inline by default,
   * and the rich-text root then wraps an inline child in a `ParagraphNode` —
   * which hides this block from the sync that keeps the transcript in step.
   */
  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {() => (
          <FailureBlock failure={this.__failure} promptId={this.__promptId} />
        )}
      </WidgetFocus>
    );
  }

  /**
   * Take the chat's latest reading of the failure. An unchanged failure, by
   * `sameErrorInfo`, is not drawn again.
   */
  setTurn(turn: FailureTurn): void {
    if (sameErrorInfo(this.__failure, turn.failure)) return;
    this.getWritable().__failure = turn.failure;
  }

  override exportJSON(): SerializedFailureTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      failure: this.__failure,
    };
  }

  static override importJSON(
    serialized: SerializedFailureTurnNode,
  ): FailureTurnNode {
    return $createFailureTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.failure,
    );
  }
}

export function $createFailureTurnNode(
  turnKey: string,
  promptId: string,
  failure: ErrorInfo,
): FailureTurnNode {
  return new FailureTurnNode(turnKey, promptId, failure);
}

export function $isFailureTurnNode(
  node: LexicalNode | null | undefined,
): node is FailureTurnNode {
  return node instanceof FailureTurnNode;
}
