import { PanelState } from 'desktop/ui/panels';
import { GitCompareIcon, TerminalIcon } from 'lucide-react';

import { PanelFrame } from '../support/sidebar-frame.js';

export default {
  title: 'desktop/ui/Panels/Panel state',
  component: PanelState,
};

export const Default = {
  render: () => (
    <PanelFrame>
      <PanelState
        title="No Project open"
        description="Open a Project to browse its files."
      />
    </PanelFrame>
  ),
};

export const NoChanges = {
  render: () => (
    <PanelFrame>
      <PanelState
        icon={<GitCompareIcon />}
        title="No changes"
        description="The working tree matches the last commit on feat/app."
      />
    </PanelFrame>
  ),
};

export const NoTerminals = {
  render: () => (
    <PanelFrame>
      <PanelState
        icon={<TerminalIcon />}
        title="No terminals"
        description="Start a terminal to run commands in the Project's sandbox."
      />
    </PanelFrame>
  ),
};
