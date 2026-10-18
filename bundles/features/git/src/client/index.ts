// The git bundle's client part (stage 10, §3.8): `git.changes/v1`, the
// `git.open-comparison/v1` command and the five elements — the Changes panel
// view and its trigger badge, the comparison tab, the footer's working
// directory and branch, and the Versioning settings section. All of it is
// bound to the activation services, never to an element's (D9-17).
//
// The region items and the `/settings/git` route (`registerGitSurfaces`) are
// registered by the activation since WP-10N removed the layout's provisional
// Changes view and working directory and the settings bundle's own
// Versioning section.

import {
  type Cleanup,
  type ClientContext,
  CommandsV1,
  type Disposable,
  type Navigation,
  NavigationV1,
  type RegionItem,
  type Regions,
  RegionsV1,
  type Ui,
  UiV1,
} from 'bundle/contracts';

import { gitApiOf } from './api/git-api.js';
import { type FilesRefresh, FilesRefreshV1 } from './api/peers.js';
import { createGitChanges, createGitStore } from './changes/store.js';
import { FILE_DIFF_TAG, openComparisonCommand } from './commands.js';
import { defineGitElements } from './elements.js';
import { setGitClient } from './state.js';

/** The tag of the Versioning section's element. */
export const VERSIONING_TAG = 'git-settings-versioning';

/** The route of the Versioning section, a child of the settings window's. */
export const VERSIONING_PATH = '/settings/git';

/** The region items of the Changes view, the footer and the Versioning link. */
export const gitRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'layout.panel',
    item: {
      id: 'changes',
      tag: 'git-changes',
      order: 200,
      props: {
        label: 'Changes',
        icon: 'file-diff',
        badgeTag: 'git-changes-badge',
      },
    },
  },
  {
    region: 'layout.footer',
    item: { id: 'git-cwd', tag: 'git-workspace-cwd', order: 10 },
  },
  {
    region: 'settings.sections',
    item: {
      id: 'versioning',
      tag: 'settings-link',
      order: 40,
      props: {
        label: 'Versioning',
        path: VERSIONING_PATH,
        icon: 'git-branch',
        description:
          'Which stored credentials the agent commits and pushes with inside a Project.',
      },
    },
  },
];

/** Adds the git surfaces to the layout's and the settings window's regions (WP-10N). */
export const registerGitSurfaces = (
  regions: Pick<Regions, 'add'>,
  navigation: Pick<Navigation, 'register'>,
  ui: Pick<Ui, 'create'>,
): Disposable => {
  const added = [
    ...gitRegions.map(({ region, item }) => regions.add(region, item)),
    navigation.register({
      path: VERSIONING_PATH,
      parent: '/settings',
      create: () => ui.create(VERSIONING_TAG),
    }),
  ];
  return {
    dispose: () => {
      for (const item of added.reverse()) item.dispose();
    },
  };
};

export function activate({ services }: ClientContext): Cleanup {
  const store = createGitStore(() => gitApiOf(services));
  let refresh: FilesRefresh | undefined;
  const coordinator = services.whenAvailable(FilesRefreshV1, (api) => {
    refresh = api;
    return () => {
      refresh = undefined;
    };
  });
  setGitClient({ store, refresh: () => refresh });
  services.provide(createGitChanges(store));

  const ui = services.use(UiV1);
  const elements = defineGitElements(store);
  const defined = [
    ui.define('git-changes', elements.changes),
    ui.define('git-changes-badge', elements.badge),
    ui.define(FILE_DIFF_TAG, elements.fileDiff),
    ui.define('git-workspace-cwd', elements.cwd),
    ui.define(VERSIONING_TAG, elements.versioning),
  ];
  const command = services.use(CommandsV1).register(openComparisonCommand);
  const surfaces = registerGitSurfaces(
    services.use(RegionsV1),
    services.use(NavigationV1),
    ui,
  );

  return () => {
    surfaces.dispose();
    command.dispose();
    for (const element of defined.reverse()) element.dispose();
    coordinator.dispose();
    store.dispose();
    setGitClient(undefined);
  };
}
