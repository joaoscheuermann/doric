import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { ThinkingItem } from '@/components/molecules/thinking-item';
import { ToolItem } from '@/components/molecules/tool-item';
import { ACTIVITY_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { ActivityItem, ActivityTurn } from '@/domain/projector';
import { activitySummary } from '@/utility/activity-summary';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

export type SerializedActivityTurnNode = Spread<
  {
    turnKey: string;
    promptId: string;
    thoughts: number;
    tools: number;
    items: readonly ActivityItem[];
  },
  SerializedLexicalNode
>;

/**
 * A completed burst of the agent's reasoning and tool calls, kept as one block:
 * a header that counts what the burst did, and, opened, the steps themselves. A
 * long run of steps then reads as one line instead of filling the transcript.
 *
 * Only a burst the log has finished writing is grouped; the one still being
 * written stays as its own thinking and tool turns, so this block is never the
 * live one and its label never shimmers.
 */
export class ActivityTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __thoughts: number;
  __tools: number;
  __items: readonly ActivityItem[];

  constructor(
    turnKey: string,
    promptId: string,
    thoughts: number,
    tools: number,
    items: readonly ActivityItem[],
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__thoughts = thoughts;
    this.__tools = tools;
    this.__items = items;
  }

  static override getType(): string {
    return ACTIVITY_TURN_BLOCK;
  }

  static override clone(node: ActivityTurnNode): ActivityTurnNode {
    return new ActivityTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__thoughts,
      node.__tools,
      node.__items,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap the conversation's blocks stand apart by, which the author
    // line's bottom margin gives every other case. A summary can follow a block
    // that carries no such line, so the gap is stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
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
      <CollapsibleBlock
        active={false}
        hasContent
        label={activitySummary(this.__thoughts, this.__tools)}
      >
        {/* A flex column, so the steps stand `gap-2` apart without carrying a
            margin of their own: a margin would also push the guide down. */}
        <div className="flex flex-col gap-2">
          {this.__items.map((item, index) =>
            item.kind === 'thinking' ? (
              <ThinkingItem key={index} streaming={false} text={item.text} />
            ) : (
              <ToolItem
                key={index}
                args={item.args}
                error={item.error}
                name={item.name}
                result={item.result}
                status={item.status}
              />
            ),
          )}
        </div>
      </CollapsibleBlock>
    );
  }

  setTurn(turn: ActivityTurn): void {
    const writable = this.getWritable();
    writable.__thoughts = turn.thoughts;
    writable.__tools = turn.tools;
    writable.__items = turn.items;
  }

  override exportJSON(): SerializedActivityTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      thoughts: this.__thoughts,
      tools: this.__tools,
      items: this.__items,
    };
  }

  static override importJSON(
    serialized: SerializedActivityTurnNode,
  ): ActivityTurnNode {
    return $createActivityTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.thoughts,
      serialized.tools,
      serialized.items,
    );
  }
}

export function $createActivityTurnNode(
  turnKey: string,
  promptId: string,
  thoughts: number,
  tools: number,
  items: readonly ActivityItem[],
): ActivityTurnNode {
  return new ActivityTurnNode(turnKey, promptId, thoughts, tools, items);
}

export function $isActivityTurnNode(
  node: LexicalNode | null | undefined,
): node is ActivityTurnNode {
  return node instanceof ActivityTurnNode;
}
