import { QueryClientProvider } from '@tanstack/react-query';
import { errorFrom } from 'desktop/reads';
import { Sidebar, SidebarScope } from 'desktop/ui/sidebar';
import { useEffect, useState } from 'react';

import {
  beginCreation,
  DashboardContent,
  DashboardNavigation,
} from '../../../src/client/components/organisms/dashboard.js';
import { DashboardSidebarFooter } from '../../../src/client/components/organisms/dashboard-sidebar.js';
import { ProjectTabBar } from '../../../src/client/components/organisms/project-tabs.js';
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
import { Placeholder } from '../../support/placeholder.js';
import { windowDecorator } from '../../support/window-frame.js';
import {
  projectTabsOf,
  workspaceActions,
  workspaceOf,
} from '../../support/workspace.js';
import {
  type WorkspaceFixture,
  WorkspaceHost,
} from '../../support/workspace-host.js';

const navigate = (path: string) => console.info('Story navigate', path);

/** The footer entry `settings` adds to `workspace.dashboard.footer`. */
const footer = {
  'workspace.dashboard.footer': [
    {
      id: 'settings',
      tag: 'settings-entry-icon',
      props: {
        label: 'All settings',
        command: 'core.open-settings/v1',
        input: { defaultPath: '/settings' },
      },
    },
  ],
};

const loaded: WorkspaceFixture = { projects, threads, regions: footer };

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

const many: WorkspaceFixture = {
  projects: manyProjects,
  threads: [],
  regions: footer,
};
const none: WorkspaceFixture = { projects: [], threads: [], regions: footer };
const failing: WorkspaceFixture = {
  projects,
  threads,
  failing: ['activity'],
  regions: footer,
};

/** Opens the create form once, as ⌘N or the "+" tab does. */
function OpenCreateForm() {
  useEffect(beginCreation, []);
  return null;
}

/**
 * The dashboard over the fake host, which answers the activity read, laid out
 * as the window's page form draws its two parts: the sidebar part in the
 * sidebar column, the content part under the tab bar.
 */
function Board({
  all = true,
  creating = false,
  fixture = loaded,
  workspace = workspaceOf(),
}: {
  readonly all?: boolean;
  readonly creating?: boolean;
  readonly fixture?: WorkspaceFixture;
  readonly workspace?: Workspace;
}) {
  const [client] = useState(createQueryClient);
  return (
    <WorkspaceHost fixture={fixture}>
      <QueryClientProvider client={client}>
        {creating && <OpenCreateForm />}
        <div className="flex min-h-0 flex-1 bg-sidebar">
          <aside className="flex shrink-0" aria-label="Dashboard navigation">
            <SidebarScope>
              <Sidebar
                collapsible="none"
                className="h-full w-[280px] shrink-0 font-normal"
              >
                <DashboardNavigation
                  workspace={workspace}
                  all={all}
                  navigate={navigate}
                />
                <DashboardSidebarFooter />
              </Sidebar>
            </SidebarScope>
          </aside>
          <div
            data-slot="dashboard-content"
            className="flex min-w-0 flex-1 flex-col bg-sidebar"
          >
            <ProjectTabBar
              actions={<Placeholder tag="account-status" />}
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
            <DashboardContent
              workspace={workspace}
              all={all}
              navigate={navigate}
            />
          </div>
        </div>
      </QueryClientProvider>
    </WorkspaceHost>
  );
}

export default {
  title: 'Workspace/Organisms/Dashboard',
  component: DashboardContent,
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
  render: () => <Board all={false} creating />,
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
      workspace={workspaceOf({
        error: {
          error: errorFrom('internal', 'The request could not be completed.'),
        },
      })}
    />
  ),
};
