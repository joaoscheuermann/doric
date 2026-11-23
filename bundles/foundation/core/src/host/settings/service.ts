// The core's `settings/v1` over the router: the rules of `createSettings`
// (`./facade.ts`) with `google.protobuf.Any` values, the router's stamp for
// the generation view and `core`'s storage facade reached in process.

import { create, type DescMessage, type Registry } from '@bufbuild/protobuf';
import type { Any } from '@bufbuild/protobuf/wkt';
import type { ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  defineSettings,
  isContractId,
  type StoredDocument,
} from 'bundle/contracts';
import type { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { stampedCallerOf } from 'bundle/host';
import type { StorageFacade } from 'storage/rpc';
import { z } from 'zod';

import {
  settingsGenerationId,
  settingsGenerationType,
  settingsType,
} from '../../contracts/storage.js';
import { routedViewOf } from '../../shared/partition.js';
import {
  createSpaceRegistry,
  type SpaceEntry,
} from '../../shared/settings-registry.js';
import { assertDefinitionOwnerIn, type CoreState } from '../../shared/state.js';
import type { CoreBinding } from '../binding.js';
import { accepts, anyOfJson, jsonOfAny, optionMessage } from '../messages.js';
import { createRegistrations, type Registrations } from '../registrations.js';

/** What a `core.settings/v1` document holds. */
interface StoredSpace {
  readonly value: unknown;
  readonly version: string;
  readonly updatedAt: string;
  readonly generation: number;
}

/** A `settings/v1.SettingsEntry` as the handlers answer it. */
interface Entry {
  readonly value: Any;
  readonly revision: number;
  readonly version: string;
  readonly updatedAt: string;
  readonly generation: number;
}

/** A space that was never written: revision and generation 0, at the epoch. */
const NEVER_WRITTEN = new Date(0).toISOString();

/** A JSON copy, as the backend would hand it back. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The items of one open `Watch`, queued by the writes it hears. */
const createInbox = (signal: AbortSignal) => {
  const items: Entry[] = [];
  let wake: (() => void) | undefined;

  signal.addEventListener('abort', () => wake?.(), { once: true });

  return {
    push: (entry: Entry) => {
      items.push(entry);
      wake?.();
    },
    /** The next item, or `undefined` once `signal` aborted. */
    next: async (): Promise<Entry | undefined> => {
      while (items.length === 0 && !signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }

      return signal.aborted ? undefined : items.shift();
    },
  };
};

export const createSettingsService = (
  state: CoreState,
  bind: () => CoreBinding,
  storage: StorageFacade,
  types: () => Registry,
): {
  readonly implementation: ServiceImpl<typeof SettingsService>;
  readonly registrations: Registrations;
} => {
  const spaces = createSpaceRegistry();
  const registrations = createRegistrations('settings-');
  const messages = new WeakMap<SpaceEntry['definition'], DescMessage>();
  const documents = new Map<string, Promise<StoredDocument | undefined>>();
  const watchers = new Map<string, Set<(entry: Entry) => void>>();
  let defined: Promise<void> | undefined;

  /** `core`'s two types, defined once on the first settings call; a failure is retried. */
  const ensureTypes = (call: Call): Promise<void> => {
    if (defined === undefined) {
      const own = bind().own(call);
      const pending = (async () => {
        await storage.defineType(settingsType, own);
        await storage.defineType(settingsGenerationType, own);
      })();

      defined = pending;
      void pending.catch(() => {
        if (defined === pending) {
          defined = undefined;
        }
      });
    }

    return defined;
  };

  /** The space `call` sees, after `core`'s types are in place. */
  const spaceOf = async (id: string, call: Call) => {
    const binding = bind();

    await ensureTypes(call);

    const space = spaces.require(
      id,
      routedViewOf(call, await binding.catalog(call)),
    );
    const desc = messages.get(space.definition);

    if (desc === undefined) {
      throw new ContractError(
        'unknown_settings',
        `Settings ${id} are not registered.`,
        { settings: id },
      );
    }

    return { space, desc };
  };

  const load = (id: string, call: Call): Promise<StoredDocument | undefined> => {
    const cached = documents.get(id);

    if (cached !== undefined) {
      return cached;
    }

    const pending = storage.get(
      { type: settingsType.type, id },
      bind().own(call),
    );

    documents.set(id, pending);
    void pending.catch(() => {
      if (documents.get(id) === pending) {
        documents.delete(id);
      }
    });

    return pending;
  };

  const entryOf = (
    space: SpaceEntry,
    desc: DescMessage,
    document: StoredDocument | undefined,
  ): Entry => {
    if (document === undefined) {
      const empty = create(desc);

      if (!accepts(desc, empty)) {
        throw new ContractError(
          'settings_missing',
          `Settings ${space.definition.id} were never set and have no default.`,
          { settings: space.definition.id },
        );
      }

      return {
        value: anyOfJson({}, desc, types()),
        revision: 0,
        version: space.version,
        updatedAt: NEVER_WRITTEN,
        generation: 0,
      };
    }

    const body = document.value as StoredSpace;

    return {
      value: anyOfJson(body.value, desc, types()),
      revision: document.revision,
      version: body.version,
      updatedAt: body.updatedAt,
      generation: body.generation,
    };
  };

  const read = async (id: string, call: Call): Promise<Entry> => {
    const { space, desc } = await spaceOf(id, call);

    return entryOf(space, desc, await load(id, call));
  };

  const write = async (
    space: SpaceEntry,
    desc: DescMessage,
    json: unknown,
    expectedRevision: number | undefined,
    call: Call,
  ): Promise<Entry> => {
    const { id } = space.definition;
    const own = bind().own(call);
    const current = await storage.get({ type: settingsType.type, id }, own);
    const counter = await storage.get(
      { type: settingsGenerationType.type, id: settingsGenerationId },
      own,
    );
    const revision = current?.revision ?? 0;

    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new ContractError(
        'settings_conflict',
        `Settings ${id} are at revision ${revision}, not ${expectedRevision}.`,
        { settings: id, expected: expectedRevision, actual: revision },
      );
    }

    const generation =
      ((counter?.value as { generation?: number } | undefined)?.generation ??
        0) + 1;
    const body: StoredSpace = {
      value: json,
      version: space.version,
      updatedAt: new Date(state.now()).toISOString(),
      generation,
    };

    await storage.commit(
      {
        expect: [
          { type: settingsType.type, id, revision },
          {
            type: settingsGenerationType.type,
            id: settingsGenerationId,
            revision: counter?.revision ?? 0,
          },
        ],
        put: [
          { type: settingsType.type, id, value: body },
          {
            type: settingsGenerationType.type,
            id: settingsGenerationId,
            value: { generation },
          },
        ],
      },
      own,
    );

    const document: StoredDocument = {
      type: settingsType.type,
      id,
      revision: revision + 1,
      value: stored(body),
    };

    documents.set(id, Promise.resolve(document));

    const entry = entryOf(space, desc, document);

    // One document backs the space in every generation, so every open
    // `Watch` of the id hears the write (D4-11), before the queue moves on.
    for (const listener of watchers.get(id) ?? []) {
      listener(entry);
    }

    return entry;
  };

  const implementation: ServiceImpl<typeof SettingsService> = {
    register: async ({ id, messageType }, context) => {
      const call = callOf(context);
      const binding = bind();

      await ensureTypes(call);

      const catalog = await binding.catalog(call);
      const version = assertDefinitionOwnerIn(catalog, call, id, 'settings');
      const desc = optionMessage(types(), messageType, 'settings', id);
      let definition: SpaceEntry['definition'];

      try {
        if (!isContractId(id)) {
          throw new TypeError(`${id} is not a settings id.`);
        }

        definition = defineSettings({ id, schema: z.unknown() });
      } catch (error) {
        throw new ContractError(
          'invalid_input',
          error instanceof Error ? error.message : String(error),
          { settings: id },
        );
      }

      messages.set(definition, desc);

      const disposable = spaces.register(
        definition,
        call.caller.bundleId,
        version,
        routedViewOf(call, catalog),
      );

      return {
        registrationId: registrations.add(stampedCallerOf(context), disposable),
      };
    },
    unregister: ({ registrationId }, context) => {
      bind();
      registrations.remove(registrationId, callOf(context).caller);

      return {};
    },
    get: async ({ id }, context) => ({
      value: (await read(id, callOf(context))).value,
    }),
    entry: async ({ id }, context) => ({
      settingsEntry: await read(id, callOf(context)),
    }),
    set: async ({ id, value, expectedRevision }, context) => {
      const call = callOf(context);
      const { space, desc } = await spaceOf(id, call);
      const json = jsonOfAny(value, desc, types(), 'value');

      return {
        settingsEntry: await state.writes.run(() =>
          write(space, desc, json, expectedRevision, call),
        ),
      };
    },
    async *watch({ id }, context) {
      const call = callOf(context);
      const { space, desc } = await spaceOf(id, call);
      const inbox = createInbox(context.signal);
      const listeners = watchers.get(id) ?? new Set();

      watchers.set(id, listeners);

      try {
        // Read the present entry in the write queue, so no write falls
        // between it and the subscription.
        const present = await state.writes.run(async () => {
          listeners.add(inbox.push);

          const document = await load(id, call);

          return document === undefined
            ? undefined
            : entryOf(space, desc, document);
        });

        if (present !== undefined) {
          yield { settingsEntry: present };
        }

        for (
          let entry = await inbox.next();
          entry !== undefined;
          entry = await inbox.next()
        ) {
          yield { settingsEntry: entry };
        }
      } finally {
        listeners.delete(inbox.push);

        if (listeners.size === 0 && watchers.get(id) === listeners) {
          watchers.delete(id);
        }
      }
    },
  };

  return { implementation, registrations };
};
