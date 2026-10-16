import type { ComponentType } from 'react';

import { Conversation } from '../../../../src/client/components/organisms/conversation/index.js';
import type {
  Thread,
  ThreadEvent,
} from '../../../../src/client/domain/workspace.js';
import {
  idleThread,
  liveOutput,
  liveTerminal,
  promptIdOf,
  queueEditOf,
  redesignDraft,
  redesignEvents,
  redesignQueue,
  redesignThread,
  type StoryHost,
} from '../../../support/conversation.js';
import { StoryWindow } from '../../../support/editor.js';

/**
 * The conversation of one Thread, opened in the store from its log, in a
 * column of the chat's height so its scroll and its nav rail work.
 */
const conversation = (
  thread: Thread,
  events: readonly ThreadEvent[],
  host: StoryHost = {},
  edits?: Parameters<typeof StoryWindow>[0]['edits'],
) => (
  <StoryWindow
    thread={thread}
    host={host}
    opened={[{ thread, events }]}
    edits={edits}
  >
    <Conversation thread={thread} autoFocus={false} />
  </StoryWindow>
);

const runningHost: StoryHost = {
  queues: { [redesignThread.id]: redesignQueue },
  drafts: { [redesignThread.id]: redesignDraft },
  terminals: [{ terminal: liveTerminal, output: liveOutput }],
};

/** The full Thread's first two prompts, settled. */
const settledThread: Thread = {
  ...redesignThread,
  state: 'idle',
  activePromptId: undefined,
  executionStartedAt: undefined,
  lastExecutionMs: 48_200,
};
const settledPrompts = new Set([promptIdOf(1001), promptIdOf(1002)]);
const settledEvents = redesignEvents.filter((event) =>
  settledPrompts.has(event.promptId),
);

export default {
  title: 'Chat/Organisms/Conversation',
  component: Conversation,
  decorators: [
    (Story: ComponentType) => (
      <div className="-m-6 flex h-[48rem] min-h-0 flex-col bg-background">
        <Story />
      </div>
    ),
  ],
};

/**
 * A whole Thread: a burst of work and its answer, comments and the agent's
 * replies, a compaction, a host stop and its resume, a subthread's result, a
 * failed prompt, and the prompt still running with a live terminal, two
 * prompts queued behind it, a drafted comment and words in the prompt.
 */
export const FullThread = {
  render: () => conversation(redesignThread, redesignEvents, runningHost),
};

/** A settled Thread: nothing running, nothing queued, the prompt empty. */
export const Settled = {
  render: () =>
    conversation(settledThread, settledEvents, {
      queues: {
        [settledThread.id]: {
          revision: 2,
          paused: false,
          stopping: false,
          items: [],
        },
      },
    }),
};

/** A Thread that ran nothing yet: only the prompt and its placeholder. */
export const NewThread = {
  render: () =>
    conversation(idleThread, [], {
      queues: {
        [idleThread.id]: {
          revision: 0,
          paused: false,
          stopping: false,
          items: [],
        },
      },
    }),
};

/** The reader editing a queued prompt: the prompt holds its words. */
export const EditingQueuedPrompt = {
  render: () => {
    const item = redesignQueue.items[0];
    return conversation(
      redesignThread,
      redesignEvents,
      runningHost,
      item === undefined
        ? undefined
        : {
            [redesignThread.id]: queueEditOf(
              item,
              'Then add an empty state to the order history, with a link back to the catalog.',
            ),
          },
    );
  },
};
