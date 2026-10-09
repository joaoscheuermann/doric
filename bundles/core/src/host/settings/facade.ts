import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
  type SettingsDefinition,
  type SettingsEntry,
  type SettingsSetOptions,
  SettingsV1,
  StorageV1,
  type StoredDocument,
  settingsMethods,
} from 'bundle/contracts';

import {
  settingsGenerationId,
  settingsGenerationType,
  settingsType,
} from '../../contracts/storage.js';
import { describeIssues } from '../issues.js';
import { viewOf } from '../partition.js';
import { assertDefinitionOwner, type CoreState, once } from '../state.js';
import { createSpaceRegistry, type SpaceEntry } from './registry.js';

/** What a `core.settings/v1` document holds. */
interface StoredSpace {
  readonly value: unknown;
  readonly version: string;
  readonly updatedAt: string;
  readonly generation: number;
}

/** A space that was never written: revision and generation 0, at the epoch. */
const NEVER_WRITTEN = new Date(0).toISOString();

/** A JSON copy, as the backend would hand it back. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The core's `settings/v1`: each registered space is one `core.settings/v1`
 * document, and a global `core.settings-generation/v1` counter grows with
 * every write. Writes run in the core's write queue; subscribers run
 * synchronously after the commit, before the queue moves on. Reads come from
 * a cache filled on the first read of each space.
 */
export const createSettings = (state: CoreState) => {
  const spaces = createSpaceRegistry();
  const documents = new Map<string, Promise<StoredDocument | undefined>>();

  const storageOf = (services: Services) => services.use(StorageV1);

  const load = (
    id: string,
    services: Services,
    call: Call,
  ): Promise<StoredDocument | undefined> => {
    const cached = documents.get(id);

    if (cached !== undefined) {
      return cached;
    }

    const pending = storageOf(services).get(
      { type: settingsType.type, id },
      call,
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
    document: StoredDocument | undefined,
  ): SettingsEntry => {
    const { definition, version } = space;

    if (document === undefined) {
      const empty = definition.schema.safeParse({});

      if (!empty.success) {
        throw new ContractError(
          'settings_missing',
          `Settings ${definition.id} were never set and have no default.`,
          { settings: definition.id },
        );
      }

      return {
        value: empty.data,
        revision: 0,
        version,
        updatedAt: NEVER_WRITTEN,
        generation: 0,
      };
    }

    const body = document.value as StoredSpace;
    const value = definition.schema.safeParse(body.value);

    if (!value.success) {
      throw new ContractError(
        'invalid_output',
        `Stored settings ${definition.id} do not match their schema: ${describeIssues(value.error)}`,
        { settings: definition.id },
      );
    }

    return {
      value: value.data,
      revision: document.revision,
      version: body.version,
      updatedAt: body.updatedAt,
      generation: body.generation,
    };
  };

  const read = async (
    definition: SettingsDefinition,
    call: Call,
    services: Services,
  ): Promise<SettingsEntry> => {
    const space = spaces.require(definition.id, viewOf(call, services));

    return entryOf(space, await load(definition.id, services, call));
  };

  const write = async (
    space: SpaceEntry,
    value: unknown,
    options: SettingsSetOptions | undefined,
    call: Call,
    services: Services,
  ): Promise<SettingsEntry> => {
    const { definition } = space;
    const parsed = definition.schema.safeParse(value);

    if (!parsed.success) {
      throw new ContractError(
        'invalid_input',
        `Invalid settings ${definition.id}: ${describeIssues(parsed.error)}`,
        { settings: definition.id },
      );
    }

    const storage = storageOf(services);
    const current = await storage.get(
      { type: settingsType.type, id: definition.id },
      call,
    );
    const counter = await storage.get(
      { type: settingsGenerationType.type, id: settingsGenerationId },
      call,
    );
    const revision = current?.revision ?? 0;

    if (
      options?.expectedRevision !== undefined &&
      options.expectedRevision !== revision
    ) {
      throw new ContractError(
        'settings_conflict',
        `Settings ${definition.id} are at revision ${revision}, not ${options.expectedRevision}.`,
        {
          settings: definition.id,
          expected: options.expectedRevision,
          actual: revision,
        },
      );
    }

    const generation =
      ((counter?.value as { generation?: number } | undefined)?.generation ??
        0) + 1;
    const body: StoredSpace = {
      value: parsed.data,
      version: space.version,
      updatedAt: new Date(state.now()).toISOString(),
      generation,
    };

    await storage.commit(
      {
        expect: [
          { type: settingsType.type, id: definition.id, revision },
          {
            type: settingsGenerationType.type,
            id: settingsGenerationId,
            revision: counter?.revision ?? 0,
          },
        ],
        put: [
          { type: settingsType.type, id: definition.id, value: body },
          {
            type: settingsGenerationType.type,
            id: settingsGenerationId,
            value: { generation },
          },
        ],
      },
      call,
    );

    documents.set(
      definition.id,
      Promise.resolve({
        type: settingsType.type,
        id: definition.id,
        revision: revision + 1,
        value: stored(body),
      }),
    );

    const entry: SettingsEntry = {
      value: parsed.data,
      revision: revision + 1,
      version: body.version,
      updatedAt: body.updatedAt,
      generation,
    };

    // One document backs the space in every generation, so every live
    // registration's subscribers hear the write (D4-11).
    const listeners = spaces
      .all(definition.id)
      .flatMap((registered) => [...registered.listeners]);

    for (const { bundleId, listener } of listeners) {
      try {
        listener(entry);
      } catch (error) {
        state.report(services, bundleId, 'settings_listener_failed', error);
      }
    }

    return entry;
  };

  return defineService(SettingsV1, {
    register: defineMethod({
      ...settingsMethods.register,
      execute: (definition: SettingsDefinition, call, services) => {
        const version = assertDefinitionOwner(
          state,
          call,
          services,
          definition.id,
          'settings',
        );

        return spaces.register(
          definition,
          call.caller.bundleId,
          version,
          viewOf(call, services),
        );
      },
    }),
    get: defineMethod({
      ...settingsMethods.get,
      execute: async (definition: SettingsDefinition, call, services) =>
        (await read(definition, call, services)).value,
    }),
    entry: defineMethod({
      ...settingsMethods.entry,
      execute: async (definition: SettingsDefinition, call, services) =>
        await read(definition, call, services),
    }),
    set: defineMethod({
      ...settingsMethods.set,
      execute: async (
        [definition, value, options]: [
          SettingsDefinition,
          unknown,
          SettingsSetOptions?,
        ],
        call,
        services,
      ) => {
        const space = spaces.require(definition.id, viewOf(call, services));

        return await state.writes.run(() =>
          write(space, value, options, call, services),
        );
      },
    }),
    subscribe: defineMethod({
      ...settingsMethods.subscribe,
      execute: (
        [definition, listener]: [
          SettingsDefinition,
          (entry: SettingsEntry) => void,
        ],
        call,
        services,
      ) => {
        const space = spaces.require(definition.id, viewOf(call, services));
        const subscription = { bundleId: call.caller.bundleId, listener };

        space.listeners.add(subscription);

        return once(() => {
          space.listeners.delete(subscription);
        });
      },
    }),
  });
};
