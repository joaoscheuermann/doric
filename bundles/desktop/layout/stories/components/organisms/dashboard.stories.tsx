import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { AccountStatus } from '../../../src/client/components/organisms/account-status.js';
import { Dashboard } from '../../../src/client/components/organisms/dashboard.js';
import { ProjectTabBar } from '../../../src/client/components/organisms/project-tabs.js';
import { SidebarHeader } from '../../../src/client/components/organisms/sidebar-header.js';
import type { Project } from '../../../src/client/domain/workspace.js';
import type { Workspace } from '../../../src/client/hooks/use-workspace.js';
import { createQueryClient } from '../../../src/client/queries/client.js';
import {
  billing,
  checkout,
  docs,
  minutesAgo,
  projects,
  threads,
} from '../../support/data.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';
import { windowDecorator } from '../../support/window-frame.js';
import {
  projectTabsOf,
  workspaceActions,
  workspaceOf,
} from '../../support/workspace.js';

const navigate = (path: string) => console.info('Story navigate', path);

const loaded: LayoutFixture = { projects, threads };

const manyProjects: readonly Project[] = Array.from(
  { length: 16 },
  (_, index) => {
    const base = projects[index % projects.length] ?? checkout;
    return {
      ...base,
      id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}`,
      name: `${base.name} ${index + 1}`,
      updatedAt: minutesAgo(index * 90),
    };
  },
);

const many: LayoutFixture = { projects: manyProjects, threads: [] };
const none: LayoutFixture = { projects: [], threads: [] };
const failing: LayoutFixture = { projects, threads, failing: ['activity'] };

/** The dashboard over the fake host, which answers the activity read. */
function Board({
  all = true,
  createRequest,
  fixture = loaded,
  workspace = workspaceOf(),
}: {
  readonly all?: boolean;
  readonly createRequest?: number;
  readonly fixture?: LayoutFixture;
  readonly workspace?: Workspace;
}) {
  const [client] = useState(createQueryClient);
  return (
    <LayoutHost fixture={fixture}>
      <QueryClientProvider client={client}>
        <Frame>
          <Dashboard
            workspace={workspace}
            all={all}
            navigate={navigate}
            createRequest={createRequest}
            onOpenSettings={() => undefined}
            sidebarHeader={
              <SidebarHeader active onDashboard={() => navigate('/projects')} />
            }
            header={
              <ProjectTabBar
                actions={<AccountStatus onOpenSettings={() => undefined} />}
                state={projectTabsOf([checkout, docs, billing])}
                path={all ? '/projects' : '/'}
                projects={[checkout, docs, billing]}
                navigate={navigate}
                close={(id) => console.info('Story close tab', id)}
                closeMany={(ids) => console.info('Story close tabs', ids)}
                move={(from, to) => console.info('Story move tab', from, to)}
                onNewProject={workspaceActions.beginProject}
                onNewThread={(project) =>
                  workspaceActions.beginThread(project.id)
                }
                setColor={workspaceActions.setProjectColor}
                rename={async () => undefined}
              />
            }
          />
        </Frame>
      </QueryClientProvider>
    </LayoutHost>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

export default {
  title: 'Layout/Organisms/Dashboard',
  component: Dashboard,
  decorators: [windowDecorator],
};

/** "Browse all projects": the full list with its column headers. */
export const AllProjects = {
  render: () => <Board />,
};

/**
 * The new-tab page (`85:7726`): the Dashboard sidebar with no row selected,
 * then actions, search and the ten most recent Projects in the inset card.
 */
export const Recent = {
  render: () => <Board all={false} />,
};

/** The new-project form open, as ⌘N or the "+" tab opens it. */
export const Creating = {
  render: () => <Board all={false} createRequest={1} />,
};

/** More Projects than the recent list shows. */
export const ManyProjects = {
  render: () => (
    <Board
      all={false}
      fixture={many}
      workspace={workspaceOf({ projects: manyProjects })}
    />
  ),
};

export const ManyProjectsList = {
  render: () => (
    <Board fixture={many} workspace={workspaceOf({ projects: manyProjects })} />
  ),
};

export const Empty = {
  render: () => (
    <Board
      all={false}
      fixture={none}
      workspace={workspaceOf({ projects: [] })}
    />
  ),
};

export const Loading = {
  render: () => <Board workspace={workspaceOf({ loadingProjects: true })} />,
};

/** The activity read failed: the retry message. */
export const LoadFailed = {
  render: () => <Board fixture={failing} />,
};

/** A failed request reported under the list. */
export const WithError = {
  render: () => (
    <Board
      all={false}
      workspace={workspaceOf({ error: 'The request could not be completed.' })}
    />
  ),
};
