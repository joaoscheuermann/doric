import { useState } from 'react';
import type { ModelGroup } from 'settings/contracts';

import { ModelPicker } from '../../../src/client/components/molecules/model-picker.js';
import { groups as twoProviders } from '../../support/execution.js';
import { footerFrame } from '../../support/frames.js';
import { OpenOnMount } from '../../support/open-on-mount.js';

const reasoningChoices = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium', note: '(default)' },
  { label: 'High', value: 'high' },
];

/** The picker over literal groups, with its own model and effort. */
function Picker({
  efforts = reasoningChoices,
  groups = twoProviders,
  initial = 'openrouter\u0000anthropic/claude-sonnet-4.5',
}: {
  readonly efforts?: typeof reasoningChoices;
  readonly groups?: readonly ModelGroup[];
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const [effort, setEffort] = useState<string | undefined>('medium');
  const selected = groups
    .flatMap((group) => group.choices)
    .find((choice) => choice.value === value);
  const label = selected?.label ?? 'Choose model';
  const effortName =
    efforts.length === 0
      ? 'Unavailable'
      : (efforts.find((choice) => choice.value === effort)?.label ?? 'None');

  return (
    <ModelPicker
      ariaLabel="Execution model"
      groups={groups}
      label={label}
      icon={selected?.icon}
      value={value}
      onSelect={setValue}
      reasoning={{
        choices: efforts,
        label: effortName,
        onSelect: setEffort,
        value: effort,
      }}
    />
  );
}

/** One provider holds every model, so its group carries no label. */
const single: readonly ModelGroup[] = [
  { choices: twoProviders[0]?.choices ?? [] },
];

export default {
  title: 'Chat/Molecules/Model picker',
  component: ModelPicker,
  decorators: [footerFrame],
};

export const Default = {
  render: () => <Picker />,
};

export const Open = {
  render: () => (
    <OpenOnMount steps={[{ selector: '[aria-label="Execution model"]' }]}>
      <Picker />
    </OpenOnMount>
  ),
};

export const ReasoningOpen = {
  render: () => (
    <OpenOnMount
      steps={[
        { selector: '[aria-label="Execution model"]' },
        { selector: '[aria-label^="Reasoning effort, "]' },
      ]}
    >
      <Picker />
    </OpenOnMount>
  ),
};

export const SingleProviderOpen = {
  render: () => (
    <OpenOnMount steps={[{ selector: '[aria-label="Execution model"]' }]}>
      <Picker groups={single} />
    </OpenOnMount>
  ),
};

export const ReasoningUnavailable = {
  render: () => (
    <OpenOnMount steps={[{ selector: '[aria-label="Execution model"]' }]}>
      <Picker
        efforts={[]}
        initial={'openrouter\u0000meta-llama/llama-4-maverick'}
      />
    </OpenOnMount>
  ),
};

export const NoModelMatches = {
  render: () => (
    <OpenOnMount steps={[{ selector: '[aria-label="Execution model"]' }]}>
      <Picker groups={[{ choices: [] }]} initial="" />
    </OpenOnMount>
  ),
};

export const LongModelName = {
  render: () => (
    <Picker
      groups={[
        {
          choices: [
            {
              label:
                'nousresearch/hermes-4-405b-instruct-preview-extended-context',
              value: 'long',
              execution: {
                providerId: 'openrouter',
                model:
                  'nousresearch/hermes-4-405b-instruct-preview-extended-context',
              },
            },
          ],
        },
      ]}
      initial="long"
    />
  ),
};
