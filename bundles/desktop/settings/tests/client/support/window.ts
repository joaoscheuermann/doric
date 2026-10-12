// One real settings window in this process: a happy-dom window as the
// globals, the window platform of `desktop-client`, the core's client part
// and the settings client part exactly as their builds ship them. The
// boundaries faked are the preload API (`window.doric.desktop`) and, behind
// it, the host contracts the bridge reaches: a test answers them as the host
// would and reads what they were asked.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Activate } from 'bundle/contracts';
import {
  type CatalogCandidate,
  type Descriptor,
  type ManifestV1,
  resolveEnvironment,
} from 'bundle/runtime';
import {
  type BridgeCallEnvelope,
  type BridgeResultPayload,
  bootstrapWindow,
  type CloseAnswer,
  type CloseRequest,
  type DoricDesktopApi,
  type RemoteContract,
  remoteMethodSpecFromSchema,
  type WindowCatalog,
} from 'desktop-client';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIST = resolve(here, '../../../../dist');
const CORE_DIST = resolve(
  dirname(fileURLToPath(import.meta.resolve('core/package.json'))),
  'dist',
);

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** What the host answers for one `<contract>.<method>`. */
export type HostAnswer = (input: unknown) => unknown;

/** The host contracts the settings part requires, with their call shapes. */
const hostContracts: Readonly<
  Record<string, Readonly<Record<string, number | null>>>
> = {
  'host-config/v1': { current: 0, replace: null },
  'models/v1': { kinds: 0, kind: 1, catalog: null },
  'tools/v1': { catalog: 0 },
  'secrets/v1': { list: 0, create: null, update: 2, delete: null },
};

const hostCandidate: CatalogCandidate = {
  id: 'host',
  source: { kind: 'installed', dir: 'host@1.0.0' },
  manifest: {
    manifestVersion: 1,
    id: 'host',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: [
      'storage.backend/v1@1.0.0',
      'secrets.backend/v1@1.0.0',
      'host-config/v1@1.0.0',
    ],
    requires: [],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'host', version: '1.0.0' },
    contracts: [
      'storage.backend/v1',
      'secrets.backend/v1',
      'host-config/v1',
    ].map((id) => ({
      id,
      version: '1.0.0',
      kind: 'service' as const,
      environment: 'host' as const,
      cardinality: 'one' as const,
      local: false,
      schema: `schemas/${id}.json`,
    })),
  },
  errors: [],
};

/** The core's desktopMain contracts as main routes them to a window. */
const coreRemote = async (
  manifest: ManifestV1,
  descriptor: Descriptor,
): Promise<RemoteContract[]> => {
  const remote: RemoteContract[] = [];

  for (const entry of descriptor.contracts) {
    if (entry.environment !== 'desktopMain') continue;

    const document = (await readJson(resolve(CORE_DIST, entry.schema))) as {
      readonly $defs?: Record<string, Record<string, unknown>>;
    };
    const defs = document.$defs ?? {};
    const methods: Record<
      string,
      ReturnType<typeof remoteMethodSpecFromSchema>
    > = {};

    for (const key of Object.keys(defs)) {
      const name = /^(.+)\.input$/.exec(key)?.[1];

      if (name !== undefined) {
        methods[name] = remoteMethodSpecFromSchema(
          (defs[key] ?? {}) as never,
          (defs[`${name}.output`] ?? {}) as never,
        );
      }
    }

    remote.push({
      id: entry.id,
      environment: 'desktopMain',
      bundleId: manifest.id,
      version: manifest.version,
      contractVersion: entry.version,
      cardinality: entry.cardinality,
      methods,
    });
  }

  return remote;
};

const hostRemote = (): RemoteContract[] =>
  Object.entries(hostContracts).map(([id, methods]) => ({
    id,
    environment: 'host',
    bundleId: id === 'host-config/v1' ? 'host' : 'core',
    version: '1.0.0',
    contractVersion: '1.0.0',
    cardinality: 'one',
    methods: Object.fromEntries(
      Object.entries(methods).map(([name, tuple]) => [
        name,
        { tuple, local: false, stream: false },
      ]),
    ),
  }));

const partUrl = (id: string, version: string): string =>
  `doric://app/bundles/${id}@${version}/client/index.js`;

/** Window globals the parts and React reach for, copied from happy-dom. */
const globalNames = (window: Window): string[] => [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'customElements',
  'MutationObserver',
  'getComputedStyle',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'innerWidth',
  'innerHeight',
  ...Object.getOwnPropertyNames(window).filter((name) =>
    /^(HTML|SVG)\w*Element$|^\w*Event$|^(Node|Element|Text|Comment|DocumentFragment|ShadowRoot|Range|Selection|DOMRect|ResizeObserver|IntersectionObserver)$/.test(
      name,
    ),
  ),
];

let imports = 0;

export interface SettingsWindow {
  readonly window: Window;
  readonly document: Document;
  /** Bridge calls of one `<contract>.<method>`, in order. */
  received(method: string): readonly BridgeCallEnvelope[];
  /** Main asks the window to close (one phase). */
  requestClose(request: CloseRequest): Promise<CloseAnswer | undefined>;
  close(): Promise<void>;
}

/** Waits for queued microtasks, immediates and short timers. */
export const settle = async (milliseconds = 0): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
  if (milliseconds > 0) {
    await new Promise<void>((done) => setTimeout(done, milliseconds));
    await settle();
  }
};

/** Boots the core and the settings part at `url`, answering `host` calls. */
/** Another bundle's client part in the window (a section it adds). */
export interface ProbeBundle {
  readonly requires: readonly string[];
  readonly activate: Activate;
}

const PROBE_VERSION = '1.0.0';

export const openSettingsWindow = async (input: {
  readonly url?: string;
  readonly host: Readonly<Record<string, HostAnswer>>;
  readonly probe?: ProbeBundle;
}): Promise<SettingsWindow> => {
  const window = new Window({
    url: input.url ?? 'doric://app/settings',
    width: 1280,
    height: 800,
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  const names = globalNames(window);
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );

  for (const name of names) {
    const value = (window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        typeof value === 'function' && !/^[A-Z]/.test(name)
          ? (value as (...args: unknown[]) => unknown).bind(window)
          : value,
    });
  }

  const coreManifest = (await readJson(
    resolve(CORE_DIST, 'manifest.json'),
  )) as ManifestV1;
  const coreDescriptor = (await readJson(
    resolve(CORE_DIST, 'contracts.json'),
  )) as Descriptor;
  const settingsManifest = (await readJson(
    resolve(SETTINGS_DIST, 'manifest.json'),
  )) as ManifestV1;
  const settingsDescriptor = (await readJson(
    resolve(SETTINGS_DIST, 'contracts.json'),
  )) as Descriptor;

  // Fresh module instances per window: their element classes extend this
  // window's HTMLElement.
  imports += 1;
  const load = async (dist: string) =>
    (await import(
      `${pathToFileURL(resolve(dist, 'client/index.js')).href}?window=${imports}`
    )) as { activate: Activate };
  const core = await load(CORE_DIST);
  const settings = await load(SETTINGS_DIST);

  const resolved = resolveEnvironment(
    {
      candidates: [
        {
          id: 'core',
          source: { kind: 'installed', dir: `core@${coreManifest.version}` },
          manifest: coreManifest,
          descriptor: coreDescriptor,
          errors: [],
        },
        hostCandidate,
        {
          id: 'settings',
          source: {
            kind: 'installed',
            dir: `settings@${settingsManifest.version}`,
          },
          manifest: settingsManifest,
          descriptor: settingsDescriptor,
          errors: [],
        },
        ...(input.probe === undefined
          ? []
          : [
              {
                id: 'probe',
                source: {
                  kind: 'installed' as const,
                  dir: `probe@${PROBE_VERSION}`,
                },
                manifest: {
                  manifestVersion: 1 as const,
                  id: 'probe',
                  version: PROBE_VERSION,
                  engines: { doric: '^1.0.0' },
                  provides: [],
                  requires: [...input.probe.requires],
                } as unknown as ManifestV1,
                descriptor: {
                  descriptorVersion: 1 as const,
                  bundle: { id: 'probe', version: PROBE_VERSION },
                  contracts: [],
                } as unknown as Descriptor,
                errors: [],
              },
            ]),
      ],
      composition: {
        core: 'core',
        enabled: [
          'core',
          'host',
          'settings',
          ...(input.probe === undefined ? [] : ['probe']),
        ],
        providers: {},
      },
      platformVersion: '1.0.0',
      generation: 3,
    },
    'client',
  );
  const catalog: WindowCatalog = {
    generation: 3,
    resolved,
    parts: {
      core: { entry: partUrl('core', coreManifest.version) },
      settings: { entry: partUrl('settings', settingsManifest.version) },
      ...(input.probe === undefined
        ? {}
        : { probe: { entry: partUrl('probe', PROBE_VERSION) } }),
    },
    remote: [
      ...(await coreRemote(coreManifest, coreDescriptor)),
      ...hostRemote(),
    ],
    hostId: 'host-1',
    storageGeneration: 1,
  };
  const calls: BridgeCallEnvelope[] = [];
  let closeHandler:
    | ((request: CloseRequest) => Promise<CloseAnswer | undefined>)
    | undefined;

  const answer = async (
    envelope: BridgeCallEnvelope,
  ): Promise<BridgeResultPayload> => {
    const handler = input.host[`${envelope.contract}.${envelope.method}`];

    if (handler === undefined) return { ok: true, output: undefined };

    try {
      return { ok: true, output: await handler(envelope.input) };
    } catch (error) {
      const failure = error as { code?: string; message?: string };

      return {
        ok: false,
        error: {
          code: failure.code ?? 'internal',
          message: failure.message ?? 'failed',
        },
      };
    }
  };

  const desktop: DoricDesktopApi = {
    describeWindow: async () => ({
      key: 'settings',
      kind: 'window',
      primary: false,
      path: window.location.pathname,
      generation: 3,
      chrome: {
        titleBar: 'integrated',
        height: 36,
        safeArea: { top: 0, left: 80, right: 0 },
      },
      mode: 'connected',
      tokens: {},
    }),
    ready: async () => undefined,
    reportFailure: async () => undefined,
    onCloseRequested: (handler) => {
      closeHandler = handler;

      return () => {
        closeHandler = undefined;
      };
    },
    onChromeChanged: () => () => undefined,
    catalog: async () => catalog,
    call: async (envelope) => {
      calls.push(envelope);

      return envelope.contract === 'doric.shell/v1'
        ? { ok: true, output: undefined }
        : answer(envelope);
    },
    cancel: () => undefined,
    subscribe: () => () => undefined,
  };
  const modules: Record<string, { activate?: Activate }> = {
    [partUrl('core', coreManifest.version)]: core,
    [partUrl('settings', settingsManifest.version)]: settings,
    ...(input.probe === undefined
      ? {}
      : {
          [partUrl('probe', PROBE_VERSION)]: { activate: input.probe.activate },
        }),
  };

  await bootstrapWindow({
    desktop,
    document: window.document as unknown as Document,
    importPart: async (url) => {
      const module = modules[url];

      if (module === undefined) throw new Error(`No module at ${url}`);

      return module;
    },
    elementRegistry: () =>
      window.customElements as unknown as CustomElementRegistry,
    keyTarget: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  await settle();

  return {
    window,
    document: window.document as unknown as Document,
    received: (method) =>
      calls.filter(
        (envelope) => `${envelope.contract}.${envelope.method}` === method,
      ),
    requestClose: async (request) => {
      if (closeHandler === undefined) {
        throw new Error('The window registered no close handler.');
      }

      return closeHandler(request);
    },
    close: async () => {
      // React roots unmount while the window globals still exist.
      window.document.body.replaceChildren();
      await settle(10);
      await window.happyDOM.abort();
      await window.happyDOM.close();
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) {
          delete globals[name];
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
    },
  };
};
