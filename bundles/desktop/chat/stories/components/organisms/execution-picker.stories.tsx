import type { ThreadExecutionResult } from 'runtime/contracts';
import type { ExecutionView } from 'settings/contracts';

import { ExecutionPicker } from '../../../src/client/components/organisms/execution-picker.js';
import {
  failedView,
  readyView,
  storySources,
  typedView,
  withoutReasoning,
} from '../../support/execution.js';
import { footerFrame } from '../../support/frames.js';
import { OpenOnMount, type OpenStep } from '../../support/open-on-mount.js';

/** The picker in the footer, over a literal view and a selected Thread. */
function Picker({
  view = readyView,
  answer,
  open = [],
}: {
  readonly view?: ExecutionView;
  readonly answer?: ThreadExecutionResult;
  readonly open?: readonly OpenStep[];
}) {
  return (
    <OpenOnMount steps={open}>
      <ExecutionPicker sources={storySources(view, answer)} />
    </OpenOnMount>
  );
}

export default {
  title: 'Chat/Organisms/Execution picker',
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
  render: () => <Picker view={withoutReasoning} />,
};

export const TypedModel = {
  render: () => <Picker view={typedView} />,
};

export const WriteRefused = {
  render: () => (
    <Picker
      answer={{ status: 'invalid', reason: 'effort' }}
      open={[
        { selector: '[aria-label="Execution model"]' },
        { selector: '[role="dialog"] button', text: 'deepseek/deepseek-v3.2' },
      ]}
    />
  ),
};

export const ReadFailed = {
  render: () => <Picker view={failedView} />,
};

/**
 * A model the view carries no icon for: its row keeps an empty slot, so the
 * labels stay aligned, and the trigger wears none.
 */
export const RowWithoutIcon = {
  render: () => (
    <Picker
      view={withoutReasoning}
      open={[{ selector: '[aria-label="Execution model"]' }]}
    />
  ),
};
