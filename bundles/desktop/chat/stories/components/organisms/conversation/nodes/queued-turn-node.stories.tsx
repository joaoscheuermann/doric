import type { LexicalNode } from 'lexical';

import { $isQueuedTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/queued-turn-node.js';
import {
  parentThread,
  promptIdOf,
  type StoryLog,
  turnsOfType,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

/** The receipt of a prompt accepted into the queue, from the given source. */
const queue = (
  log: StoryLog,
  n: number,
  text: string,
  source: Readonly<Record<string, unknown>> = { kind: 'user' },
) => {
  log.push(promptIdOf(n), {
    type: 'prompt.accepted',
    text,
    source,
    queued: true,
  });
  log.push(promptIdOf(n), { type: 'prompt.queued' });
};

const one = turnsOfType('queued', (log) =>
  queue(log, 3101, 'Then remove @types/jest from the devDependencies.'),
);

const several = turnsOfType('queued', (log) => {
  queue(log, 3102, 'Fix the two suites that still use jest.mock hoisting.');
  queue(log, 3103, 'Then remove @types/jest from the devDependencies.');
  queue(
    log,
    3104,
    'Summarize the migration in the pull request description, with the suites that changed.',
    { kind: 'parent', threadId: parentThread.id },
  );
});

const open = (blocks: readonly LexicalNode[]): void => {
  for (const block of blocks)
    if ($isQueuedTurnNode(block)) block.setChosen(true);
};

export default {
  title: 'Chat/Nodes/Queued turn',
};

/** One prompt the host queued: the receipt row with its author and words. */
export const OnePrompt = {
  render: () => <TurnsEditor turns={one} />,
};

/** The row opened on the prompt's whole text. */
export const OnePromptOpen = {
  render: () => <TurnsEditor turns={one} after={open} />,
};

/** Consecutive receipts read as one row. */
export const SeveralPrompts = {
  render: () => <TurnsEditor turns={several} />,
};

/** The grouped row opened: each prompt with its author. */
export const SeveralPromptsOpen = {
  render: () => <TurnsEditor turns={several} after={open} />,
};

/** A prompt a terminal queued. */
export const FromTerminal = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('queued', (log) =>
        queue(
          log,
          3105,
          'The dev server exited with code 1: Cannot find module "vite-plugin-checker".',
          { kind: 'terminal', terminalId: 'terminal-dev' },
        ),
      )}
    />
  ),
};
