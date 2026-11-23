// The core's `secrets/v1` over the router: the rules of `createSecrets`
// (`./facade.ts`) over `secrets.backend/v1`, the reference sources reached
// through each registrant's `ReferenceSourceService`, and `WatchRedactions`
// as a resumable stream of the complete list.

import { randomUUID } from 'node:crypto';

import { ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  builtinCredentialKinds,
  type Call,
  ContractError,
  type CredentialKindDefinition,
  type CredentialValues,
  callOf,
  credentialFieldsSatisfied,
  fromConnectError,
  type Secret,
  secretsMethods,
} from 'bundle/contracts';
import type { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { type StampedCaller, stampedCallerOf } from 'bundle/host';

import { describeIssues } from '../../shared/issues.js';
import {
  collidesIn,
  routedViewOf,
  seenBy,
  type View,
} from '../../shared/partition.js';
import { type CoreState, once } from '../../shared/state.js';
import type { CoreBinding } from '../binding.js';
import { createInbox } from '../inbox.js';
import { createRegistrations, type Registrations } from '../registrations.js';
import { invalid, type KindEntry, missing, row } from './facade.js';
import { createSecretsCache, describe, type SecretsCache } from './cache.js';

const unknownKind = (kind: string): ContractError =>
  new ContractError(
    'unknown_kind',
    `Credential kind ${kind} is not registered.`,
    { kind },
  );

/** One `RegisterReferences`: the registering instance and its source name. */
interface SourceEntry {
  readonly id: string;
  readonly caller: StampedCaller;
  readonly source: string;
}

/** The optional fields of a request, without the absent ones. */
const valuesOf = (input: {
  readonly username?: string | undefined;
  readonly email?: string | undefined;
  readonly secret?: string | undefined;
}): CredentialValues => ({
  ...(input.username === undefined ? {} : { username: input.username }),
  ...(input.email === undefined ? {} : { email: input.email }),
  ...(input.secret === undefined ? {} : { secret: input.secret }),
});

/** A kind definition as `secrets/v1` answers it. */
const kindMessage = (definition: {
  readonly id: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly label?: string | undefined;
}) => ({
  id: definition.id,
  required: [...definition.required],
  optional: [...definition.optional],
  ...(definition.label === undefined ? {} : { label: definition.label }),
});

/**
 * `secrets/v1` as `createCoreServices` serves it. Each RPC keeps the
 * semantics and errors of the matching method of today's facade:
 * - `Delete` first calls `ReferenceSourceService.List{source}` of every live
 *   reference registration, at its instance; a listed id answers
 *   `referenced`, and a source call that fails fails the `Delete` with that
 *   error and deletes nothing.
 * - `RegisterReferences` is keyed by (instance, `source`): the same instance
 *   and name again replaces it and answers the same id.
 * - `WatchRedactions` yields the complete list once loaded, then the list
 *   after each change, until the call ends. A write resolves after its list
 *   was queued on every open stream; a stream that ended does not fail it.
 * Credentials load on the first call that needs them.
 */
export const createSecretsService = (
  state: CoreState,
  bind: () => CoreBinding,
): {
  readonly implementation: ServiceImpl<typeof SecretsService>;
  readonly registrations: Registrations;
  /** The redaction list `events/v1.Append` redacts with; loads the cache once. */
  redactions(call: Call): Promise<readonly string[]>;
} => {
  const registrations = createRegistrations('secrets-');
  const sources = new Map<string, SourceEntry>();
  const watchers = new Set<(list: string[]) => void>();
  const kinds: KindEntry[] = builtinCredentialKinds.map((definition) => ({
    generation: 0,
    definition,
  }));
  let cache: SecretsCache | undefined;
  let loading: Promise<SecretsCache> | undefined;

  /** Queues the current list on every open stream. */
  const changed = (): void => {
    if (cache === undefined) {
      return;
    }

    const list = [...cache.view.redactions()];

    for (const push of watchers) {
      push(list);
    }
  };

  /** The cache, loading the backend once; a failed load is retried. */
  const loaded = async (): Promise<SecretsCache> => {
    const binding = bind();

    if (cache !== undefined) {
      return cache;
    }

    if (loading === undefined) {
      // Shared by every waiting call, so no one call's signal ends it.
      const pending = binding.secretsBackend.list().then((rows) => {
        cache ??= createSecretsCache(rows, changed);

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

  const viewOf = async (call: Call): Promise<View> =>
    routedViewOf(call, await bind().catalog(call));

  /** The kinds one call's generation view sees, built-in ones included. */
  const seenKinds = async (call: Call) => {
    const view = await viewOf(call);

    return kinds
      .filter((entry) => seenBy(entry.generation, view))
      .map(({ definition }) => definition);
  };

  /** The definition a call may use; a kind no view registers is refused. */
  const knownKind = async (
    kind: string,
    call: Call,
  ): Promise<CredentialKindDefinition> => {
    const definition = (await seenKinds(call)).find(({ id }) => id === kind);

    if (definition === undefined) {
      throw unknownKind(kind);
    }

    return definition;
  };

  const find = (secrets: SecretsCache, id: string): Secret | undefined =>
    secrets.list().find((credential) => credential.id === id);

  /** Whether a live reference source names `id`; a failing source fails. */
  const referenced = async (id: string, call: Call): Promise<boolean> => {
    for (const { caller, source } of [...sources.values()]) {
      let credentialIds: readonly string[];

      try {
        ({ credentialIds } = await bind()
          .referenceSource(caller)
          .list({ source }, { signal: call.signal }));
      } catch (error) {
        throw error instanceof ConnectError ? fromConnectError(error) : error;
      }

      if (credentialIds.includes(id)) {
        return true;
      }
    }

    return false;
  };

  const implementation: ServiceImpl<typeof SecretsService> = {
    resolve: async ({ credentialRef }, context) => {
      const call = callOf(context);
      const id = credentialRef?.id ?? '';
      const credential = find(await loaded(), id);

      if (credential === undefined) {
        throw missing(id);
      }

      await knownKind(credential.kind, call);

      return { secret: credential };
    },
    list: async () => ({
      credentials: (await loaded()).list().map(describe),
    }),
    kinds: async (_input, context) => ({
      kinds: (await seenKinds(callOf(context))).map(kindMessage),
    }),
    registerKind: async ({ credentialKindDefinition }, context) => {
      const call = callOf(context);
      const parsed = secretsMethods.registerKind.input.safeParse(
        credentialKindDefinition === undefined
          ? undefined
          : kindMessage(credentialKindDefinition),
      );

      if (!parsed.success) {
        throw new ContractError(
          'invalid_input',
          `Invalid credential kind: ${describeIssues(parsed.error)}`,
        );
      }

      const definition = parsed.data;
      const view = await viewOf(call);
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

      return {
        registrationId: registrations.add(
          stampedCallerOf(context),
          once(() => {
            const index = kinds.indexOf(entry);

            if (index >= 0) {
              kinds.splice(index, 1);
            }
          }),
        ),
      };
    },
    registerReferences: ({ source }, context) => {
      bind();

      const caller = stampedCallerOf(context);
      const key = JSON.stringify([
        caller.bundleId,
        caller.generation,
        caller.incarnation,
        source,
      ]);
      const current = sources.get(key);

      if (current !== undefined) {
        return { registrationId: current.id };
      }

      const id = registrations.add(
        caller,
        once(() => {
          if (sources.get(key)?.id === id) {
            sources.delete(key);
          }
        }),
      );

      sources.set(key, { id, caller, source });

      return { registrationId: id };
    },
    unregister: ({ registrationId }, context) => {
      bind();
      registrations.remove(registrationId, callOf(context).caller);

      return {};
    },
    describe: async ({ credentialRef }) => {
      const credential = find(await loaded(), credentialRef?.id ?? '');

      return credential === undefined
        ? {}
        : { credentialDescription: describe(credential) };
    },
    create: async (input, context) => {
      const call = callOf(context);

      return await state.writes.run(async () => {
        const secrets = await loaded();
        const definition = await knownKind(input.kind, call);
        const values = valuesOf(input);

        if (!credentialFieldsSatisfied(definition, values)) {
          throw invalid(definition);
        }

        const credential: Secret = {
          id: randomUUID(),
          kind: input.kind,
          name: input.name,
          ...values,
        };

        await bind().secretsBackend.put(row(credential), call);
        secrets.save(credential);
        changed();

        return { credentialDescription: describe(credential) };
      });
    },
    update: async ({ ref, update }, context) => {
      const call = callOf(context);
      const id = ref?.id ?? '';

      return await state.writes.run(async () => {
        const secrets = await loaded();
        const current = find(secrets, id);

        if (current === undefined) {
          throw missing(id);
        }

        if (update?.kind !== undefined && update.kind !== current.kind) {
          throw new ContractError(
            'credential_kind_immutable',
            `Credential ${id} is a ${current.kind} credential; its kind cannot change.`,
            { id, kind: current.kind },
          );
        }

        // Absent keeps the stored field; any string sets it.
        const next: Secret = {
          id,
          kind: current.kind,
          name: update?.name ?? current.name,
          ...valuesOf({
            username: update?.username ?? current.username,
            email: update?.email ?? current.email,
            secret: update?.secret ?? current.secret,
          }),
        };
        const definition = await knownKind(current.kind, call);

        if (!credentialFieldsSatisfied(definition, next)) {
          throw invalid(definition);
        }

        await bind().secretsBackend.put(row(next), call);
        secrets.save(next);
        changed();

        return { credentialDescription: describe(next) };
      });
    },
    delete: async ({ credentialRef }, context) => {
      const call = callOf(context);
      const id = credentialRef?.id ?? '';

      return await state.writes.run(async () => {
        const secrets = await loaded();

        // References are checked first, before the backend is touched.
        if (await referenced(id, call)) {
          return { result: 'referenced' };
        }

        const outcome = await bind().secretsBackend.delete(id, call);

        // A deleted credential stops resolving at once.
        if (outcome === 'deleted') {
          secrets.remove(id);
          changed();
        }

        return { result: outcome };
      });
    },
    resolveByKind: async ({ kind, exclude }, context) => {
      await knownKind(kind, callOf(context));

      const excluded = new Set(exclude);
      const matches = (await loaded())
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

      const [match] = matches;

      return match === undefined ? {} : { secret: match };
    },
    listSecrets: async () => ({ secrets: [...(await loaded()).list()] }),
    redactions: async () => ({
      redactions: [...(await loaded()).view.redactions()],
    }),
    addRedaction: async ({ secret }) => {
      (await loaded()).view.addRedaction(secret);

      return {};
    },
    async *watchRedactions(_input, context) {
      const secrets = await loaded();
      const inbox = createInbox<string[]>(context.signal);

      // Subscribed and read with no await between, so no change falls
      // between the first list and the next.
      watchers.add(inbox.push);

      try {
        yield { redactions: [...secrets.view.redactions()] };

        for (
          let list = await inbox.next();
          list !== undefined;
          list = await inbox.next()
        ) {
          yield { redactions: list };
        }
      } finally {
        watchers.delete(inbox.push);
      }
    },
  };

  return {
    implementation,
    registrations,
    redactions: async () => (await loaded()).view.redactions(),
  };
};
