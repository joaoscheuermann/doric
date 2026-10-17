import { $getRoot } from 'lexical';

import { QueueNode } from '../../../src/client/components/organisms/conversation/nodes/queue-node.js';
import { ThreadQueue } from '../../../src/client/components/organisms/thread-queue.js';
import type {
  ThreadQueue as Queue,
  QueueItem,
} from '../../../src/client/domain/queue.js';
import {
  childThread,
  nodesThread,
  parentThread,
  queueEditOf,
  queueItem,
  type StoryHost,
} from '../../support/conversation.js';
import { $focusNodes, ConversationEditor } from '../../support/editor.js';

/**
 * The queue as the conversation draws it: inside the editor, as the queue
 * node's widget, read from the Thread's queue query.
 */
const queueOf = (
  host: StoryHost,
  options: {
    readonly focus?: string;
    readonly editing?: QueueItem;
  } = {},
) => (
  <ConversationEditor
    host={host}
    edits={
      options.editing === undefined
        ? undefined
        : {
            [nodesThread.id]: queueEditOf(
              options.editing,
              options.editing.preview,
            ),
          }
    }
    seed={() => {
      const node = new QueueNode(nodesThread.id);
      $getRoot().append(node);
      if (options.focus === undefined) return;
      const queue = host.queues?.[nodesThread.id];
      node.setItems(
        [
          ...(queue?.current === undefined ? [] : [queue.current]),
          ...(queue?.items ?? []),
        ].map((item) => item.promptId),
      );
      node.focusItem(options.focus);
      $focusNodes(node);
    }}
  />
);

const withQueue = (queue: Queue): StoryHost => ({
  queues: { [nodesThread.id]: queue },
});

const next = [
  queueItem(3502, 'Cache the TypeScript build info in CI.'),
  queueItem(3503, 'Then open a pull request with the numbers.'),
];

const running: Queue = {
  revision: 3,
  paused: false,
  stopping: false,
  current: queueItem(3501, 'Profile the production build.'),
  items: next,
};

export default {
  title: 'Chat/Organisms/Thread queue',
  component: ThreadQueue,
};

/** The prompt running and the prompts waiting behind it. */
export const CurrentAndNext = {
  render: () => queueOf(withQueue(running)),
};

/** A queue the reader paused: the prompts wait for Resume. */
export const Paused = {
  render: () =>
    queueOf(
      withQueue({ revision: 2, paused: true, stopping: false, items: next }),
    ),
};

/** The run being stopped: the current prompt stays listed. */
export const Stopping = {
  render: () =>
    queueOf(
      withQueue({
        revision: 5,
        paused: false,
        stopping: true,
        current: queueItem(3504, 'Make the checkout e2e test deterministic.'),
        items: [],
      }),
    ),
};

/** The host paused the queue on an error. */
export const PausedOnError = {
  render: () =>
    queueOf(
      withQueue({
        revision: 4,
        paused: true,
        stopping: false,
        error: {
          code: 'rate_limited',
          message:
            'The model provider is rate limiting requests. Resume when it recovers.',
        },
        resumable: queueItem(3505, 'Fix the two suites that use jest.mock.'),
        items: [queueItem(3506, 'Then remove @types/jest.')],
      }),
    ),
};

/** The caret on one row, as the arrow keys move it. */
export const CaretOnRow = {
  render: () => queueOf(withQueue(running), { focus: next[0]?.promptId }),
};

/** The row the composer is editing. */
export const EditingRow = {
  render: () =>
    queueOf(withQueue({ ...running, current: undefined }), {
      editing: next[0],
    }),
};

/** Prompts from every kind of author: the reader, a terminal, Threads. */
export const EveryAuthor = {
  render: () =>
    queueOf(
      withQueue({
        revision: 6,
        paused: true,
        stopping: false,
        items: [
          queueItem(3507, 'Add an empty state to the order history.'),
          queueItem(
            3508,
            'The dev server exited with code 1: Cannot find module "vite-plugin-checker".',
            { kind: 'terminal', terminalId: 'terminal-dev' },
            'npm run dev',
          ),
          queueItem(
            3509,
            'Summarize the migration in the pull request description.',
            { kind: 'parent', threadId: parentThread.id },
            parentThread.name,
          ),
          queueItem(
            3510,
            'Two pairs fail WCAG AA: muted text (3.9:1) and the disabled label (2.8:1).',
            { kind: 'result', threadId: childThread.id },
            childThread.name,
          ),
        ],
      }),
    ),
};

/** A long queue scrolls inside its list. */
export const ManyPrompts = {
  render: () =>
    queueOf(
      withQueue({
        revision: 9,
        paused: true,
        stopping: false,
        items: Array.from({ length: 12 }, (_, index) =>
          queueItem(
            3520 + index,
            `Migrate ${['cart', 'checkout', 'orders', 'catalog', 'search', 'account', 'wishlist', 'reviews', 'shipping', 'payments', 'coupons', 'admin'][index]} to the new data client.`,
          ),
        ),
      }),
    ),
};

/**
 * The host refuses to read the queue: once the hook's two retries fail (about
 * three seconds), a retry is offered.
 */
export const Unavailable = {
  render: () => queueOf({}),
};
