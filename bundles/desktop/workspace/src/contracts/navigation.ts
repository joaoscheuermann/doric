// The sidebar's and the dashboard's services, moved from `layout/contracts`
// with no member changed (bundle isolation 4(c)). One file holds them so both
// `index.ts` (the `workspace.*` ids) and `transition.ts` (the `layout.*` ids)
// read them without importing each other.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  noInput,
} from 'bundle/contracts';
import { z } from 'zod';

const listenerSchema = functionSchema<() => void>();

/**
 * The dashboard's shown page (1.0.0). Two regions extend the dashboard:
 * `workspace.dashboard.nav` items `{ id, tag, order? }` are groups drawn in the
 * dashboard sidebar after the Projects group, each element drawing its own
 * `SidebarGroup`; `workspace.dashboard.page` items `{ id, tag, order? }` are
 * pages the main area shows instead of the project list. At most one page shows
 * at a time; with none, the project list shows.
 */
export interface WorkspaceDashboard {
  /** The shown page's `workspace.dashboard.page` item id; `undefined` while the project list shows. */
  active(call?: CallArg): string | undefined;
  /** Shows the page with this id. An id no item has is stored but draws the project list; an empty id is refused (`invalid_input`). Showing the shown page notifies no one. */
  show(id: string, call?: CallArg): void;
  /** Back to the project list: `active()` is `undefined` afterwards. */
  close(call?: CallArg): void;
  /** Called after every change of `active()`; disposing stops the calls. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}
export const workspaceDashboardMethods = {
  active: { input: noInput, output: z.string().optional() },
  show: { input: z.string().min(1), output: z.void() },
  close: { input: noInput, output: z.void() },
  subscribe: { input: listenerSchema, output: disposableSchema },
} as const;

/** Rows a bundle adds under each Thread of the sidebar tree (1.0.0; busy 1.1.0). */
export interface ThreadRows {
  readonly id: string;
  /** Mounted as `<tag thread-id="…">` before the Thread's child Threads. */
  readonly tag: string;
  /** How many rows the Thread has; above 0 the Thread row is expandable. */
  count(threadId: string): number;
  /** Called by the owner after every change of any count. */
  subscribe(listener: () => void): Disposable;
  /**
   * 1.1.0: whether work this bundle tracks directly under the Thread, not under
   * its descendants, keeps the Thread active. The workspace makes the Thread and
   * every ancestor active (shimmer and elapsed badge) while it answers true.
   * The workspace calls it once per Thread of the selected Project on every
   * render of the tree, drawn or not (under a collapsed row, outside a search),
   * so it must answer from memory. A throw reads as false. The owner calls the
   * `subscribe` listener after every change of any answer. Absent: never busy.
   */
  busy?(threadId: string): boolean;
}

export interface WorkspaceSidebar {
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
    typeof rows.subscribe === 'function' &&
    (rows.busy === undefined || typeof rows.busy === 'function')
  );
};

export const workspaceSidebarMethods = {
  addThreadRows: {
    input: z.custom<ThreadRows>(isThreadRows, {
      message: 'Expected { id, tag, count, subscribe, busy? }.',
    }),
    output: disposableSchema,
  },
} as const;
