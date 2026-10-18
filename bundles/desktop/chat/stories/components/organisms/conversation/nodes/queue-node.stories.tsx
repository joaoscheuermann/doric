import type { ThreadQueue } from '../../../../../src/client/domain/queue.js';
import { nodesThread, queueItem } from '../../../../support/conversation.js';
import {
  $appendPromptTail,
  $focusNodes,
  ConversationEditor,
} from '../../../../support/editor.js';

const running: ThreadQueue = {
  revision: 3,
  paused: false,
  stopping: false,
  current: queueItem(3401, 'Profile the production build.'),
  items: [
    queueItem(3402, 'Cache the TypeScript build info in CI.'),
    queueItem(3403, 'Then open a pull request with the numbers.'),
  ],
};

/** The tail of the conversation with the queue above the prompt. */
const tail = (queue: ThreadQueue | undefined, focus?: string) => (
  <ConversationEditor
    host={{
      queues: queue === undefined ? {} : { [nodesThread.id]: queue },
    }}
    seed={() => {
      const { queue: node } = $appendPromptTail(nodesThread);
      if (focus === undefined) return;
      node.setItems([
        ...(queue?.current === undefined ? [] : [queue.current.promptId]),
        ...(queue?.items ?? []).map((item) => item.promptId),
      ]);
      node.focusItem(focus);
      $focusNodes(node);
    }}
  />
);

export default {
  title: 'Chat/Nodes/Queue',
};

/** The run and the prompts waiting behind it, above the prompt. */
export const Running = {
  render: () => tail(running),
};

/** The caret on one of the queue's rows. */
export const CaretOnRow = {
  render: () => tail(running, running.items[0]?.promptId),
};

/** A queue the host paused on an error. */
export const PausedOnError = {
  render: () =>
    tail({
      revision: 4,
      paused: true,
      stopping: false,
      error: {
        code: 'rate_limited',
        message: 'The model provider is rate limiting requests.',
      },
      resumable: queueItem(3404, 'Fix the two suites that use jest.mock.'),
      items: [queueItem(3405, 'Then remove @types/jest.')],
    }),
};

/** Nothing waits: the queue draws nothing. */
export const Empty = {
  render: () =>
    tail({ revision: 1, paused: false, stopping: false, items: [] }),
};
