import { $isThinkingTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/thinking-turn-node.js';
import type { ThinkingTurn } from '../../../../../src/client/domain/projector.js';
import {
  answer,
  promptIdOf,
  turnsOfLog,
} from '../../../../support/conversation.js';
import { $focusNodes, TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2201);

const reasoning =
  'The reader says the Pay button disappears in dark mode. The button likely uses a hard-coded white background instead of the theme token, so I should read `Checkout.tsx` first and then grep for other hard-coded backgrounds.';

/** Reasoning the run settled, followed by the answer it led to. */
const settled = turnsOfLog((log) => {
  log.prompt(prompt, 'Fix the Pay button in dark mode.');
  log.thinking(prompt, reasoning);
  answer(log, prompt, 'The button now uses the `primary` token.');
}).filter((turn) => turn.type !== 'user');

export default {
  title: 'Chat/Nodes/Thinking turn',
};

/** Reasoning still being written: open, so the reader watches it arrive. */
export const Streaming = {
  render: () => (
    <TurnsEditor
      turns={turnsOfLog((log) => {
        log.prompt(prompt, 'Fix the Pay button in dark mode.');
        log.push(prompt, { type: 'agent.started' });
        log.thinking(prompt, 'The reader says the Pay button disappears in ');
        log.thinking(prompt, 'dark mode. The button likely uses a hard-coded');
      }).filter((turn) => turn.type === 'thinking')}
    />
  ),
};

/** The agent waiting before it produced anything: the empty pending run. */
export const Waiting = {
  render: () => {
    const waiting: ThinkingTurn = {
      type: 'thinking',
      promptId: prompt,
      events: [],
      text: '',
      streaming: true,
    };
    return <TurnsEditor turns={[waiting]} />;
  },
};

/** Settled reasoning folds away once the run moved on. */
export const Settled = {
  render: () => <TurnsEditor turns={settled} />,
};

/** Settled reasoning the reader opened again. */
export const SettledOpen = {
  render: () => (
    <TurnsEditor
      turns={settled}
      after={(blocks) => {
        for (const block of blocks)
          if ($isThinkingTurnNode(block)) block.setChosen(true);
      }}
    />
  ),
};

/** The run holding the editor's focus, drawn in its hover style. */
export const Focused = {
  render: () => (
    <TurnsEditor
      turns={settled}
      after={(blocks) => {
        const thinking = blocks.filter($isThinkingTurnNode);
        $focusNodes(...thinking);
      }}
    />
  ),
};

/** Long reasoning, open. */
export const LongReasoning = {
  render: () => (
    <TurnsEditor
      turns={turnsOfLog((log) => {
        log.prompt(prompt, 'Plan the checkout migration.');
        log.push(prompt, { type: 'agent.started' });
        for (let step = 1; step <= 6; step += 1)
          log.thinking(
            prompt,
            `Step ${step}: the cart store, the checkout card and the order history all draw prices, so each one has to move to \`formatTotal\` before \`currency()\` can be deleted without breaking the admin package. `,
          );
      }).filter((turn) => turn.type === 'thinking')}
    />
  ),
};
