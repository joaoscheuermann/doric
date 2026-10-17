import type { UserTurn } from '../../../../../src/client/domain/projector.js';
import {
  flushedComment,
  longPrompt,
  projectLog,
  promptIdOf,
  turnsOfType,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2101);

export default {
  title: 'Chat/Nodes/User turn',
};

/** The reader's prompt the host accepted, with the reader's author line. */
export const Accepted = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('user', (log) => {
        log.prompt(
          prompt,
          'The Pay button in the checkout disappears in dark mode. Can you fix it?',
        );
      })}
    />
  ),
};

/**
 * The words the reader just sent, drawn dimmed and nameless before the host
 * accepts them (the conversation's pending turn).
 */
export const Pending = {
  render: () => {
    const pending: UserTurn = {
      type: 'user',
      promptId: '',
      events: [],
      text: 'Also run the e2e tests before you finish.',
      accepted: false,
      comments: [],
      awaiting: false,
    };
    return <TurnsEditor turns={[pending]} />;
  },
};

const commented = projectLog((log) => {
  log.prompt(prompt, 'Tighten the checkout card using my notes.');
  flushedComment(log, prompt, {
    id: 'comment-turn-1',
    line: 42,
    text: 'The primary button disappears in dark mode',
  });
  flushedComment(log, prompt, {
    id: 'comment-turn-2',
    line: 18,
    label: 'h2',
    text: 'Title and list need 8px between them',
  });
});

/** A prompt sent with comments: their lines stand above the reader's words. */
export const WithComments = {
  render: () => (
    <TurnsEditor
      threads={commented.threads}
      turns={commented.turns.filter((turn) => turn.type === 'user')}
    />
  ),
};

/** A prompt written in markdown keeps its markers, read as blocks. */
export const MarkdownPrompt = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('user', (log) => {
        log.prompt(prompt, longPrompt);
      })}
    />
  ),
};

/** One long line, to see how the turn wraps. */
export const LongLine = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('user', (log) => {
        log.prompt(
          prompt,
          'Please check every component under src/components/checkout/payment-methods/saved-cards/ and replace the hard-coded hex colors with the tokens from the theme, keeping the focus rings visible in both light and dark mode.',
        );
      })}
    />
  ),
};
