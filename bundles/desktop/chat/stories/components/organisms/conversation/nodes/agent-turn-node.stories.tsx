import {
  answer,
  promptIdOf,
  redesignAnswer,
  turnsOfType,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2001);

export default {
  title: 'Chat/Nodes/Agent turn',
};

/** A settled answer, with the agent's author line under it. */
export const Answered = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('agent', (log) => {
        log.prompt(prompt, 'Why does the Pay button vanish in dark mode?');
        answer(
          log,
          prompt,
          'The button used a hard-coded `bg-white`, so in dark mode it blended into the card. It now uses the `primary` token.',
        );
      })}
    />
  ),
};

/** The answer while the model is still writing it. */
export const Streaming = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('agent', (log) => {
        log.prompt(prompt, 'Summarize what changed in the checkout.');
        log.push(prompt, { type: 'agent.started' });
        log.text(
          prompt,
          'So far the checkout card has a new grid: the summary',
        );
        log.text(prompt, ' sits above the payment form, and the');
      })}
    />
  ),
};

/** Every markdown block the theme styles: heading, list, table, fence, quote. */
export const MarkdownBlocks = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('agent', (log) => {
        log.prompt(prompt, 'What did the redesign change?');
        answer(log, prompt, redesignAnswer);
      })}
    />
  ),
};

/** A long answer, to see how paragraphs and inline code wrap. */
export const LongAnswer = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('agent', (log) => {
        log.prompt(prompt, 'Explain the price helpers.');
        answer(
          log,
          prompt,
          Array.from(
            { length: 6 },
            (_, index) =>
              `${index + 1}. \`formatTotal\` reads the locale from the store, so a price drawn in the cart, the checkout and the order history uses the same separators, currency symbol and rounding, and \`src/legacy/currency.ts\` can go once nothing imports it.`,
          ).join('\n\n'),
        );
      })}
    />
  ),
};

/** A run the reader stopped: what streamed stays, with no closing text. */
export const Cancelled = {
  render: () => (
    <TurnsEditor
      turns={turnsOfType('agent', (log) => {
        log.prompt(prompt, 'Rewrite every test in the checkout package.');
        log.push(prompt, { type: 'agent.started' });
        log.text(prompt, 'I started with `checkout.test.tsx` and');
        log.push(prompt, {
          type: 'prompt.finished',
          status: 'cancelled',
          text: '',
          source: { kind: 'user' },
        });
      })}
    />
  ),
};
