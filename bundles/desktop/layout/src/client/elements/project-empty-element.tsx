// The elements of the Project routes, children of `/` (bundle isolation
// 4(a), change 7): `layout-project-empty` draws the empty state of
// `/projects/:projectId` in the frame's outlet, and `layout-projects-route`,
// the element of `/projects`, draws nothing because the page form covers it.

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from 'desktop/ui/empty';
import { defineReactElement } from 'desktop/ui/react-element';

import { useWorkspace } from '../hooks/use-workspace.js';
import { LayoutProviders } from './navigation-elements.js';

/**
 * The Project's name, the hint and "New thread"; for a Project the mirror
 * does not hold, "No project selected" and no button.
 */
function ProjectEmpty({ projectId }: { readonly projectId?: string }) {
  const workspace = useWorkspace();
  const project = workspace.projects.find(({ id }) => id === projectId);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{project?.name ?? 'No project selected'}</EmptyTitle>
        <EmptyDescription>
          Start a thread or select one from the sidebar.
        </EmptyDescription>
      </EmptyHeader>
      {project && (
        <button
          type="button"
          className="dashboard-new"
          onClick={() => workspace.actions.beginThread(project.id)}
        >
          New thread
        </button>
      )}
    </Empty>
  );
}

export const LayoutProjectEmptyElement = defineReactElement<{
  readonly projectId?: string;
}>({
  props: ['projectId'],
  wrap: () => LayoutProviders,
  render: ({ projectId }) => <ProjectEmpty projectId={projectId} />,
});

export const LayoutProjectsRouteElement = defineReactElement({
  props: [],
  render: () => null,
});
