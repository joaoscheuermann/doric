import { SidebarScope } from 'desktop/ui/sidebar';
import { type CSSProperties, useState } from 'react';

import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '../../../src/client/components/organisms/project-sidebar.js';
import type { Draft, Entity } from '../../../src/client/domain/workspace.js';
import {
  checkout,
  empty,
  formThread,
  manyThreads,
  planThread,
  validationThread,
} from '../../support/data.js';
import { screenPane } from '../../support/fake-host.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';
import { sidebarActions, sidebarModelOf } from '../../support/workspace.js';

const fill = { '--sidebar-width': '100%' } as CSSProperties;

/**
 * The sidebar at the width the workspace opens it, keeping its own
 * selection, draft and rename so the tree can be clicked through.
 */
function Sidebar({
  fixture,
  model = sidebarModelOf(),
}: {
  readonly fixture?: LayoutFixture;
  readonly model?: SidebarModel;
}) {
  const [selectedThreadId, setSelected] = useState(model.selectedThreadId);
  const [draft, setDraft] = useState<Draft | undefined>(model.draft);
  const [editing, setEditing] = useState<Entity | undefined>(model.editing);
  const actions: SidebarActions = {
    ...sidebarActions,
    beginThread: (projectId, parentThreadId) =>
      setDraft({ kind: 'thread', projectId, parentThreadId }),
    cancelDraft: () => setDraft(undefined),
    cancelRename: () => setEditing(undefined),
    createThread: (name) => {
      console.info('Story action: createThread', name);
      setDraft(undefined);
      return Promise.resolve();
    },
    rename: (entity, name) => {
      console.info('Story action: rename', entity.value.id, name);
      setEditing(undefined);
      return Promise.resolve();
    },
    selectThread: (thread) => {
      setDraft(undefined);
      setSelected(thread.id);
    },
    startRename: setEditing,
  };

  return (
    <LayoutHost fixture={fixture}>
      <SidebarScope>
        <div className="flex h-[640px] w-60 border" style={fill}>
          <ProjectSidebar
            actions={actions}
            model={{ ...model, draft, editing, selectedThreadId }}
          />
        </div>
      </SidebarScope>
    </LayoutHost>
  );
}

const screensOpen: LayoutFixture = {
  panes: [{ ...screenPane, initiallyOpen: true }],
};
const terminals: LayoutFixture = {
  terminalRows: { [planThread.id]: 1, [formThread.id]: 2 },
};

export default {
  title: 'Layout/Organisms/Project sidebar',
  component: ProjectSidebar,
};

/** The Checkout Project's tree, with the collapsed Screens group below. */
export const Threads = {
  render: () => <Sidebar />,
};

export const ChildSelected = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({ selectedThreadId: validationThread.id })}
    />
  ),
};

/** The Screens group expanded, its header action beside the title. */
export const ScreensOpen = {
  render: () => <Sidebar fixture={screensOpen} />,
};

/** The terminal bundle's rows under two Threads. */
export const WithTerminalRows = {
  render: () => <Sidebar fixture={terminals} />,
};

/** The Project's Threads are still loading. */
export const LoadingThreads = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({
        loadingProjectThreads: new Set([checkout.id]),
        selectedThreadId: undefined,
        threadsByProject: {},
      })}
    />
  ),
};

/** A failed request, reported above the tree. */
export const RequestFailed = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({ error: 'The request could not be completed.' })}
    />
  ),
};

/** A new root Thread being named at the end of the tree. */
export const DraftThread = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({
        draft: { kind: 'thread', projectId: checkout.id },
      })}
    />
  ),
};

export const Renaming = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({
        editing: { kind: 'thread', value: formThread },
      })}
    />
  ),
};

/** A Project with no Threads yet. */
export const EmptyProject = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({
        projects: [empty],
        selectedProjectId: empty.id,
        selectedThreadId: undefined,
        threadsByProject: { [empty.id]: [] },
      })}
    />
  ),
};

/** No Project selected: the "New thread" action is disabled. */
export const NoProject = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({
        selectedProjectId: undefined,
        selectedThreadId: undefined,
      })}
    />
  ),
};

export const ManyThreads = {
  render: () => (
    <Sidebar
      model={sidebarModelOf({
        selectedThreadId: manyThreads[3]?.id,
        threadsByProject: { [checkout.id]: manyThreads },
      })}
    />
  ),
};
