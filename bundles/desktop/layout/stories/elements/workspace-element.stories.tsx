import { useEffect, useRef } from 'react';

import { LayoutWorkspaceElement } from '../../src/client/elements/workspace-element.js';
import {
  billing,
  checkout,
  checkoutTabs,
  docs,
  planThread,
  projects,
  threadRoute,
  threads,
} from '../support/data.js';
import { bindLayout, type LayoutFixture } from '../support/layout-host.js';
import { windowDecorator } from '../support/window-frame.js';

const tag = 'layout-workspace';

/**
 * `<layout-workspace>` as the `/` route creates it: the element, given the
 * layout's services, renders the workspace view in its own React root. The
 * element's root outlives this story's commit, so the layout is unbound only
 * after the element is disposed, as the platform disposes a route's element
 * before it deactivates the bundle.
 */
function WorkspaceElement({ fixture }: { readonly fixture: LayoutFixture }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const bound = bindLayout(fixture);
    if (customElements.get(tag) === undefined)
      customElements.define(tag, LayoutWorkspaceElement);
    const element = document.createElement(tag) as InstanceType<
      typeof LayoutWorkspaceElement
    >;
    element.services = bound.services;
    frame.replaceChildren(element);
    return () => {
      frame.replaceChildren();
      queueMicrotask(() => {
        element.dispose();
        bound.unbind();
      });
    };
  }, [fixture]);

  return <div ref={host} className="flex min-h-0 flex-1 flex-col" />;
}

const workspace: LayoutFixture = {
  projects,
  threads,
  path: threadRoute(planThread),
  projectTabs: [checkout, docs, billing],
  tabs: checkoutTabs,
};

const dashboard: LayoutFixture = { ...workspace, path: '/projects' };

export default {
  title: 'Layout/Elements/Workspace element',
  component: LayoutWorkspaceElement,
  decorators: [windowDecorator],
};

export const Thread = {
  render: () => <WorkspaceElement fixture={workspace} />,
};

export const Dashboard = {
  render: () => <WorkspaceElement fixture={dashboard} />,
};
