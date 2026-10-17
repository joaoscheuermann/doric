import { EditQueuePrompt } from '../../../../../src/client/components/organisms/conversation/plugins/edit-queue-prompt.js';
import type { QueueItem } from '../../../../../src/client/domain/queue.js';
import {
  nodesThread,
  parentThread,
  queueEditOf,
  queueItem,
} from '../../../../support/conversation.js';
import {
  $appendPromptTail,
  ConversationEditor,
} from '../../../../support/editor.js';

const own = queueItem(3301, 'Document the retry options of the API client.');

/**
 * The prompt being edited: the heading above it names the queued prompt, and
 * the prompt holds the words the reader is changing (the edit plugin marks
 * the editor as editing, which the queue-edit surface is styled by).
 */
const editing = (
  item: QueueItem,
  words: string,
  extra?: Parameters<typeof queueEditOf>[2],
) => (
  <ConversationEditor
    host={{
      queues: {
        [nodesThread.id]: {
          revision: 2,
          paused: false,
          stopping: false,
          items: [item],
        },
      },
    }}
    edits={{ [nodesThread.id]: queueEditOf(item, words, extra) }}
    seed={() => $appendPromptTail(nodesThread, words).prompt.selectEnd()}
  >
    <EditQueuePrompt threadId={nodesThread.id} />
  </ConversationEditor>
);

export default {
  title: 'Chat/Nodes/Prompt edit',
};

/** Editing one of the reader's queued prompts. */
export const Editing = {
  render: () =>
    editing(
      own,
      'Document the retry options of the API client, with one example each.',
    ),
};

/** A save the host refused: the error stands under the heading. */
export const SaveFailed = {
  render: () =>
    editing(own, 'Document the retry options.', {
      error: 'The prompt already started; it can no longer be edited.',
    }),
};

/** Editing a prompt another Thread queued. */
export const FromParent = {
  render: () =>
    editing(
      queueItem(
        3302,
        'Summarize the migration in the pull request description.',
        { kind: 'parent', threadId: parentThread.id },
        parentThread.name,
      ),
      'Summarize the migration in the pull request description, with the suites that changed.',
    ),
};

/** Nothing is being edited: the heading draws nothing above the prompt. */
export const NotEditing = {
  render: () => (
    <ConversationEditor
      seed={() => {
        $appendPromptTail(nodesThread, 'Add an empty state to the orders.');
      }}
    />
  ),
};
