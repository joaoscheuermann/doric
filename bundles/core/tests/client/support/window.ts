// One real window of the desktop client in this process: a happy-dom window
// as the globals, the window platform of `desktop-client` (bootstrap,
// activation, doric.elements/v1), the core's client part exactly as its build
// ships it, and probe bundles. The preload API (`window.doric.desktop`) is
// the faked boundary: it answers the bridge calls of the remote contracts the
// way main would and records them.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  Activate,
  ClientContext,
  JsonObject,
  Services,
} from 'bundle/contracts';
import {
  type CatalogCandidate,
  type Descriptor,
  type ManifestV1,
  manifestV1Schema,
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
  type WindowFailure,
} from 'desktop-client';
import { Window } from 'happy-dom';

const DIST = 'bundles/core/dist';

const names = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'HTMLElement',
  'HTMLAnchorElement',
  'Node',
  'Element',
  'ShadowRoot',
  'Event',
  'MouseEvent',
  'PopStateEvent',
  'customElements',
  'MutationObserver',
] as const;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** A client bundle of the window besides the core. */
export interface Probe {
  readonly id: string;
  /** Contracts it uses from the core (`<id>@^1.0.0`). */
  readonly requires?: readonly string[];
  /** Commands it registers in the client. */
  readonly commands?: readonly string[];
  readonly activate?: Activate<ClientContext>;
}

/** A probe that keeps its activation services and runs `then` with them. */
export const probe = (
  id: string,
  then: (services: Services) => void = () => undefined,
  requires: readonly string[] = [
    'ui/v1@^1.0.0',
    'navigation/v1@^1.0.0',
    'regions/v1@^1.0.0',
    'commands/v1@^1.0.0',
    'hooks/v1@^1.0.0',
    'log/v1@^1.0.0',
  ],
  commands: readonly string[] = [],
): Probe & { services(): Services } => {
  let kept: Services | undefined;

  return {
    id,
    requires,
    commands,
    activate: ({ services }) => {
      kept = services;
      then(services);
    },
    services: () => {
      if (kept === undefined) {
        throw new Error(`Probe ${id} did not activate.`);
      }

      return kept;
    },
  };
};

/** The host-only foundation the core requires, provided in the host. */
const foundation = {
  manifest: {
    manifestVersion: 1 as const,
    id: 'memory',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: ['storage.backend/v1@1.0.0', 'secrets.backend/v1@1.0.0'],
    requires: [],
  },
  descriptor: {
    descriptorVersion: 1 as const,
    bundle: { id: 'memory', version: '1.0.0' },
    contracts: ['storage.backend/v1', 'secrets.backend/v1'].map((id) => ({
      id,
      version: '1.0.0',
      kind: 'service' as const,
      environment: 'host' as const,
      cardinality: 'one' as const,
      local: true,
      schema: `schemas/${id}.json`,
    })),
  },
};

const probeCandidate = (bundle: Probe): CatalogCandidate => ({
  id: bundle.id,
  source: { kind: 'installed', dir: `${bundle.id}@1.0.0` },
  manifest: manifestV1Schema.parse({
    manifestVersion: 1,
    id: bundle.id,
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: (bundle.commands ?? []).map((id) => `${id}@1.0.0`),
    requires: [...(bundle.requires ?? [])],
  }),
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: bundle.id, version: '1.0.0' },
    contracts: (bundle.commands ?? []).map((id) => ({
      id,
      version: '1.0.0',
      kind: 'command' as const,
      environment: 'client' as const,
      cardinality: 'one' as const,
      local: false,
      schema: `schemas/${id}.json`,
    })),
  },
  errors: [],
});

/**
 * The core's desktopMain contracts as main routes them to a window: one
 * remote record per contract, with method specs from the built schemas.
 */
const remoteContracts = async (
  manifest: ManifestV1,
  descriptor: Descriptor,
): Promise<RemoteContract[]> => {
  const remote: RemoteContract[] = [];

  for (const entry of descriptor.contracts) {
    if (entry.environment !== 'desktopMain') {
      continue;
    }

    const document = (await readJson(resolve(DIST, entry.schema))) as {
      readonly $defs?: Record<string, JsonObject>;
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
          defs[key] ?? {},
          defs[`${name}.output`] ?? {},
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

const partUrl = (id: string): string =>
  `doric://app/bundles/${id}@1.0.0/client/index.js`;

let imports = 0;

export interface TestWindow {
  readonly window: Window;
  readonly document: Document;
  /** Every bridge call the window made, in order. */
  readonly calls: BridgeCallEnvelope[];
  readonly failures: WindowFailure[];
  readonly steps: string[];
  /** Quarantine reasons the window reported to main, by bundle ID. */
  readonly quarantines: Readonly<
    Record<string, { readonly code: string; readonly message: string }>
  >;
  /** Main asks the window to close (one phase). */
  requestClose(request: CloseRequest): Promise<CloseAnswer | undefined>;
  /** Bridge calls of one `<contract>.<method>`. */
  received(method: string): readonly BridgeCallEnvelope[];
  close(): Promise<void>;
}

export interface WindowOptions {
  readonly url?: string;
  readonly key?: string;
  readonly probes?: readonly Probe[];
  /** Answers bridge calls besides the shell's; default `{ ok: true }`. */
  readonly answer?: (
    envelope: BridgeCallEnvelope,
  ) => Promise<BridgeResultPayload> | BridgeResultPayload;
}

/** Waits for queued microtasks and immediate callbacks. */
export const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

/** Boots a window of the core plus `probes` at `url`. */
export const openWindow = async (
  options: WindowOptions = {},
): Promise<TestWindow> => {
  const window = new Window({ url: options.url ?? 'doric://app/' });
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );

  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: (window as unknown as Record<string, unknown>)[name],
    });
  }

  const manifest = (await readJson(
    resolve(DIST, 'manifest.json'),
  )) as ManifestV1;
  const descriptor = (await readJson(
    resolve(DIST, 'contracts.json'),
  )) as Descriptor;
  // A fresh module instance per window: its element classes extend this
  // window's HTMLElement.
  imports += 1;
  const core = (await import(
    `${pathToFileURL(resolve(DIST, 'client/index.js')).href}?window=${imports}`
  )) as { activate: Activate };
  const probes = options.probes ?? [];
  const resolved = resolveEnvironment(
    {
      candidates: [
        {
          id: 'core',
          source: { kind: 'installed', dir: `core@${manifest.version}` },
          manifest,
          descriptor,
          errors: [],
        },
        {
          id: 'memory',
          source: { kind: 'installed', dir: 'memory@1.0.0' },
          ...foundation,
          errors: [],
        },
        ...probes.map(probeCandidate),
      ],
      composition: {
        core: 'core',
        enabled: ['core', 'memory', ...probes.map(({ id }) => id)],
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
    parts: Object.fromEntries(
      ['core', ...probes.map(({ id }) => id)].map((id) => [
        id,
        { entry: partUrl(id) },
      ]),
    ),
    remote: await remoteContracts(manifest, descriptor),
    hostId: 'host-1',
    storageGeneration: 1,
  };
  const quarantines: Record<
    string,
    { readonly code: string; readonly message: string }
  > = {};
  const calls: BridgeCallEnvelope[] = [];
  const failures: WindowFailure[] = [];
  const steps: string[] = [];
  let closeHandler:
    | ((request: CloseRequest) => Promise<CloseAnswer | undefined>)
    | undefined;
  const desktop: DoricDesktopApi = {
    describeWindow: async () => ({
      key: options.key ?? 'workspace',
      kind: 'window',
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
    ready: async () => {
      steps.push('ready');
    },
    reportFailure: async (info) => {
      steps.push('reportFailure');
      failures.push(info);
    },
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

      if (envelope.contract === 'doric.shell/v1') {
        const input = envelope.input as {
          readonly kind?: string;
          readonly bundleId?: string;
          readonly reason?: { readonly code: string; readonly message: string };
        };

        if (
          envelope.method === 'diagnostic' &&
          input.kind === 'quarantine' &&
          input.bundleId !== undefined &&
          input.reason !== undefined
        ) {
          quarantines[input.bundleId] = input.reason;
        }

        return { ok: true, output: undefined };
      }

      return (
        (await options.answer?.(envelope)) ?? {
          ok: true,
          output: undefined,
        }
      );
    },
    cancel: () => undefined,
    subscribe: () => () => undefined,
  };
  const modules: Record<string, { activate?: Activate }> = {
    [partUrl('core')]: core,
    ...Object.fromEntries(
      probes.map((bundle) => [
        partUrl(bundle.id),
        bundle.activate === undefined
          ? {}
          : { activate: bundle.activate as Activate },
      ]),
    ),
  };

  await bootstrapWindow({
    desktop,
    document: window.document as unknown as Document,
    importPart: async (url) => {
      const module = modules[url];

      if (module === undefined) {
        throw new Error(`No module at ${url}`);
      }

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
    calls,
    failures,
    steps,
    quarantines,
    requestClose: async (request) => {
      if (closeHandler === undefined) {
        throw new Error('The window registered no close handler.');
      }

      return closeHandler(request);
    },
    received: (method) =>
      calls.filter(
        (envelope) => `${envelope.contract}.${envelope.method}` === method,
      ),
    close: async () => {
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) {
          delete globals[name];
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }

      await window.happyDOM.close();
    },
  };
};
