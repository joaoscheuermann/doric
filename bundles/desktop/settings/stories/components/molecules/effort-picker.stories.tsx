import { useState } from 'react';

import { EffortPicker } from '../../../src/client/components/molecules/effort-picker.js';
import { effortLabel } from '../../../src/client/domain/config.js';
import { footerFrame } from '../../support/frames.js';
import { OpenOnMount } from '../../support/open-on-mount.js';

const choices = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium', note: '(default)' },
  { label: 'High', value: 'high' },
] as const;

/** The picker with its own effort, so a choice renames the trigger. */
function Picker({ initial = 'medium' }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  const current = choices.find((choice) => choice.value === value);

  return (
    <EffortPicker
      ariaLabel="Reasoning effort"
      choices={choices}
      label={current?.label ?? effortLabel('none')}
      value={value}
      onSelect={setValue}
    />
  );
}

export default {
  title: 'Settings/Molecules/Effort picker',
  component: EffortPicker,
  decorators: [footerFrame],
};

export const Default = {
  render: () => <Picker />,
};

export const Open = {
  render: () => (
    <OpenOnMount steps={[{ selector: '[aria-label="Reasoning effort"]' }]}>
      <Picker initial="high" />
    </OpenOnMount>
  ),
};

export const Unavailable = {
  render: () => (
    <EffortPicker
      ariaLabel="Reasoning effort"
      choices={[]}
      disabled
      label="Unavailable"
      onSelect={() => {}}
    />
  ),
};
