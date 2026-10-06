import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { MouseEvent } from 'react';
import type { JSX } from 'react/jsx-runtime';

import { CollapsibleBlock } from '@/components/molecules/collapsible-block';
import { ThinkingItem } from '@/components/molecules/thinking-item';
import { ToolItem } from '@/components/molecules/tool-item';
import { WidgetFocus } from '@/components/molecules/widget-focus';
import type { ItemCursor } from '@/domain/caret-navigation';
import {
  blockOpen,
  blockToggled,
  type Chosen,
  settledOpenness,
  thinkingOpenness,
  toolOpenness,
} from '@/domain/collapsible';
import { ACTIVITY_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { ActivityItem, ActivityTurn } from '@/domain/projector';
import { activitySummary } from '@/utility/activity-summary';
import { reasoningText } from '@/utility/reasoning-text';

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
 * Whether two bursts are the same steps. A projection rebuilds its items every
 * time it runs, so the node reads the fields a surface draws rather than the
 * identity of the objects: a burst that changed nothing keeps its DOM, and its
 * steps are not drawn again.
 */
const sameItems = (
  current: readonly ActivityItem[],
  next: readonly ActivityItem[],
): boolean =>
  current.length === next.length &&
  current.every((item, index) => {
    const other = next[index];
    if (other === undefined) return false;
    if (item.kind === 'thinking' && other.kind === 'thinking')
      return item.text === other.text;
    if (item.kind === 'tool' && other.kind === 'tool')
      return (
        item.name === other.name &&
        item.args === other.args &&
        item.status === other.status &&
        item.result === other.result &&
        item.error === other.error
      );
    return false;
  });

/**
 * A completed burst of the agent's reasoning and tool calls, kept as one block:
 * a header that counts what the burst did, and, opened, the steps themselves. A
 * long run of steps then reads as one line instead of filling the transcript.
 *
 * Only a burst the log has finished writing, and that did more than one thing,
 * is grouped: a lone step reads as itself, and the burst still being written
 * stays its own thinking and tool turns, so this block is never the live one and
 * its label never shimmers.
 */
export class ActivityTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __thoughts: number;
  __tools: number;
  __items: readonly ActivityItem[];
  /** The reader's choice of open/closed; `null` until they make one. */
  __chosen: boolean | null = null;
  /** The reader's choice of open/closed per step; `null` until they make one. */
  __itemChosen: readonly Chosen[] = [];
  /** The caret's place inside the summary: one step, or its header line. */
  __itemFocus: ItemCursor = null;

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
   * The reader's choices and the caret's place are theirs, not the sync's: they
   * travel with the block through every update a sync writes.
   */
  override afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__chosen = prevNode.__chosen;
    this.__itemChosen = prevNode.__itemChosen;
    this.__itemFocus = prevNode.__itemFocus;
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

  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {(focused) => (
          <div onClick={() => this.takeStep(editor, null)}>
            <CollapsibleBlock
              chosen={this.__chosen}
              focused={focused && this.__itemFocus === null}
              label={activitySummary(this.__thoughts, this.__tools)}
              onChosenChange={(chosen) =>
                editor.update(() => {
                  const node = $getNodeByKey(this.__key);
                  if ($isActivityTurnNode(node)) node.setChosen(chosen);
                })
              }
              openness={settledOpenness}
            >
              {/* A flex column, so the steps stand `gap-2` apart without carrying a
                margin of their own: a margin would also push the guide down. */}
              <div className="flex flex-col gap-2">
                {this.__items.map((item, index) => (
                  <div
                    key={index}
                    onClick={(event: MouseEvent) => {
                      event.stopPropagation();
                      this.takeStep(editor, index);
                    }}
                  >
                    {item.kind === 'thinking' ? (
                      <ThinkingItem
                        chosen={this.__itemChosen[index] ?? null}
                        focused={focused && this.__itemFocus === index}
                        onChosenChange={(chosen) =>
                          this.takeStepChosen(editor, index, chosen)
                        }
                        streaming={false}
                        text={item.text}
                      />
                    ) : (
                      <ToolItem
                        args={item.args}
                        chosen={this.__itemChosen[index] ?? null}
                        error={item.error}
                        focused={focused && this.__itemFocus === index}
                        name={item.name}
                        onChosenChange={(chosen) =>
                          this.takeStepChosen(editor, index, chosen)
                        }
                        result={item.result}
                        status={item.status}
                      />
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleBlock>
          </div>
        )}
      </WidgetFocus>
    );
  }

  /** The caret takes the step the click took, or the summary's own header. */
  private takeStep(editor: LexicalEditor, cursor: ItemCursor): void {
    editor.update(() => {
      const node = $getNodeByKey(this.__key);
      if ($isActivityTurnNode(node)) node.setItemFocus(cursor);
    });
  }

  /** Write the reader's choice of open/closed for one step. */
  private takeStepChosen(
    editor: LexicalEditor,
    index: number,
    chosen: boolean,
  ): void {
    editor.update(() => {
      const node = $getNodeByKey(this.__key);
      if ($isActivityTurnNode(node)) node.setStepChosen(index, chosen);
    });
  }

  /** Write the reader's choice of open/closed. */
  setChosen(chosen: Chosen): void {
    if (this.__chosen === chosen) return;
    this.getWritable().__chosen = chosen;
  }

  /** Write the reader's choice of open/closed for one step. */
  setStepChosen(index: number, chosen: boolean): void {
    const steps = [...this.__itemChosen];
    steps[index] = chosen;
    this.getWritable().__itemChosen = steps;
  }

  /** The reader opens or closes the summary: their next choice is its opposite. */
  toggle(): void {
    this.setChosen(blockToggled(this.__chosen, settledOpenness));
  }

  /**
   * The reader opens or closes one step: its next choice is its opposite, over
   * the step's own answer — the same one its block computes.
   */
  toggleItem(index: number): void {
    const item = this.__items[index];
    if (item === undefined) return;
    const openness =
      item.kind === 'thinking'
        ? thinkingOpenness(reasoningText(item.text), false)
        : toolOpenness(item.status, item.args, item.result, item.error);
    this.setStepChosen(
      index,
      blockToggled(this.__itemChosen[index] ?? null, openness),
    );
  }

  /** The steps the caret walks: the summary's steps while it shows them. */
  visibleSteps(): number {
    return blockOpen(this.__chosen, settledOpenness) ? this.__items.length : 0;
  }

  /** The step the caret stands on, or `null` for the summary's own header. */
  getItemFocus(): ItemCursor {
    return this.__itemFocus;
  }

  /** Put the caret on one step, or on the summary's header. */
  setItemFocus(cursor: ItemCursor): void {
    if (this.__itemFocus === cursor) return;
    this.getWritable().__itemFocus = cursor;
  }

  setTurn(turn: ActivityTurn): void {
    if (
      this.__thoughts === turn.thoughts &&
      this.__tools === turn.tools &&
      sameItems(this.__items, turn.items)
    ) {
      return;
    }

    // The reader's choices are kept per step by their place in the run, so a
    // step that stays keeps its own.
    const steps = this.__itemChosen.slice(0, turn.items.length);
    const writable = this.getWritable();
    writable.__thoughts = turn.thoughts;
    writable.__tools = turn.tools;
    writable.__items = turn.items;
    writable.__itemChosen = steps;
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
