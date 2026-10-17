import { ExecutionPicker } from '../../../src/client/components/organisms/execution-picker.js';
import {
  bareConfiguration,
  storedConfiguration,
} from '../../support/fixtures.js';
import { footerFrame } from '../../support/frames.js';
import { SettingsHost, type StoryHost } from '../../support/host.js';
import { OpenOnMount, type OpenStep } from '../../support/open-on-mount.js';

/** The picker in the footer, over a story host that stores what it saves. */
function Picker({
  host,
  open = [],
}: {
  readonly host?: StoryHost;
  readonly open?: readonly OpenStep[];
}) {
  return (
    <SettingsHost host={host}>
      {() => (
        <OpenOnMount steps={open}>
          <ExecutionPicker />
        </OpenOnMount>
      )}
    </SettingsHost>
  );
}

export default {
  title: 'Settings/Organisms/Execution picker',
  component: ExecutionPicker,
  decorators: [footerFrame],
};

export const Default = {
  render: () => <Picker />,
};

export const ModelMenuOpen = {
  render: () => (
    <Picker open={[{ selector: '[aria-label="Execution model"]' }]} />
  ),
};

export const ReasoningMenuOpen = {
  render: () => (
    <Picker open={[{ selector: 'button[aria-label="Reasoning effort"]' }]} />
  ),
};

export const ModelWithoutReasoning = {
  render: () => (
    <Picker
      host={{
        config: storedConfiguration({
          ...storedConfiguration().configuration,
          models: {
            execution: {
              providerId: 'openrouter',
              model: 'meta-llama/llama-4-maverick',
            },
          },
        }),
      }}
    />
  ),
};

export const TypedModel = {
  render: () => (
    <Picker host={{ config: storedConfiguration(bareConfiguration) }} />
  ),
};

export const SaveRefused = {
  render: () => (
    <Picker
      host={{
        refuseSave: 'The Doric configuration could not be activated.',
      }}
      open={[
        { selector: '[aria-label="Execution model"]' },
        { selector: '[role="dialog"] button', text: 'deepseek/deepseek-v3.2' },
      ]}
    />
  ),
};
