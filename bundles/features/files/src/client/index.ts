// The files bundle's client part (stage 10, §3.6): `files.sandbox/v1`,
// `files.refresh/v1`, the `files.open-file/v1` command and the three
// elements — the Files panel view, the panel toggle and the file tab. All of
// it is bound to the activation services, never to an element's (D9-17).
//
// The panel region item (`filesRegions`) is registered by the activation.
// Its selector is rendered in the workspace tab bar; no hide toggle is added.

import {
  type Cleanup,
  type ClientContext,
  CommandsV1,
  type Disposable,
  HooksV1,
  type RegionItem,
  type Regions,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import { LayoutWorkspaceV1 } from 'layout/contracts';

import { ChatHooksV1 } from './api/peers.js';
import { filesReadsOf } from './api/reads.js';
import { FILE_VIEW_TAG, openFileCommand } from './commands.js';
import { defineFilesElements } from './elements.js';
import {
  createFilesRefresh,
  createRefreshCoordinator,
  type RefreshEnvironment,
} from './refresh/coordinator.js';
import { createFilesSandbox, createSandboxStore } from './sandbox-store.js';
import { setFilesClient } from './state.js';
import { resetExpansion } from './stores/expansion.js';

/** The window's focus, visibility and timers. */
const windowEnvironment = (): RefreshEnvironment => ({
  visible: () => document.visibilityState === 'visible',
  onFocus: (listener) => {
    window.addEventListener('focus', listener);
    document.addEventListener('visibilitychange', listener);
    return () => {
      window.removeEventListener('focus', listener);
      document.removeEventListener('visibilitychange', listener);
    };
  },
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
});

/** The Files view is selected from the workspace's compact top tabs. */
export const filesRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'layout.panel',
    item: {
      id: 'files',
      tag: 'files-tree',
      order: 100,
      props: { label: 'Files', icon: 'files' },
    },
  },
];

/** Adds the Files view to the layout's regions. */
export const registerFilesRegions = (
  regions: Pick<Regions, 'add'>,
): Disposable => {
  const added = filesRegions.map(({ region, item }) =>
    regions.add(region, item),
  );
  return {
    dispose: () => {
      for (const item of added.reverse()) item.dispose();
    },
  };
};

export function activate({ services }: ClientContext): Cleanup {
  const store = createSandboxStore(() => filesReadsOf(services));
  const coordinator = createRefreshCoordinator(windowEnvironment());
  setFilesClient({ store, coordinator });
  services.provide(createFilesSandbox(store));
  services.provide(createFilesRefresh(coordinator));

  const ui = services.use(UiV1);
  const elements = defineFilesElements(store);
  const defined = [
    ui.define('files-tree', elements.tree),
    ui.define('files-toggle', elements.toggle),
    ui.define(FILE_VIEW_TAG, elements.fileView),
  ];
  const command = services.use(CommandsV1).register(openFileCommand);
  const regions = registerFilesRegions(services.use(RegionsV1));

  // The coordinator's workspace triggers, while the layout serves them.
  const workspace = services.whenAvailable(LayoutWorkspaceV1, (api) => {
    coordinator.setWorkspace(api);
    return () => coordinator.setWorkspace(undefined);
  });
  // D9-10: a sandbox-writing tool in any held conversation refreshes its Project.
  const activity = services.use(HooksV1).whenAvailable(ChatHooksV1, (chat) => {
    chat.onSandboxActivityHook(({ projectId }) => {
      coordinator.request(projectId);
    });
  });

  return () => {
    activity.dispose();
    workspace.dispose();
    regions.dispose();
    command.dispose();
    for (const element of defined.reverse()) element.dispose();
    coordinator.dispose();
    store.dispose();
    resetExpansion();
    setFilesClient(undefined);
  };
}
