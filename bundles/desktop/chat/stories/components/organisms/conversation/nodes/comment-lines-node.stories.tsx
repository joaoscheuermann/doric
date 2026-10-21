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
 * The comment group of the log's last user turn, opening its block above its
 * words, with the state each thread is in across the whole log.
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

/** The same comments once the agent resolved one thread and asked on another. */
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

const ANSWER =
  'I see the placeholder text and a photo of an orange kitten. Are you testing messages and comments, or do you want me to change the checkout?';

/**
 * A comment on words of the agent's answer, sent with the next prompt: its
 * card reads the passage in the answer's paragraph, the words highlighted.
 */
export const OnTheAnswer = {
  render: () => {
    const projection = projectLog((log) => {
      log.prompt(first, 'Describe the image.');
      log.text(first, ANSWER);
      const turn = `agent:${first}:${log.events.at(-1)?.sequence ?? 0}`;
      log.finish(first, ANSWER);
      log.prompt(second, 'Esse é um prompt do usuário');
      log.push(second, {
        type: 'comments.added/v1',
        commentId: 'comment-lines-6',
        target: {
          kind: 'message',
          id: first,
          anchor: { form: 'range', text: 'of an orange', turn, block: 0 },
        },
        text: 'asdasda',
        author: 'jao.scheuermann',
      });
    });
    return (
      <TurnsEditor threads={projection.threads} turns={projection.turns} />
    );
  },
};
