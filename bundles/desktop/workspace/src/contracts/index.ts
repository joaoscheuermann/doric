// The workspace's contracts and slots (bundle isolation 4(c), spec §6, §8).

import {
  type CallArg,
  type Disposable,
  defineHook,
  defineHooks,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import type { WorkspaceDashboard, WorkspaceSidebar } from './navigation.js';

/** The dashboard sidebar's groups, after Projects; items are elements that draw their own `SidebarGroup`. */
export const WORKSPACE_DASHBOARD_NAV = 'workspace.dashboard.nav';
/** Pages the dashboard draws instead of its Project list; one shows at a time (`workspace.dashboard/v1`). */
export const WORKSPACE_DASHBOARD_PAGE = 'workspace.dashboard.page';
/** The dashboard sidebar's footer entries: data items with `DashboardFooterItemProps`; `tag` is the filler's 16 px icon element. */
export const WORKSPACE_DASHBOARD_FOOTER = 'workspace.dashboard.footer';

/** The `props` of a `workspace.dashboard.footer` item (D9). */
export interface DashboardFooterItemProps {
  readonly label: string;
  /** The command `workspace` executes through `commands/v1` when the reader picks the entry. */
  readonly command: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceSelection {
  readonly projectId?: string;
  readonly threadId?: string;
}

/** `workspace.selection/v1` (client, local): the validated selection, as ids. */
export interface WorkspaceSelectionService {
  /** The same object until the selection changes. */
  current(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const workspaceSelectionMethods = {
  current: {
    input: noInput,
    output: z.custom<WorkspaceSelection>(
      (value) => typeof value === 'object' && value !== null,
      { message: 'Expected a selection.' },
    ),
  },
  subscribe: {
    input: functionSchema<() => void>(),
    output: disposableSchema,
  },
} as const;

export const WorkspaceSelectionV1 = ref<WorkspaceSelectionService>(
  'workspace.selection/v1',
);

/** `workspace.hooks/v1`. */
export const WorkspaceHooksV1 = defineHooks('workspace.hooks/v1', {
  /** The reader asked to open a Thread beside the conversation. */
  onOpenThreadHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string(), threadId: z.string() }).strict(),
  }),
});

export {
  type ThreadRows,
  type WorkspaceDashboard,
  type WorkspaceSidebar,
  workspaceDashboardMethods,
  workspaceSidebarMethods,
} from './navigation.js';

export const WorkspaceSidebarV1 = ref<WorkspaceSidebar>('workspace.sidebar/v1');
export const WorkspaceDashboardV1 = ref<WorkspaceDashboard>(
  'workspace.dashboard/v1',
);

export * from './transition.js';
