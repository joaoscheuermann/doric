import { $isElementNode, $isTextNode, type LexicalNode } from 'lexical';

import { CommentSelection } from '../../../../../src/client/components/organisms/conversation/plugins/comment-selection.js';
import {
  answer,
  promptIdOf,
  turnsOfLog,
} from '../../../../support/conversation.js';
import {
  $appendTurns,
  ConversationEditor,
} from '../../../../support/editor.js';

const prompt = promptIdOf(3701);

const turns = turnsOfLog((log) => {
  log.prompt(prompt, 'What changed in the checkout card?');
  answer(
    log,
    prompt,
    'The summary now sits above the payment form, and the Pay button uses the `primary` token so it stays readable in dark mode.',
  );
});

/** The first text of a block, where a selection can start. */
const firstText = (node: LexicalNode | undefined) => {
  let current: LexicalNode | null | undefined = node;
  while ($isElementNode(current)) current = current.getFirstChild();
  return $isTextNode(current) ? current : undefined;
};

export default {
  title: 'Chat/Plugins/Comment selection',
  component: CommentSelection,
};

/**
 * Text selected in one of the agent's messages: nothing opens yet — the first
 * character typed over it opens a comment closing the block the words end in.
 */
export const MessageSelected = {
  render: () => (
    <ConversationEditor
      seed={() => {
        const blocks = $appendTurns(turns);
        firstText(blocks.at(-1))?.select(4, 47);
      }}
    />
  ),
};

/** Text selected in the reader's own prompt: no comment, it is not a message. */
export const PromptSelected = {
  render: () => (
    <ConversationEditor
      seed={() => {
        const blocks = $appendTurns(turns);
        firstText(blocks[0])?.select(0, 12);
      }}
    />
  ),
};
