// The windows main opened for bundles, by key and by webContents.

import type { BaseWindow, WebContents } from 'electron';

import type { ParsedAppearance } from './appearance';

/** A window whose content is an app route, or a page on the host (1.1.0). */
export type WindowKind = 'path' | 'view';

export interface WindowContext {
  path: string | null;
  focus: string | null;
}

export interface WindowEntry {
  readonly key: string;
  readonly kind: WindowKind;
  /**
   * The window itself: a `BrowserWindow` for an app route, a `BaseWindow` for a
   * view (which owns no web contents of its own).
   */
  readonly window: BaseWindow;
  /** The web contents that serves this window: the window's own, or the view's. */
  readonly contents: WebContents;
  readonly appearance: ParsedAppearance;
  /** Opened as the primary window: its core failures are core failures. */
  readonly primary: boolean;
  /** The client generation the shell loaded; null until it is pinned. */
  pinnedGeneration: number | null;
  /** The menu context of this window (`menus/v1.setContext`). */
  readonly context: WindowContext;
}

export class WindowRegistry {
  readonly #byKey = new Map<string, WindowEntry>();
  readonly #byContents = new Map<number, WindowEntry>();
  #focused: string | undefined;

  add(entry: WindowEntry): void {
    this.#byKey.set(entry.key, entry);
    this.#byContents.set(entry.contents.id, entry);
  }

  remove(entry: WindowEntry, contentsId: number): void {
    if (this.#byKey.get(entry.key) === entry) {
      this.#byKey.delete(entry.key);
    }

    this.#byContents.delete(contentsId);

    if (this.#focused === entry.key) {
      this.#focused = undefined;
    }
  }

  byKey(key: string): WindowEntry | undefined {
    return this.#byKey.get(key);
  }

  byWebContents(id: number): WindowEntry | undefined {
    return this.#byContents.get(id);
  }

  setFocused(key: string | undefined): void {
    this.#focused = key;
  }

  /** The last focused window that is still open. */
  focused(): WindowEntry | undefined {
    return this.#focused === undefined
      ? undefined
      : this.#byKey.get(this.#focused);
  }

  all(): readonly WindowEntry[] {
    return [...this.#byKey.values()];
  }
}
