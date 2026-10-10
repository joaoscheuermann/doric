// The layout's contracts (stage 9, §5.2): both are client contracts the
// layout provides in each workspace window.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import type { Thread } from 'runtime/contracts';
import { z } from 'zod';

/** A tab another bundle asks the workspace to show. */
export interface TabRequest {
  /** Unique among the tabs of one owner; opening an open id focuses it. */
  readonly id: string;
  readonly title: string;
  /** The custom element `ui/v1` creates for the tab's content. */
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/**
 * The tabs of the active route's Thread: the route `threadId`, else
 * `project:<selected Project>`, owns them.
 */
export interface LayoutTabs {
  /**
   * Opens the tab, or only focuses it when its id is open. With no Thread
   * and no Project selected it fails with
   * `ContractError('unavailable', 'No thread or project is selected.')`.
   */
  open(input: TabRequest, call?: CallArg): Promise<void>;
  /** Closes the tab and disposes its element (`ui.dispose`). */
  close(input: { readonly id: string }, call?: CallArg): Promise<void>;
  focus(input: { readonly id: string }, call?: CallArg): Promise<void>;
}

export const tabRequestSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    tag: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const tabIdSchema = z.object({ id: z.string().min(1) }).strict();

export const layoutTabsMethods = {
  open: { input: tabRequestSchema, output: z.void() },
  close: { input: tabIdSchema, output: z.void() },
  focus: { input: tabIdSchema, output: z.void() },
} as const;

export const LayoutTabsV1 = ref<LayoutTabs>('layout.tabs/v1');

/** A read-only view of the sidebar tree for other client bundles. */
export interface LayoutWorkspace {
  /** The tree's record of a Thread of any loaded Project. */
  thread(threadId: string, call?: CallArg): Thread | undefined;
  /** The selected Thread, once the tree describes it. */
  selectedThread(call?: CallArg): Thread | undefined;
  /** Called after every change of the tree or the selection. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

const threadRecordSchema = z.custom<Thread | undefined>(
  (value) =>
    value === undefined || (typeof value === 'object' && value !== null),
  { message: 'Expected a Thread record or undefined.' },
);

export const layoutWorkspaceMethods = {
  thread: { input: z.string(), output: threadRecordSchema },
  selectedThread: { input: noInput, output: threadRecordSchema },
  subscribe: {
    input: functionSchema<() => void>(),
    output: disposableSchema,
  },
} as const;

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');
