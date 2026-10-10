// activateClientBundles: the client environment of one window, pinned to the
// generation of the shell it loaded (section 15.3).

import {
  type Activate,
  type Call,
  type HookHandle,
  HooksV1,
  type Services,
  WindowHooksV1,
} from 'bundle/contracts';
import {
  type ActivationResult,
  activateEnvironment,
  catalogView,
  createHopCall,
  createPrincipal,
  type Directory,
  PLATFORM_VERSION,
  type ProviderListener,
  type ProviderRecord,
  ServiceDirectory,
  type ServiceRuntime,
} from 'bundle/runtime';

import { remoteContractRecord } from './bridge.js';
import { provideClientPlatform, WindowDiagnostics } from './platform.js';
import type {
  DoricDesktopApi,
  WindowCatalog,
  WindowDescription,
} from './protocol.js';
import { insertBundleStyles } from './styles.js';

export interface ClientActivation {
  readonly result: ActivationResult;
  readonly windowHooks: HookHandle<typeof WindowHooksV1> | undefined;
  /** Services of the window platform principal (`doric`). */
  readonly services: Services;
  readonly diagnostics: WindowDiagnostics;
}

export type ImportPart = (url: string) => Promise<{ activate?: Activate }>;

const defaultImport: ImportPart = (url) =>
  import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<{
    activate?: Activate;
  }>;

/**
 * A directory whose in-window records see `scope.windowKey` of this window:
 * every call a local provider receives carries it (S1 §1.7), which binds
 * `WindowHooksV1` registrations to their window. Remote records are left as
 * they are: main fills `windowKey` for calls leaving the window.
 */
export class WindowDirectory implements Directory {
  readonly #inner: ServiceDirectory;
  readonly #windowKey: string;
  readonly #generationSignal: AbortSignal;
  readonly #wrapped = new WeakMap<ProviderRecord, ProviderRecord>();
  readonly #originals = new WeakMap<ProviderRecord, ProviderRecord>();

  constructor(
    inner: ServiceDirectory,
    windowKey: string,
    generationSignal: AbortSignal,
  ) {
    this.#inner = inner;
    this.#windowKey = windowKey;
    this.#generationSignal = generationSignal;
  }

  #wrap(record: ProviderRecord): ProviderRecord {
    if (record.origin === 'remote') {
      return record;
    }

    let wrapped = this.#wrapped.get(record);

    if (wrapped === undefined) {
      const windowKey = this.#windowKey;
      const generationSignal = this.#generationSignal;

      wrapped = Object.freeze({
        ...record,
        invoke: (method: string, input: unknown, call: Call) =>
          record.invoke(
            method,
            input,
            call.scope?.windowKey === windowKey
              ? call
              : createHopCall({
                  caller: call.caller,
                  arg: call,
                  windowKey,
                  generationSignal,
                }),
          ),
      });
      this.#wrapped.set(record, wrapped);
      this.#originals.set(wrapped, record);
    }

    return wrapped;
  }

  #original(record: ProviderRecord): ProviderRecord {
    return this.#originals.get(record) ?? record;
  }

  register(record: ProviderRecord): () => void {
    return this.#inner.register(this.#original(record));
  }

  providers(contractId: string): readonly ProviderRecord[] {
    return this.#inner
      .providers(contractId)
      .map((record) => this.#wrap(record));
  }

  active(contractId: string): ProviderRecord | undefined {
    const record = this.#inner.active(contractId);

    return record === undefined ? undefined : this.#wrap(record);
  }

  isActive(record: ProviderRecord): boolean {
    return this.#inner.isActive(this.#original(record));
  }

  subscribe(contractId: string, listener: ProviderListener): () => void {
    return this.#inner.subscribe(contractId, {
      added: (record) => listener.added(this.#wrap(record)),
      removed: (record) => listener.removed(this.#wrap(record)),
    });
  }
}

/**
 * Activates the client parts of the window's generation: local platform
 * providers, remote records for every bridge contract, bundle styles in
 * activation order, then the generic activation loop. A failing part is
 * quarantined and the others continue.
 */
export const activateClientBundles = async (input: {
  readonly catalog: WindowCatalog;
  readonly desktop: DoricDesktopApi;
  readonly description: WindowDescription;
  readonly importPart?: ImportPart;
  readonly document?: Document;
  readonly now?: () => number;
}): Promise<ClientActivation> => {
  const { catalog, desktop, description } = input;
  const { resolved } = catalog;
  const importPart = input.importPart ?? defaultImport;
  const controller = new AbortController();
  const diagnostics = new WindowDiagnostics({
    generation: catalog.generation,
    desktop,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  diagnostics.load(resolved);

  const inner = new ServiceDirectory();
  const runtime: ServiceRuntime = {
    directory:
      description.key === null
        ? inner
        : new WindowDirectory(inner, description.key, controller.signal),
    catalog: catalogView(resolved),
    environment: 'client',
    generation: catalog.generation,
    operationGeneration: catalog.generation,
    generationSignal: controller.signal,
    report: (entry) => diagnostics.report(entry),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });

  provideClientPlatform(platform, {
    resolved,
    diagnostics,
    desktop,
    tokens: description.tokens,
  });

  for (const contract of catalog.remote) {
    runtime.directory.register(remoteContractRecord(desktop, contract));
  }

  insertBundleStyles({
    order: resolved.order.filter((id) =>
      resolved.entries.some(
        (entry) => entry.id === id && entry.state === 'scheduled',
      ),
    ),
    parts: catalog.parts,
    ...(input.document === undefined ? {} : { document: input.document }),
  });

  let windowHooks: HookHandle<typeof WindowHooksV1> | undefined;
  const result = await activateEnvironment({
    resolved,
    runtime,
    platform,
    diagnostics,
    loadPart: async (entry) => {
      const part = catalog.parts[entry.id];

      if (part === undefined) {
        return undefined;
      }

      const module = await importPart(part.entry);

      return module.activate;
    },
    onHooksProviderReady: (principal) => {
      windowHooks = principal.services.use(HooksV1).define(WindowHooksV1);
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return {
    result: {
      ...result,
      stop: async () => {
        await result.stop();
        controller.abort();
      },
    },
    windowHooks,
    services: platform.services,
    diagnostics,
  };
};
