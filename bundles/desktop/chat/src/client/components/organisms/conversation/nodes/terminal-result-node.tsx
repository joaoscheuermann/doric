/**
 * A background terminal's answer as a block of the transcript: the command the
 * agent left running, how it finished and the output the host kept, drawn by the
 * very card a `terminal` tool call draws (`TerminalBlock`) and named by the
 * verbs a settled background command owns instead of `Ran`/`Failed` — so a
 * settled command reads as the step it was, not as the Markdown prompt the host
 * framed it in.
 *
 * The host enqueues that prompt when the command settles, so the block is
 * always a finished result: folded away behind the command it answered, and
 * open when the command did not finish cleanly, which is the one result a
 * reader must not scroll past (`terminalResultOpenness`). The caret treats it
 * as one stop, and Enter opens or closes it like any other widget.
 */

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
  terminalResultOpenness,
} from '../../../../domain/collapsible.js';
import { TERMINAL_RESULT_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { UserTurn } from '../../../../domain/projector.js';
import {
  type TerminalResult,
  terminalResultEquals,
  terminalResultFailed,
} from '../../../../domain/terminal-result.js';
import { wholeStream } from '../../../../domain/terminal-tool.js';
import {
  TerminalBlock,
  type TerminalVerbs,
} from '../../../molecules/terminal-tool-item.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

type TerminalResultBlock = {
  readonly turnKey: string;
  readonly promptId: string;
  readonly result: TerminalResult;
};
type SerializedTerminalResult = Spread<
  TerminalResultBlock,
  SerializedLexicalNode
>;

/** The verbs a settled background command's block names itself by. */
const BACKGROUND_TERMINAL_VERBS: TerminalVerbs = {
  running: 'Background terminal',
  ran: 'Background terminal',
  failed: 'Background terminal failed',
};

/**
 * The result as the reader meets it: `Background terminal <command>`, and the
 * very card a `terminal` call draws — the command behind its `$`, then the
 * streams the host kept — named by the verbs a background result owns instead
 * of `Ran`/`Failed`. A command that did not finish cleanly says so in the
 * header, so a folded block still tells the reader something went wrong.
 */
function TerminalResultRow({
  result,
  chosen,
  focused,
  onChosenChange,
}: {
  readonly result: TerminalResult;
  readonly chosen: Chosen;
  readonly focused: boolean;
  readonly onChosenChange: (chosen: boolean) => void;
}) {
  const failed = terminalResultFailed(result);

  return (
    <TerminalBlock
      verbs={BACKGROUND_TERMINAL_VERBS}
      chosen={chosen}
      command={result.command}
      failed={failed}
      focused={focused}
      onChosenChange={onChosenChange}
      openness={terminalResultOpenness(failed)}
      running={false}
      slot="terminal-result"
      stderr={wholeStream(result.stderr)}
      stdout={wholeStream(result.stdout)}
      toggleLabel={`Toggle background terminal: ${result.command}`}
    />
  );
}

/** A background terminal's answer is a settled widget; the reader owns its open state. */
export class TerminalResultNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __result: TerminalResult;
  __chosen: Chosen = null;

  constructor(block: TerminalResultBlock, key?: NodeKey) {
    super(key);
    this.__turnKey = block.turnKey;
    this.__promptId = block.promptId;
    this.__result = block.result;
  }

  static override getType(): string {
    return TERMINAL_RESULT_TURN_BLOCK;
  }
  static override clone(node: TerminalResultNode): TerminalResultNode {
    return new TerminalResultNode(
      {
        turnKey: node.__turnKey,
        promptId: node.__promptId,
        result: node.__result,
      },
      node.__key,
    );
  }
  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__chosen = previous.__chosen;
  }
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    dom.dataset.promptId = this.__promptId;
    dom.dataset.terminalId = this.__result.terminalId;
    return dom;
  }
  override updateDOM(): boolean {
    return false;
  }
  override isInline(): boolean {
    return false;
  }
  override getTextContent(): string {
    return [this.__result.command, this.__result.stdout, this.__result.stderr]
      .map((part) => part.trimEnd())
      .filter((part) => part.length > 0)
      .join('\n');
  }
  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {(focused) => (
          <TerminalResultRow
            result={this.__result}
            chosen={this.__chosen}
            focused={focused}
            onChosenChange={(chosen) =>
              editor.update(() => {
                const node = $getNodeByKey(this.__key);
                if ($isTerminalResultNode(node)) node.setChosen(chosen);
              })
            }
          />
        )}
      </WidgetFocus>
    );
  }
  setChosen(chosen: Chosen): void {
    if (this.__chosen !== chosen) this.getWritable().__chosen = chosen;
  }
  toggle(): void {
    this.setChosen(
      blockToggled(
        this.__chosen,
        terminalResultOpenness(terminalResultFailed(this.__result)),
      ),
    );
  }
  setTurn(turn: UserTurn): void {
    const result = turn.terminal;
    if (result === undefined) return;
    if (terminalResultEquals(this.__result, result)) return;
    this.getWritable().__result = result;
  }
  override exportJSON(): SerializedTerminalResult {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      result: this.__result,
    };
  }
  static override importJSON(
    value: SerializedTerminalResult,
  ): TerminalResultNode {
    return new TerminalResultNode(value);
  }
}

export function $createTerminalResultNode(
  block: TerminalResultBlock,
): TerminalResultNode {
  return new TerminalResultNode(block);
}

export function $isTerminalResultNode(
  node: LexicalNode | null | undefined,
): node is TerminalResultNode {
  return node instanceof TerminalResultNode;
}
