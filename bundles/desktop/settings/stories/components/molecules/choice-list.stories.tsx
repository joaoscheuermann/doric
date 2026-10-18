import { useState } from 'react';

import { ChoiceList } from '../../../src/client/components/molecules/choice-list.js';
import { modelChoiceKey } from '../../../src/client/domain/config.js';
import { controlFrame } from '../../support/frames.js';

const efforts = [
  { label: 'Minimal', value: 'minimal' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium', note: '(default)' },
  { label: 'High', value: 'high' },
];

const models = [
  'anthropic/claude-sonnet-4.5',
  'deepseek/deepseek-v3.2',
  'meta-llama/llama-4-maverick',
].map((model) => ({
  label: model,
  value: modelChoiceKey('openrouter', model),
}));

/** The list with its own selection, so a click moves the check. */
function Selectable({
  choices,
  compact,
  initial,
}: {
  readonly choices: readonly {
    readonly label: string;
    readonly note?: string;
    readonly value: string;
  }[];
  readonly compact?: boolean;
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);

  return (
    <div className={compact ? 'w-32' : 'w-64'}>
      <ChoiceList
        choices={choices}
        compact={compact}
        value={value}
        onSelect={setValue}
      />
    </div>
  );
}

export default {
  title: 'Settings/Molecules/Choice list',
  component: ChoiceList,
  decorators: [controlFrame],
};

export const EffortMenu = {
  render: () => <Selectable compact choices={efforts} initial="medium" />,
};

export const ModelList = {
  render: () => (
    <Selectable
      choices={models}
      initial={modelChoiceKey('openrouter', 'anthropic/claude-sonnet-4.5')}
    />
  ),
};

export const NothingSelected = {
  render: () => <Selectable compact choices={efforts} />,
};

export const LongLabels = {
  render: () => (
    <Selectable
      choices={[
        {
          label: 'nousresearch/hermes-4-405b-instruct-preview-extended-context',
          value: 'long-1',
          note: '(default)',
        },
        { label: 'qwen/qwen3-coder-480b-a35b-instruct', value: 'long-2' },
      ]}
      initial="long-1"
    />
  ),
};
