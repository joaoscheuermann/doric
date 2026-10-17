import { useState } from 'react';

import { ModelPicker } from '../../../src/client/components/molecules/model-picker.js';
import {
  type Configuration,
  effortLabel,
  type ModelGroup,
  modelChoiceKey,
  modelGroups,
} from '../../../src/client/domain/config.js';
import { configuration } from '../../support/fixtures.js';
import { footerFrame } from '../../support/frames.js';
import { OpenOnMount } from '../../support/open-on-mount.js';

const reasoningChoices = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium', note: '(default)' },
  { label: 'High', value: 'high' },
];

/** The picker over a configuration's groups, with its own model and effort. */
function Picker({
  efforts = reasoningChoices,
  groups = modelGroups(configuration),
  initial = modelChoiceKey('openrouter', 'anthropic/claude-sonnet-4.5'),
}: {
  readonly efforts?: typeof reasoningChoices;
  readonly groups?: readonly ModelGroup[];
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const [effort, setEffort] = useState<string | undefined>('medium');
  const label =
    groups
      .flatMap((group) => group.choices)
      .find((choice) => choice.value === value)?.label ?? 'Choose model';
  const effortName =
    efforts.length === 0
      ? 'Unavailable'
      : (efforts.find((choice) => choice.value === effort)?.label ??
        effortLabel('none'));

  return (
    <ModelPicker
      ariaLabel="Execution model"
      groups={groups}
      label={label}
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

const single: Configuration = {
  ...configuration,
  providers: configuration.providers.slice(0, 1),
};

export default {
  title: 'Settings/Molecules/Model picker',
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
      <Picker groups={modelGroups(single)} />
    </OpenOnMount>
  ),
};

export const ReasoningUnavailable = {
  render: () => (
    <OpenOnMount steps={[{ selector: '[aria-label="Execution model"]' }]}>
      <Picker
        efforts={[]}
        initial={modelChoiceKey('openrouter', 'meta-llama/llama-4-maverick')}
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
            },
          ],
        },
      ]}
      initial="long"
    />
  ),
};
