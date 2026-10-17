import { TreeSkeleton } from 'desktop/ui/panels';

import { PanelFrame } from '../support/sidebar-frame.js';

export default {
  title: 'desktop/ui/Panels/Tree skeleton',
  component: TreeSkeleton,
};

export const Default = {
  render: () => (
    <PanelFrame>
      <TreeSkeleton label="Loading files" />
    </PanelFrame>
  ),
};

export const WithRoot = {
  render: () => (
    <PanelFrame>
      <TreeSkeleton root label="Loading changes" />
    </PanelFrame>
  ),
};
