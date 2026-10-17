import { useState } from 'react';

import { defineFilesElements } from '../src/client/elements.js';
import { filesKeys } from '../src/client/sandbox-store.js';
import { setFilesClient } from '../src/client/state.js';
import { ElementHost } from './support/element-host.js';
import { fixedSandboxStore, seedExpansion } from './support/files-client.js';
import {
  changeMarks,
  openDirectories,
  paymentForm,
  project,
  thread,
} from './support/fixtures.js';
import { still, storyServices } from './support/services.js';

/**
 * The three elements the files client defines, over one seeded activation:
 * its sandbox store (the tree read and the file tab's query client), the
 * layout's selection, panel and tabs, and git's changes read.
 */
const useElements = () =>
  useState(() => {
    const store = fixedSandboxStore({
      read: {
        status: 'ready',
        value: [
          {
            name: 'apps',
            path: 'apps',
            type: 'directory',
            children: [
              {
                name: 'web',
                path: 'apps/web',
                type: 'directory',
                children: [
                  {
                    name: 'src',
                    path: 'apps/web/src',
                    type: 'directory',
                    children: [
                      {
                        name: 'checkout',
                        path: 'apps/web/src/checkout',
                        type: 'directory',
                        children: [
                          {
                            name: 'payment-form.tsx',
                            path: paymentForm.path,
                            type: 'file',
                          },
                          {
                            name: 'shipping-step.tsx',
                            path: 'apps/web/src/checkout/shipping-step.tsx',
                            type: 'file',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { name: 'README.md', path: 'README.md', type: 'file' },
        ],
      },
      fetching: false,
    });
    store.client.setQueryData(filesKeys.file(project.id, paymentForm.path), {
      status: 'ready',
      file: paymentForm,
    });
    setFilesClient({
      store,
      coordinator: {
        register: () => ({ dispose: () => undefined }),
        request: () => undefined,
        setWorkspace: () => undefined,
        dispose: () => undefined,
      },
    });
    seedExpansion(project.id, '', openDirectories);
    const services = storyServices({
      apis: {
        'layout.workspace/v1': {
          ...still,
          selection: () => ({ project, thread }),
        },
        'layout.tabs/v1': {
          ...still,
          current: () => ({ id: `file:${paymentForm.path}` }),
        },
        'layout.panel/v1': {
          ...still,
          isOpen: () => false,
          active: () => 'files',
          show: () => undefined,
          toggle: () => undefined,
        },
        'commands/v1': { execute: async () => undefined },
        'git.changes/v1': {
          observe: (
            _scope: unknown,
            listener: (state: {
              readonly decorations: typeof changeMarks;
              readonly fetching: boolean;
            }) => void,
          ) => {
            listener({ decorations: changeMarks, fetching: false });
            return { dispose: () => undefined };
          },
        },
      },
      scoped: {
        'files/v1': () => ({
          content: async () => ({
            status: 'ready',
            value: { status: 'read', ...paymentForm },
          }),
        }),
      },
    });
    return { elements: defineFilesElements(store), services };
  })[0];

const fileTabProperties = {
  projectId: project.id,
  path: paymentForm.path,
};

const headerProperties = { placement: 'header' };

export default {
  title: 'Files/Elements/Files elements',
};

export const Tree = {
  render: function Tree() {
    const { elements, services } = useElements();
    return (
      <div
        className="flex flex-col overflow-hidden rounded-md border bg-sidebar text-sidebar-foreground"
        style={{ width: 320, height: 420 }}
      >
        <ElementHost
          tag="story-files-tree"
          element={elements.tree}
          services={services}
        />
      </div>
    );
  },
};

export const FileTab = {
  render: function FileTab() {
    const { elements, services } = useElements();
    return (
      <div
        className="flex flex-col overflow-hidden rounded-md border"
        style={{ height: 480 }}
      >
        <ElementHost
          tag="story-files-file-view"
          element={elements.fileView}
          services={services}
          properties={fileTabProperties}
        />
      </div>
    );
  },
};

export const HeaderToggle = {
  render: function HeaderToggle() {
    const { elements, services } = useElements();
    return (
      <div className="flex chrome-bar w-96 items-center justify-end rounded-md border">
        <ElementHost
          tag="story-files-toggle"
          element={elements.toggle}
          services={services}
          properties={headerProperties}
        />
      </div>
    );
  },
};
