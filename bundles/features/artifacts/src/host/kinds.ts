// `artifact.kind/v1`: the registry of artifact kinds. A bundle that owns a kind
// declares it here during activation, so the kind is known before any artifact
// of it exists — its id and title, the zod schema of its payload, its own
// `materialize`, the `blockType` of its body, the `bodyTag` the registry's
// frame mounts the body with and who draws the header (`header`). The registry keeps them; it interprets neither a
// kind nor an artifact, and an artifact whose kind nobody registered is still
// stored, exactly as the log stores it.
//
// A registration is a `Disposable`, tracked by the platform on the caller's
// generation: when that generation ends, its kinds go with it. A bundle's next
// generation registers before the previous one is disposed, so the same
// bundle registering an id again replaces the declaration — title and block
// type included — and disposing the older registration then leaves the newer
// one in force. Only another bundle claiming an id in use is a conflict.

import {
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
} from 'bundle/contracts';

import {
  type ArtifactKindDescriptor,
  type ArtifactKindHeader,
  type ArtifactKindMaterialize,
  type ArtifactKindPayload,
  ArtifactKindV1,
  artifactKindMethods,
} from '../contracts/index.js';

/** The grammar of a kind id (`preview`, `screen.recording`, …). */
export const artifactKindIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** One kind as the registry keeps it: the descriptor plus its providers. */
export interface RegisteredKind extends ArtifactKindDescriptor {
  readonly payload?: ArtifactKindPayload;
  readonly materialize?: ArtifactKindMaterialize;
}

/** What `register` was called with. */
export interface ArtifactKindRegistration {
  readonly id: string;
  readonly title?: string;
  readonly payload?: ArtifactKindPayload;
  readonly materialize?: ArtifactKindMaterialize;
  readonly blockType?: string;
  readonly bodyTag?: string;
  readonly header?: ArtifactKindHeader;
}

/** The registry's state, as the service and a test read it. */
export interface ArtifactKindRegistryState {
  /** Registers a kind for `owner` (the registering bundle). */
  register(input: ArtifactKindRegistration, owner: string): Disposable;
  /** The kind in force, when any bundle declared it. */
  find(id: string): RegisteredKind | undefined;
  list(): readonly RegisteredKind[];
}

/**
 * The descriptor as the registry hands it out: the wire fields only. The
 * kind's own providers (`payload`, `materialize`) are registry-internal and
 * never cross the bridge.
 */
const wireDescriptor = (kind: ArtifactKindDescriptor): ArtifactKindDescriptor =>
  ({
    id: kind.id,
    ...(kind.title === undefined ? {} : { title: kind.title }),
    ...(kind.blockType === undefined ? {} : { blockType: kind.blockType }),
    ...(kind.bodyTag === undefined ? {} : { bodyTag: kind.bodyTag }),
    ...(kind.header === undefined ? {} : { header: kind.header }),
  }) as ArtifactKindDescriptor;

interface Registration {
  readonly owner: string;
  readonly kind: RegisteredKind;
}

/** An in-memory registry; a kind lives as long as the registration that declared it. */
export const createArtifactKindRegistry = (): ArtifactKindRegistryState => {
  // Every live registration of an id, oldest first; the newest is in force.
  const kinds = new Map<string, Registration[]>();

  const current = (id: string): Registration | undefined =>
    kinds.get(id)?.at(-1);

  return {
    register: (input, owner) => {
      const id = input.id.trim();

      if (!artifactKindIdPattern.test(id)) {
        throw new ContractError(
          'invalid_input',
          `"${input.id}" is not an artifact kind id.`,
          { kind: input.id },
        );
      }

      const holder = current(id);

      if (holder !== undefined && holder.owner !== owner) {
        throw new ContractError(
          'registration_conflict',
          `Artifact kind "${id}" is already registered by bundle "${holder.owner}".`,
          { kind: id, owner: holder.owner },
        );
      }

      const registration: Registration = {
        owner,
        kind: { ...input, id },
      };
      const stack = kinds.get(id) ?? [];

      stack.push(registration);
      kinds.set(id, stack);

      let disposed = false;

      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;

          const remaining = (kinds.get(id) ?? []).filter(
            (entry) => entry !== registration,
          );

          if (remaining.length === 0) kinds.delete(id);
          else kinds.set(id, remaining);
        },
      };
    },
    find: (id) => current(id)?.kind,
    list: () =>
      [...kinds.values()].flatMap((stack) => {
        const kind = stack.at(-1)?.kind;

        return kind === undefined ? [] : [kind];
      }),
  };
};

/** `artifact.kind/v1` over the registry. */
export const artifactKindService = (registry: ArtifactKindRegistryState) =>
  defineService(ArtifactKindV1, {
    register: defineMethod({
      ...artifactKindMethods.register,
      execute: async (input: ArtifactKindRegistration, call) =>
        registry.register(input, call.caller.bundleId),
    }),
    list: defineMethod({
      ...artifactKindMethods.list,
      expose: 'desktop',
      execute: async (): Promise<readonly ArtifactKindDescriptor[]> =>
        registry.list().map(wireDescriptor),
    }),
  });
