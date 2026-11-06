// The `openui` client part activated over a services stub that answers by
// contract id: `ui/v1`, `regions/v1`, `navigation/v1`, `hooks/v1`,
// `chat.views/v1` and `openui.setting/v1` record what the client asks of
// them. Import `./dom.js` first: the client reads `window` when it loads.

import type { Activate, ClientContext, Services } from 'bundle/contracts';

/** The client entry, imported by URL: `src/client/index.ts` is the module under test. */
const CLIENT_ENTRY = new URL('../../../src/client/index.js', import.meta.url)
  .href;

export interface Registration<T> {
  readonly spec: T;
  disposed: boolean;
}

export interface ClientWorld {
  readonly services: Services;
  /** `ui/v1.define`: element constructors by tag. */
  readonly elements: Map<string, CustomElementConstructor>;
  /** `regions/v1.add` calls. */
  readonly regions: Registration<{
    readonly region: string;
    readonly item: unknown;
  }>[];
  /** `navigation/v1.register` calls. */
  readonly routes: Registration<{
    readonly path: string;
    readonly parent?: string;
    readonly create?: () => unknown;
  }>[];
  /** `chat.views/v1.registerFenceRenderer` calls. */
  readonly fenceRenderers: Registration<{
    readonly tag: string;
    readonly elementTag: string;
  }>[];
  /** `chat.views/v1.registerProjector` calls. */
  readonly projectors: Registration<{
    readonly eventTypes: readonly string[];
    initial(): unknown;
    reduce(
      state: unknown,
      event: unknown,
    ): { readonly state: unknown; readonly blocks: readonly unknown[] };
  }>[];
  /** Hooks the client registered through `hooks/v1.whenAvailable`, by contract id. */
  readonly hooks: {
    readonly contract: string;
    readonly registered: Record<string, unknown>;
  }[];
  /** `openui.setting/v1.watch` listeners. */
  readonly settingListeners: ((value: { readonly enabled: boolean }) => void)[];
  /** `openui.setting/v1.set` inputs. */
  readonly settingWrites: { readonly enabled: boolean }[];
  /** Reports a value to every `watch` listener, as the host does after a write. */
  report(value: { readonly enabled: boolean }): void;
  /** Runs the client's cleanup. */
  deactivate(): Promise<void>;
}

const disposableFor = <T>(registration: Registration<T>) => ({
  dispose: () => {
    registration.disposed = true;
  },
});

/** Activates the client entry over the stub. */
export const activateClient = async (): Promise<ClientWorld> => {
  const elements = new Map<string, CustomElementConstructor>();
  const regions: ClientWorld['regions'] = [];
  const routes: ClientWorld['routes'] = [];
  const fenceRenderers: ClientWorld['fenceRenderers'] = [];
  const projectors: ClientWorld['projectors'] = [];
  const hooks: ClientWorld['hooks'] = [];
  const settingListeners: ClientWorld['settingListeners'] = [];
  const settingWrites: ClientWorld['settingWrites'] = [];
  let current = { enabled: false };

  const push = <T>(list: Registration<T>[], spec: T) => {
    const registration = { spec, disposed: false };
    list.push(registration);
    return disposableFor(registration);
  };

  const apis: Record<string, unknown> = {
    'ui/v1': {
      define: (tag: string, element: CustomElementConstructor) => {
        elements.set(tag, element);
        return { dispose: () => elements.delete(tag) };
      },
      create: (tag: string) => document.createElement(tag),
      dispose: () => undefined,
    },
    'regions/v1': {
      add: (region: string, item: unknown) => push(regions, { region, item }),
    },
    'navigation/v1': {
      register: (route: ClientWorld['routes'][number]['spec']) =>
        push(routes, route),
    },
    'hooks/v1': {
      whenAvailable: (
        contract: {
          readonly id: string;
          readonly hooks?: Record<string, unknown>;
        },
        callback: (
          registrar: Record<string, (handler: unknown) => unknown>,
        ) => unknown,
      ) => {
        const registered: Record<string, unknown> = {};
        hooks.push({ contract: contract.id, registered });
        const registrar = new Proxy(
          {},
          {
            get: (_target, name: string) => (handler: unknown) => {
              registered[name] = handler;
              return { dispose: () => delete registered[name] };
            },
          },
        ) as Record<string, (handler: unknown) => unknown>;
        callback(registrar);
        return { dispose: () => undefined };
      },
    },
    'chat.views/v1': {
      registerFenceRenderer: (spec: { tag: string; elementTag: string }) =>
        push(fenceRenderers, spec),
      registerProjector: (spec: ClientWorld['projectors'][number]['spec']) =>
        push(projectors, spec),
      watchFences: () => ({ dispose: () => undefined }),
    },
    'openui.setting/v1': {
      get: async () => current,
      set: async (value: { enabled: boolean }) => {
        settingWrites.push(value);
        current = value;
        for (const listener of [...settingListeners]) listener(value);
        return value;
      },
      watch: (listener: (value: { enabled: boolean }) => void) => {
        settingListeners.push(listener);
        queueMicrotask(() => listener(current));
        return {
          dispose: () => {
            settingListeners.splice(settingListeners.indexOf(listener), 1);
          },
        };
      },
    },
  };

  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { readonly id?: string }) => apis[contract.id ?? ''],
    whenAvailable: (
      contract: { readonly id?: string },
      callback: (api: unknown, info: unknown) => unknown,
    ) => {
      const api = apis[contract.id ?? ''];
      const cleanup =
        api === undefined
          ? undefined
          : callback(api, { bundleId: 'test', version: '0.0.0' });
      return {
        dispose: () => {
          if (typeof cleanup === 'function') void (cleanup as () => unknown)();
        },
      };
    },
  } as unknown as Services;

  const { activate } = (await import(CLIENT_ENTRY)) as {
    readonly activate: Activate<ClientContext>;
  };
  const cleanup = await activate({ services });

  return {
    services,
    elements,
    regions,
    routes,
    fenceRenderers,
    projectors,
    hooks,
    settingListeners,
    settingWrites,
    report: (value) => {
      current = value;
      for (const listener of [...settingListeners]) listener(value);
    },
    deactivate: async () => {
      if (typeof cleanup === 'function') await cleanup();
    },
  };
};
