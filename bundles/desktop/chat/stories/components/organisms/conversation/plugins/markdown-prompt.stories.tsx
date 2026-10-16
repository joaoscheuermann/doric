import { $createLineBreakNode, $createTextNode, $getRoot } from 'lexical';

import { $createTurnAuthorNode } from '../../../../../src/client/components/organisms/conversation/nodes/turn-author-node.js';
import { $createUserPromptNode } from '../../../../../src/client/components/organisms/conversation/nodes/user-prompt-node.js';
import { MarkdownPromptPlugin } from '../../../../../src/client/components/organisms/conversation/plugins/markdown-prompt.js';
import { READER_NAME } from '../../../../../src/client/domain/conversation-authors.js';
import { ConversationEditor } from '../../../../support/editor.js';

/**
 * The prompt holding the lines given. The story editor runs the plugin, as
 * the conversation does: each line wears the style its markdown names.
 */
const prompt = (lines: readonly string[]) => (
  <ConversationEditor
    seed={() => {
      const node = $createUserPromptNode();
      lines.forEach((text, index) => {
        if (index > 0) node.append($createLineBreakNode());
        if (text.length > 0) node.append($createTextNode(text));
      });
      $getRoot().append(
        node,
        $createTurnAuthorNode('user', READER_NAME, undefined),
      );
    }}
  />
);

export default {
  title: 'Chat/Plugins/Markdown prompt',
  component: MarkdownPromptPlugin,
};

/** Every line kind the prompt styles while the reader types. */
export const EveryLineKind = {
  render: () =>
    prompt([
      '# Checkout cleanup',
      '## Price helpers',
      '> keep the admin package as it is',
      '- keep `formatTotal`',
      '- delete `currency()`',
      '1. migrate the cart',
      '```ts',
      'formatTotal(total, locale)',
      '```',
      'Plain words stay plain.',
    ]),
};

/** A plain prompt: nothing to style. */
export const PlainWords = {
  render: () => prompt(['Add an empty state to the order history page.']),
};
