// The files client's elements (stage 10, §3.6), built inside a factory the
// activation calls, so importing this module touches no DOM global [D10-7].
// Each renders in light DOM with `display: contents`; the file tab shares the
// files bundle's one query client.

import { QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { SidebarScope } from 'desktop/ui/sidebar';
import type { ReactNode } from 'react';

import { FileView } from './file/file-view.js';
import type { SandboxStore } from './sandbox-store.js';
import {
  FilesToggleView,
  type TogglePlacement,
} from './toggle/files-toggle.js';
import { FilesTreeView } from './tree/files-tree.js';

export const defineFilesElements = (store: SandboxStore) => {
  const withClient = () =>
    function FilesQueries({ children }: { readonly children?: ReactNode }) {
      return (
        <QueryClientProvider client={store.client}>
          {children}
        </QueryClientProvider>
      );
    };

  return {
    tree: defineReactElement<object>({
      props: [],
      render: ({ services }: { readonly services: Services }) => (
        // Its rows are sidebar rows inside the layout's panel (WP-10N).
        <SidebarScope>
          <FilesTreeView services={services} />
        </SidebarScope>
      ),
    }),
    toggle: defineReactElement<{ readonly placement?: TogglePlacement }>({
      props: ['placement'],
      render: ({ services, placement }) => (
        <FilesToggleView services={services} placement={placement} />
      ),
    }),
    fileView: defineReactElement<{
      readonly projectId?: string;
      readonly path?: string;
    }>({
      props: ['projectId', 'path'],
      wrap: withClient,
      render: ({ services, projectId, path }) => (
        <FileView services={services} projectId={projectId} path={path} />
      ),
    }),
  };
};
