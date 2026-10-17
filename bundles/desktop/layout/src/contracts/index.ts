// The layout's contracts (stage 9, §5.2; stage 10 WP-10P minors): client
// contracts the layout provides in each workspace window.

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

/** A tab another bundle asks the workspace to show. */
export interface TabRequest {
  /** Unique among the tabs of one owner; opening an open id focuses it. */
  readonly id: string;
  readonly title: string;
  /** The custom element `ui/v1` creates for the tab's content. */
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /** 1.1.0: the trigger's icon; absent, the trigger shows only its title. */
  readonly icon?: TabIcon;
  /** 1.1.0: the trigger's accessible name; defaults to `title`. */
  readonly ariaLabel?: string;
  /** 1.1.0: the trigger's tooltip (`title` attribute); defaults to `title`. */
  readonly tooltip?: string;
}

/** The icons a tab trigger may carry (1.1.0). */
export type TabIcon = 'file' | 'file-diff' | 'terminal' | 'thread';

/** The selected tab of the active owner (1.1.0). */
export interface CurrentTab {
  readonly id: string;
  /** The props an element tab was opened with. */
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
  /**
   * Closes the tab and disposes its element (`ui.dispose`). 1.1.0: with
   * `threadId` it closes the tab of that owner, without needing a selection.
   */
  close(
    input: { readonly id: string; readonly threadId?: string },
    call?: CallArg,
  ): Promise<void>;
  focus(input: { readonly id: string }, call?: CallArg): Promise<void>;
  /** 1.1.0: the selected tab of the active owner, if any (local). */
  current(call?: CallArg): CurrentTab | undefined;
  /** 1.1.0: called after every change of the tabs or of the owner (local). */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const tabRequestSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    tag: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    icon: z.enum(['file', 'file-diff', 'terminal', 'thread']).optional(),
    ariaLabel: z.string().optional(),
    tooltip: z.string().optional(),
  })
  .strict();

const tabIdSchema = z.object({ id: z.string().min(1) }).strict();

const tabCloseSchema = z
  .object({ id: z.string().min(1), threadId: z.string().min(1).optional() })
  .strict();

const currentTabSchema = z.custom<CurrentTab | undefined>(
  (value) =>
    value === undefined || (typeof value === 'object' && value !== null),
  { message: 'Expected a tab or undefined.' },
);

const listenerSchema = functionSchema<() => void>();

export const layoutTabsMethods = {
  open: { input: tabRequestSchema, output: z.void() },
  close: { input: tabCloseSchema, output: z.void() },
  focus: { input: tabIdSchema, output: z.void() },
  current: { input: noInput, output: currentTabSchema },
  subscribe: { input: listenerSchema, output: disposableSchema },
} as const;

export const LayoutTabsV1 = ref<LayoutTabs>('layout.tabs/v1');

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
  selection(call?: CallArg): WorkspaceSelection;
  /** 1.1.0: the loaded Threads of a Project (empty until described). */
  threads(projectId: string, call?: CallArg): readonly Thread[];
  /** 1.1.0: whether the window is connected to the host (the sidebar footer). */
  connected(call?: CallArg): boolean;
  /**
   * 1.1.0: shows (`true`) or hides the `layout.main.bottom` split for one
   * item. The split is shown while any item asked for it; its items mount
   * only while it is shown.
   */
  setBottomVisible(itemId: string, visible: boolean, call?: CallArg): void;
  /** Called after every change of the tree, the selection or the connection. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export interface WorkspaceSelection {
  readonly project?: Project;
  readonly thread?: Thread;
}

const threadRecordSchema = z.custom<Thread | undefined>(
  (value) =>
    value === undefined || (typeof value === 'object' && value !== null),
  { message: 'Expected a Thread record or undefined.' },
);

const selectionSchema = z.custom<WorkspaceSelection>(
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

/**
 * The Project panel beside the conversation (1.0.0, WP-10P). Its views are
 * the `layout.panel` region items `{ id, tag, order, props: { label, icon,
 * badgeTag? } }`, drawn as the icon-only "Project views" tab strip; an item's
 * element mounts only while the panel is open and the item is selected.
 */
export interface LayoutPanel {
  isOpen(call?: CallArg): boolean;
  /** The selected view's id. */
  active(call?: CallArg): string;
  /** Opens the panel and selects the view. */
  show(id: string, call?: CallArg): void;
  /** Opens or closes the panel. */
  toggle(call?: CallArg): void;
  /** Called after every change of the open state or of the selected view. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

/** The props of a `layout.panel` region item. */
export interface PanelItemProps {
  readonly label: string;
  /** `files`, `file-diff`, `file` or `terminal`. */
  readonly icon: string;
  /** An element drawn inside the view's tab trigger (a badge). */
  readonly badgeTag?: string;
}

export const layoutPanelMethods = {
  isOpen: { input: noInput, output: z.boolean() },
  active: { input: noInput, output: z.string() },
  show: { input: z.string().min(1), output: z.void() },
  toggle: { input: noInput, output: z.void() },
  subscribe: { input: listenerSchema, output: disposableSchema },
} as const;

export const LayoutPanelV1 = ref<LayoutPanel>('layout.panel/v1');

/** Rows a bundle adds under each Thread of the sidebar tree (1.0.0). */
export interface ThreadRows {
  readonly id: string;
  /** Mounted as `<tag thread-id="…">` before the Thread's child Threads. */
  readonly tag: string;
  /** How many rows the Thread has; above 0 the Thread row is expandable. */
  count(threadId: string): number;
  /** Called by the owner after every change of any count. */
  subscribe(listener: () => void): Disposable;
}

export interface LayoutSidebar {
  /** A duplicate id fails with `registration_conflict`. */
  addThreadRows(rows: ThreadRows, call?: CallArg): Disposable;
}

const isThreadRows = (value: unknown): value is ThreadRows => {
  if (typeof value !== 'object' || value === null) return false;
  const rows = value as Record<string, unknown>;
  return (
    typeof rows.id === 'string' &&
    rows.id.length > 0 &&
    typeof rows.tag === 'string' &&
    rows.tag.length > 0 &&
    typeof rows.count === 'function' &&
    typeof rows.subscribe === 'function'
  );
};

export const layoutSidebarMethods = {
  addThreadRows: {
    input: z.custom<ThreadRows>(isThreadRows, {
      message: 'Expected { id, tag, count, subscribe }.',
    }),
    output: disposableSchema,
  },
} as const;

export const LayoutSidebarV1 = ref<LayoutSidebar>('layout.sidebar/v1');

/**
 * A group of the sidebar's vertical stack (1.0.0). The layout draws one
 * resizable panel per pane, in `order`, plus the pane's header: its title, the
 * collapse control and the element `headerTag` names for the group's own action
 * (its add or hide control). The pane's own element (`tag`) draws only what is
 * inside the group.
 */
export interface StackPane {
  /** Unique in the stack; a duplicate fails with `registration_conflict`. */
  readonly id: string;
  /** Top to bottom: ascending, absent last, then registration order. */
  readonly order?: number;
  /** The header text the layout draws. */
  readonly title: string;
  /** The custom element `ui/v1` creates for the group's content (`sidebar-menu` rows). */
  readonly tag?: string;
  /** The props that element is created with. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** An element drawn inside the header, where the group's action belongs. */
  readonly headerTag?: string;
  /**
   * Whether the reader can collapse the pane (default `true`). A pane that
   * cannot collapse draws no control and stays open.
   */
  readonly collapsible?: boolean;
  /**
   * Whether the pane starts expanded (default `true`). A collapsed pane starts
   * at its header and expands to `minSize`.
   */
  readonly initiallyOpen?: boolean;
  /** Size when expanded; absent, the pane takes what the others leave. */
  readonly defaultSize?: number | string;
  /** Smallest size while expanded (for example `'20%'`). */
  readonly minSize?: string;
  /** Largest size (for example `'80%'`). */
  readonly maxSize?: string;
}

/**
 * The sidebar's stack of panes other bundles own. A pane never collapses past
 * its header, so resizing the sidebar cannot make a group vanish.
 */
export interface LayoutStack {
  /** A duplicate id fails with `registration_conflict`. */
  register(pane: StackPane, call?: CallArg): Disposable;
  /** The panes top to bottom; the same array until the stack changes. */
  panes(call?: CallArg): readonly StackPane[];
  /** Whether the pane is expanded; a pane that cannot collapse always is. */
  isOpen(paneId: string, call?: CallArg): boolean;
  /** Opens or collapses the pane, as its header control does. */
  setOpen(paneId: string, open: boolean, call?: CallArg): void;
  toggle(paneId: string, call?: CallArg): void;
  /** Called after every change of the panes or of one pane's state. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const stackPaneSchema = z
  .object({
    id: z.string().min(1),
    order: z.number().optional(),
    title: z.string(),
    tag: z.string().min(1).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    headerTag: z.string().min(1).optional(),
    collapsible: z.boolean().optional(),
    initiallyOpen: z.boolean().optional(),
    defaultSize: z.union([z.number(), z.string()]).optional(),
    minSize: z.string().optional(),
    maxSize: z.string().optional(),
  })
  .strict();

const stackPanesSchema = z.custom<readonly StackPane[]>(
  (value) => Array.isArray(value),
  { message: 'Expected the stack panes.' },
);

export const layoutStackMethods = {
  register: { input: stackPaneSchema, output: disposableSchema },
  panes: { input: noInput, output: stackPanesSchema },
  isOpen: { input: z.string().min(1), output: z.boolean() },
  setOpen: {
    input: z.tuple([z.string().min(1), z.boolean()]),
    output: z.void(),
  },
  toggle: { input: z.string().min(1), output: z.void() },
  subscribe: { input: listenerSchema, output: disposableSchema },
} as const;

export const LayoutStackV1 = ref<LayoutStack>('layout.stack/v1');
