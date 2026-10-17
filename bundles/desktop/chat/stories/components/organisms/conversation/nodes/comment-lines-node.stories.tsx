import {
  answer,
  checkoutTarget,
  commentReply,
  flushedComment,
  projectLog,
  promptIdOf,
  type StoryLog,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const first = promptIdOf(3001);
const second = promptIdOf(3002);

/**
 * The comment lines of the log's last user turn, drawn above its words, with
 * the state each thread is in across the whole log.
 */
const lines = (build: (log: StoryLog) => void) => {
  const projection = projectLog(build);
  const users = projection.turns.filter((turn) => turn.type === 'user');
  return { threads: projection.threads, turns: users.slice(-1) };
};

const notes = (log: StoryLog) => {
  log.prompt(first, 'Tighten the checkout card using my notes.');
  flushedComment(log, first, {
    id: 'comment-lines-1',
    line: 42,
    text: 'The primary button disappears in dark mode',
  });
  flushedComment(log, first, {
    id: 'comment-lines-2',
    line: 18,
    label: 'h2',
    text: 'Title and list need 8px between them',
  });
};

const open = lines(notes);

const answered = lines((log) => {
  notes(log);
  commentReply(log, first, {
    id: 'comment-lines-3',
    callId: 'call-1',
    inReplyTo: 'comment-lines-1',
    line: 42,
    text: 'Fixed: the button uses the primary token.',
  });
  log.push(first, {
    type: 'comments.resolved/v1',
    commentId: 'comment-lines-1',
    resolved: true,
  });
  commentReply(log, first, {
    id: 'comment-lines-4',
    callId: 'call-2',
    inReplyTo: 'comment-lines-2',
    line: 18,
    label: 'h2',
    text: 'Only from md up, or on mobile too?',
  });
  answer(log, first, 'Both notes are addressed.');
});

const replied = lines((log) => {
  notes(log);
  commentReply(log, first, {
    id: 'comment-lines-4',
    callId: 'call-2',
    inReplyTo: 'comment-lines-2',
    line: 18,
    label: 'h2',
    text: 'Only from md up, or on mobile too?',
  });
  answer(log, first, 'One question is open on the heading.');
  log.prompt(second, 'Answered on the heading.');
  log.push(second, {
    type: 'comments.added/v1',
    commentId: 'comment-lines-5',
    inReplyTo: 'comment-lines-2',
    target: checkoutTarget(18, 'h2'),
    text: 'On mobile too, please',
    author: 'jao.scheuermann',
  });
});

export default {
  title: 'Chat/Nodes/Comment lines',
};

/** Comments the send flushed, nobody has answered yet. */
export const Open = {
  render: () => <TurnsEditor threads={open.threads} turns={open.turns} />,
};

/** The same lines once the agent resolved one thread and asked on the other. */
export const Answered = {
  render: () => (
    <TurnsEditor threads={answered.threads} turns={answered.turns} />
  ),
};

/** The reader's reply in a thread, sent with the next prompt. */
export const ReaderReply = {
  render: () => <TurnsEditor threads={replied.threads} turns={replied.turns} />,
};

/** Many comments, some with long notes. */
export const ManyComments = {
  render: () => {
    const many = lines((log) => {
      log.prompt(first, 'Here is my review of the checkout.');
      const notesOf = [
        [42, 'button', 'The primary button disappears in dark mode'],
        [18, 'h2', 'Title and list need 8px between them'],
        [
          57,
          'p',
          'The tax notice repeats what the total line already says; drop it or merge the two into one sentence under the total',
        ],
        [64, 'img', ''],
        [71, 'a', 'Link the return policy here'],
      ] as const;
      notesOf.forEach(([line, label, text], index) => {
        flushedComment(log, first, {
          id: `comment-many-${index + 1}`,
          line,
          label,
          text,
        });
      });
    });
    return <TurnsEditor threads={many.threads} turns={many.turns} />;
  },
};
