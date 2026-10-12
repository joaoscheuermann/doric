import { randomUUID } from 'node:crypto';

import {
  builtinCredentialKinds,
  type Call,
  ContractError,
  type CredentialCreate,
  type CredentialKind,
  type CredentialKindDefinition,
  type CredentialRef,
  type CredentialUpdate,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
  type Disposable,
  defineMethod,
  defineService,
  type ReferenceSource,
  type ResolveByKindOptions,
  type Secret,
  SecretsBackendV1,
  SecretsV1,
  type Services,
  type StoredSecret,
  type StreamListener,
  type StreamObserver,
  secretsMethods,
  toStreamObserver,
} from 'bundle/contracts';

import { collidesIn, seenBy, viewOf } from '../../shared/partition.js';
import { type CoreState, once } from '../../shared/state.js';
import { createSecretsCache, describe, type SecretsCache } from './cache.js';

const missing = (id: string): ContractError =>
  new ContractError('credential_missing', `Credential ${id} is not stored.`, {
    id,
  });

const invalid = (kind: CredentialKindDefinition): ContractError =>
  new ContractError('credential_invalid', credentialFieldsMessage(kind), {
    kind: kind.id,
  });

const unknownKind = (kind: CredentialKind): ContractError =>
  new ContractError(
    'unknown_kind',
    `Credential kind ${kind} is not registered.`,
    { kind },
  );

/** A registered kind, held with the generation whose registration it is (0: the platform's). */
interface KindEntry {
  readonly generation: number;
  readonly definition: CredentialKindDefinition;
}

/** The fields a row holds: an absent value is not stored at all. */
const row = (credential: Secret): StoredSecret => ({
  id: credential.id,
  kind: credential.kind,
  name: credential.name,
  ...(credential.username === undefined
    ? {}
    : { username: credential.username }),
  ...(credential.email === undefined ? {} : { email: credential.email }),
  ...(credential.secret === undefined ? {} : { secret: credential.secret }),
});

/**
 * The core's `secrets/v1` over the chosen `secrets.backend/v1`. The backend
 * is read once, on the first call (a failure is retried by the next one), and
 * the cache answers every read after that. Writes run in the core's write
 * queue, and a credential that a registered reference source names is never
 * deleted. Nothing here logs, and no error carries a secret.
 */
export const createSecrets = (state: CoreState) => {
  let cache: SecretsCache | undefined;
  let loading: Promise<SecretsCache> | undefined;
  const sources = new Set<{ readonly source: ReferenceSource }>();
  const watchers = new Set<StreamObserver<string[]>>();
  const kinds: KindEntry[] = builtinCredentialKinds.map((definition) => ({
    generation: 0,
    definition,
  }));

  /** The kinds one call's generation view sees, built-in ones included. */
  const seenKinds = (call: Call, services: Services) => {
    const view = viewOf(call, services);

    return kinds
      .filter((entry) => seenBy(entry.generation, view))
      .map(({ definition }) => definition);
  };

  /** The definition a call may use; a kind no view registers is refused. */
  const knownKind = (
    kind: CredentialKind,
    call: Call,
    services: Services,
  ): CredentialKindDefinition => {
    const definition = seenKinds(call, services).find(({ id }) => id === kind);

    if (definition === undefined) {
      throw unknownKind(kind);
    }

    return definition;
  };

  /**
   * Hands one watcher the list as the cache holds it now. A remote listener
   * answers a promise; neither its rejection nor a throwing listener reaches
   * the write that changed the list.
   */
  const deliver = async (
    watcher: StreamObserver<string[]>,
    list: string[],
  ): Promise<void> => {
    try {
      await (watcher.next(list) as unknown);
    } catch {
      // A failing listener is that listener's problem.
    }
  };

  /** Delivers the current list to every watcher; resolves once all received it. */
  const changed = async (): Promise<void> => {
    if (cache === undefined || watchers.size === 0) {
      return;
    }

    const list = [...cache.view.redactions()];

    await Promise.all([...watchers].map((watcher) => deliver(watcher, list)));
  };

  const loaded = async (services: Services, call: Call) => {
    if (cache !== undefined) {
      return cache;
    }

    if (loading === undefined) {
      const pending = services
        .use(SecretsBackendV1)
        .list(call)
        .then((rows) => {
          cache ??= createSecretsCache(rows, () => {
            void changed();
          });

          return cache;
        });

      loading = pending;
      void pending.catch(() => {
        if (loading === pending) {
          loading = undefined;
        }
      });
    }

    return await loading;
  };

  const find = (secrets: SecretsCache, id: string): Secret | undefined =>
    secrets.list().find((credential) => credential.id === id);

  const referenced = (id: string): boolean => {
    for (const { source } of sources) {
      for (const candidate of source()) {
        if (candidate === id) {
          return true;
        }
      }
    }

    return false;
  };

  return defineService(SecretsV1, {
    resolve: defineMethod({
      ...secretsMethods.resolve,
      execute: async ({ id }: CredentialRef, call, services) => {
        const credential = find(await loaded(services, call), id);

        if (credential === undefined) {
          throw missing(id);
        }

        knownKind(credential.kind, call, services);

        return credential;
      },
    }),
    list: defineMethod({
      ...secretsMethods.list,
      execute: async (_input, call, services) =>
        (await loaded(services, call)).list().map(describe),
    }),
    kinds: defineMethod({
      ...secretsMethods.kinds,
      execute: async (_input, call, services) => seenKinds(call, services),
    }),
    registerKind: defineMethod({
      ...secretsMethods.registerKind,
      execute: (definition: CredentialKindDefinition, call, services) => {
        const view = viewOf(call, services);
        const taken = kinds.find(
          (entry) =>
            entry.definition.id === definition.id &&
            collidesIn(entry.generation, view),
        );

        if (taken !== undefined) {
          throw new ContractError(
            'duplicate_credential_kind',
            `Duplicate credential kind "${definition.id}": it is already registered.`,
            { kind: definition.id },
          );
        }

        const entry: KindEntry = {
          generation: view.generation,
          definition: Object.freeze({ ...definition }),
        };

        kinds.push(entry);

        let disposed = false;

        return {
          dispose: () => {
            if (disposed) {
              return;
            }

            disposed = true;

            const index = kinds.indexOf(entry);

            if (index >= 0) {
              kinds.splice(index, 1);
            }
          },
        } satisfies Disposable;
      },
    }),
    describe: defineMethod({
      ...secretsMethods.describe,
      execute: async ({ id }: CredentialRef, call, services) => {
        const credential = find(await loaded(services, call), id);

        return credential === undefined ? undefined : describe(credential);
      },
    }),
    create: defineMethod({
      ...secretsMethods.create,
      execute: async (input: CredentialCreate, call, services) =>
        await state.writes.run(async () => {
          const secrets = await loaded(services, call);
          const definition = knownKind(input.kind, call, services);

          if (!credentialFieldsSatisfied(definition, input)) {
            throw invalid(definition);
          }

          const credential: Secret = {
            id: randomUUID(),
            kind: input.kind,
            name: input.name,
            ...(input.username === undefined
              ? {}
              : { username: input.username }),
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.secret === undefined ? {} : { secret: input.secret }),
          };

          await services.use(SecretsBackendV1).put(row(credential), call);
          secrets.save(credential);
          await changed();

          return describe(credential);
        }),
    }),
    update: defineMethod({
      ...secretsMethods.update,
      execute: async (
        [{ id }, input]: [CredentialRef, CredentialUpdate],
        call,
        services,
      ) =>
        await state.writes.run(async () => {
          const secrets = await loaded(services, call);
          const current = find(secrets, id);

          if (current === undefined) {
            throw missing(id);
          }

          if (input.kind !== undefined && input.kind !== current.kind) {
            throw new ContractError(
              'credential_kind_immutable',
              `Credential ${id} is a ${current.kind} credential; its kind cannot change.`,
              { id, kind: current.kind },
            );
          }

          // Absent or null keeps the stored field; any string sets it.
          const username = input.username ?? current.username;
          const email = input.email ?? current.email;
          const secret = input.secret ?? current.secret;
          const next: Secret = {
            id,
            kind: current.kind,
            name: input.name ?? current.name,
            ...(username === undefined ? {} : { username }),
            ...(email === undefined ? {} : { email }),
            ...(secret === undefined ? {} : { secret }),
          };

          const definition = knownKind(current.kind, call, services);

          if (!credentialFieldsSatisfied(definition, next)) {
            throw invalid(definition);
          }

          await services.use(SecretsBackendV1).put(row(next), call);
          secrets.save(next);
          await changed();

          return describe(next);
        }),
    }),
    delete: defineMethod({
      ...secretsMethods.delete,
      execute: async ({ id }: CredentialRef, call, services) =>
        await state.writes.run(async () => {
          const secrets = await loaded(services, call);

          // References are checked first, before the backend is touched.
          if (referenced(id)) {
            return 'referenced' as const;
          }

          const outcome = await services.use(SecretsBackendV1).delete(id, call);

          // A deleted credential stops resolving at once.
          if (outcome === 'deleted') {
            secrets.remove(id);
            await changed();
          }

          return outcome;
        }),
    }),
    resolveByKind: defineMethod({
      ...secretsMethods.resolveByKind,
      execute: async (
        [kind, options]: [CredentialKind, ResolveByKindOptions?],
        call,
        services,
      ) => {
        knownKind(kind, call, services);

        const excluded = new Set(options?.exclude ?? []);
        const matches = (await loaded(services, call))
          .list()
          .filter(
            (credential) =>
              !excluded.has(credential.id) && credential.kind === kind,
          );

        if (matches.length > 1) {
          throw new ContractError(
            'credential_ambiguous',
            `More than one ${kind} credential is stored; name the one to use.`,
            { kind },
          );
        }

        return matches[0];
      },
    }),
    redactions: defineMethod({
      ...secretsMethods.redactions,
      execute: async (_input, call, services) =>
        (await loaded(services, call)).view.redactions(),
    }),
    watchRedactions: defineMethod({
      ...secretsMethods.watchRedactions,
      execute: (listener: StreamListener<string[]>, call, services) => {
        const watcher = toStreamObserver(listener);
        let open = true;

        watchers.add(watcher);
        // The first list is the current one, once the credentials are loaded;
        // a load failure leaves the watcher waiting for the next change.
        void loaded(services, call).then(
          (secrets) =>
            open ? deliver(watcher, [...secrets.view.redactions()]) : undefined,
          () => undefined,
        );

        return once(() => {
          open = false;
          watchers.delete(watcher);
        });
      },
    }),
    registerReferences: defineMethod({
      ...secretsMethods.registerReferences,
      execute: (source: ReferenceSource) => {
        const registration = { source };

        sources.add(registration);

        return once(() => {
          sources.delete(registration);
        });
      },
    }),
    view: defineMethod({
      ...secretsMethods.view,
      execute: () => {
        if (cache === undefined) {
          throw new ContractError('unavailable', 'Credentials are not loaded.');
        }

        return cache.view;
      },
    }),
  });
};
