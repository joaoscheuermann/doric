import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Call,
  ContractError,
  DoricCacheV1,
  defineMethod,
  defineService,
  type Services,
  type SettingsDefinition,
  type SettingsEntry,
  type SettingsSetOptions,
  SettingsV1,
  settingsMethods,
} from 'bundle/contracts';

import { describeIssues } from '../shared/issues.js';
import { viewOf } from '../shared/partition.js';
import {
  createSpaceRegistry,
  type SpaceEntry,
} from '../shared/settings-registry.js';
import {
  assertDefinitionOwner,
  type CoreState,
  once,
} from '../shared/state.js';

/** The preferences file, in the core's `doric.cache/v1` directory. */
export const SETTINGS_FILE = 'settings.json';

/** One written space, as the file stores it. */
interface StoredSpace {
  readonly value: unknown;
  readonly revision: number;
  readonly version: string;
  readonly updatedAt: string;
  readonly generation: number;
}

/** The whole file: the global write counter and every written space. */
interface StoredFile {
  readonly generation: number;
  readonly spaces: Readonly<Record<string, StoredSpace>>;
}

const EMPTY: StoredFile = { generation: 0, spaces: {} };

/** A space that was never written: revision and generation 0, at the epoch. */
const NEVER_WRITTEN = new Date(0).toISOString();

const isMissing = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'ENOENT';

/**
 * The desktopMain `settings/v1`: the local preferences of this desktop, with
 * the host provider's semantics (registration by owner, values with their
 * revision, version and write time, `expectedRevision` conflicts, listeners
 * after each commit). Every space lives in one JSON file in the core's
 * `doric.cache/v1` directory, replaced atomically on each write; the file
 * appears with the first `set`.
 */
export const createDesktopSettings = (state: CoreState) => {
  const spaces = createSpaceRegistry();
  let file: Promise<StoredFile> | undefined;
  let directory: Promise<string> | undefined;

  const directoryOf = (services: Services, call: Call): Promise<string> => {
    directory ??= services.use(DoricCacheV1).directory(call);
    void directory.catch(() => {
      directory = undefined;
    });

    return directory;
  };

  const load = (services: Services, call: Call): Promise<StoredFile> => {
    if (file !== undefined) {
      return file;
    }

    const pending = (async (): Promise<StoredFile> => {
      const path = join(await directoryOf(services, call), SETTINGS_FILE);

      try {
        return JSON.parse(await readFile(path, 'utf8')) as StoredFile;
      } catch (error) {
        if (isMissing(error)) {
          return EMPTY;
        }

        throw new ContractError(
          'invalid_output',
          `The settings file ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();

    file = pending;
    void pending.catch(() => {
      if (file === pending) {
        file = undefined;
      }
    });

    return pending;
  };

  const save = async (
    next: StoredFile,
    services: Services,
    call: Call,
  ): Promise<void> => {
    const dir = await directoryOf(services, call);
    const path = join(dir, SETTINGS_FILE);
    const temporary = `${path}.${process.pid}.tmp`;

    await mkdir(dir, { recursive: true });

    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  const entryOf = (
    space: SpaceEntry,
    stored: StoredSpace | undefined,
  ): SettingsEntry => {
    const { definition, version } = space;

    if (stored === undefined) {
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

    const value = definition.schema.safeParse(stored.value);

    if (!value.success) {
      throw new ContractError(
        'invalid_output',
        `Stored settings ${definition.id} do not match their schema: ${describeIssues(value.error)}`,
        { settings: definition.id },
      );
    }

    return {
      value: value.data,
      revision: stored.revision,
      version: stored.version,
      updatedAt: stored.updatedAt,
      generation: stored.generation,
    };
  };

  const read = async (
    definition: SettingsDefinition,
    call: Call,
    services: Services,
  ): Promise<SettingsEntry> => {
    const space = spaces.require(definition.id, viewOf(call, services));
    const stored = (await load(services, call)).spaces[definition.id];

    return entryOf(space, stored);
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

    const current = await load(services, call);
    const revision = current.spaces[definition.id]?.revision ?? 0;

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

    const generation = current.generation + 1;
    const stored: StoredSpace = {
      value: parsed.data,
      revision: revision + 1,
      version: space.version,
      updatedAt: new Date(state.now()).toISOString(),
      generation,
    };
    const next: StoredFile = {
      generation,
      spaces: { ...current.spaces, [definition.id]: stored },
    };

    await save(next, services, call);
    file = Promise.resolve(next);

    const entry: SettingsEntry = {
      value: parsed.data,
      revision: stored.revision,
      version: stored.version,
      updatedAt: stored.updatedAt,
      generation,
    };

    for (const { bundleId, listener } of spaces
      .all(definition.id)
      .flatMap((registered) => [...registered.listeners])) {
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
