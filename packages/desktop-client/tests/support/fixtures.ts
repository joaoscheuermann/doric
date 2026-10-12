// Test doubles of the true external boundaries of a window: the preload API
// (`window.doric.desktop`), the DOM pieces the shell touches, and a small
// client hooks/v1 provider standing in for the core's.

import {
  type Activate,
  type AnyHookHandler,
  type Call,
  type ClientContext,
  type Decision,
  type Disposable,
  defineMethod,
  defineService,
  type HooksContract,
  HooksV1,
  hooksMethods,
} from 'bundle/contracts';
import {
  type CatalogCandidate,
  type Descriptor,
  type ManifestV1Input,
  manifestV1Schema,
  type ResolvedEnvironment,
  resolveEnvironment,
} from 'bundle/runtime';

import type {
  BridgeCallEnvelope,
  BridgeResultPayload,
  BridgeStreamEvent,
  CloseAnswer,
  CloseRequest,
  DoricDesktopApi,
  RemoteContract,
  WindowCatalog,
  WindowChrome,
  WindowDescription,
  WindowFailure,
  WindowPart,
} from '../../src/index.js';

// Bundles -------------------------------------------------------------------

export interface ClientBundle {
  readonly id: string;
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  /** Descriptor entries of the provided contracts (default environment client). */
  readonly contracts?: readonly {
    readonly id: string;
    readonly version: string;
    readonly environment?: 'client' | 'desktopMain' | 'host';
    readonly cardinality?: 'one' | 'many';
  }[];
  readonly activate?: Activate<ClientContext>;
  readonly styles?: boolean;
  /** No client part at all. */
  readonly noPart?: boolean;
}

const manifestOf = (bundle: ClientBundle): ManifestV1Input => ({
  manifestVersion: 1,
  id: bundle.id,
  version: '1.0.0',
  engines: { doric: '^1.0.0' },
  provides: [...(bundle.provides ?? [])],
  requires: [...(bundle.requires ?? [])],
});

const descriptorOf = (bundle: ClientBundle): Descriptor => ({
  descriptorVersion: 1,
  bundle: { id: bundle.id, version: '1.0.0' },
  contracts: (bundle.contracts ?? []).map((contract) => ({
    id: contract.id,
    version: contract.version,
    kind: 'service' as const,
    environment: contract.environment ?? 'client',
    cardinality: contract.cardinality ?? 'one',
    local: false,
    schema: `schemas/${contract.id}.json`,
  })),
});

export const resolveClient = (
  bundles: readonly ClientBundle[],
  core: string,
): ResolvedEnvironment =>
  resolveEnvironment(
    {
      candidates: bundles.map(
        (bundle): CatalogCandidate => ({
          id: bundle.id,
          source: { kind: 'installed', dir: `${bundle.id}@1.0.0` },
          manifest: manifestV1Schema.parse(manifestOf(bundle)),
          descriptor: descriptorOf(bundle),
          errors: [],
        }),
      ),
      composition: {
        core,
        enabled: bundles.map(({ id }) => id),
        providers: {},
      },
      platformVersion: '1.0.0',
      generation: 3,
    },
    'client',
  );

export const partUrl = (id: string): string =>
  `doric://app/bundles/${id}@1.0.0/client/index.js`;

export const stylesUrl = (id: string): string =>
  `doric://app/bundles/${id}@1.0.0/client/styles.css`;

export const windowCatalog = (
  bundles: readonly ClientBundle[],
  options: { readonly core: string; readonly remote?: RemoteContract[] },
): WindowCatalog => ({
  generation: 3,
  resolved: resolveClient(bundles, options.core),
  parts: Object.fromEntries(
    bundles
      .filter(({ noPart }) => noPart !== true)
      .map((bundle): [string, WindowPart] => [
        bundle.id,
        {
          entry: partUrl(bundle.id),
          ...(bundle.styles === true ? { styles: stylesUrl(bundle.id) } : {}),
        },
      ]),
  ),
  remote: options.remote ?? [],
  hostId: 'host-1',
  storageGeneration: 1,
});

/** importPart over the bundles' activate functions, by part URL. */
export const importerOf =
  (bundles: readonly ClientBundle[]) =>
  async (url: string): Promise<{ activate?: Activate }> => {
    const bundle = bundles.find(({ id }) => partUrl(id) === url);

    if (bundle === undefined) {
      throw new Error(`No module at ${url}`);
    }

    return bundle.activate === undefined
      ? {}
      : { activate: bundle.activate as Activate };
  };

// Client hooks/v1 -------------------------------------------------------------

export interface HooksLog {
  /** `windowKey` of the call of every registration, by hook. */
  readonly registrations: { hook: string; windowKey: string | undefined }[];
  readonly defined: string[];
}

/**
 * A minimal client hooks/v1 provider: `decide` hooks allow unless a handler
 * denies; `observe` hooks run every handler.
 */
export const clientHooksBundle = (log: HooksLog, id = 'core'): ClientBundle => {
  const handlers = new Map<string, AnyHookHandler[]>();
  const kinds = new Map<string, string>();
  const key = (contract: HooksContract, hook: string) =>
    `${contract.id}#${hook}`;
  const provider = defineService(HooksV1, {
    define: defineMethod({
      input: hooksMethods.define.input,
      output: hooksMethods.define.output,
      execute: (contract): Disposable => {
        log.defined.push(contract.id);

        for (const [hook, definition] of Object.entries(contract.hooks)) {
          kinds.set(key(contract, hook), definition.kind);
        }

        return { dispose: () => undefined };
      },
    }),
    register: defineMethod({
      input: hooksMethods.register.input,
      output: hooksMethods.register.output,
      execute: ([contract, hook, handler], call): Disposable => {
        log.registrations.push({ hook, windowKey: call.scope?.windowKey });
        handlers.set(key(contract, hook), [
          ...(handlers.get(key(contract, hook)) ?? []),
          handler,
        ]);

        return {
          dispose: () =>
            handlers.set(
              key(contract, hook),
              (handlers.get(key(contract, hook)) ?? []).filter(
                (entry) => entry !== handler,
              ),
            ),
        };
      },
    }),
    whenDefined: defineMethod({
      input: hooksMethods.whenDefined.input,
      output: hooksMethods.whenDefined.output,
      execute: ([, callback]): Disposable => {
        callback();

        return { dispose: () => undefined };
      },
    }),
    execute: defineMethod({
      input: hooksMethods.execute.input,
      output: hooksMethods.execute.output,
      execute: async ([contract, hook, input], call: Call) => {
        const list = handlers.get(key(contract, hook)) ?? [];

        if (kinds.get(key(contract, hook)) === 'decide') {
          for (const handler of list) {
            const decision = (await handler(input, call)) as Decision;

            if (!decision.allow) {
              return decision;
            }
          }

          return { allow: true };
        }

        for (const handler of list) {
          await handler(input, call);
        }

        return undefined;
      },
    }),
  });

  return {
    id,
    provides: ['hooks/v1@1.0.0'],
    contracts: [{ id: 'hooks/v1', version: '1.0.0' }],
    activate: ({ services }) => {
      services.provide(provider);
    },
  };
};

// Preload API -----------------------------------------------------------------

export interface FakeDesktop extends DoricDesktopApi {
  readonly calls: BridgeCallEnvelope[];
  readonly cancels: string[];
  readonly subscriptions: {
    readonly envelope: BridgeCallEnvelope;
    readonly listener: (event: BridgeStreamEvent) => void;
    unsubscribed: boolean;
  }[];
  readonly failures: WindowFailure[];
  readonly steps: string[];
  /** Answers of non-shell calls; default `{ ok: true, output: undefined }`. */
  answer: (envelope: BridgeCallEnvelope) => Promise<BridgeResultPayload>;
  requestClose(request: CloseRequest): Promise<CloseAnswer | undefined>;
  changeChrome(chrome: WindowChrome): void;
  /** Pushes an item on every open subscription of a contract method. */
  push(contract: string, method: string, event: unknown): void;
  /** Shell calls of one method, by input. */
  shell(method: string): unknown[];
}

export const fakeDesktop = (
  description: WindowDescription,
  catalog: WindowCatalog,
  options: { readonly describeError?: Error } = {},
): FakeDesktop => {
  let closeHandler:
    | ((request: CloseRequest) => Promise<CloseAnswer | undefined>)
    | undefined;
  const chromeListeners: ((chrome: WindowChrome) => void)[] = [];
  const desktop: FakeDesktop = {
    calls: [],
    cancels: [],
    subscriptions: [],
    failures: [],
    steps: [],
    answer: async () => ({ ok: true, output: undefined }),
    describeWindow: async () => {
      desktop.steps.push('describeWindow');

      if (options.describeError !== undefined) {
        throw options.describeError;
      }

      return description;
    },
    ready: async () => {
      desktop.steps.push('ready');
    },
    reportFailure: async (info) => {
      desktop.steps.push('reportFailure');
      desktop.failures.push(info);
    },
    onCloseRequested: (handler) => {
      closeHandler = handler;

      return () => {
        closeHandler = undefined;
      };
    },
    onChromeChanged: (listener) => {
      chromeListeners.push(listener);

      return () => undefined;
    },
    catalog: async () => {
      desktop.steps.push('catalog');

      return catalog;
    },
    call: async (envelope) => {
      desktop.calls.push(envelope);

      return envelope.contract === 'doric.shell/v1'
        ? { ok: true, output: undefined }
        : desktop.answer(envelope);
    },
    cancel: (id) => {
      desktop.cancels.push(id);
    },
    subscribe: (envelope, listener) => {
      const entry = { envelope, listener, unsubscribed: false };

      desktop.subscriptions.push(entry);

      return () => {
        entry.unsubscribed = true;
      };
    },
    requestClose: async (request) => {
      if (closeHandler === undefined) {
        throw new Error('No close handler.');
      }

      return closeHandler(request);
    },
    changeChrome: (chrome) => {
      for (const listener of chromeListeners) {
        listener(chrome);
      }
    },
    push: (contract, method, event) => {
      for (const entry of desktop.subscriptions) {
        if (
          !entry.unsubscribed &&
          entry.envelope.contract === contract &&
          entry.envelope.method === method
        ) {
          entry.listener({ type: 'event', event });
        }
      }
    },
    shell: (method) =>
      desktop.calls
        .filter(
          (envelope) =>
            envelope.contract === 'doric.shell/v1' &&
            envelope.method === method,
        )
        .map(({ input }) => input),
  };

  return desktop;
};

export const chrome: WindowChrome = {
  titleBar: 'integrated',
  height: 36,
  safeArea: { top: 0, left: 80, right: 0 },
};

export const describe = (
  overrides: Partial<WindowDescription> = {},
): WindowDescription => ({
  key: 'workspace',
  kind: 'window',
  primary: true,
  path: '/',
  generation: 3,
  chrome,
  mode: 'connected',
  tokens: { titlebarHeight: '36', window: '#101010' },
  ...overrides,
});

// DOM -------------------------------------------------------------------------

export interface FakeLink {
  rel: string;
  href: string;
  readonly dataset: Record<string, string>;
}

export interface FakeDocument {
  readonly head: {
    readonly children: FakeLink[];
    appendChild(link: FakeLink): FakeLink;
  };
  readonly documentElement: {
    readonly style: {
      readonly values: Map<string, string>;
      setProperty(name: string, value: string): void;
    };
  };
  createElement(tag: string): FakeLink;
}

export const fakeDocument = (): FakeDocument => {
  const children: FakeLink[] = [];
  const values = new Map<string, string>();

  return {
    head: {
      children,
      appendChild: (link) => {
        children.push(link);

        return link;
      },
    },
    documentElement: {
      style: {
        values,
        setProperty: (name, value) => {
          values.set(name, value);
        },
      },
    },
    createElement: (tag) => {
      if (tag !== 'link') {
        throw new Error(`Unexpected element ${tag}`);
      }

      return { rel: '', href: '', dataset: {} };
    },
  };
};

export const asDocument = (document: FakeDocument): Document =>
  document as unknown as Document;

/** A keydown target that records listeners and dispatches fake events. */
export const fakeKeyTarget = () => {
  const listeners: { listener: EventListener; capture: boolean }[] = [];

  return {
    listeners,
    addEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      listeners.push({
        listener: listener as EventListener,
        capture: typeof options === 'object' && options.capture === true,
      });
    },
    removeEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject | null,
    ) => {
      const index = listeners.findIndex((entry) => entry.listener === listener);

      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    /** Dispatches a keydown; returns whether it was prevented. */
    press: (init: {
      readonly key: string;
      readonly metaKey?: boolean;
      readonly ctrlKey?: boolean;
      readonly altKey?: boolean;
      readonly shiftKey?: boolean;
    }): boolean => {
      let prevented = false;
      const event = {
        type: 'keydown',
        key: init.key,
        metaKey: init.metaKey ?? false,
        ctrlKey: init.ctrlKey ?? false,
        altKey: init.altKey ?? false,
        shiftKey: init.shiftKey ?? false,
        preventDefault: () => {
          prevented = true;
        },
      };

      for (const { listener } of [...listeners]) {
        listener(event as unknown as Event);
      }

      return prevented;
    },
  };
};

export const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};
