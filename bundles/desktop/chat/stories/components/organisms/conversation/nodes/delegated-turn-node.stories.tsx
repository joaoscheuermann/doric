import type { LexicalNode } from 'lexical';

import { $isDelegatedTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/delegated-turn-node.js';
import {
  childThread,
  parentThread,
  promptIdOf,
  turnsOfType,
} from '../../../../support/conversation.js';
import { $focusNodes, TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2801);

/** The instruction a parent Thread wrote into this one. */
const instruction = (threadId: string, text: string) =>
  turnsOfType('user', (log) =>
    log.push(prompt, {
      type: 'prompt.accepted',
      text,
      source: { kind: 'parent', threadId },
    }),
  );

/** The result a subthread handed back, in the host's envelope. */
const result = (threadId: string, status: string, body: string) =>
  turnsOfType('user', (log) =>
    log.push(prompt, {
      type: 'prompt.accepted',
      text: [
        '# Delegated task result',
        `Thread: ${threadId}`,
        `Parent: ${parentThread.id}`,
        `Prompt: ${promptIdOf(2899)}`,
        `Status: ${status}`,
        '## Result',
        body,
      ].join('\n'),
      source: { kind: 'result', threadId },
    }),
  );

const contrastResult = result(
  childThread.id,
  'completed',
  'Two pairs fail WCAG AA:\n\n- muted text on the card (3.9:1)\n- the disabled button label (2.8:1)',
);

const open = (blocks: readonly LexicalNode[]): void => {
  for (const block of blocks)
    if ($isDelegatedTurnNode(block)) block.setChosen(true);
};

export default {
  title: 'Chat/Nodes/Delegated turn',
};

/** A parent Thread's instruction: open, so the task reads at once. */
export const Instruction = {
  render: () => (
    <TurnsEditor
      turns={instruction(
        parentThread.id,
        'Check the color contrast of every checkout component against WCAG AA and report the failing pairs.',
      )}
    />
  ),
};

/** A subthread's result: folded behind the sender's name. */
export const Result = {
  render: () => <TurnsEditor turns={contrastResult} />,
};

/** The result opened, with the status the host recorded. */
export const ResultOpen = {
  render: () => <TurnsEditor turns={contrastResult} after={open} />,
};

/** A failed subthread's result. */
export const FailedResult = {
  render: () => (
    <TurnsEditor
      after={open}
      turns={result(
        childThread.id,
        'failed',
        'The contrast checker could not start: `axe-core` is not installed in the sandbox.',
      )}
    />
  ),
};

/** A sender the sidebar tree no longer holds: named by its short id. */
export const UnknownSender = {
  render: () => (
    <TurnsEditor
      turns={instruction(
        '9f1e2d3c-4b5a-4968-8776-655443322110',
        'Summarize the open issues labelled checkout.',
      )}
    />
  ),
};

/** The block holding the editor's focus. */
export const Focused = {
  render: () => (
    <TurnsEditor
      turns={contrastResult}
      after={(blocks) => $focusNodes(...blocks.filter($isDelegatedTurnNode))}
    />
  ),
};
