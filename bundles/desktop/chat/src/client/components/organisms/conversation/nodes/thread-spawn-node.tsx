/**
 * A `thread-spawn` call as a block of the transcript, shaped like the delegated
 * "Result from:" block: the call hands a task to a Thread of its own, and once
 * the child exists its header names it, so the agent's delegation reads as where
 * the work went rather than as one more tool row.
 *
 * The block is open while the call spawns — the prompt the agent handed down is
 * what the reader sees — folded once the child exists, since the header names
 * it, and open again when the call failed, which is the one outcome a reader
 * must not scroll past (`spawnOpenness`). The caret treats it as one stop, and
 * Enter opens or closes it like any other widget.
 */

import { Button } from 'desktop/ui/button';
import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react/jsx-runtime';

import {
  blockToggled,
  type Chosen,
  spawnOpenness,
} from '../../../../domain/collapsible.js';
import { THREAD_SPAWN_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { ToolStatus, ToolTurn } from '../../../../domain/projector.js';
import { parseThreadSpawn } from '../../../../domain/thread-spawn.js';
import { useDelegatedSource } from '../../../../hooks/use-delegated-source.js';
import { CollapsibleBlock } from '../../../molecules/collapsible-block.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { ReadonlyMarkdown } from '../readonly-markdown.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

/** The fields a spawn call carries, as the sync writes and serializes them. */
export type ThreadSpawnBlock = Pick<
  ToolTurn,
  'promptId' | 'callId' | 'args' | 'status' | 'result' | 'error'
> & { readonly turnKey: string };

export type SerializedThreadSpawnNode = Spread<
  ThreadSpawnBlock,
  SerializedLexicalNode
>;

/** The verb the block's header names the call by. */
const spawnVerb = (status: ToolStatus): string =>
  status === 'running'
    ? 'Spawning'
    : status === 'failed'
      ? 'Spawn failed'
      : 'Spawned';

/** The child the call started, named by the transcript's own words for it. */
function SpawnedLink({ threadId }: { readonly threadId: string }) {
  const source = useDelegatedSource(threadId);
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto min-w-0 shrink px-0 py-0"
      title={threadId}
      onClick={source.open}
    >
      <span className="truncate">{source.label.value}</span>
    </Button>
  );
}

/**
 * The call as the reader meets it: the verb the call is at, the child it started
 * once the result names one, and the prompt the agent handed down — with the
 * error beside it when the call failed.
 */
function ThreadSpawnRow({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: {
  readonly args: string;
  readonly chosen: Chosen;
  readonly error: string | undefined;
  readonly focused: boolean;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly result: string | undefined;
  readonly status: ToolStatus;
}) {
  const parsed = parseThreadSpawn(args, result);
  const child = parsed.child;
  return (
    <CollapsibleBlock
      label={<span className="font-normal">{spawnVerb(status)}</span>}
      action={
        child === undefined
          ? undefined
          : {
              toggleLabel: 'Toggle thread spawn',
              content: <SpawnedLink threadId={child.threadId} />,
            }
      }
      chosen={chosen}
      focused={focused}
      onChosenChange={onChosenChange}
      openness={spawnOpenness(status)}
    >
      <ReadonlyMarkdown text={parsed.prompt} />
      {error === undefined ? null : (
        <div className="text-destructive">{error}</div>
      )}
    </CollapsibleBlock>
  );
}

/** A `thread-spawn` call: a read-only widget named by the delegation it made. */
export class ThreadSpawnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __callId: string;
  __args: string;
  __status: ToolStatus;
  __result?: string;
  __error?: string;
  /** The reader's choice of open/closed; `null` until they make one. */
  __chosen: Chosen = null;

  constructor(block: ThreadSpawnBlock, key?: NodeKey) {
    super(key);
    this.__turnKey = block.turnKey;
    this.__promptId = block.promptId;
    this.__callId = block.callId;
    this.__args = block.args;
    this.__status = block.status;
    this.__result = block.result;
    this.__error = block.error;
  }

  static override getType(): string {
    return THREAD_SPAWN_TURN_BLOCK;
  }

  /** The fields this node carries, in the shape a sync writes them. */
  private block(): ThreadSpawnBlock {
    return {
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      callId: this.__callId,
      args: this.__args,
      status: this.__status,
      result: this.__result,
      error: this.__error,
    };
  }

  static override clone(node: ThreadSpawnNode): ThreadSpawnNode {
    return new ThreadSpawnNode(node.block(), node.__key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap the conversation's blocks stand apart by, which the author
    // line's bottom margin gives every other case. A step of a run can follow a
    // block that carries no such line, so the gap is stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    dom.dataset.spawnCallId = this.__callId;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * The reader's choice of open/closed is theirs, not the sync's: it travels
   * with the block through every update a sync writes.
   */
  override afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__chosen = prevNode.__chosen;
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
          <ThreadSpawnRow
            args={this.__args}
            chosen={this.__chosen}
            error={this.__error}
            focused={focused}
            onChosenChange={(chosen) =>
              editor.update(() => {
                const node = $getNodeByKey(this.__key);
                if ($isThreadSpawnNode(node)) node.setChosen(chosen);
              })
            }
            result={this.__result}
            status={this.__status}
          />
        )}
      </WidgetFocus>
    );
  }

  /** Write the reader's choice of open/closed. */
  setChosen(chosen: Chosen): void {
    if (this.__chosen === chosen) return;
    this.getWritable().__chosen = chosen;
  }

  /** The reader opens or closes the block: their next choice is its opposite. */
  toggle(): void {
    this.setChosen(blockToggled(this.__chosen, spawnOpenness(this.__status)));
  }

  setTurn(turn: ToolTurn): void {
    // A sync that says nothing new touches nothing, so the editor keeps its own
    // DOM and the reader keeps the caret where it was.
    if (
      this.__args === turn.args &&
      this.__status === turn.status &&
      this.__result === turn.result &&
      this.__error === turn.error
    ) {
      return;
    }

    const writable = this.getWritable();
    writable.__args = turn.args;
    writable.__status = turn.status;
    writable.__result = turn.result;
    writable.__error = turn.error;
  }

  override exportJSON(): SerializedThreadSpawnNode {
    return { ...super.exportJSON(), ...this.block() };
  }

  static override importJSON(
    serialized: SerializedThreadSpawnNode,
  ): ThreadSpawnNode {
    return $createThreadSpawnNode(serialized);
  }
}

export function $createThreadSpawnNode(
  block: ThreadSpawnBlock,
): ThreadSpawnNode {
  return new ThreadSpawnNode(block);
}

export function $isThreadSpawnNode(
  node: LexicalNode | null | undefined,
): node is ThreadSpawnNode {
  return node instanceof ThreadSpawnNode;
}
