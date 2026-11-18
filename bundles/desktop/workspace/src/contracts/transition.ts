// The three layout ids `workspace` provides during the transition, under
// their layout names (bundle isolation 4(c), spec §6): `layout.workspace/v1`
// as the layout declared it, and `layout.sidebar/v1` and `layout.dashboard/v1`
// over the workspace's own services. Deleted in step 4(e).

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import type { Project, Thread } from 'runtime/contracts';
import { z } from 'zod';

import {
  type WorkspaceDashboard,
  type WorkspaceSidebar,
  workspaceDashboardMethods,
  workspaceSidebarMethods,
} from './navigation.js';

/** A read-only view of the sidebar tree for other client bundles. */
export interface LayoutWorkspace {
  /** The tree's record of a Thread of any loaded Project. */
  thread(threadId: string, call?: CallArg): Thread | undefined;
  /** The selected Thread, once the tree describes it. */
  selectedThread(call?: CallArg): Thread | undefined;
  /**
   * 1.1.0: the validated selection the workspace shows. A Project-only
   * selection has no `thread`; a Thread the tree does not describe yet is
   * absent too.
   */
  selection(call?: CallArg): LegacyWorkspaceSelection;
  /** 1.1.0: the loaded Threads of a Project (empty until described). */
  threads(projectId: string, call?: CallArg): readonly Thread[];
  /** 1.1.0: whether the window is connected to the host (the sidebar footer). */
  connected(call?: CallArg): boolean;
  /**
   * 1.1.0: shows (`true`) or hides the `shell.conversation.bottom` split for one
   * item. The split is shown while any item asked for it; its items mount
   * only while it is shown.
   */
  setBottomVisible(itemId: string, visible: boolean, call?: CallArg): void;
  /** Called after every change of the tree, the selection or the connection. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export interface LegacyWorkspaceSelection {
  readonly project?: Project;
  readonly thread?: Thread;
}

const threadRecordSchema = z.custom<Thread | undefined>(
  (value) =>
    value === undefined || (typeof value === 'object' && value !== null),
  { message: 'Expected a Thread record or undefined.' },
);

const selectionSchema = z.custom<LegacyWorkspaceSelection>(
  (value) => typeof value === 'object' && value !== null,
  { message: 'Expected a selection.' },
);

const threadListSchema = z.custom<readonly Thread[]>(
  (value) => Array.isArray(value),
  { message: 'Expected a list of Threads.' },
);

export const layoutWorkspaceMethods = {
  thread: { input: z.string(), output: threadRecordSchema },
  selectedThread: { input: noInput, output: threadRecordSchema },
  selection: { input: noInput, output: selectionSchema },
  threads: { input: z.string(), output: threadListSchema },
  connected: { input: noInput, output: z.boolean() },
  setBottomVisible: {
    input: z.tuple([z.string().min(1), z.boolean()]),
    output: z.void(),
  },
  subscribe: {
    input: functionSchema<() => void>(),
    output: disposableSchema,
  },
} as const;

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');

export type LayoutDashboard = WorkspaceDashboard;
export const layoutDashboardMethods = workspaceDashboardMethods;
export const LayoutDashboardV1 = ref<LayoutDashboard>('layout.dashboard/v1');

export type LayoutSidebar = WorkspaceSidebar;
export const layoutSidebarMethods = workspaceSidebarMethods;
export const LayoutSidebarV1 = ref<LayoutSidebar>('layout.sidebar/v1');
