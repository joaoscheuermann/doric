import type { LexicalNode } from 'lexical';

import { $isActivityTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/activity-turn-node.js';
import {
  answer,
  promptIdOf,
  type StoryLog,
  turnsOfLog,
} from '../../../../support/conversation.js';
import { $focusNodes, TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2401);

/** A completed burst of reasoning and calls, and the answer it led to. */
const burst = (build: (log: StoryLog) => void) =>
  turnsOfLog((log) => {
    log.prompt(prompt, 'Find every hard-coded background in the checkout.');
    build(log);
    answer(log, prompt, 'Two hard-coded backgrounds remain; both are listed.');
  }).filter((turn) => turn.type === 'activity' || turn.type === 'agent');

const investigation = burst((log) => {
  log.thinking(
    prompt,
    'I should read the checkout component, then grep for `bg-white`.',
  );
  log.tool(
    prompt,
    'call-1',
    'read',
    { path: 'src/components/Checkout.tsx' },
    { output: 'export function Checkout({ total }: CheckoutProps) { … }' },
  );
  log.tool(
    prompt,
    'call-2',
    'grep',
    { pattern: 'bg-white', path: 'src' },
    {
      output:
        'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18',
    },
  );
  log.thinking(prompt, 'Two matches. Both are backgrounds of cards.');
});

const open =
  (step?: number) =>
  (blocks: readonly LexicalNode[]): void => {
    for (const block of blocks) {
      if (!$isActivityTurnNode(block)) continue;
      block.setChosen(true);
      if (step !== undefined) block.setStepChosen(step, true);
    }
  };

export default {
  title: 'Chat/Nodes/Activity turn',
};

/** A settled burst, folded into its summary line. */
export const Collapsed = {
  render: () => <TurnsEditor turns={investigation} />,
};

/** The burst opened: each step as its own folded block. */
export const Expanded = {
  render: () => <TurnsEditor turns={investigation} after={open()} />,
};

/** The burst opened, with one tool call opened inside it. */
export const StepOpen = {
  render: () => <TurnsEditor turns={investigation} after={open(2)} />,
};

/** The burst holding the editor's focus. */
export const Focused = {
  render: () => (
    <TurnsEditor
      turns={investigation}
      after={(blocks) => $focusNodes(...blocks.filter($isActivityTurnNode))}
    />
  ),
};

/** A long burst: many reads and searches before the answer. */
export const ManyToolCalls = {
  render: () => (
    <TurnsEditor
      after={open()}
      turns={burst((log) => {
        log.thinking(prompt, 'I will read every component of the checkout.');
        const files = [
          'Checkout.tsx',
          'CartSummary.tsx',
          'PaymentForm.tsx',
          'SavedCards.tsx',
          'OrderTotal.tsx',
          'CouponField.tsx',
          'ShippingPicker.tsx',
          'GiftWrap.tsx',
          'AddressForm.tsx',
          'TaxNotice.tsx',
        ];
        files.forEach((file, index) => {
          log.tool(
            prompt,
            `call-${index + 1}`,
            'read',
            { path: `src/components/checkout/${file}` },
            { output: `export function ${file.replace('.tsx', '')}() { … }` },
          );
        });
        log.tool(
          prompt,
          'call-11',
          'grep',
          { pattern: 'bg-white|#fff', path: 'src/components/checkout' },
          { error: 'grep: invalid regular expression' },
        );
        log.thinking(prompt, 'The pattern failed; the reads are enough.');
      })}
    />
  ),
};
