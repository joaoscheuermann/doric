import { type ComponentType, useState } from 'react';

import { ProjectTabBar } from '../../../src/client/components/organisms/project-tabs.js';
import {
  closeProjectTabs,
  type ProjectTabs,
  rememberPath,
} from '../../../src/client/domain/project-tabs.js';
import type { Project } from '../../../src/client/domain/workspace.js';
import {
  billing,
  checkout,
  docs,
  planThread,
  projects,
  research,
  threadRoute,
} from '../../support/data.js';
import { Placeholder } from '../../support/placeholder.js';
import { projectTabsOf } from '../../support/workspace.js';

/** The strip with its own route and tabs, so tabs open, close and move. */
function Strip({
  actions,
  initialPath,
  open,
  trailing,
}: {
  readonly actions?: boolean;
  readonly initialPath: string;
  readonly open: readonly Project[];
  readonly trailing?: boolean;
}) {
  const [path, setPath] = useState(initialPath);
  const [state, setState] = useState<ProjectTabs>(() => projectTabsOf(open));
  const navigate = (next: string) => {
    setPath(next);
    setState((current) => rememberPath(current, next));
  };
  return (
    <ProjectTabBar
      actions={actions ? <Placeholder tag="terminal-new-button" /> : undefined}
      trailing={trailing}
      state={state}
      path={path}
      projects={projects}
      navigate={navigate}
      close={(id) => setState((current) => closeProjectTabs(current, [id]))}
      closeMany={(ids) => setState((current) => closeProjectTabs(current, ids))}
      move={(from, to) =>
        setState((current) => {
          const order = [...current.order];
          order.splice(order.indexOf(from), 1);
          order.splice(order.indexOf(to), 0, from);
          return { ...current, order };
        })
      }
      onNewProject={() => navigate('/')}
      rename={(project, name) => {
        console.info('Story action: rename', project.id, name);
        return Promise.resolve();
      }}
    />
  );
}

export default {
  title: 'Layout/Organisms/Project tabs',
  component: ProjectTabBar,
  decorators: [
    (Story: ComponentType) => (
      <div className="w-[1280px] max-w-full">
        <Story />
      </div>
    ),
  ],
};

/** Three Projects open, the Checkout Thread's tab active. */
export const ProjectActive = {
  render: () => (
    <Strip
      initialPath={threadRoute(planThread)}
      open={[checkout, docs, billing]}
    />
  ),
};

/** The Dashboard tab active, as the window opens. */
export const DashboardActive = {
  render: () => (
    <Strip initialPath="/projects" open={[checkout, docs, billing]} trailing />
  ),
};

/** No Project tab open yet. */
export const NoTabs = {
  render: () => <Strip initialPath="/projects" open={[]} trailing />,
};

/** Every Project open, long names included: the strip scrolls. */
export const ManyTabs = {
  render: () => (
    <Strip initialPath={`/projects/${research.id}`} open={projects} />
  ),
};

/** With actions at the trailing end of the strip. */
export const WithActions = {
  render: () => (
    <Strip
      actions
      initialPath={`/projects/${docs.id}`}
      open={[checkout, docs]}
    />
  ),
};
