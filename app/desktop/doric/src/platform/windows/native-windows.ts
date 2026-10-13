// `doric.windows/v1` in main: windows by key (decision 75). An open key is
// focused (and navigated when the path differs), a new key gets a window
// with the appearance's native options, and main remembers the last path of
// each key.

import type { OpenWindowRequest } from 'bundle/contracts';
import {
  ContractError,
  openWindowRequestSchema,
  windowAppearanceSchema,
} from 'bundle/contracts';
import { BrowserWindow, nativeTheme, screen } from 'electron';

import type { PlatformLog } from '../log';
import { doricUrl } from '../protocol/scheme';
import type { WindowPaths } from '../state';
import type { WindowTokens } from '../tokens';
import {
  chromeFor,
  keepsWindowButtons,
  nativeOptions,
  type ParsedAppearance,
} from './appearance';
import { type CloseAnswers, installCloseProtocol } from './close';
import { installNavigationGuard } from './navigation-guard';
import { push } from './push';
import type { WindowEntry, WindowRegistry } from './registry';

export interface NativeWindowEvents {
  /** A window was created (before its first load). */
  created?(entry: WindowEntry): void;
  /** A window was closed and unbound. */
  closed?(entry: WindowEntry): void;
  /** Focus moved to this window, or away from every window (undefined). */
  focused?(entry: WindowEntry | undefined): void;
  /** A main-frame document load started: the window's pin is cleared. */
  navigating?(entry: WindowEntry): void;
}

export interface NativeWindowsOptions {
  readonly registry: WindowRegistry;
  readonly paths: Pick<WindowPaths, 'get' | 'set' | 'flush'>;
  readonly tokens: WindowTokens;
  readonly preload: string;
  readonly answers: CloseAnswers;
  readonly quitting: () => boolean;
  readonly log: PlatformLog;
  readonly events?: NativeWindowEvents;
  readonly platform?: NodeJS.Platform;
  /** Test seam for the close protocol's flush deadline. */
  readonly flushDeadlineMs?: number;
}

const pathnameOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
};

const failed = (error: unknown): ContractError =>
  new ContractError(
    'unavailable',
    `The window could not load: ${error instanceof Error ? error.message : String(error)}`,
  );

export class NativeWindows {
  readonly #options: NativeWindowsOptions;
  readonly #lastRequest = new Map<
    string,
    {
      readonly path: string;
      readonly appearance: ParsedAppearance;
      readonly primary: boolean;
    }
  >();

  constructor(options: NativeWindowsOptions) {
    this.#options = options;
  }

  get registry(): WindowRegistry {
    return this.#options.registry;
  }

  /** `open({ key, path, appearance? })`. */
  async open(request: OpenWindowRequest): Promise<void> {
    const parsed = openWindowRequestSchema.parse(request);

    if (!parsed.path.startsWith('/')) {
      throw new ContractError(
        'invalid_input',
        `A window path must start with "/": "${parsed.path}".`,
      );
    }

    if (parsed.key === '') {
      throw new ContractError(
        'invalid_input',
        'A window key must not be empty.',
      );
    }

    const appearance: ParsedAppearance =
      parsed.appearance ?? windowAppearanceSchema.parse({});
    const primary = parsed.primary === true;
    const existing = this.#options.registry.byKey(parsed.key);

    // The primary mark is fixed when a window is created: a request for it on
    // an open window that lacks it cannot be honoured, so it is refused, not
    // reported as done. An omitted flag never demotes an open primary window.
    if (primary && existing !== undefined && !existing.primary) {
      throw new ContractError(
        'registration_conflict',
        `Window "${parsed.key}" is already open without the primary flag; close it before opening it as the primary window.`,
        { windowKey: parsed.key },
      );
    }

    const otherPrimary = this.#options.registry
      .all()
      .find((entry) => entry.primary && entry.key !== parsed.key);

    if (primary && otherPrimary !== undefined) {
      throw new ContractError(
        'registration_conflict',
        `Window "${otherPrimary.key}" is already the primary window.`,
        { windowKey: otherPrimary.key },
      );
    }

    if (existing !== undefined) {
      const { window } = existing;

      if (window.isMinimized()) {
        window.restore();
      }

      window.focus();

      if (pathnameOf(window.webContents.getURL()) !== parsed.path) {
        try {
          await window.loadURL(doricUrl(parsed.path));
        } catch (error) {
          throw failed(error);
        }
      }

      return;
    }

    this.#lastRequest.set(parsed.key, {
      path: parsed.path,
      appearance,
      primary,
    });

    const entry = this.#create(parsed.key, appearance, primary);

    try {
      await entry.window.loadURL(doricUrl(parsed.path));
    } catch (error) {
      throw failed(error);
    }
  }

  /**
   * Stage 9 (D9-7): focuses the open window of `key` without navigating it;
   * false when no such window is open.
   */
  focus(key: string): boolean {
    const existing = this.#options.registry.byKey(key);

    if (existing === undefined) {
      return false;
    }

    if (existing.window.isMinimized()) {
      existing.window.restore();
    }

    existing.window.focus();

    return true;
  }

  /** Focuses an open key, or reopens it with this run's last request. */
  async focusOrOpen(key: string): Promise<void> {
    const existing = this.#options.registry.byKey(key);

    if (existing !== undefined) {
      if (existing.window.isMinimized()) {
        existing.window.restore();
      }

      existing.window.focus();

      return;
    }

    const last = this.#lastRequest.get(key);

    if (last === undefined) {
      throw new ContractError(
        'not_found',
        `No window "${key}" was opened in this run.`,
      );
    }

    await this.open({
      key,
      path: this.lastPath(key) ?? last.path,
      appearance: last.appearance,
      primary: last.primary,
    });
  }

  lastPath(key: string): string | null {
    return this.#options.paths.get(key);
  }

  #create(
    key: string,
    appearance: ParsedAppearance,
    primary: boolean,
  ): WindowEntry {
    const { registry, tokens, preload, paths, answers, events, log } =
      this.#options;
    const platform = this.#options.platform ?? process.platform;
    const window = new BrowserWindow(
      nativeOptions(
        appearance,
        tokens,
        platform,
        screen.getPrimaryDisplay().workAreaSize,
        preload,
        nativeTheme.shouldUseDarkColors,
      ),
    );
    const contents = window.webContents;
    const contentsId = contents.id;
    const entry: WindowEntry = {
      key,
      window,
      appearance,
      primary,
      pinnedGeneration: null,
      context: { path: null, focus: null },
    };

    if (keepsWindowButtons(appearance, platform)) {
      window.setWindowButtonVisibility(true);
    }

    installNavigationGuard(contents);
    installCloseProtocol(window, {
      answers,
      quitting: this.#options.quitting,
      denied: (reason) =>
        log.info({ windowKey: key, reason }, 'Window close denied'),
      ...(this.#options.flushDeadlineMs === undefined
        ? {}
        : { flushDeadlineMs: this.#options.flushDeadlineMs }),
    });

    window.once('ready-to-show', () => {
      window.show();
    });

    const remember = (url: string) => {
      const path = pathnameOf(url);

      if (path !== undefined) {
        paths.set(key, path);
      }
    };

    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        events?.navigating?.(entry);
      }
    });
    contents.on('did-navigate', (_event, url) => remember(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        remember(url);
      }
    });

    window.on('focus', () => {
      registry.setFocused(key);
      events?.focused?.(entry);
    });
    window.on('blur', () => {
      if (registry.focused() === entry) {
        registry.setFocused(undefined);
        events?.focused?.(undefined);
      }
    });

    const chrome = () =>
      push(contents, {
        type: 'chrome',
        chrome: chromeFor(appearance.titleBar, tokens, window.isFullScreen()),
      });

    window.on('enter-full-screen', chrome);
    window.on('leave-full-screen', chrome);

    window.once('closed', () => {
      registry.remove(entry, contentsId);
      void paths.flush();
      events?.closed?.(entry);
    });

    registry.add(entry);
    events?.created?.(entry);

    return entry;
  }
}
