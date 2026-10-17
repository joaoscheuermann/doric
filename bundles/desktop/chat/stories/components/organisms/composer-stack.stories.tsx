import { $createTextNode, $getRoot } from 'lexical';

import {
  ComposerStack,
  type StackItemElement,
} from '../../../src/client/components/organisms/composer-stack.js';
import { $createComposerStackNode } from '../../../src/client/components/organisms/conversation/nodes/composer-stack-node.js';
import { $createUserPromptNode } from '../../../src/client/components/organisms/conversation/nodes/user-prompt-node.js';
import type { ComposerItem } from '../../../src/contracts/index.js';
import {
  checkoutTarget,
  nodesThread,
  stackItem,
} from '../../support/conversation.js';
import { ConversationEditor } from '../../support/editor.js';

/**
 * The stack as the conversation draws it: the stack node's widget above the
 * prompt, its items read from the composer's watch.
 */
const stackOf = (items: readonly ComposerItem[], words = '') => (
  <ConversationEditor
    host={{ drafts: { [nodesThread.id]: { text: words, items } } }}
    seed={() => {
      const prompt = $createUserPromptNode();
      if (words.length > 0) prompt.append($createTextNode(words));
      $getRoot().append($createComposerStackNode(nodesThread), prompt);
    }}
  />
);

/** The tag of an element a comment's owner draws its own line with. */
const OWNER_TAG = 'story-pin-line';

/**
 * A stand-in for an owner's line element (`ui/v1` defines the real ones): it
 * draws the properties the stack hands it.
 */
const defineOwnerLine = (): void => {
  if (customElements.get(OWNER_TAG) !== undefined) return;
  customElements.define(
    OWNER_TAG,
    class extends HTMLElement implements Partial<StackItemElement> {
      #item: ComposerItem | undefined;
      #pin = 0;
      set item(item: ComposerItem) {
        this.#item = item;
        this.draw();
      }
      set pin(pin: number) {
        this.#pin = pin;
        this.draw();
      }
      draw(): void {
        this.className =
          'flex items-center gap-2 rounded-md px-2.5 py-0.75 font-conversation text-sm font-light';
        this.textContent = `Pin ${this.#pin} · ${this.#item?.note || 'No note yet'}`;
      }
    },
  );
};

export default {
  title: 'Chat/Organisms/Composer stack',
  component: ComposerStack,
};

/** One comment drafted above the prompt. */
export const OneComment = {
  render: () =>
    stackOf([stackItem(1, 'The primary button disappears in dark mode', 42)]),
};

/** Several comments, in the order they were added. */
export const SeveralComments = {
  render: () =>
    stackOf(
      [
        stackItem(1, 'The primary button disappears in dark mode', 42),
        stackItem(2, 'Title and list need 8px between them', 18, 'h2'),
        stackItem(3, 'The total should align with the button baseline', 44),
      ],
      'Fix these before the release.',
    ),
};

/** A reply drafted in a sent comment's thread. */
export const Reply = {
  render: () =>
    stackOf([
      {
        id: 'comment-draft-reply',
        kind: 'papercraft.comment',
        elementTag: 'chat-comment-line',
        data: {
          target: checkoutTarget(18, 'h2'),
          pin: 2,
          inReplyTo: 'comment-redesign-2',
        },
        author: 'jao.scheuermann',
        note: 'On mobile too, please',
      },
    ]),
};

/** A comment on one of the agent's messages, its note not written yet. */
export const MessageComment = {
  render: () =>
    stackOf([
      {
        id: 'comment-draft-message',
        kind: 'message',
        elementTag: 'chat-comment-line',
        data: {
          target: {
            kind: 'message',
            id: 'a0000000-0000-4000-8000-000000001001',
            anchor: {
              form: 'range',
              text: 'the summary sits above the payment form',
            },
          },
        },
        author: 'jao.scheuermann',
        note: '',
      },
    ]),
};

/** A long note, truncated on its line. */
export const LongNote = {
  render: () =>
    stackOf([
      stackItem(
        1,
        'This section should have 8px of breathing room between the header and the list, and the list items should align with the title baseline on every breakpoint.',
        18,
        'h2',
      ),
    ]),
};

/** An item whose owner draws its line with its own element. */
export const OwnerElement = {
  render: () => {
    defineOwnerLine();
    return stackOf([
      {
        ...stackItem(1, 'Move the coupon field under the total', 52),
        elementTag: OWNER_TAG,
      },
      stackItem(2, 'The primary button disappears in dark mode', 42),
    ]);
  },
};

/** Nothing stacked: the stack draws nothing. */
export const Empty = {
  render: () => stackOf([], 'Add an empty state to the orders.'),
};
