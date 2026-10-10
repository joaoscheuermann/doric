// One real workspace window in this process (after chat's own test window):
// a happy-dom window as the globals, the window platform of `desktop-client`,
// the core's, chat's and this bundle's client parts exactly as their builds
// ship them, plus an optional in-memory "probe" bundle standing for the
// layout's `layout.workspace/v1`. The boundaries faked are the preload API
// (`window.doric.desktop`) and, behind it, the host's `runtime.threads/v1`
// and main's shell streams: a test answers them as the host would and reads
// what they were asked.

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
  type BridgeStreamEvent,
  bootstrapWindow,
  type DoricDesktopApi,
  type RemoteContract,
  type WindowCatalog,
} from 'desktop-client';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const THREADS_DIST = resolve(here, '../../../../dist');
const CHAT_DIST = resolve(
  dirname(fileURLToPath(import.meta.resolve('chat/package.json'))),
  'dist',
);
const CORE_DIST = resolve(
  dirname(fileURLToPath(import.meta.resolve('core/package.json'))),
  'dist',
);

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** What the host answers for one `<contract>.<method>`. */
export type HostAnswer = (input: unknown) => unknown;

/** One open stream: the input it was opened with, and its listener. */
export interface OpenStream {
  readonly envelope: BridgeCallEnvelope;
  push(item: unknown): void;
  end(error?: { code: string; message: string }): void;
}

/** `runtime.threads/v1` as main routes it: tuple length per method. */
const threadMethods: Readonly<Record<string, number | null>> = {
  thread: 1,
  queue: 1,
  prompt: null,
  resume: null,
  rewind: null,
  pause: null,
  queuedPrompt: null,
  editQueued: null,
  removeQueued: null,
  resumeQueue: 1,
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
      'runtime.threads/v1@1.1.0',
      'tools/v1@1.2.0',
    ],
    requires: [],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'host', version: '1.0.0' },
    contracts: [
      ['storage.backend/v1', '1.0.0'],
      ['secrets.backend/v1', '1.0.0'],
      ['runtime.threads/v1', '1.1.0'],
      ['tools/v1', '1.2.0'],
    ].map(([id, version]) => ({
      id,
      version,
      kind: 'service' as const,
      environment: 'host' as const,
      cardinality: 'one' as const,
      local: false,
      schema: `schemas/${id}.json`,
    })),
  },
  errors: [],
};

const threadsRemote: RemoteContract = {
  id: 'runtime.threads/v1',
  environment: 'host',
  bundleId: 'host',
  version: '1.0.0',
  contractVersion: '1.1.0',
  cardinality: 'one',
  methods: {
    ...Object.fromEntries(
      Object.entries(threadMethods).map(([name, tuple]) => [
        name,
        { tuple, local: false, stream: false },
      ]),
    ),
    watchThread: { tuple: 2, local: false, stream: true },
  },
};

/** The probe bundle: a client part defined by the test. */
export interface Probe {
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  readonly activate: Activate;
}

const probeCandidate = (probe: Probe): CatalogCandidate => ({
  id: 'probe',
  source: { kind: 'installed', dir: 'probe@1.0.0' },
  manifest: {
    manifestVersion: 1,
    id: 'probe',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: [...(probe.provides ?? [])].map((id) => `${id}@1.0.0`),
    requires: [...(probe.requires ?? [])],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'probe', version: '1.0.0' },
    contracts: (probe.provides ?? []).map((id) => ({
      id,
      version: '1.0.0',
      kind: 'service' as const,
      environment: 'client' as const,
      cardinality: 'one' as const,
      local: true,
      schema: `schemas/${id}.json`,
    })),
  },
  errors: [],
});

const partUrl = (id: string, version: string): string =>
  `doric://app/bundles/${id}@${version}/client/index.js`;

/** Window globals the parts, React and Lexical reach for. */
const globalNames = (window: Window): string[] => [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'customElements',
  'MutationObserver',
  'getComputedStyle',
  'getSelection',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'innerWidth',
  'innerHeight',
  ...Object.getOwnPropertyNames(window).filter((name) =>
    /^(HTML|SVG)\w*Element$|^\w*Event$|^(Node|Element|Text|Comment|DocumentFragment|ShadowRoot|Range|Selection|StaticRange|DOMRect|ResizeObserver|IntersectionObserver|DataTransfer|NodeFilter)$/.test(
      name,
    ),
  ),
];

let imports = 0;

export interface ThreadsWindow {
  readonly window: Window;
  readonly document: Document;
  /** Bridge calls of one `<contract>.<method>`, in order. */
  received(method: string): readonly BridgeCallEnvelope[];
  /** Every bridge call, in order. */
  calls(): readonly BridgeCallEnvelope[];
  /** The open `runtime.threads/v1.watchThread` streams. */
  watches(): readonly OpenStream[];
  /** Reports a host connection status on main's stream. */
  connection(status: 'connected' | 'disconnected'): void;
  close(): Promise<void>;
}

/** Waits for queued microtasks, immediates, frames and short timers. */
export const settle = async (milliseconds = 0): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
  await new Promise<void>((done) => setTimeout(done, milliseconds + 20));
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

/** Boots the core, chat, threads and the probe at `url`, answering `host` calls. */
export const openThreadsWindow = async (input: {
  readonly url: string;
  readonly host: Readonly<Record<string, HostAnswer>>;
  readonly probe?: Probe;
}): Promise<ThreadsWindow> => {
  const window = new Window({ url: input.url, width: 1280, height: 800 });
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
  const chatManifest = (await readJson(
    resolve(CHAT_DIST, 'manifest.json'),
  )) as ManifestV1;
  const chatDescriptor = (await readJson(
    resolve(CHAT_DIST, 'contracts.json'),
  )) as Descriptor;

  // Fresh module instances per window: their element classes extend this
  // window's HTMLElement, and the chat's module state starts empty.
  imports += 1;
  const load = async (dist: string) =>
    (await import(
      `${pathToFileURL(resolve(dist, 'client/index.js')).href}?window=${imports}`
    )) as { activate: Activate };
  const core = await load(CORE_DIST);
  const chat = await load(CHAT_DIST);
  const threadsManifest = (await readJson(
    resolve(THREADS_DIST, 'manifest.json'),
  )) as ManifestV1;
  const threadsDescriptor = (await readJson(
    resolve(THREADS_DIST, 'contracts.json'),
  )) as Descriptor;
  const threads = await load(THREADS_DIST);

  const candidates: CatalogCandidate[] = [
    {
      id: 'core',
      source: { kind: 'installed', dir: `core@${coreManifest.version}` },
      manifest: coreManifest,
      descriptor: coreDescriptor,
      errors: [],
    },
    hostCandidate,
    {
      id: 'chat',
      source: { kind: 'installed', dir: `chat@${chatManifest.version}` },
      manifest: chatManifest,
      descriptor: chatDescriptor,
      errors: [],
    },
    {
      id: 'threads',
      source: {
        kind: 'installed',
        dir: `threads@${threadsManifest.version}`,
      },
      manifest: threadsManifest,
      descriptor: threadsDescriptor,
      errors: [],
    },
  ];
  if (input.probe !== undefined) candidates.push(probeCandidate(input.probe));
  const enabled = candidates.map((candidate) => candidate.id);

  const resolved = resolveEnvironment(
    {
      candidates,
      composition: { core: 'core', enabled, providers: {} },
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
      chat: { entry: partUrl('chat', chatManifest.version) },
      threads: { entry: partUrl('threads', threadsManifest.version) },
      ...(input.probe === undefined
        ? {}
        : { probe: { entry: partUrl('probe', '1.0.0') } }),
    },
    remote: [threadsRemote],
    hostId: 'host-1',
    storageGeneration: 1,
  };
  const calls: BridgeCallEnvelope[] = [];
  const streams: OpenStream[] = [];
  const connectionListeners = new Set<(event: BridgeStreamEvent) => void>();

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
      key: 'main',
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
    ready: async () => undefined,
    reportFailure: async () => undefined,
    onCloseRequested: () => () => undefined,
    onChromeChanged: () => () => undefined,
    catalog: async () => catalog,
    call: async (envelope) => {
      calls.push(envelope);

      return envelope.contract === 'doric.shell/v1'
        ? { ok: true, output: undefined }
        : answer(envelope);
    },
    cancel: () => undefined,
    subscribe: (envelope, listener) => {
      calls.push(envelope);
      if (
        envelope.contract === 'doric.shell/v1' &&
        envelope.method === 'connection'
      ) {
        connectionListeners.add(listener);
        listener({ type: 'event', event: 'connected' });
        return () => connectionListeners.delete(listener);
      }
      if (
        envelope.contract === 'runtime.threads/v1' &&
        envelope.method === 'watchThread'
      ) {
        let open = true;
        const stream: OpenStream = {
          envelope,
          push: (item) => {
            if (open) listener({ type: 'event', event: item });
          },
          end: (error) => {
            if (!open) return;
            open = false;
            listener(
              error === undefined ? { type: 'end' } : { type: 'end', error },
            );
          },
        };
        streams.push(stream);
        return () => {
          open = false;
          const index = streams.indexOf(stream);
          if (index >= 0) streams.splice(index, 1);
        };
      }
      return () => undefined;
    },
  };
  const modules: Record<string, { activate?: Activate }> = {
    [partUrl('core', coreManifest.version)]: core,
    [partUrl('chat', chatManifest.version)]: chat,
    [partUrl('threads', threadsManifest.version)]: threads,
    ...(input.probe === undefined
      ? {}
      : { [partUrl('probe', '1.0.0')]: { activate: input.probe.activate } }),
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
    calls: () => calls,
    watches: () => streams,
    connection: (status) => {
      for (const listener of [...connectionListeners]) {
        listener({ type: 'event', event: status });
      }
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
