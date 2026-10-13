// The technical desktop platform, composed (section 10): the `doric://app`
// protocol, the windows and menus main owns, the host bridge, the verified
// artifact cache, one desktopMain utility process per generation, the
// single IPC dispatcher and the splash and recovery surface.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CommandsV1,
  ContractError,
  type Diagnostics,
  type NotificationRequest,
} from 'bundle/contracts';
import {
  catalogSnapshot,
  catalogView,
  createPrincipal,
  type DistributionBundle,
  type DistributionCatalog,
  distributionArtifactSchema,
  distributionCatalogSchema,
  newTrace,
  PLATFORM_VERSION,
  ServiceDirectory,
  statesOf,
  type WireCall,
} from 'bundle/runtime';
import type { WindowChrome, WindowFailure, WindowMode } from 'desktop/protocol';
import {
  app,
  type BrowserWindow,
  ipcMain,
  Menu,
  MenuItem,
  nativeTheme,
  net,
  protocol,
  utilityProcess,
} from 'electron';

import { ConnectionRelay } from '../connection/relay';
import {
  cacheSchemaReader,
  type GenerationView,
  generationView,
} from './bridge/client-routing';
import { Dispatcher } from './bridge/dispatcher';
import {
  type BridgeSocket,
  connectBridgeSocket,
  createHostBridge,
  type HostBridge,
} from './bridge/host-bridge';
import { createSchemaValidators } from './bridge/validation';
import { ArtifactCache, type ArtifactFetch } from './catalog/artifacts';
import { type LoadOutcome, Startup } from './catalog/distribution';
import {
  type DesktopResolution,
  foundationIds,
  resolveDistribution,
} from './catalog/resolve';
import { loadCatalogSnapshot, saveCatalogSnapshot } from './catalog/snapshot';
import { provideBroker } from './generation/broker';
import { utilityTransport } from './generation/electron-transport';
import { encodeRunnerArguments } from './generation/module-hooks';
import { GenerationProcess } from './generation/process';
import { Lifecycle } from './lifecycle';
import { createPlatformLog, messageOf, type PlatformLog } from './log';
import { NativeMenus } from './menus/native-menus';
import { migrateStorageOrigin } from './migration/storage-origin';
import { cacheDirectory } from './native/cache';
import { type NotificationApi, showNotification } from './native/notifications';
import { desktopPaths } from './paths';
import {
  createDevProxy,
  DEFAULT_DEV_SERVER_ORIGIN,
} from './protocol/dev-proxy';
import { registerDoricProtocol } from './protocol/handler';
import {
  fileImportMap,
  generationImportMap,
  type ImportMap,
  platformImportMap,
} from './protocol/import-map';
import {
  type Resources,
  resourcesFor,
  shellPrefix,
  splashPath,
  splashPrefix,
} from './protocol/resources';
import { createShellRenderer } from './protocol/shell';
import { SplashStates } from './splash/state';
import { type Clock, systemClock } from './splash/timing';
import { openSplashWindow, type SplashWindow } from './splash/window';
import { DesktopState, WindowPaths } from './state';
import { loadWindowTokens, type WindowTokens } from './tokens';
import { chromeFor } from './windows/appearance';
import { CloseAnswers } from './windows/close';
import { NativeWindows } from './windows/native-windows';
import { type WindowEntry, WindowRegistry } from './windows/registry';

export interface DesktopPlatformOptions {
  /** The directory of the built `main.js` (`__dirname`). */
  readonly mainDir: string;
  readonly userData: string;
  readonly hostUrl: string;
  readonly packaged: boolean;
  readonly argv: readonly string[];
  readonly notifications: NotificationApi;
  readonly devServerOrigin?: string;
  readonly log?: PlatformLog;
  readonly clock?: Clock;
  /** Test seams. */
  readonly resources?: Resources;
  readonly socket?: BridgeSocket;
  readonly preload?: string;
  readonly runnerPath?: string;
  readonly flushDeadlineMs?: number;
  readonly platform?: NodeJS.Platform;
}

interface Live {
  readonly view: GenerationView;
  readonly process: GenerationProcess;
  /** `(hostId, hostBoot, host generation)` [S8-22]. */
  readonly key: string;
  readonly retained: readonly DistributionBundle[];
}

const PLATFORM_CALLER = (generation: number): WireCall['caller'] => ({
  bundleId: 'doric',
  version: PLATFORM_VERSION,
  generation,
});

const platformWire = (generation: number, deadline = 0): WireCall => ({
  caller: PLATFORM_CALLER(generation),
  trace: { traceparent: newTrace().traceparent },
  deadline,
  generation,
});

const hostKey = (catalog: DistributionCatalog): string =>
  `${catalog.storage?.hostId ?? ''}\u0000${catalog.hostBoot}\u0000${catalog.generation}`;

const decodeBase64 = (base64: string): Uint8Array =>
  new Uint8Array(Buffer.from(base64, 'base64'));

export class DesktopPlatform {
  readonly options: DesktopPlatformOptions;
  readonly log: PlatformLog;
  readonly resources: Resources;
  readonly tokens: WindowTokens;
  readonly registry = new WindowRegistry();
  readonly answers = new CloseAnswers();
  readonly splashStates = new SplashStates();
  readonly host: HostBridge;
  readonly cache: ArtifactCache;
  readonly windows: NativeWindows;
  readonly menus: NativeMenus;
  readonly dispatcher: Dispatcher;
  /** Stage 9: what windows read as the host connection status (D9-5). */
  readonly connection = new ConnectionRelay();
  readonly startup: Startup;
  readonly lifecycle: Lifecycle;
  readonly #paths;
  readonly #clock: Clock;
  readonly #validators = createSchemaValidators();
  readonly #kernel = new ServiceDirectory();
  readonly #kernelPrincipal;
  readonly #lives = new Map<number, Live>();
  readonly #pins = new Map<number, Set<number>>();
  readonly #localGenerations = new Map<string, number>();
  readonly #platformMap: ImportMap;
  readonly #preload: string;
  readonly #runnerPath: string;
  #state: DesktopState | undefined;
  #windowPaths: WindowPaths | undefined;
  #newest: number | undefined;
  #counter = 0;
  #splash: SplashWindow | undefined;
  #watching: (() => void) | undefined;
  #refreshing: Promise<void> | undefined;
  #lastGood:
    | { id: string; version: string; bundle: DistributionBundle }
    | undefined;

  constructor(options: DesktopPlatformOptions) {
    this.options = options;
    this.log = options.log ?? createPlatformLog();
    this.#clock = options.clock ?? systemClock;
    this.#paths = desktopPaths(options.userData);
    this.resources = options.resources ?? resourcesFor(options.mainDir);
    this.#preload = options.preload ?? join(options.mainDir, 'preload.js');
    this.#runnerPath =
      options.runnerPath ??
      join(options.mainDir, 'assets', 'generation-runner.mjs');
    this.tokens = loadWindowTokens(
      join(
        this.resources.platformRoot,
        `desktop@${PLATFORM_VERSION}`,
        'tokens.json',
      ),
    );
    this.#platformMap = platformImportMap(this.resources.platformRoot);
    this.cache = new ArtifactCache(this.#paths.bundles, this.#paths.staging);
    this.host = createHostBridge(
      options.socket ?? connectBridgeSocket(options.hostUrl),
    );
    this.#kernelPrincipal = createPrincipal(
      {
        directory: this.#kernel,
        catalog: catalogView({
          environment: 'desktopMain',
          generation: 0,
          composition: { core: '', enabled: [], providers: {} },
          issues: [],
          entries: [],
          order: [],
          contracts: [],
        }),
        environment: 'desktopMain',
        generation: 0,
        operationGeneration: 0,
        generationSignal: new AbortController().signal,
        report: (entry) => this.log.warn({ ...entry }, 'Platform report'),
      },
      {
        bundleId: 'doric',
        version: PLATFORM_VERSION,
        provides: 'any',
        requires: 'any',
      },
    );
    this.lifecycle = new Lifecycle({
      target: {
        run: (hook, input) => this.#runHook(hook, input),
      },
      log: this.log,
      quit: () => app.quit(),
      flush: async () => {
        await this.#windowPaths?.flush();
        await this.#state?.flush();
      },
    });
    this.menus = new NativeMenus({
      registry: this.registry,
      platform: options.platform ?? process.platform,
      newestGeneration: () => this.#newest,
      dispatch: (command, origin) => {
        void this.dispatchCommand(command, origin);
      },
      electron: {
        setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
        buildFromTemplate: (template) => Menu.buildFromTemplate(template),
        item: (itemOptions) => new MenuItem(itemOptions),
        ...((options.platform ?? process.platform) === 'darwin'
          ? {
              setDockMenu: (menu: Menu) => app.dock?.setMenu(menu),
            }
          : {}),
      },
      bindingsChanged: (entry) => this.dispatcher.bindingsChanged(entry),
    });
    this.windows = new NativeWindows({
      registry: this.registry,
      // The file opens in `prepare`; no window exists before it.
      paths: {
        get: (key) => this.#windowPaths?.get(key) ?? null,
        set: (key, path) => this.#windowPaths?.set(key, path),
        flush: async () => this.#windowPaths?.flush(),
      },
      tokens: this.tokens,
      preload: this.#preload,
      answers: this.answers,
      quitting: () => this.lifecycle.quitting,
      log: this.log,
      ...(options.flushDeadlineMs === undefined
        ? {}
        : { flushDeadlineMs: options.flushDeadlineMs }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      events: {
        created: (entry) => this.#created?.(entry),
        closed: (entry) => {
          this.#unpin(entry);

          // A held close cancels Electron's quit; once the window really
          // closed, the quit main decided goes on (section 17.3).
          if (this.lifecycle.quitting) {
            app.quit();
          }
        },
        focused: () => this.menus.rebuild(),
        navigating: (entry) => {
          this.dispatcher.navigating(entry.window.webContents.id);
          this.#unpin(entry);
        },
      },
    });
    provideBroker(this.#kernelPrincipal, {
      windows: this.windows,
      menus: this.menus,
      cacheDirectory: (bundleId) =>
        cacheDirectory(this.#paths.bundleCache, bundleId),
      migrateStorage: (request) =>
        migrateStorageOrigin(
          {
            state: this.state,
            packaged: this.options.packaged,
            legacyPage: join(
              this.options.mainDir,
              'assets',
              'legacy-origin.html',
            ),
            blankPath: this.blankPath(),
            log: this.log,
          },
          request,
        ),
      tokens: () => this.tokens.variables(),
      notify: (request: NotificationRequest) => this.notify(request),
      log: this.log,
    });
    this.dispatcher = new Dispatcher({
      registry: this.registry,
      validators: this.#validators,
      host: this.host,
      log: this.log,
      splashContents: () => this.#splash?.contentsId,
      splashStates: this.splashStates,
      splashAct: (action) => this.startup.act(action),
      view: (generation) => this.#lives.get(generation)?.view,
      process: (generation) => this.#lives.get(generation)?.process,
      pinWindow: (entry, generation) => this.#pin(entry, generation),
      chrome: (entry) => this.chrome(entry),
      tokens: () => this.tokens.variables(),
      answerClose: (id, answer) => this.answers.answer(id, answer),
      windowReady: () => this.startup.windowReady(),
      windowFailure: (entry, failure) => this.#windowFailure(entry, failure),
      bindingsFor: (entry) => this.menus.bindingsFor(entry),
      dispatchCommand: (command, origin) =>
        this.dispatchCommand(command, origin),
      diagnostic: (entry, diagnostic) =>
        this.log.info(
          { windowKey: entry.key, diagnostic },
          'Window diagnostic',
        ),
      connection: this.connection,
    });
    const host = this.host;

    this.startup = new Startup({
      clock: this.#clock,
      splash: {
        set: (state) => this.splashStates.set(state),
        open: () => this.#openSplash(),
        close: () => this.#closeSplash(),
      },
      host: {
        url: options.hostUrl,
        get connected() {
          return host.connected;
        },
        onStatus: (listener) => host.onStatus(listener),
        retry: () => host.retry(),
      },
      log: this.log,
      recovery: options.argv.includes('--recovery'),
      hasSnapshot: async () =>
        (await loadCatalogSnapshot(this.#paths.catalogSnapshot)) !== undefined,
      hasLastGoodCore: () => this.#lastGood !== undefined,
      load: (input) => this.#load(input.mode, input.step),
      appReady: async () => {
        await this.#runHook('onAppReadyHook', {});
      },
      disable: async (bundleId) => {
        await this.host.call(
          {
            contract: 'doric.catalog/v1',
            method: 'disable',
            input: { bundleId },
          },
          platformWire(0),
        );
      },
      resetComposition: async () => {
        await this.host.call(
          {
            contract: 'doric.catalog/v1',
            method: 'resetComposition',
            input: [],
          },
          platformWire(0),
        );
      },
      diagnostics: () => this.diagnostics(),
    });
  }

  #created: ((entry: WindowEntry) => void) | undefined;

  /** Called for every window main creates (legacy connection push, …). */
  onWindowCreated(listener: (entry: WindowEntry) => void): void {
    this.#created = listener;
  }

  get newestGeneration(): number | undefined {
    return this.#newest;
  }

  get mode(): WindowMode {
    return this.#newest === undefined
      ? 'connected'
      : (this.#lives.get(this.#newest)?.view.mode ?? 'connected');
  }

  /** Whether host calls may cross (legacy channels included). */
  hostAvailable(): boolean {
    return this.mode !== 'last-good-core';
  }

  diagnostics(): Diagnostics | undefined {
    return this.#newest === undefined
      ? undefined
      : this.#lives.get(this.#newest)?.process.diagnostics;
  }

  chrome(entry: WindowEntry | undefined): WindowChrome {
    return chromeFor(
      entry?.appearance.titleBar ?? 'none',
      this.tokens,
      entry?.window.isFullScreen(),
    );
  }

  generationOf(generation: number): Live | undefined {
    return this.#lives.get(generation);
  }

  notify(request: NotificationRequest): void {
    showNotification(request, {
      api: this.options.notifications,
      log: (error) => this.log.error({ error }, 'Notification failed'),
    });
  }

  /** Opens state, registers the protocol and the dispatcher. */
  async prepare(): Promise<void> {
    this.#state = await DesktopState.open(this.#paths.state);
    this.#windowPaths = await WindowPaths.open(this.#paths.windows);

    const stored = this.#state.data.lastGoodCore;

    if (
      stored !== undefined &&
      typeof stored.bundle === 'object' &&
      stored.bundle !== null
    ) {
      this.#lastGood = {
        id: stored.id,
        version: stored.version,
        bundle: stored.bundle as DistributionBundle,
      };
    }

    const devServerOrigin =
      this.options.devServerOrigin ?? DEFAULT_DEV_SERVER_ORIGIN;
    const devProxy = this.options.packaged
      ? undefined
      : createDevProxy({
          origin: devServerOrigin,
          shellPrefix: shellPrefix(this.resources),
          fetch: (url) => net.fetch(url),
        });
    const shellRenderer = createShellRenderer({
      mode: this.options.packaged ? 'packaged' : 'development',
      template:
        devProxy === undefined
          ? async () => {
              const { readFile } = await import('node:fs/promises');

              return await readFile(
                join(this.resources.shellRoot, 'shell.html'),
                'utf8',
              );
            }
          : () => devProxy.template(),
      generation: () => this.#newest ?? null,
      importMap: (generation) => this.#importMap(generation),
      themeHref: `/platform/desktop@${PLATFORM_VERSION}/theme.css`,
      devServerOrigin,
    });

    registerDoricProtocol(protocol, {
      resources: this.resources,
      shell: shellRenderer,
      bundles: this.cache,
      ...(devProxy === undefined ? {} : { devProxy }),
    });
    ipcMain.handle('doric:desktop', (event, request: unknown) =>
      this.dispatcher.handle(event as never, request),
    );
    this.host.onStatus((status) => {
      this.lifecycle.connectionChanged(status.connected);

      if (status.connected && this.startup.appReadyFired) {
        this.#watch();
        void this.refresh();
      }

      if (!status.connected) {
        this.#watching?.();
        this.#watching = undefined;
      }
    });
  }

  /** The state store (after `prepare`). */
  get state(): DesktopState {
    if (this.#state === undefined) {
      throw new Error('The desktop platform was not started.');
    }

    return this.#state;
  }

  #importMap(generation: number | null): ImportMap {
    const live = generation === null ? undefined : this.#lives.get(generation);

    if (live === undefined) {
      return this.#platformMap;
    }

    return generationImportMap(
      this.#platformMap,
      live.retained
        .filter((bundle) => bundle.parts.contracts !== undefined)
        .map((bundle) => ({
          id: bundle.id,
          version: bundle.version,
          entry: bundle.parts.contracts as string,
        })),
    );
  }

  /**
   * Opens the splash, then the startup up to `onAppReadyHook`, where the core
   * asks for its storage migrations before it opens the primary window.
   */
  async start(): Promise<void> {
    this.#openSplash();
    await this.startup.run();
    this.#watch();
  }

  #openSplash(): void {
    if (this.#splash !== undefined) {
      this.#splash.window.focus();

      return;
    }

    this.#splash = openSplashWindow({
      backgroundColor: this.tokens.color(
        'window',
        nativeTheme.shouldUseDarkColors,
      ),
      preload: this.#preload,
      path: splashPath(this.resources),
      closed: () => {
        this.#splash = undefined;
      },
    });
  }

  #closeSplash(): void {
    this.#splash?.close();
    this.#splash = undefined;
  }

  get splashWindow(): BrowserWindow | undefined {
    return this.#splash?.window;
  }

  /** The `doric://app` path of a static page next to the splash. */
  blankPath(): string {
    return `${splashPrefix(this.resources)}blank.html`;
  }

  async #runHook(
    hook:
      | 'onAppReadyHook'
      | 'onAppActivateHook'
      | 'onBeforeQuitHook'
      | 'onConnectionChangedHook'
      | 'onGenerationReadyHook',
    input: unknown,
    generation = this.#newest,
  ): Promise<unknown> {
    const live =
      generation === undefined ? undefined : this.#lives.get(generation);

    if (live === undefined) {
      return hook === 'onBeforeQuitHook' ? { allow: true } : undefined;
    }

    return await live.process.lifecycle(hook, input);
  }

  /** `app.on('activate')` with no window of a key (P12). */
  async activate(): Promise<void> {
    if (!this.startup.appReadyFired || this.registry.all().length > 0) {
      return;
    }

    await this.lifecycle.appActivate();
  }

  // Generations ----------------------------------------------------------------

  #allocate(catalog: DistributionCatalog, mode: WindowMode): number {
    const key = `${mode}\u0000${hostKey(catalog)}`;
    const known = this.#localGenerations.get(key);

    if (known !== undefined && this.#lives.has(known)) {
      return known;
    }

    this.#counter += 1;
    this.#localGenerations.set(key, this.#counter);

    return this.#counter;
  }

  async #catalogFor(mode: WindowMode): Promise<DistributionCatalog> {
    if (mode === 'connected') {
      const raw = await this.host.call(
        { contract: 'doric.catalog/v1', method: 'distribution', input: [] },
        platformWire(0),
      );

      return distributionCatalogSchema.parse(raw);
    }

    const snapshot = await loadCatalogSnapshot(this.#paths.catalogSnapshot);
    const live =
      mode === 'last-good-core' && this.host.connected
        ? await this.#catalogFor('connected').catch(() => undefined)
        : undefined;
    const base = live ?? snapshot;

    if (base === undefined) {
      throw new ContractError(
        'not_found',
        'No catalog snapshot was saved yet.',
      );
    }

    if (mode === 'disconnected-copy') {
      return base;
    }

    const lastGood = this.#lastGood;

    if (lastGood === undefined) {
      throw new ContractError('not_found', 'No core has activated yet.');
    }

    return {
      ...base,
      composition: { ...base.composition, core: lastGood.id },
      bundles: [
        ...base.bundles.filter((bundle) => bundle.id !== lastGood.id),
        lastGood.bundle,
      ],
    };
  }

  /** Loads, verifies, resolves and activates one generation. */
  async #load(
    mode: WindowMode,
    step: (
      step: 'catalog' | 'download' | 'verify' | 'activation',
      progress?: { done: number; total: number },
    ) => void,
  ): Promise<LoadOutcome> {
    step('catalog');

    const catalog = await this.#catalogFor(mode);
    const lastGood = mode === 'last-good-core' ? this.#lastGood : undefined;
    const only =
      lastGood === undefined
        ? undefined
        : {
            core: lastGood.id,
            ids: new Set([...foundationIds(catalog), lastGood.id]),
          };
    const bundles = catalog.bundles.filter(
      (bundle) =>
        bundle.state !== 'disabled' &&
        (only === undefined || only.ids.has(bundle.id)),
    );
    const fetch: ArtifactFetch =
      mode === 'connected'
        ? async (sha256) => {
            const raw = await this.host.call(
              {
                contract: 'doric.catalog/v1',
                method: 'artifact',
                input: { sha256 },
              },
              platformWire(0),
            );

            return decodeBase64(distributionArtifactSchema.parse(raw).base64);
          }
        : () =>
            Promise.reject(
              new ContractError('unavailable', 'The host is not connected.'),
            );

    step('verify');

    const ensured = await this.cache.ensure(bundles, fetch, (progress) => {
      if (progress.downloading) {
        step('download', { done: progress.done, total: progress.total });
      }
    });

    step('activation');

    const generation = this.#allocate(catalog, mode);
    const resolution = resolveDistribution(
      catalog,
      generation,
      ensured.failed,
      only === undefined ? {} : { only },
    );

    if (mode === 'connected') {
      for (const quarantine of resolution.quarantines) {
        void this.host
          .call(
            {
              contract: 'doric.diagnostics/v1',
              method: 'report',
              input: {
                bundleId: quarantine.id,
                kind: 'desktop_quarantine',
                message: quarantine.reasons
                  .map((reason) => reason.message)
                  .join('; '),
                details: {
                  version: quarantine.version,
                  reasons: quarantine.reasons,
                },
              },
            },
            platformWire(generation),
          )
          .catch((error: unknown) =>
            this.log.warn(
              { bundleId: quarantine.id, error: messageOf(error) },
              'Desktop quarantine report failed',
            ),
          );
      }
    }

    const core = catalog.bundles.find(
      (bundle) => bundle.id === resolution.desktopMain.composition.core,
    );
    const coreRef = {
      id: resolution.desktopMain.composition.core,
      version: core?.version ?? '',
    };

    if (resolution.desktopMain.recovery !== undefined) {
      return {
        kind: 'core-failure',
        core: coreRef,
        error: resolution.desktopMain.recovery.reason,
      };
    }

    this.cache.retain(generation, bundles);

    const view = generationView({
      generation,
      mode,
      catalog,
      resolution,
      read: cacheSchemaReader((bundle, path) =>
        this.cache.pathOf(bundle, path),
      ),
    });
    const process = this.#spawn(generation, catalog, resolution, bundles);
    const activation = await process.start();

    if (!activation.ok) {
      await process.stop(1_000);
      this.cache.release(generation);

      return {
        kind: 'core-failure',
        core: coreRef,
        error: activation.error ?? 'The core desktopMain part failed.',
      };
    }

    const live: Live = {
      view,
      process,
      key: hostKey(catalog),
      retained: bundles,
    };
    const previous = this.#newest;

    this.#lives.set(generation, live);
    this.#newest = generation;

    if (mode === 'connected') {
      await saveCatalogSnapshot(this.#paths.catalogSnapshot, catalog).catch(
        (error: unknown) =>
          this.log.warn(
            { error: messageOf(error) },
            'Catalog snapshot was not saved',
          ),
      );
    }

    const coreState = activation.diagnostics?.bundles.find(
      (bundle) => bundle.id === coreRef.id,
    )?.state;

    if (
      core !== undefined &&
      core.parts.desktopMain !== undefined &&
      coreState === 'active'
    ) {
      this.#lastGood = { id: core.id, version: core.version, bundle: core };
      await this.state
        .update((data) => ({
          ...data,
          lastGoodCore: {
            id: core.id,
            version: core.version,
            generation,
            bundle: core,
          },
        }))
        .catch(() => undefined);
    }

    if (previous !== undefined && previous !== generation) {
      this.#maybeRelease(previous);
    }

    return { kind: 'ready', generation, quarantines: resolution.quarantines };
  }

  #spawn(
    generation: number,
    catalog: DistributionCatalog,
    resolution: DesktopResolution,
    bundles: readonly DistributionBundle[],
  ): GenerationProcess {
    const imports: Record<string, string> = {
      ...fileImportMap(this.#platformMap, this.resources.platformRoot),
      // One contracts instance per generation, shared with the runner.
      'bundle/contracts': pathToFileURL(
        join(this.#runnerPath, '..', 'generation-contracts.mjs'),
      ).href,
    };
    const parts: Record<string, string> = {};

    for (const bundle of bundles) {
      if (bundle.parts.contracts !== undefined) {
        const file = this.cache.pathOf(bundle, bundle.parts.contracts);

        if (file !== undefined) {
          imports[`${bundle.id}/contracts`] = pathToFileURL(file).href;
        }
      }
    }

    for (const entry of resolution.desktopMain.entries) {
      const bundle = bundles.find((candidate) => candidate.id === entry.id);
      const path = bundle?.parts.desktopMain;

      if (
        entry.state === 'scheduled' &&
        bundle !== undefined &&
        path !== undefined
      ) {
        const file = this.cache.pathOf(bundle, path);

        if (file !== undefined) {
          parts[entry.id] = pathToFileURL(file).href;
        }
      }
    }

    const diagnostics = statesOf({
      generation,
      mode: 'normal',
      issues: [],
      bundles: [],
      errors: [],
      consumers: {},
    });
    const snapshot = catalogSnapshot(
      resolution.desktopMain,
      diagnostics,
      catalog.storage,
    );

    return new GenerationProcess({
      generation,
      resolved: resolution.desktopMain,
      catalog: snapshot,
      kernel: this.#kernel,
      kernelPrincipal: this.#kernelPrincipal,
      validators: this.#validators,
      log: this.log,
      spawn: () => {
        const child = utilityProcess.fork(
          this.#runnerPath,
          [
            encodeRunnerArguments({
              imports,
              parts,
              moduleRoots: [
                `${pathToFileURL(this.resources.platformRoot).href}/`,
                `${pathToFileURL(this.cache.root).href}/`,
              ],
            }),
          ],
          { serviceName: `Doric desktopMain g${generation}`, stdio: 'inherit' },
        );

        return {
          transport: utilityTransport(child),
          kill: () => {
            child.kill();
          },
        };
      },
      diagnostics: (next) => this.#diagnosticsChanged(generation, next),
      lost: () => this.menus.dropGeneration(generation),
      respawned: () => this.menus.rebuild(),
    });
  }

  #diagnosticsChanged(generation: number, diagnostics: Diagnostics): void {
    for (const bundle of diagnostics.bundles) {
      if (bundle.state !== 'active') {
        this.menus.dropOwner(generation, bundle.id);
      }
    }
  }

  #pin(entry: WindowEntry, generation: number): boolean {
    if (!this.#lives.has(generation)) {
      return false;
    }

    entry.pinnedGeneration = generation;

    const pins = this.#pins.get(generation) ?? new Set<number>();

    pins.add(entry.window.webContents.id);
    this.#pins.set(generation, pins);
    this.menus.rebuild();
    this.dispatcher.bindingsChanged(entry);

    return true;
  }

  #unpin(entry: WindowEntry): void {
    const generation = entry.pinnedGeneration;

    if (generation === null) {
      return;
    }

    entry.pinnedGeneration = null;

    const pins = this.#pins.get(generation);

    if (pins !== undefined) {
      for (const id of [...pins]) {
        if (
          this.registry.byWebContents(id) === entry ||
          this.registry.byWebContents(id) === undefined
        ) {
          pins.delete(id);
        }
      }
    }

    this.#maybeRelease(generation);
  }

  /** An older generation stops once no window pins it (decision 76). */
  #maybeRelease(generation: number): void {
    if (generation === this.#newest) {
      return;
    }

    const pins = this.#pins.get(generation);

    if (pins !== undefined && pins.size > 0) {
      return;
    }

    const live = this.#lives.get(generation);

    if (live === undefined) {
      return;
    }

    this.#lives.delete(generation);
    this.#pins.delete(generation);
    this.menus.dropGeneration(generation, { skeleton: true });
    this.cache.release(generation);
    void live.process
      .stop()
      .then(() =>
        this.cache.collect(
          this.#lastGood === undefined ? [] : [this.#lastGood],
        ),
      );
  }

  /** `doric.catalog/v1.watch()`: a new host generation loads in the background. */
  #watch(): void {
    if (this.#watching !== undefined || !this.host.connected) {
      return;
    }

    this.#watching = this.host.subscribe(
      { contract: 'doric.catalog/v1', method: 'watch', input: [] },
      platformWire(0),
      {
        event: () => {
          void this.refresh();
        },
        end: () => {
          this.#watching = undefined;
        },
      },
    );
  }

  /**
   * Loads the live distribution as a new generation when it differs from the
   * newest one; the new process gets `onGenerationReadyHook`, existing windows
   * stay pinned and nothing reloads.
   */
  refresh(): Promise<void> {
    this.#refreshing ??= (async () => {
      try {
        if (!this.host.connected || !this.startup.appReadyFired) {
          return;
        }

        const newest =
          this.#newest === undefined
            ? undefined
            : this.#lives.get(this.#newest);
        const raw = await this.host.call(
          { contract: 'doric.catalog/v1', method: 'distribution', input: [] },
          platformWire(0),
        );
        const catalog = distributionCatalogSchema.parse(raw);

        if (
          newest !== undefined &&
          newest.view.mode === 'connected' &&
          newest.key === hostKey(catalog)
        ) {
          return;
        }

        const outcome = await this.#load('connected', () => undefined);

        if (outcome.kind === 'ready') {
          await this.#runHook(
            'onGenerationReadyHook',
            { generation: outcome.generation },
            outcome.generation,
          ).catch((error: unknown) =>
            this.log.error(
              { error: messageOf(error) },
              'onGenerationReadyHook failed',
            ),
          );
        } else {
          this.log.error({ outcome }, 'A new generation did not activate');
        }
      } catch (error) {
        this.log.warn(
          { error: messageOf(error) },
          'The catalog refresh failed',
        );
      } finally {
        this.#refreshing = undefined;
      }
    })();

    return this.#refreshing;
  }

  // Commands -------------------------------------------------------------------

  /**
   * Menu and keybinding dispatch (decision 77, section 18.3): the focused
   * window's desktopMain registry, then its client registry, then
   * diagnostics.
   */
  async dispatchCommand(
    command: string,
    origin: { readonly windowKey: string | null },
  ): Promise<void> {
    const entry =
      (origin.windowKey === null
        ? undefined
        : this.registry.byKey(origin.windowKey)) ?? this.registry.focused();
    const generation = entry?.pinnedGeneration ?? this.#newest;
    const live =
      generation === undefined ? undefined : this.#lives.get(generation);

    if (live !== undefined) {
      try {
        await live.process.services
          .use(CommandsV1)
          .execute(
            command as `${string}/v${number}`,
            {},
            live.process.call(
              entry === undefined ? {} : { windowKey: entry.key },
            ),
          );

        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          (error as { code?: unknown }).code !== 'unknown_command'
        ) {
          this.log.error(
            { command, error: messageOf(error) },
            'Command failed',
          );

          return;
        }
      }
    }

    if (entry !== undefined && this.dispatcher.servesCommands(entry)) {
      const result = await this.dispatcher.runClientCommand(entry, command);

      if (result.ok) {
        return;
      }

      if (result.error.code !== 'unknown_command') {
        this.log.error(
          { command, error: result.error.message },
          'Command failed',
        );

        return;
      }
    }

    this.log.warn(
      { command, kind: 'command_not_found' },
      'No registry has this command',
    );
  }

  /**
   * Executes the command `id` (with `input`, `{}` by default) in the newest
   * generation's desktopMain `commands/v1`. Tests use it to drive a command
   * the way a menu or keybinding does.
   */
  async runCommand(id: string, input: unknown = {}): Promise<void> {
    const generation = this.#newest;
    const live =
      generation === undefined ? undefined : this.#lives.get(generation);

    if (live === undefined) {
      throw new Error('Doric is still starting.');
    }

    await live.process.services
      .use(CommandsV1)
      .execute(id as `${string}/v${number}`, input, live.process.call());
  }

  #windowFailure(entry: WindowEntry, failure: WindowFailure): void {
    this.log.error({ windowKey: entry.key, ...failure }, 'Window failure');

    if (entry.primary && failure.kind === 'core') {
      const live =
        entry.pinnedGeneration === null
          ? undefined
          : this.#lives.get(entry.pinnedGeneration);
      const coreId =
        failure.bundleId ?? live?.view.resolution.client.composition.core ?? '';
      const core = live?.view.bundles.get(coreId);

      this.startup.coreFailed(
        { id: coreId, version: core?.version ?? '' },
        failure.message,
      );
    }
  }

  /**
   * Tears the platform down in this process (tests): windows, generations,
   * the bridge, the IPC handler and the protocol.
   */
  async dispose(): Promise<void> {
    for (const entry of this.registry.all()) {
      if (!entry.window.isDestroyed()) {
        entry.window.destroy();
      }
    }

    this.#closeSplash();
    await this.stop();
    ipcMain.removeHandler('doric:desktop');
    protocol.unhandle('doric');
  }

  /** Stops every generation (quit). */
  async stop(): Promise<void> {
    this.#watching?.();
    this.host.close();
    await Promise.all(
      [...this.#lives.values()].map((live) => live.process.stop()),
    );
    await this.#windowPaths?.flush();
    await this.#state?.flush();
  }
}

export type { Live as LiveGeneration };
