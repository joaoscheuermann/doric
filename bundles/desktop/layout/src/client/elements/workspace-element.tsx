// `<layout-workspace>`: the `/` route's element (stage 9 §5.4).

import { defineReactElement } from 'desktop/ui/react-element';

import { WorkspaceView } from '../views/workspace-view.js';

export const LayoutWorkspaceElement = defineReactElement({
  props: [],
  render: () => <WorkspaceView />,
});
