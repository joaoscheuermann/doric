import { basename } from 'node:path';

import type { Activate, HostContext } from '../contracts/context.js';
import type { QuarantineReason } from '../contracts/platform.js';
import type { JsonObject } from '../contracts/types.js';
import {
  type CatalogCandidate,
  type ResolvedEnvironment,
  resolveEnvironment,
} from '../runtime/catalog.js';
import type { Composition } from '../runtime/composition.js';
import { type Descriptor, descriptorSchema } from '../runtime/descriptor.js';
import { type ManifestV1Input, manifestV1Schema } from '../runtime/manifest.js';
import type { InstalledBundle } from './discover.js';

/** A bundle passed in code (for example the provisional host adapter). */
export interface EmbeddedBundle {
  readonly manifest: ManifestV1Input;
  readonly descriptor: Descriptor;
  /**
   * The contract documents an installed bundle would ship as files, by the
   * descriptor's `schema` path (`schemas/<id>.json`). The host distributes
   * them, so a desktop part can call the bundle's host contracts (stage 9).
   */
  readonly documents?: Readonly<Record<string, JsonObject>>;
  readonly host?: { readonly activate: Activate<HostContext> };
}

export interface BuildCatalogInput {
  readonly installed: readonly InstalledBundle[];
  readonly embedded: readonly EmbeddedBundle[];
  readonly composition: Composition;
  readonly platformVersion: string;
  readonly generation: number;
  readonly issues?: readonly string[];
  readonly recovery?: { readonly reason: string };
}

const embeddedCandidate = (bundle: EmbeddedBundle): CatalogCandidate => {
  const manifest = manifestV1Schema.safeParse(bundle.manifest);
  const descriptor = descriptorSchema.safeParse(bundle.descriptor);
  const id = manifest.success
    ? manifest.data.id
    : typeof bundle.manifest.id === 'string'
      ? bundle.manifest.id
      : 'embedded';
  const errors: QuarantineReason[] = [];

  if (!manifest.success) {
    errors.push({ code: 'invalid_manifest', message: manifest.error.message });
  }

  if (!descriptor.success) {
    errors.push({
      code: 'invalid_descriptor',
      message: descriptor.error.message,
    });
  }

  return {
    id,
    source: { kind: 'embedded' },
    ...(manifest.success ? { manifest: manifest.data } : {}),
    ...(descriptor.success ? { descriptor: descriptor.data } : {}),
    errors,
  };
};

/** The ID an embedded bundle resolves to (its manifest ID). */
export const embeddedId = (bundle: EmbeddedBundle): string =>
  embeddedCandidate(bundle).id;

/** Resolves the host environment from installed and embedded bundles. */
export const buildCatalog = (input: BuildCatalogInput): ResolvedEnvironment =>
  resolveEnvironment(
    {
      candidates: [
        ...input.installed.map(
          (bundle): CatalogCandidate => ({
            id: bundle.read?.manifest.id ?? basename(bundle.dir),
            source: { kind: 'installed', dir: bundle.dir },
            ...(bundle.read === undefined
              ? {}
              : { manifest: bundle.read.manifest }),
            ...(bundle.descriptor === undefined
              ? {}
              : { descriptor: bundle.descriptor }),
            errors: bundle.errors,
          }),
        ),
        ...input.embedded.map(embeddedCandidate),
      ],
      composition: input.composition,
      platformVersion: input.platformVersion,
      generation: input.generation,
      ...(input.issues === undefined ? {} : { issues: input.issues }),
      ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    },
    'host',
  );
