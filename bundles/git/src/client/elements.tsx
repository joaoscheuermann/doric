// The git client's elements (stage 10, §3.8), built inside a factory the
// activation calls, so importing this module touches no DOM global [D10-7].
// Each renders in light DOM with `display: contents` over the git bundle's
// one query client and its own tooltip provider; none mounts a toaster,
// since the window's single toaster belongs to the layout.

import { QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop-ui/react-element';
import { SidebarScope } from 'desktop-ui/sidebar';
import { TooltipProvider } from 'desktop-ui/tooltip';
import { type ReactNode, StrictMode } from 'react';

import { ChangesBadge } from './changes/changes-badge.js';
import { GitChangesView } from './changes/git-changes.js';
import type { GitStore } from './changes/store.js';
import { WorkspaceCwdView } from './cwd/workspace-cwd-view.js';
import { FileDiffView } from './diff/file-diff.js';
import { VersioningView } from './settings/versioning.js';

export const defineGitElements = (store: GitStore) => {
  const wrap = () =>
    function GitRoot({ children }: { readonly children?: ReactNode }) {
      return (
        <StrictMode>
          <QueryClientProvider client={store.client}>
            <TooltipProvider>
              <SidebarScope>{children}</SidebarScope>
            </TooltipProvider>
          </QueryClientProvider>
        </StrictMode>
      );
    };

  return {
    changes: defineReactElement<object>({
      props: [],
      wrap,
      render: ({ services }: { readonly services: Services }) => (
        <GitChangesView services={services} />
      ),
    }),
    badge: defineReactElement<object>({
      props: [],
      wrap,
      render: ({ services }: { readonly services: Services }) => (
        <ChangesBadge services={services} />
      ),
    }),
    fileDiff: defineReactElement<{
      readonly projectId?: string;
      readonly repository?: string;
      readonly path?: string;
    }>({
      props: ['projectId', 'repository', 'path'],
      wrap,
      render: ({ services, projectId, repository, path }) => (
        <FileDiffView
          services={services}
          projectId={projectId}
          repository={repository}
          path={path}
        />
      ),
    }),
    cwd: defineReactElement<object>({
      props: [],
      wrap,
      render: ({ services }: { readonly services: Services }) => (
        <WorkspaceCwdView services={services} />
      ),
    }),
    versioning: defineReactElement<object>({
      props: [],
      wrap,
      render: ({ services }: { readonly services: Services }) => (
        <VersioningView services={services} />
      ),
    }),
  };
};
