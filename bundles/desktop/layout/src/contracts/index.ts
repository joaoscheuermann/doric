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
import { isValidElement, type ReactElement } from 'react';
import { z } from 'zod';

// The shell's slots (4.1.0). Their items are elements `{ id, tag, order? }`
// with no props type. The frame is in the page form while `shell.page`
// holds an item, and in the conversation form otherwise.

/** The sidebar column's content, in both forms. */
export const SHELL_SIDEBAR = 'shell.sidebar';
/** The sidebar column's foot, under the quarantine notice. */
export const SHELL_SIDEBAR_FOOTER = 'shell.sidebar.footer';
/** The title bar's tabs, in both forms. */
export const SHELL_TITLEBAR_TABS = 'shell.titlebar.tabs';
/** The page form's body; an item here switches the frame to the page form. */
export const SHELL_PAGE = 'shell.page';
/** The window's actions: the title bar's end (page form) or the side panel's header (conversation form). */
export const SHELL_WINDOW_ACTIONS = 'shell.window.actions';
/** The Project tab bar's right end, in the conversation form (4.2.0). */
export const SHELL_HEADER_ACTIONS = 'shell.header.actions';
/** The conversation footer, a 44 px band floating over the conversation's bottom (4.3.0). */
export const SHELL_CONVERSATION_FOOTER = 'shell.conversation.footer';
/** The split under the conversation, shown while an item asks through `setBottomVisible` (4.4.0). */
export const SHELL_CONVERSATION_BOTTOM = 'shell.conversation.bottom';
/** A floating layer over the conversation; its items place themselves (4.5.0). */
export const SHELL_CONVERSATION_OVERLAY = 'shell.conversation.overlay';
/** The Project panel's views; an item's props are a `PanelItemProps` (4.6.0). */
export const SHELL_PANEL = 'shell.panel';
/** The Files column footer, one 28 px row under the Project panel (4.7.0). */
export const SHELL_PANEL_FOOTER = 'shell.panel.footer';

/** One entry of a viewer tab's context menu (1.2.0). */
export interface TabMenuItem {
  readonly id: string;
  readonly label: string;
  /**
   * The entry's leading 16 px icon: a React element, such as
   * `createElement(FolderOpenIcon)` from lucide-react, drawn before the label.
   * Anything but a valid React element fails `invalid_input`. Absent, the
   * label aligns with the labels of the entries that have one.
   */
  readonly icon?: ReactElement;
  /** Drawn with the destructive item variant. */
  readonly destructive?: boolean;
  /** Runs when the reader picks the entry; the menu closes. */
  readonly run: () => void;
}

/** The selected tab of the active owner (1.1.0). */
export interface CurrentTab {
  readonly id: string;
  /** The props an element tab was opened with. */
  readonly props?: Readonly<Record<string, unknown>>;
}

const tabMenuSchema = z
  .array(
    z
      .object({
        id: z.string(),
        label: z.string(),
        icon: z
          .custom<ReactElement>((value) => isValidElement(value), {
            message: 'Expected a React element.',
          })
          .optional(),
        destructive: z.boolean().optional(),
        run: functionSchema<() => void>(),
      })
      .strict(),
  )
  .optional();

const tabIdSchema = z.object({ id: z.string().min(1) }).strict();

const currentTabSchema = z.custom<CurrentTab | undefined>(
  (value) =>
    value === undefined || (typeof value === 'object' && value !== null),
  { message: 'Expected a tab or undefined.' },
);

const listenerSchema = functionSchema<() => void>();

/** A tab another bundle asks the shell to show (`layout.tabs/v2` 2.0.0). */
export interface TabRequest {
  /** Unique among the tabs of one owner; opening an open id focuses it. */
  readonly id: string;
  readonly title: string;
  /** The custom element `ui/v1` creates for the tab's content. */
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /** The element drawn as the trigger's 16 px icon, created through `ui/v1` with the tab's `props`. */
  readonly iconTag?: string;
  /** The viewer card draws no bottom padding while this tab is selected. */
  readonly openBottom?: boolean;
  /** The trigger's accessible name; defaults to `title`. */
  readonly ariaLabel?: string;
  /** The trigger's tooltip (`title` attribute); defaults to `title`. */
  readonly tooltip?: string;
  /** The entries the tab's context menu shows besides "Close tab". */
  readonly menu?: readonly TabMenuItem[];
}

/** The tabs of the owner `setOwner` last named (`layout.tabs/v2` 2.0.0). */
export interface LayoutTabs {
  /**
   * Opens the tab, or only focuses it when its id is open. With no owner it
   * fails with `ContractError('unavailable', 'No thread or project is selected.')`.
   */
  open(input: TabRequest, call?: CallArg): Promise<void>;
  /** Closes the tab and disposes its element (`ui.dispose`). */
  close(
    input: {
      readonly id: string;
      /** The owner key whose tab closes; absent, the active owner. */
      readonly threadId?: string;
      /** Closes the tab with this id in every owner; `threadId` is then ignored. */
      readonly everyOwner?: boolean;
    },
    call?: CallArg,
  ): Promise<void>;
  focus(input: { readonly id: string }, call?: CallArg): Promise<void>;
  /** Sets the title of the tab with that id, in the owners `close` would reach; without such a tab it does nothing. */
  retitle(
    input: {
      readonly id: string;
      readonly title: string;
      readonly threadId?: string;
      readonly everyOwner?: boolean;
    },
    call?: CallArg,
  ): Promise<void>;
  /** The selected tab of the active owner, if any (local). */
  current(call?: CallArg): CurrentTab | undefined;
  /** Called after every change of the tabs or of the owner (local). */
  subscribe(listener: () => void, call?: CallArg): Disposable;
  /** Names the set of tabs the frame shows; absent, no set. Local. */
  setOwner(input: { readonly owner?: string }, call?: CallArg): void;
}

/** The `layout.tabs/v2` request. Strict: an unknown key, such as `icon`, fails validation. */
export const tabRequestSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    tag: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    iconTag: z.string().min(1).optional(),
    openBottom: z.boolean().optional(),
    ariaLabel: z.string().optional(),
    tooltip: z.string().optional(),
    menu: tabMenuSchema,
  })
  .strict();

const tabCloseSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1).optional(),
    everyOwner: z.boolean().optional(),
  })
  .strict();

const tabRetitleSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    threadId: z.string().optional(),
    everyOwner: z.boolean().optional(),
  })
  .strict();

const tabOwnerSchema = z
  .object({ owner: z.string().min(1).optional() })
  .strict();

export const layoutTabsMethods = {
  open: { input: tabRequestSchema, output: z.void() },
  close: { input: tabCloseSchema, output: z.void() },
  focus: { input: tabIdSchema, output: z.void() },
  retitle: { input: tabRetitleSchema, output: z.void() },
  current: { input: noInput, output: currentTabSchema },
  subscribe: { input: listenerSchema, output: disposableSchema },
  setOwner: { input: tabOwnerSchema, output: z.void() },
} as const;

export const LayoutTabsV2 = ref<LayoutTabs>('layout.tabs/v2');

/**
 * The Project panel beside the conversation (`layout.panel/v3` 3.0.0). Its
 * views are the `shell.panel` region items `{ id, tag, order, props: { label,
 * iconTag?, badgeTag? } }`, drawn as the icon-only "Project views" tab strip; the
 * selected item's element is mounted. The panel is always shown: it has no
 * open state, and nothing about it is persisted.
 */
export interface LayoutPanel {
  /**
   * Selects the view whose `shell.panel` item id is `id`. An id no item has
   * is kept: the panel draws no view until an item with that id registers.
   * Selecting the selected view changes nothing; an empty id is refused
   * (`invalid_input`).
   */
  select(id: string, call?: CallArg): void;
}

/** The props of a `shell.panel` region item. */
export interface PanelItemProps {
  readonly label: string;
  /** An element drawn as the view's icon. */
  readonly iconTag?: string;
  /** An element drawn inside the view's tab trigger (a badge). */
  readonly badgeTag?: string;
}

export const layoutPanelMethods = {
  select: { input: z.string().min(1), output: z.void() },
} as const;

/** `layout.panel/v3` (3.0.0): the panel starts with no view selected; `select` names the first. */
export const LayoutPanelV3 = ref<LayoutPanel>('layout.panel/v3');

/** `layout.conversation/v1` (1.0.0). */
export interface LayoutConversation {
  /**
   * Shows (`true`) or hides the `shell.conversation.bottom` split for one item. The
   * split is shown while any item asked for it; its items mount only while it
   * is shown.
   */
  setBottomVisible(itemId: string, visible: boolean, call?: CallArg): void;
}

export const layoutConversationMethods = {
  setBottomVisible: {
    input: z.tuple([z.string().min(1), z.boolean()]),
    output: z.void(),
  },
} as const;

export const LayoutConversationV1 = ref<LayoutConversation>(
  'layout.conversation/v1',
);

/**
 * A group of the sidebar's vertical stack (`layout.stack/v2`, 2.0.0). The
 * layout draws one group per pane, in `order`, under the Thread region and
 * pinned to the column's bottom; nothing is resizable. Each group is the
 * pane's 28 px header — its title, the collapse control and the element
 * `headerTag` names for the group's own action (its add or hide control), which
 * the layout hides until the header is hovered or holds focus — and,
 * while the pane is open, the pane's own element (`tag`), which draws only
 * what is inside the group. An open pane takes its content's height, up to
 * 40% of the column, and its content scrolls vertically past that; when the
 * column is short, the Thread region gives up its free height first, then
 * open panes shrink toward their headers. A pane never shrinks past its
 * header, so the group cannot vanish.
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
   * at its header.
   */
  readonly initiallyOpen?: boolean;
}

/**
 * The sidebar's stack of panes other bundles own (`layout.stack/v2`): only the
 * registered panes — the layout's Thread region is not one of them. The panes
 * sit under the Thread region, pinned to the column's bottom, one group each,
 * with no dividers and no sizes: an open pane is as tall as its content, at
 * most 40% of the column, and a collapsed one is its 28 px header. A pane never
 * collapses past its header, so no change of the column's height makes a group
 * vanish.
 */
export interface LayoutStack {
  /**
   * A duplicate id fails with `registration_conflict`; disposing removes the
   * pane.
   */
  register(pane: StackPane, call?: CallArg): Disposable;
  /** The panes top to bottom; the same array until the stack changes. */
  panes(call?: CallArg): readonly StackPane[];
  /** Whether the pane is expanded; a pane that cannot collapse always is. */
  isOpen(paneId: string, call?: CallArg): boolean;
  /** Opens or collapses the pane, as its header control does. */
  setOpen(paneId: string, open: boolean, call?: CallArg): void;
  /** Flips the pane between open and collapsed, as its header control does. */
  toggle(paneId: string, call?: CallArg): void;
  /** Called after every change of the panes or of one pane's state. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

/**
 * A pane as `register` accepts it. Strict: an unknown key — including v1's
 * `defaultSize`, `minSize` and `maxSize` — fails validation.
 */
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

/** `layout.stack/v2` (2.0.0); replaces `layout.stack/v1`, which is no longer provided. */
export const LayoutStackV2 = ref<LayoutStack>('layout.stack/v2');
