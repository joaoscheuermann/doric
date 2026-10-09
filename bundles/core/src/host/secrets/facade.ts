import { randomUUID } from 'node:crypto';

import {
  type Call,
  ContractError,
  type CredentialCreate,
  type CredentialKind,
  type CredentialRef,
  type CredentialUpdate,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
  defineMethod,
  defineService,
  type ReferenceSource,
  type ResolveByKindOptions,
  type Secret,
  SecretsBackendV1,
  SecretsV1,
  type Services,
  type StoredSecret,
  secretsMethods,
} from 'bundle/contracts';

import { type CoreState, once } from '../state.js';
import { createSecretsCache, describe, type SecretsCache } from './cache.js';

const missing = (id: string): ContractError =>
  new ContractError('credential_missing', `Credential ${id} is not stored.`, {
    id,
  });

const invalid = (kind: CredentialKind): ContractError =>
  new ContractError('credential_invalid', credentialFieldsMessage(kind), {
    kind,
  });

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

  const loaded = async (services: Services, call: Call) => {
    if (cache !== undefined) {
      return cache;
    }

    if (loading === undefined) {
      const pending = services
        .use(SecretsBackendV1)
        .list(call)
        .then((rows) => {
          cache ??= createSecretsCache(rows);

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

        return credential;
      },
    }),
    list: defineMethod({
      ...secretsMethods.list,
      execute: async (_input, call, services) =>
        (await loaded(services, call)).list().map(describe),
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

          if (!credentialFieldsSatisfied(input.kind, input)) {
            throw invalid(input.kind);
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

          if (!credentialFieldsSatisfied(current.kind, next)) {
            throw invalid(current.kind);
          }

          await services.use(SecretsBackendV1).put(row(next), call);
          secrets.save(next);

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
