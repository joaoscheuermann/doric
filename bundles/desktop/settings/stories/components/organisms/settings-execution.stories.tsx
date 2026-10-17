import { useState } from 'react';

import { SettingsExecution } from '../../../src/client/components/organisms/settings-execution.js';
import type { Configuration } from '../../../src/client/domain/config.js';
import { bareConfiguration, configuration } from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';
import { OpenOnMount, type OpenStep } from '../../support/open-on-mount.js';

/** The section over its own draft, so every choice shows. */
function Section({
  initial = configuration,
  open = [],
}: {
  readonly initial?: Configuration;
  readonly open?: readonly OpenStep[];
}) {
  const [draft, setDraft] = useState(initial);

  return (
    <OpenOnMount steps={open}>
      <SettingsExecution draft={draft} onChange={setDraft} />
    </OpenOnMount>
  );
}

export default {
  title: 'Settings/Organisms/Settings execution',
  component: SettingsExecution,
  decorators: [sectionFrame],
};

export const Default = {
  render: () => <Section />,
};

export const ProviderMenuOpen = {
  render: () => (
    <Section
      open={[
        {
          selector: '[aria-label="Execution provider"]',
        },
      ]}
    />
  ),
};

export const ModelMenuOpen = {
  render: () => (
    <Section open={[{ selector: '[aria-label="Execution model"]' }]} />
  ),
};

export const ModelWithoutReasoning = {
  render: () => (
    <Section
      initial={{
        ...configuration,
        models: {
          execution: {
            providerId: 'openrouter',
            model: 'meta-llama/llama-4-maverick',
          },
        },
        execution: { maxTurns: 64 },
      }}
    />
  ),
};

export const TypedModel = {
  render: () => <Section initial={bareConfiguration} />,
};

export const InvalidTurnLimit = {
  render: () => (
    <Section
      initial={{
        ...configuration,
        execution: { maxTurns: Number.NaN },
      }}
    />
  ),
};
