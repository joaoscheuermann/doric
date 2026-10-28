// `doric.windows/v1` in main: windows by key (decision 75). An open key is
// focused (and navigated when the path differs), a new key gets a window
// with the appearance's native options, and main remembers the last path of
// each key. 1.1.0 adds the view window: a `BaseWindow` whose whole content is
// one `WebContentsView` over a page on the host, in its own session, with no
// app chrome, no preload and no bundle contracts.

import type {
  DoricWindows,
  OpenWindowRequest,
  WindowView,
} from 'bundle/contracts';
import {
  ContractError,
  openWindowRequestSchema,
  windowAppearanceSchema,
} from 'bundle/contracts';
import {
  BaseWindow,
  BrowserWindow,
  type NativeImage,
  nativeTheme,
  screen,
  WebContentsView,
} from 'electron';

import type { PlatformLog } from '../log';
import { doricUrl } from '../protocol/scheme';
import type { WindowPaths } from '../state';
import type { WindowTokens } from '../tokens';
import {
  chromeFor,
  keepsWindowButtons,
  nativeOptions,
  type ParsedAppearance,
  windowOptions,
} from './appearance';
import { type CloseAnswers, installCloseProtocol } from './close';
import {
  installNavigationGuard,
  installViewNavigationGuard,
} from './navigation-guard';
import { push } from './push';
import type { WindowEntry, WindowRegistry } from './registry';
import { composeViewUrl, navigateDisposition, viewOriginOf } from './view';

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
  /** The origin the app reaches the host on; a view window resolves its path against it. */
  readonly hostUrl: string;
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

type WindowCaptureRequest = Parameters<DoricWindows['capture']>[0];
type WindowCapture = Awaited<ReturnType<DoricWindows['capture']>>;

/** The two shapes `open` accepts, after schema parsing. */
type ParsedOpen = ReturnType<typeof openWindowRequestSchema.parse>;

interface LastOpen {
  readonly request: ParsedOpen;
  readonly appearance: ParsedAppearance;
}

export class NativeWindows {
  readonly #options: NativeWindowsOptions;
  readonly #lastRequest = new Map<string, LastOpen>();
  /** The kind of the last window opened under a key, across this run. */
  readonly #kinds = new Map<string, 'path' | 'view'>();
  /** The host path a view window currently shows, for `focusOrOpen`. */
  readonly #viewPaths = new Map<string, string>();

  constructor(options: NativeWindowsOptions) {
    this.#options = options;
  }

  get registry(): WindowRegistry {
    return this.#options.registry;
  }

  /**
   * `open(request)`: an app route (`path`) loads `doric://app/<path>` with the
   * app's preload; a view (`view`) loads a page on the host in its own session.
   */
  async open(request: OpenWindowRequest): Promise<void> {
    const parsed = openWindowRequestSchema.parse(request);

    if (parsed.key === '') {
      throw new ContractError(
        'invalid_input',
        'A window key must not be empty.',
      );
    }

    const appearance: ParsedAppearance =
      parsed.appearance ?? windowAppearanceSchema.parse({});
    const primary = parsed.primary === true;

    this.#checkPrimary(parsed.key, primary);

    if ('path' in parsed) {
      await this.#openPath(parsed, appearance, primary);
    } else {
      await this.#openView(parsed, appearance, primary);
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

    const { request } = last;

    if ('path' in request) {
      await this.open({
        key,
        path: this.lastPath(key) ?? request.path,
        appearance: last.appearance,
        primary: request.primary,
      });

      return;
    }

    await this.open({
      key,
      view: {
        ...request.view,
        path: this.#viewPaths.get(key) ?? request.view.path,
      },
      appearance: last.appearance,
      primary: request.primary,
    });
  }

  /**
   * `doric.windows/v1.lastPath`: the app path main stored for a key. A view
   * window has none — its content is a page on the host, not an app route — so
   * this answers `null` for it.
   */
  lastPath(key: string): string | null {
    if (this.#kinds.get(key) === 'view') {
      return null;
    }

    return this.#options.paths.get(key);
  }

  /**
   * `doric.windows/v1.capture` (1.2.0): a PNG of `rect`, in CSS px of an open
   * path window's viewport. The rectangle is scaled by the page zoom into the
   * window's DIPs (outward to whole DIPs) and captured from its contents, which
   * takes in out-of-process frames and the device pixel ratio. A key that is
   * not open fails `not_found`; a view window or a rectangle outside the
   * viewport fails `invalid_input`; a capture that could not be taken, or came
   * back empty, fails `unavailable`.
   */
  async capture(input: WindowCaptureRequest): Promise<WindowCapture> {
    const { key, rect } = input;
    const entry = this.#options.registry.byKey(key);

    if (entry === undefined || entry.contents.isDestroyed()) {
      throw new ContractError('not_found', `No window "${key}" is open.`, {
        windowKey: key,
      });
    }

    if (entry.kind !== 'path') {
      throw new ContractError(
        'invalid_input',
        `Window "${key}" shows a host page; only app windows can be captured.`,
        { windowKey: key },
      );
    }

    const zoom = entry.contents.getZoomFactor();
    const x = Math.floor(rect.x * zoom);
    const y = Math.floor(rect.y * zoom);
    const dip = {
      x,
      y,
      width: Math.ceil((rect.x + rect.width) * zoom) - x,
      height: Math.ceil((rect.y + rect.height) * zoom) - y,
    };
    const [contentWidth = 0, contentHeight = 0] = entry.window.getContentSize();

    if (
      dip.width <= 0 ||
      dip.height <= 0 ||
      dip.x + dip.width > contentWidth ||
      dip.y + dip.height > contentHeight
    ) {
      throw new ContractError(
        'invalid_input',
        `The rectangle lies outside window "${key}".`,
        { windowKey: key },
      );
    }

    let image: NativeImage;

    try {
      image = await entry.contents.capturePage(dip, { stayHidden: true });
    } catch (error) {
      throw new ContractError(
        'unavailable',
        `Window "${key}" could not be captured: ${error instanceof Error ? error.message : String(error)}`,
        { windowKey: key },
      );
    }

    // The representation at the device pixel ratio the page was drawn at.
    const factor = Math.max(1, ...image.getScaleFactors());
    const size = image.getSize(factor);

    if (image.isEmpty() || size.width === 0 || size.height === 0) {
      throw new ContractError(
        'unavailable',
        `Window "${key}" gave an empty capture.`,
        { windowKey: key },
      );
    }

    return {
      png: image.toPNG({ scaleFactor: factor }).toString('base64'),
      width: size.width,
      height: size.height,
      scale: size.width / rect.width,
    };
  }

  /**
   * `doric.windows/v1.navigate` (1.1.0): points an open view window at another
   * host-relative path, resolved against the app's host origin. A key that is
   * not open fails `not_found`; a path window is not navigable this way and
   * fails `invalid_input`.
   */
  async navigate(input: { key: string; path: string }): Promise<void> {
    const disposition = navigateDisposition(
      this.#options.registry.byKey(input.key),
      this.#options.hostUrl,
      input.path,
    );

    if (disposition.kind === 'absent') {
      throw new ContractError(
        'not_found',
        `No window "${input.key}" is open.`,
        { windowKey: input.key },
      );
    }

    if (disposition.kind === 'path_window') {
      throw new ContractError(
        'invalid_input',
        `Window "${input.key}" is an app window; it cannot be navigated to a host path.`,
        { windowKey: input.key },
      );
    }

    const existing = this.#options.registry.byKey(input.key);

    if (existing === undefined || existing.contents.isDestroyed()) {
      throw new ContractError(
        'not_found',
        `No window "${input.key}" is open.`,
        { windowKey: input.key },
      );
    }

    try {
      await existing.contents.loadURL(disposition.url);
    } catch (error) {
      throw failed(error);
    }

    this.#viewPaths.set(input.key, input.path);
  }

  #checkPrimary(key: string, primary: boolean): void {
    const existing = this.#options.registry.byKey(key);

    // The primary mark is fixed when a window is created: a request for it on
    // an open window that lacks it cannot be honoured, so it is refused, not
    // reported as done. An omitted flag never demotes an open primary window.
    if (primary && existing !== undefined && !existing.primary) {
      throw new ContractError(
        'registration_conflict',
        `Window "${key}" is already open without the primary flag; close it before opening it as the primary window.`,
        { windowKey: key },
      );
    }

    const otherPrimary = this.#options.registry
      .all()
      .find((entry) => entry.primary && entry.key !== key);

    if (primary && otherPrimary !== undefined) {
      throw new ContractError(
        'registration_conflict',
        `Window "${otherPrimary.key}" is already the primary window.`,
        { windowKey: otherPrimary.key },
      );
    }
  }

  async #openPath(
    parsed: Extract<ParsedOpen, { path: string }>,
    appearance: ParsedAppearance,
    primary: boolean,
  ): Promise<void> {
    if (!parsed.path.startsWith('/')) {
      throw new ContractError(
        'invalid_input',
        `A window path must start with "/": "${parsed.path}".`,
      );
    }

    const { key } = parsed;
    const existing = this.#options.registry.byKey(key);

    if (existing !== undefined) {
      const { window } = existing;

      if (window.isMinimized()) {
        window.restore();
      }

      window.focus();

      if (
        existing.kind === 'path' &&
        pathnameOf(existing.contents.getURL()) !== parsed.path
      ) {
        try {
          await existing.contents.loadURL(doricUrl(parsed.path));
        } catch (error) {
          throw failed(error);
        }
      }

      return;
    }

    this.#lastRequest.set(key, { request: parsed, appearance });
    this.#kinds.set(key, 'path');

    const entry = this.#createPath(key, appearance, primary);

    try {
      await entry.contents.loadURL(doricUrl(parsed.path));
    } catch (error) {
      throw failed(error);
    }
  }

  async #openView(
    parsed: Extract<ParsedOpen, { view: WindowView }>,
    appearance: ParsedAppearance,
    primary: boolean,
  ): Promise<void> {
    const { key } = parsed;
    const existing = this.#options.registry.byKey(key);

    if (existing !== undefined) {
      if (existing.window.isMinimized()) {
        existing.window.restore();
      }

      existing.window.focus();

      if (
        existing.kind === 'view' &&
        this.#viewPaths.get(key) !== parsed.view.path
      ) {
        try {
          await existing.contents.loadURL(
            composeViewUrl(this.#options.hostUrl, parsed.view.path),
          );
        } catch (error) {
          throw failed(error);
        }

        this.#viewPaths.set(key, parsed.view.path);
      }

      return;
    }

    this.#lastRequest.set(key, { request: parsed, appearance });
    this.#kinds.set(key, 'view');
    this.#viewPaths.set(key, parsed.view.path);

    const entry = this.#createView(key, parsed.view, appearance, primary);

    try {
      await entry.contents.loadURL(
        composeViewUrl(this.#options.hostUrl, parsed.view.path),
      );
    } catch (error) {
      throw failed(error);
    }
  }

  #createPath(
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
    const entry: WindowEntry = {
      key,
      kind: 'path',
      window,
      contents,
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
      registry.remove(entry, contents.id);
      void paths.flush();
      events?.closed?.(entry);
    });

    registry.add(entry);
    events?.created?.(entry);

    return entry;
  }

  #createView(
    key: string,
    view: WindowView,
    appearance: ParsedAppearance,
    primary: boolean,
  ): WindowEntry {
    const { registry, tokens, events } = this.#options;
    const platform = this.#options.platform ?? process.platform;
    const hostUrl = this.#options.hostUrl;
    const window = new BaseWindow(
      windowOptions(
        appearance,
        tokens,
        platform,
        screen.getPrimaryDisplay().workAreaSize,
        nativeTheme.shouldUseDarkColors,
      ),
    );

    // The view is the window's whole content: one `WebContentsView` filling it.
    // No preload, no bundle contracts — the page's own session keeps its
    // cookies, storage and cache out of the app's.
    const contentsView = new WebContentsView({
      webPreferences: {
        partition: view.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.contentView.addChildView(contentsView);

    const contents = contentsView.webContents;
    const entry: WindowEntry = {
      key,
      kind: 'view',
      window,
      contents,
      appearance,
      primary,
      pinnedGeneration: null,
      context: { path: null, focus: null },
    };

    const fit = () => {
      const { width, height } = window.getContentBounds();

      contentsView.setBounds({ x: 0, y: 0, width, height });
    };
    fit();
    window.on('resize', fit);

    if (view.title !== undefined) {
      window.setTitle(view.title);
    } else {
      contents.on('page-title-updated', (_event, title) => {
        window.setTitle(title);
      });
    }

    if (keepsWindowButtons(appearance, platform)) {
      window.setWindowButtonVisibility(true);
    }

    // A view may navigate inside its own origin (the xpra HTML5 client
    // redirects itself to `connect.html`) and nowhere else.
    installViewNavigationGuard(contents, viewOriginOf(hostUrl, view.path));

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

    // A `WebContentsView`'s web contents are not destroyed with the window:
    // closing them here is what keeps them from leaking.
    window.once('closed', () => {
      registry.remove(entry, contents.id);

      if (!contents.isDestroyed()) {
        contents.close();
      }

      events?.closed?.(entry);
    });

    // No app renderer answers a load: reveal the window without waiting for a
    // `ready-to-show` a `BaseWindow` never emits.
    window.show();

    registry.add(entry);
    events?.created?.(entry);

    return entry;
  }
}
