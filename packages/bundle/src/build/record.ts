import { basicContractSpec } from '../contracts/basic/index.js';
import type { Activate, Disposable, Services } from '../contracts/context.js';
import {
  type CommandDefinition,
  definitionKindOf,
  type EventDefinition,
  type HooksContract,
  isHooksContract,
  isServiceDefinition,
  isServiceRef,
  type SettingsDefinition,
  type StorageTypeDefinition,
} from '../contracts/define.js';
import { type Environment, isPlatformContract } from '../contracts/ids.js';
import { misdeclaredExposure } from '../runtime/exposure.js';
import { type ManifestV1, parseContractEntry } from '../runtime/manifest.js';
import type { RecordedContract } from './schemas.js';

const inert: Disposable = Object.freeze({ dispose: () => undefined });

/** A stub whose every method is a no-op returning an inert Disposable. */
const inertStub = (): unknown =>
  new Proxy(Object.create(null) as object, {
    get: (_target, property) =>
      typeof property === 'string' && property !== 'then'
        ? () => inert
        : undefined,
  });

const ids = (entries: readonly string[]): Set<string> =>
  new Set(
    entries.flatMap((entry) => {
      const parsed = parseContractEntry(entry);

      return parsed === undefined ? [] : [parsed.id];
    }),
  );

export class RecordingError extends Error {
  override readonly name = 'RecordingError';
}

/**
 * Runs a part's `activate` against recording services: provides, hook
 * definitions and event/settings/storage/command registrations are recorded,
 * every other call is an inert no-op and `whenAvailable` never fires.
 */
export const recordActivation = async (options: {
  readonly manifest: ManifestV1;
  readonly environment: Environment;
  readonly activate: Activate;
}): Promise<readonly RecordedContract[]> => {
  const { manifest, environment } = options;
  const requires = new Set([
    ...ids(manifest.requires),
    ...(manifest.optional ?? []),
  ]);
  const provides = ids(manifest.provides);
  const recorded: RecordedContract[] = [];
  const assertUsable = (id: string) => {
    if (!(isPlatformContract(id) || requires.has(id) || provides.has(id))) {
      throw new RecordingError(
        `Bundle "${manifest.id}" uses "${id}" without listing it in requires.`,
      );
    }
  };
  const hooksFacade = Object.freeze({
    define: (contract: HooksContract) => {
      if (!isHooksContract(contract)) {
        throw new RecordingError('define expects a hooks contract.');
      }

      if (!isPlatformContract(contract.id)) {
        recorded.push({
          id: contract.id,
          environment,
          cardinality: 'one',
          kind: 'hooks',
          hooks: contract.hooks,
        });
      }

      return Object.freeze(
        Object.fromEntries(
          Object.keys(contract.hooks).map((hook) => [
            hook,
            Object.freeze({ execute: () => Promise.resolve(undefined) }),
          ]),
        ),
      );
    },
    use: (contract: HooksContract) => {
      if (!isHooksContract(contract)) {
        throw new RecordingError('use expects a hooks contract.');
      }

      // Same rule as services.use: a consumed hooks contract is in requires.
      assertUsable(contract.id);

      return Object.freeze(
        Object.fromEntries(
          Object.keys(contract.hooks).map((hook) => [hook, () => inert]),
        ),
      );
    },
    whenAvailable: () => inert,
  });
  const recorders: Record<string, Record<string, (value: unknown) => void>> = {
    'events/v1': {
      register: (value) => {
        const event = value as EventDefinition;

        recorded.push({
          id: event.type,
          environment,
          cardinality: 'one',
          kind: 'event',
          payload: event.payload,
        });
      },
    },
    'settings/v1': {
      register: (value) => {
        const settings = value as SettingsDefinition;

        recorded.push({
          id: settings.id,
          environment,
          cardinality: 'one',
          kind: 'settings',
          value: settings.schema,
        });
      },
    },
    'storage/v1': {
      defineType: (value) => {
        const type = value as StorageTypeDefinition;

        recorded.push({
          id: type.type,
          environment,
          cardinality: 'one',
          kind: 'storage-type',
          value: type.schema,
          indexes: type.indexes,
        });
      },
    },
    'commands/v1': {
      register: (value) => {
        if (definitionKindOf(value) !== 'command') {
          return;
        }

        const command = value as CommandDefinition;

        recorded.push({
          id: command.id,
          environment,
          cardinality: 'one',
          kind: 'command',
          input: command.input,
        });
      },
    },
  };
  const services: Services = Object.freeze({
    provide: (definition: unknown) => {
      if (!isServiceDefinition(definition)) {
        throw new RecordingError('provide expects a service definition.');
      }

      // One bundle may serve several records of a `many` contract (one per
      // provider kind); the descriptor lists the contract once.
      if (
        definition.cardinality === 'many' &&
        recorded.some(
          (entry) =>
            entry.kind === 'service' &&
            entry.id === definition.id &&
            entry.cardinality === 'many',
        )
      ) {
        return inert;
      }

      recorded.push({
        id: definition.id,
        environment,
        cardinality: definition.cardinality,
        kind: 'service',
        methods: definition.methods,
      });

      return inert;
    },
    use: (contract: unknown) => {
      if (!isServiceRef(contract)) {
        throw new RecordingError('use expects a contract ref.');
      }

      assertUsable(contract.id);

      if (contract.id === 'hooks/v1') {
        return hooksFacade;
      }

      const recorder = recorders[contract.id];

      if (recorder === undefined) {
        return inertStub();
      }

      return new Proxy(Object.create(null) as object, {
        get: (_target, property) => {
          if (typeof property !== 'string' || property === 'then') {
            return undefined;
          }

          const record = recorder[property];

          return (value: unknown) => {
            record?.(value);

            return inert;
          };
        },
      });
    },
    whenAvailable: () => inert,
  }) as unknown as Services;

  await options.activate({ services });

  return recorded;
};

/** Build-time checks of a recording against the manifest. */
export const checkRecording = (
  manifest: ManifestV1,
  recorded: readonly RecordedContract[],
): readonly string[] => {
  const errors: string[] = [];
  const provides = new Map<string, string>();

  for (const entry of manifest.provides) {
    const parsed = parseContractEntry(entry);

    if (parsed !== undefined) {
      provides.set(parsed.id, parsed.spec);
    }
  }

  const seen = new Set<string>();

  for (const contract of recorded) {
    const key = `${contract.id} ${contract.environment}`;

    if (seen.has(key)) {
      errors.push(
        `${contract.id} is recorded more than once in ${contract.environment}.`,
      );
    }

    seen.add(key);

    if (!provides.has(contract.id)) {
      errors.push(
        `${contract.id} is ${contract.kind === 'service' ? 'provided' : 'defined'} in ${contract.environment} but not declared in provides.`,
      );
    }

    const spec = basicContractSpec(contract.id);

    if (spec !== undefined && spec.cardinality !== contract.cardinality) {
      errors.push(
        `${contract.id} is ${contract.cardinality}; the platform publishes it as ${spec.cardinality}.`,
      );
    }

    if (contract.kind === 'service') {
      const method = misdeclaredExposure(contract.id, contract.methods);

      if (method !== undefined) {
        errors.push(
          `${contract.id} ${method} may not be exposed to the desktop: the platform specification decides.`,
        );
      }
    }
  }

  for (const id of provides.keys()) {
    if (!recorded.some((contract) => contract.id === id)) {
      errors.push(
        `provides declares ${id}, but no part provides, defines or registers it during activate.`,
      );
    }
  }

  return errors;
};
