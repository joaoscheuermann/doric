import { useState } from 'react';

import { ProviderModelsEditor } from '../../../src/client/components/molecules/provider-models-editor.js';
import type {
  ProviderDraft,
  ProviderKind,
} from '../../../src/client/domain/config.js';
import { configuration, openAiKind } from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';

/** OpenAI as a kind that keeps a model list but no efforts per model. */
const namesOnlyKind: ProviderKind = {
  ...openAiKind,
  id: 'openai-compatible',
  label: 'OpenAI compatible',
  lists: ['models'],
};

const openAi = configuration.providers[1];

/** The editor over its own draft, so every edit shows. */
function Editor({
  initial,
  kind = openAiKind,
}: {
  readonly initial: ProviderDraft;
  readonly kind?: ProviderKind;
}) {
  const [draft, setDraft] = useState(initial);

  return <ProviderModelsEditor draft={draft} kind={kind} onChange={setDraft} />;
}

export default {
  title: 'Settings/Molecules/Provider models editor',
  component: ProviderModelsEditor,
  decorators: [sectionFrame],
};

export const WithReasoning = {
  render: () =>
    openAi === undefined ? null : <Editor initial={{ ...openAi, index: 1 }} />,
};

export const NamesOnly = {
  render: () => (
    <Editor
      kind={namesOnlyKind}
      initial={{
        id: 'vllm',
        kind: namesOnlyKind.id,
        configuration: { endpoint: 'http://localhost:8000/v1' },
        models: [{ name: 'qwen3-coder:30b' }, { name: 'gpt-oss-120b' }],
      }}
    />
  ),
};

export const Empty = {
  render: () => (
    <Editor
      initial={{ id: 'openai', kind: 'openai', configuration: {}, models: [] }}
    />
  ),
};

export const UnnamedModel = {
  render: () => (
    <Editor
      initial={{
        id: 'openai',
        kind: 'openai',
        configuration: {},
        models: [
          { name: 'gpt-5', reasonings: ['low', 'medium', 'high'] },
          { name: '', reasonings: [] },
        ],
      }}
    />
  ),
};
