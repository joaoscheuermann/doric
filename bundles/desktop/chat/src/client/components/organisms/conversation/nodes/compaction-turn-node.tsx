/**
 * One compaction of the thread's history as a block of the transcript: a quiet
 * row between the blocks the event sits between, stating what the bracket's
 * closing half reported, or why the attempt failed. Completed rows expand to
 * the durable summary; the caret skips this read-only block.
 */

import { type ErrorInfo, errorFrom, sameErrorInfo } from 'desktop/reads';
import { Button } from 'desktop/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { Marker, MarkerContent } from 'desktop/ui/marker';
import { toast } from 'desktop/ui/sonner';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { ChevronRightIcon, CopyIcon } from 'lucide-react';
import { useContext } from 'react';
import type { JSX } from 'react/jsx-runtime';

import { COMPACTION_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import { chatErrorCatalog } from '../../../../domain/error-catalog.js';
import type { CompactionTurn } from '../../../../domain/projector.js';
import { ConversationThreadContext } from '../../../../hooks/conversation-thread.js';
import { ReadonlyMarkdown } from '../readonly-markdown.js';
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
    summary?: string;
    /** Written only when the node holds a failure. */
    error?: ErrorInfo;
  },
  SerializedLexicalNode
>;

/** The line a completed row reads: what the compaction did. */
const rowLine = (
  condensedMessages: CompactionTurn['condensedMessages'],
  tokensFreed: CompactionTurn['tokensFreed'],
): string => {
  // The closing half carries the counts; a report that names none of them
  // still reads as a compaction that happened.
  if (condensedMessages === undefined || tokensFreed === undefined)
    return 'Context compacted';
  return `Context compacted · ${condensedMessages} ${condensedMessages === 1 ? 'message' : 'messages'} → summary (${tokensFreed.toLocaleString('en-US')} tokens freed)`;
};

/** A failed compaction: the compact notice of its failure, inside the separator. */
function CompactionFailure({
  error,
  promptId,
}: {
  readonly error: ErrorInfo;
  readonly promptId: string;
}) {
  const thread = useContext(ConversationThreadContext);
  return (
    <Marker variant="separator" className="gap-1.5 text-xs">
      <MarkerContent>
        <ErrorNotice
          variant="compact"
          error={error}
          catalog={chatErrorCatalog}
          context={{
            ...(thread === null ? {} : { Thread: thread.threadId }),
            Prompt: promptId,
          }}
        />
      </MarkerContent>
    </Marker>
  );
}

function CompactionDetails({
  label,
  summary,
}: {
  readonly label: string;
  readonly summary?: string;
}) {
  return (
    <Collapsible>
      <Marker variant="separator" className="gap-1.5 text-xs">
        <MarkerContent>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="group h-auto max-w-full whitespace-normal py-1 font-normal"
              />
            }
          >
            {label}
            <ChevronRightIcon
              data-icon="inline-end"
              className="group-data-panel-open:rotate-90"
            />
          </CollapsibleTrigger>
        </MarkerContent>
      </Marker>
      <CollapsibleContent className="mt-2 min-w-0 select-text rounded-md border border-border p-3">
        {summary === undefined ? (
          <p className="text-xs text-muted-foreground">
            The summary of this older compaction was not kept in the history.
          </p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>Summary sent to the model</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void navigator.clipboard.writeText(summary).then(
                    () =>
                      toast.success('Summary copied.', {
                        id: 'compaction-summary-copy',
                      }),
                    () =>
                      toast.error('Could not copy the summary.', {
                        id: 'compaction-summary-copy',
                      }),
                  );
                }}
              >
                <CopyIcon data-icon="inline-start" />
                Copy
              </Button>
            </div>
            <ReadonlyMarkdown text={summary} />
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export class CompactionTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __trigger: CompactionTurn['trigger'];
  __status: CompactionTurn['status'];
  __condensedMessages: CompactionTurn['condensedMessages'];
  __tokensFreed: CompactionTurn['tokensFreed'];
  __code: CompactionTurn['code'];
  __summary: string | undefined;
  /** The failure of a failed compaction, as `CompactionTurn.error`. */
  __error: ErrorInfo | undefined;

  constructor(
    turnKey: string,
    promptId: string,
    trigger: CompactionTurn['trigger'],
    status: CompactionTurn['status'],
    condensedMessages: CompactionTurn['condensedMessages'],
    tokensFreed: CompactionTurn['tokensFreed'],
    code: CompactionTurn['code'],
    summary?: string,
    error?: ErrorInfo,
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
    this.__summary = summary;
    this.__error = error;
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
      node.__summary,
      node.__error,
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
    if (this.__status === 'open')
      return (
        <Marker
          variant="separator"
          className="gap-1.5 text-xs"
          role="status"
          aria-live="polite"
        >
          <MarkerContent>
            <span className="shimmer">Compacting</span>
          </MarkerContent>
        </Marker>
      );
    if (this.__status === 'completed')
      return (
        <CompactionDetails
          label={rowLine(this.__condensedMessages, this.__tokensFreed)}
          summary={this.__summary}
        />
      );
    return (
      <CompactionFailure
        error={
          this.__error ??
          errorFrom(this.__code ?? '', '', undefined, { at: null })
        }
        promptId={this.__promptId}
      />
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
      this.__code === turn.code &&
      this.__summary === turn.summary &&
      sameErrorInfo(this.__error, turn.error)
    )
      return;
    const writable = this.getWritable();
    writable.__trigger = turn.trigger;
    writable.__status = turn.status;
    writable.__condensedMessages = turn.condensedMessages;
    writable.__tokensFreed = turn.tokensFreed;
    writable.__code = turn.code;
    writable.__summary = turn.summary;
    writable.__error = turn.error;
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
      ...(this.__summary === undefined ? {} : { summary: this.__summary }),
      ...(this.__error === undefined ? {} : { error: this.__error }),
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
      serialized.summary,
      serialized.error,
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
  summary?: string,
  error?: ErrorInfo,
): CompactionTurnNode {
  return new CompactionTurnNode(
    turnKey,
    promptId,
    trigger,
    status,
    condensedMessages,
    tokensFreed,
    code,
    summary,
    error,
  );
}

export function $isCompactionTurnNode(
  node: LexicalNode | null | undefined,
): node is CompactionTurnNode {
  return node instanceof CompactionTurnNode;
}
