// The host a settings story runs against. The settings surfaces reach the
// host only through `api()` (the module adapter `initSettingsApi` binds) and
// the window's `navigation/v1` and `hooks/v1`, so a story binds the adapter to
// fake services that answer from the fixtures, the way the host's providers
// would, and keeps every write in memory. Nothing here reaches a network.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'desktop/ui/sonner';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ReactNode, useState } from 'react';

import { initSettingsApi } from '../../src/client/api/settings-api.js';
import type {
  CatalogModel,
  Credential,
  DoricConfiguration,
  ProviderKind,
  ToolCatalogEntry,
} from '../../src/client/domain/config.js';
import { sectionPath } from '../../src/client/domain/section-route.js';
import { queryKeys } from '../../src/client/queries/keys.js';
import {
  claudeCatalog,
  claudeCredential,
  credentials as credentialFixtures,
  openRouterCatalog,
  providerKinds,
  storedConfiguration,
  toolCatalog,
} from './fixtures.js';

/** The services the settings surfaces are handed, typed from their own API. */
export type StoryServices = NonNullable<Parameters<typeof initSettingsApi>[0]>;

/**
 * One read the fake host answers: a value, a read that never settles (the
 * loading state), or a refusal with the message the surface shows.
 */
export type Answer<T> = T | { readonly pending: true } | Error;

/** What the fake host stores and answers. Each read defaults to a fixture. */
export type StoryHost = {
  readonly claudeLogin?: Answer<Credential>;
  readonly config?: Answer<DoricConfiguration>;
  readonly kinds?: Answer<readonly ProviderKind[]>;
  readonly tools?: Answer<readonly ToolCatalogEntry[]>;
  readonly credentials?: Answer<readonly Credential[]>;
  readonly catalog?: Answer<readonly CatalogModel[]>;
  /** The message a configuration save is refused with, if any. */
  readonly refuseSave?: string;
  /** The route the window shows, `/settings/<section>`. */
  readonly path?: string;
};

export const pending = { pending: true } as const;

const isPending = (value: unknown): value is { readonly pending: true } =>
  typeof value === 'object' &&
  value !== null &&
  (value as { pending?: unknown }).pending === true;

const answer = <T,>(value: Answer<T>): Promise<T> => {
  if (value instanceof Error) return Promise.reject(value);
  // A read that never settles stands for one still in flight. It holds no
  // timer, so nothing keeps running behind the story.
  if (isPending(value)) return new Promise<T>(() => {});
  return Promise.resolve(value as T);
};

/** A settled value of an answer, for seeding the query cache before render. */
const settled = <T,>(value: Answer<T>): T | undefined =>
  value instanceof Error || isPending(value) ? undefined : (value as T);

type Listener = () => void;

/** The window's route, as `navigation/v1` reports it. */
export type StoryNavigation = {
  current():
    | { path: string; pattern: string; params: Record<string, string> }
    | undefined;
  navigate(path: string): void;
  back(): void;
  chain(): readonly never[];
  register(): { dispose(): void };
  subscribe(listener: Listener): { dispose(): void };
};

const createNavigation = (path: string): StoryNavigation => {
  let match = { path, pattern: path, params: {} as Record<string, string> };
  const listeners = new Set<Listener>();

  return {
    current: () => match,
    navigate: (next) => {
      if (next === match.path) return;
      match = { path: next, pattern: next, params: {} };
      for (const listener of [...listeners]) listener();
    },
    back: () => {},
    chain: () => [],
    register: () => ({ dispose: () => {} }),
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
};

/** The navigation of the story host the core stand-ins follow. */
let activeNavigation: StoryNavigation | undefined;

export const storyNavigation = (): StoryNavigation | undefined =>
  activeNavigation;

/** Each story host's navigation, by the services that carry it. */
const navigations = new WeakMap<object, StoryNavigation>();

/** The services the settings adapter and the core stand-ins are bound to. */
let bound: StoryServices | undefined;

/**
 * Binds the settings adapter (`initSettingsApi`) and the core stand-ins to one
 * story host's services. It is called from a render with the services that
 * render keeps, so a double-invoked initializer (Strict Mode) can never leave
 * the adapter bound to a host the tree does not use; binding the same
 * services again changes nothing.
 */
export const bindStoryServices = (services: StoryServices): void => {
  if (bound === services) return;
  bound = services;
  activeNavigation = navigations.get(services);
  initSettingsApi(services);
};

const noRegistration = () => ({ dispose: () => {} });

/**
 * Fake services over one story host: the four host contracts the settings
 * adapter calls, answered from the host's values, and the window contracts
 * the settings view reads. A configuration save stores what it was sent and
 * answers the next revision, and a credential write changes the stored list,
 * so the autosave and the dialogs behave as they do against the host.
 */
export const createStoryServices = (host: StoryHost = {}): StoryServices => {
  let config = host.config ?? storedConfiguration();
  let stored = host.credentials ?? credentialFixtures;
  let created = 0;
  const navigation = createNavigation(host.path ?? sectionPath('providers'));
  const kinds = host.kinds ?? providerKinds;

  const list = (): readonly Credential[] => settled(stored) ?? [];

  const contracts: Record<string, unknown> = {
    'claude.login/v1': {
      start: () =>
        Promise.resolve({ url: 'https://claude.com/cai/oauth/authorize' }),
      finish: () => answer(host.claudeLogin ?? claudeCredential),
    },
    'doric.browser/v1': { open: () => Promise.resolve() },
    'host-config/v1': {
      current: () => answer(config),
      replace: (input: unknown) => {
        if (host.refuseSave !== undefined)
          return { status: 'invalid', message: host.refuseSave };
        const previous = settled(config);
        const next = {
          configuration: input,
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        config = next as DoricConfiguration;
        return { status: 'replaced', config: next };
      },
    },
    'models/v1': {
      kinds: () => answer(kinds),
      kind: async (id: string) =>
        (settled(kinds) ?? []).find((kind) => kind.id === id),
      // A refusal is the endpoint's: the host read it and could not list it.
      catalog: async (input: { readonly kind: string }) =>
        host.catalog instanceof Error
          ? { status: 'unreadable' }
          : {
              status: 'read',
              models: await answer(
                host.catalog ??
                  (input.kind === 'claude' ? claudeCatalog : openRouterCatalog),
              ),
            },
    },
    'tools/v1': { catalog: () => answer(host.tools ?? toolCatalog) },
    'secrets/v1': {
      list: () => answer(stored),
      create: (input: Omit<Credential, 'id' | 'hasSecret'>) => {
        created += 1;
        const credential = {
          id: `00000000-0000-4000-8000-9000000000${String(created).padStart(2, '0')}`,
          kind: input.kind,
          name: input.name,
          ...(input.username === undefined ? {} : { username: input.username }),
          ...(input.email === undefined ? {} : { email: input.email }),
          hasSecret: (input as { secret?: string }).secret !== undefined,
        };
        stored = [...list(), credential];
        return credential;
      },
      update: (
        ref: { readonly id: string },
        input: Partial<Credential> & { readonly secret?: string | null },
      ) => {
        const current = list().find((entry) => entry.id === ref.id);
        const next = {
          ...current,
          ...(input.name == null ? {} : { name: input.name }),
          ...(input.username == null ? {} : { username: input.username }),
          ...(input.email == null ? {} : { email: input.email }),
          hasSecret:
            typeof input.secret === 'string' || current?.hasSecret === true,
        } as Credential;
        stored = list().map((entry) => (entry.id === ref.id ? next : entry));
        return next;
      },
      delete: (ref: { readonly id: string }) => {
        stored = list().filter((entry) => entry.id !== ref.id);
        return 'deleted';
      },
    },
    'navigation/v1': navigation,
    'hooks/v1': {
      use: () => ({
        onCloseHook: noRegistration,
        onFlushHook: noRegistration,
      }),
      whenAvailable: noRegistration,
    },
  };

  const services = {
    use: (contract: { readonly id: string }) => {
      const provided = contracts[contract.id];
      if (provided === undefined)
        throw new Error(`The story host does not provide ${contract.id}.`);
      return provided;
    },
  };

  navigations.set(services, navigation);
  return services as unknown as StoryServices;
};

/**
 * A query client as the window's (`createQueryClient`), except that a seeded
 * read stays fresh, so a story opens on its fixtures instead of reading again.
 */
const createStoryQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    },
  });

/** Writes the host's settled reads into a query cache before anything renders. */
export const seedQueries = (client: QueryClient, host: StoryHost): void => {
  const seeds: readonly [readonly unknown[], unknown][] = [
    [queryKeys.config, settled(host.config ?? storedConfiguration())],
    [queryKeys.providerKinds, settled(host.kinds ?? providerKinds)],
    [queryKeys.toolCatalog, settled(host.tools ?? toolCatalog)],
    [queryKeys.credentials, settled(host.credentials ?? credentialFixtures)],
  ];
  for (const [key, value] of seeds) {
    if (value !== undefined) client.setQueryData(key, value);
  }
};

/**
 * Binds the settings adapter to a story host for as long as the story is
 * mounted, and gives the tree the providers a settings root mounts: its query
 * client (seeded), the tooltip provider, and the window's toaster.
 */
export function SettingsHost({
  children,
  host = {},
}: {
  readonly children: (services: StoryServices) => ReactNode;
  readonly host?: StoryHost;
}) {
  const [state] = useState(() => {
    const client = createStoryQueryClient();
    seedQueries(client, host);
    return { client, services: createStoryServices(host) };
  });
  bindStoryServices(state.services);

  return (
    <QueryClientProvider client={state.client}>
      <TooltipProvider>
        {children(state.services)}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
