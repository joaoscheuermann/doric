import type { LexicalNode } from 'lexical';

import { $isRepliesTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/replies-turn-node.js';
import {
  answer,
  commentReply,
  flushedComment,
  projectLog,
  promptIdOf,
  type StoryLog,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2901);

/** The agent's replies to the reader's comments, and the threads they are in. */
const replies = (build: (log: StoryLog) => void) => {
  const projection = projectLog((log) => {
    log.prompt(prompt, 'Tighten the checkout card using my notes.');
    flushedComment(log, prompt, {
      id: 'comment-replies-1',
      line: 42,
      text: 'The primary button disappears in dark mode',
    });
    flushedComment(log, prompt, {
      id: 'comment-replies-2',
      line: 18,
      label: 'h2',
      text: 'Title and list need 8px between them',
    });
    build(log);
    answer(log, prompt, 'I went through both notes.');
  });
  return {
    threads: projection.threads,
    turns: projection.turns.filter(
      (turn) => turn.type === 'replies' || turn.type === 'agent',
    ),
  };
};

const fixed = (log: StoryLog) =>
  commentReply(log, prompt, {
    id: 'comment-replies-3',
    callId: 'call-1',
    inReplyTo: 'comment-replies-1',
    line: 42,
    text: 'Fixed: the button now uses the `primary` token in both themes.',
  });

const asked = (log: StoryLog) =>
  commentReply(log, prompt, {
    id: 'comment-replies-4',
    callId: 'call-2',
    inReplyTo: 'comment-replies-2',
    line: 18,
    label: 'h2',
    text: 'Should the gap be 8px on mobile too, or only from `md` up?',
  });

const resolve = (log: StoryLog, commentId: string) =>
  log.push(prompt, { type: 'comments.resolved/v1', commentId, resolved: true });

const awaiting = replies(asked);
const both = replies((log) => {
  fixed(log);
  resolve(log, 'comment-replies-1');
  asked(log);
});
const done = replies((log) => {
  fixed(log);
  resolve(log, 'comment-replies-1');
});

export default {
  title: 'Chat/Nodes/Replies turn',
};

/** A reply that asks the reader something: open, waiting for an answer. */
export const Awaiting = {
  render: () => (
    <TurnsEditor threads={awaiting.threads} turns={awaiting.turns} />
  ),
};

/** A reply on a thread the agent resolved: folded, with the done glyph. */
export const Resolved = {
  render: () => <TurnsEditor threads={done.threads} turns={done.turns} />,
};

/** The resolved reply, opened. */
export const ResolvedOpen = {
  render: () => (
    <TurnsEditor
      threads={done.threads}
      turns={done.turns}
      after={(blocks: readonly LexicalNode[]) => {
        for (const block of blocks)
          if ($isRepliesTurnNode(block))
            block.setChosen('comment-replies-3', true);
      }}
    />
  ),
};

/** Several replies in a row: one block, one row per reply. */
export const SeveralReplies = {
  render: () => <TurnsEditor threads={both.threads} turns={both.turns} />,
};

/** A long reply, with markdown. */
export const LongReply = {
  render: () => {
    const long = replies((log) =>
      commentReply(log, prompt, {
        id: 'comment-replies-5',
        callId: 'call-3',
        inReplyTo: 'comment-replies-2',
        line: 18,
        label: 'h2',
        text: [
          'There are two ways to get the gap:',
          '',
          '1. `gap-2` on the card, which also spaces the footer',
          '2. `mt-2` on the list only, which keeps the footer where it is',
          '',
          'I went with the second; the footer already has its own `pt-4`, and doubling it made the card look loose on mobile.',
        ].join('\n'),
      }),
    );
    return <TurnsEditor threads={long.threads} turns={long.turns} />;
  },
};
