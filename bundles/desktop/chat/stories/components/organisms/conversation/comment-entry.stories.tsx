// The inline comments typing over a selection inside one of the agent's
// messages opens: each a seat `CommentSeatNode` puts at the end of the block
// the selection ends in, drawn by `CommentEntry` — the reader's avatar and
// the note, one element from the first character on — with its words kept
// highlighted for as long as it stands (`CommentHighlights`).
//
// The first section is a selection alone: nothing opens until the reader types
// (`CommentSelection`), so the page shows the platform's selection and nothing
// else. The second holds two comments on one paragraph, as the composer's
// stack holds them after their first characters: `CommentSeats` seats each,
// in the order of the passages they are about, and both passages stay
// highlighted.

import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';

import { $isAgentTurnNode } from '../../../../src/client/components/organisms/conversation/nodes/agent-turn-node.js';
import { solidLength } from '../../../../src/client/domain/comment-highlight.js';
import { READER_NAME } from '../../../../src/client/domain/conversation-authors.js';
import { syncPlan } from '../../../../src/client/domain/conversation-sync.js';
import {
  CHAT_COMMENT_LINE_TAG,
  type ComposerItem,
  MESSAGE_KIND,
} from '../../../../src/contracts/index.js';
import {
  answer,
  nodesThread,
  promptIdOf,
  turnsOfLog,
} from '../../../support/conversation.js';
import {
  $appendTurns,
  $createSectionCaptionNode,
  ConversationEditor,
} from '../../../support/editor.js';

const waitingPrompt = promptIdOf(4701);
const writtenPrompt = promptIdOf(4702);

/** The paragraph the reader selects in: the answer's second block. */
const paragraph =
  'The card now follows the new layout: the summary sits above the payment form, and the Pay button uses the primary token.';

/** The index of that paragraph among the answer's blocks. */
const paragraphBlock = 1;

/**
 * The answer both sections show: a heading, the paragraph the reader selects
 * in, and the one below it — so the entry stands between two paragraphs, as it
 * does in the transcript.
 */
const answerText = [
  '## Checkout card',
  '',
  paragraph,
  '',
  'Dark mode broke because the old stylesheet set its own background; that file is gone now.',
].join('\n');

/** The words the reader selected, which stay highlighted. */
const quote = 'the summary sits above the payment form';

/** A later passage of the same paragraph, the second comment's. */
const laterQuote = 'the Pay button uses the primary token';

const waitingTurns = turnsOfLog((log) => {
  log.prompt(waitingPrompt, 'Review the checkout card.');
  answer(log, waitingPrompt, answerText);
});

const writtenTurns = turnsOfLog((log) => {
  log.prompt(writtenPrompt, 'Review the checkout card.');
  answer(log, writtenPrompt, answerText);
});

/** The key the written answer's block carries, as the sync gives it. */
const writtenTurn =
  syncPlan([], writtenTurns, writtenTurns.length).steps.find(
    (step) => step.kind === 'create' && step.turn.type === 'agent',
  )?.key ?? '';

/** A comment on `words` of the paragraph, as the composer's stack holds it. */
const writtenItem = (
  id: string,
  words: string,
  note: string,
): ComposerItem => ({
  id,
  kind: MESSAGE_KIND,
  elementTag: CHAT_COMMENT_LINE_TAG,
  data: {
    target: {
      kind: MESSAGE_KIND,
      id: writtenPrompt,
      anchor: {
        form: 'range',
        text: words,
        turn: writtenTurn,
        block: paragraphBlock,
      },
    },
    seat: {
      turn: writtenTurn,
      block: paragraphBlock,
      at: solidLength(paragraph.slice(0, paragraph.indexOf(words))),
    },
  },
  author: READER_NAME,
  note,
});

/**
 * The paragraph's two comments, the later passage's first on the stack: the
 * transcript seats them in passage order all the same.
 */
const writtenItems = [
  writtenItem(
    'comment-story-later',
    laterQuote,
    'Which token, exactly? Link it.',
  ),
  writtenItem(
    'comment-story-earlier',
    quote,
    'Name the form component here, so the layout is easy to find.',
  ),
];

/** The first text of a block, where a selection can start. */
const firstText = (node: LexicalNode | undefined) => {
  let current: LexicalNode | null | undefined = node;
  while ($isElementNode(current)) current = current.getFirstChild();
  return $isTextNode(current) ? current : undefined;
};

/** Selects the quoted words inside a block, as a drag over them does. */
const $selectQuote = (block: LexicalNode | undefined, words: string): void => {
  const text = firstText(block);
  if (text === undefined) return;
  const start = text.getTextContent().indexOf(words);
  if (start < 0) return;
  text.select(start, start + words.length);
};

/**
 * One page, two sections: a selection that opened nothing yet, and a paragraph
 * holding two comments.
 */
function CommentEntryPage() {
  return (
    <ConversationEditor
      host={{
        drafts: { [nodesThread.id]: { text: '', items: writtenItems } },
      }}
      seed={() => {
        $getRoot().append(
          $createSectionCaptionNode(
            'A selection alone — nothing opens until the reader types over it',
          ),
        );
        const waiting = $appendTurns(waitingTurns).at(-1);
        if ($isAgentTurnNode(waiting))
          $selectQuote(waiting.getChildren()[paragraphBlock], quote);

        $getRoot().append(
          $createSectionCaptionNode(
            'Two comments on one paragraph — in passage order, both passages highlighted',
          ),
        );
        $appendTurns(writtenTurns);
      }}
    />
  );
}

export default {
  title: 'Chat/Organisms/Conversation comment entry',
  parameters: { layout: 'padded' },
};

/**
 * A selection that has opened nothing, and a paragraph whose two comments
 * stand after it in the order of the passages they are about.
 */
export const States = { render: () => <CommentEntryPage /> };
