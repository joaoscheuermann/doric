import { $createLineBreakNode, $createTextNode, $getRoot } from 'lexical';

import { $createTurnAuthorNode } from '../../../../../src/client/components/organisms/conversation/nodes/turn-author-node.js';
import { $createUserPromptNode } from '../../../../../src/client/components/organisms/conversation/nodes/user-prompt-node.js';
import { READER_NAME } from '../../../../../src/client/domain/conversation-authors.js';
import { ConversationEditor } from '../../../../support/editor.js';

/** The prompt holding the words given, and the reader's line under it. */
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
      node.selectEnd();
    }}
  />
);

export default {
  title: 'Chat/Nodes/User prompt',
};

/** The empty prompt, with its placeholder. */
export const Empty = {
  render: () => prompt([]),
};

/** The reader writing a prompt. */
export const Writing = {
  render: () => prompt(['Add an empty state to the order history page.']),
};

/** A prompt of several lines, in markdown. */
export const Multiline = {
  render: () =>
    prompt([
      'Consolidate the price helpers:',
      '',
      '- keep `formatTotal`',
      '- delete `currency()` and its tests',
    ]),
};
