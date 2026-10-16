// `artifact.kind/v1`: the registry of artifact kinds. A bundle that owns a kind
// declares it here during activation, so the kind is known before any artifact
// of it exists — its id and title, the zod schema of its payload, its own
// `materialize` and the `blockType` its renderer draws. The registry keeps
// them; it interprets neither a kind nor an artifact, and an artifact whose
// kind nobody registered is still stored, exactly as the log stores it.

import { ContractError, defineMethod, defineService } from 'bundle/contracts';

import {
  type ArtifactKindDescriptor,
  type ArtifactKindMaterialize,
  type ArtifactKindPayload,
  ArtifactKindV1,
  artifactKindMethods,
} from '../contracts/index.js';

/** The grammar of a kind id (`preview`, `screen.recording`, …). */
export const artifactKindIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** One kind as the registry keeps it: the descriptor plus its providers. */
interface RegisteredKind extends ArtifactKindDescriptor {
  readonly payload?: ArtifactKindPayload;
  readonly materialize?: ArtifactKindMaterialize;
}

/** What `register` was called with, minus what the registry itself adds. */
export interface ArtifactKindRegistration {
  readonly id: string;
  readonly title?: string;
  readonly payload?: ArtifactKindPayload;
  readonly materialize?: ArtifactKindMaterialize;
  readonly blockType?: string;
}

/** The registry's state, as the service and a test read it. */
export interface ArtifactKindRegistryState {
  register(input: ArtifactKindRegistration): ArtifactKindDescriptor;
  /** The registered kind, when any bundle declared it. */
  find(id: string): ArtifactKindDescriptor | undefined;
  list(): readonly ArtifactKindDescriptor[];
}

/**
 * The descriptor as the registry hands it back: the wire fields only. The
 * kind's own providers (`payload`, `materialize`) are registry-internal and
 * never cross the bridge.
 */
const wireDescriptor = (kind: ArtifactKindDescriptor): ArtifactKindDescriptor =>
  ({
    id: kind.id,
    ...(kind.title === undefined ? {} : { title: kind.title }),
    ...(kind.blockType === undefined ? {} : { blockType: kind.blockType }),
  }) as ArtifactKindDescriptor;

/** An in-memory registry; a kind lives as long as the generation that registers it. */
export const createArtifactKindRegistry = (): ArtifactKindRegistryState => {
  const kinds = new Map<string, RegisteredKind>();

  return {
    register: (input) => {
      const id = input.id.trim();

      if (!artifactKindIdPattern.test(id)) {
        throw new ContractError(
          'invalid_input',
          `"${input.id}" is not an artifact kind id.`,
          {
            kind: input.id,
          },
        );
      }

      const current = kinds.get(id);

      if (
        current !== undefined &&
        (current.title !== input.title || current.blockType !== input.blockType)
      ) {
        throw new ContractError(
          'invalid_input',
          `Artifact kind "${id}" is already registered as "${
            current.title ?? id
          }"${current.blockType === undefined ? '' : ` (${current.blockType})`}.`,
          { kind: id },
        );
      }

      // Idempotent for the same declaration: the name and the block type stay,
      // and the kind's own providers are refreshed to what this generation
      // declared. A different title or block type is a conflict, as before.
      kinds.set(id, {
        id,
        title: input.title,
        payload: input.payload ?? current?.payload,
        materialize: input.materialize ?? current?.materialize,
        blockType: input.blockType,
      });

      return wireDescriptor(kinds.get(id) as RegisteredKind);
    },
    find: (id) => {
      const found = kinds.get(id);

      return found === undefined ? undefined : { ...found };
    },
    list: () => [...kinds.values()].map((kind) => ({ ...kind })),
  };
};

/** `artifact.kind/v1` over the registry. */
export const artifactKindService = (registry: ArtifactKindRegistryState) =>
  defineService(ArtifactKindV1, {
    register: defineMethod({
      ...artifactKindMethods.register,
      execute: async (input: ArtifactKindRegistration) =>
        registry.register(input),
    }),
    list: defineMethod({
      ...artifactKindMethods.list,
      expose: 'desktop',
      execute: async (): Promise<readonly ArtifactKindDescriptor[]> => [
        ...registry.list().map(wireDescriptor),
      ],
    }),
  });
