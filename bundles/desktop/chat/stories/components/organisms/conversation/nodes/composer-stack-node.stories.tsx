import type { ComposerItem } from '../../../../../src/contracts/index.js';
import { nodesThread, stackItem } from '../../../../support/conversation.js';
import {
  $appendPromptTail,
  ConversationEditor,
} from '../../../../support/editor.js';

/** The tail of the conversation, with the comment stack above the prompt. */
const tail = (items: readonly ComposerItem[], words = '') => (
  <ConversationEditor
    host={{ drafts: { [nodesThread.id]: { text: words, items } } }}
    seed={() => {
      $appendPromptTail(nodesThread, words);
    }}
  />
);

export default {
  title: 'Chat/Nodes/Composer stack',
};

/** Two drafted comments, above the words they will be sent with. */
export const TwoComments = {
  render: () =>
    tail(
      [
        stackItem(1, 'The primary button disappears in dark mode', 42),
        stackItem(2, 'Title and list need 8px between them', 18, 'h2'),
      ],
      'Fix these before the release.',
    ),
};

/** A comment whose note is not written yet. */
export const EmptyNote = {
  render: () => tail([stackItem(1, '', 64, 'img')]),
};

/** Nothing stacked: the stack draws nothing. */
export const Empty = {
  render: () => tail([], 'Add an empty state to the orders.'),
};
