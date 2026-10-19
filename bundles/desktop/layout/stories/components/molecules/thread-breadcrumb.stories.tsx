import type { ComponentType } from 'react';

import { ThreadBreadcrumb } from '../../../src/client/components/molecules/thread-breadcrumb.js';
import {
  checkout,
  checkoutThreads,
  docs,
  formThread,
  planThread,
  research,
  researchThread,
  validationThread,
} from '../../support/data.js';
import { pathTo } from '../../support/workspace.js';

const ignore = () => undefined;

export default {
  title: 'Layout/Molecules/Thread breadcrumb',
  component: ThreadBreadcrumb,
  decorators: [
    (Story: ComponentType) => (
      <div className="flex h-10 max-w-3xl items-center bg-sidebar px-2">
        <Story />
      </div>
    ),
  ],
};

/** A child Thread: Project, its ancestor, then the Thread itself. */
export const ChildThread = {
  render: () => (
    <ThreadBreadcrumb
      project={checkout}
      path={pathTo(checkoutThreads, formThread)}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** A root Thread. */
export const RootThread = {
  render: () => (
    <ThreadBreadcrumb
      project={checkout}
      path={[planThread]}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** No Thread selected: the Project is the current crumb. */
export const ProjectOnly = {
  render: () => (
    <ThreadBreadcrumb
      project={docs}
      path={[]}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** Three levels deep. */
export const DeepPath = {
  render: () => (
    <ThreadBreadcrumb
      project={checkout}
      path={pathTo(checkoutThreads, validationThread)}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** An agent Thread: the bot mark, under the Thread that spawned it. */
export const AgentThread = {
  render: () => (
    <ThreadBreadcrumb
      project={checkout}
      path={pathTo(checkoutThreads, validationThread)}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};

/** Long names truncate inside each crumb. */
export const LongNames = {
  render: () => (
    <ThreadBreadcrumb
      project={research}
      path={[researchThread]}
      onSelectProject={ignore}
      onSelectThread={ignore}
    />
  ),
};
