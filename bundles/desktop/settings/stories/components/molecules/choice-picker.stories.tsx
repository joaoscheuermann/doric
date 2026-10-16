import { useState } from 'react';

import {
  type Choice,
  ChoicePicker,
} from '../../../src/client/components/molecules/choice-picker.js';
import { controlFrame } from '../../support/frames.js';
import { OpenOnMount } from '../../support/open-on-mount.js';

const providers: readonly Choice[] = [
  { label: 'openrouter', value: 'openrouter' },
  { label: 'openai', value: 'openai' },
  { label: 'local', value: 'local' },
];

/** The picker with its own value, so choosing updates the trigger. */
function Picker({
  ariaLabel = 'Execution provider',
  choices = providers,
  emptyLabel,
  initial = 'openrouter',
}: {
  readonly ariaLabel?: string;
  readonly choices?: readonly Choice[];
  readonly emptyLabel?: string;
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);

  return (
    <ChoicePicker
      ariaLabel={ariaLabel}
      choices={choices}
      emptyLabel={emptyLabel}
      value={value}
      onSelect={setValue}
    />
  );
}

export default {
  title: 'Settings/Molecules/Choice picker',
  component: ChoicePicker,
  decorators: [controlFrame],
};

export const Default = {
  render: () => <Picker />,
};

export const Open = {
  render: () => (
    <OpenOnMount
      steps={[
        {
          selector: '[aria-label="Execution provider"]',
          gesture: 'pointerdown',
        },
      ]}
    >
      <Picker />
    </OpenOnMount>
  ),
};

export const UnknownValue = {
  render: () => <Picker initial="anthropic" />,
};

export const EmptyWithLabel = {
  render: () => (
    <Picker
      ariaLabel="Reasoning effort"
      choices={[]}
      emptyLabel="Not offered by this model"
      initial=""
    />
  ),
};

export const EmptyWithoutLabel = {
  render: () => <Picker ariaLabel="Search engine" choices={[]} initial="" />,
};
