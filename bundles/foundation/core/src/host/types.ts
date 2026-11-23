// The message types of every bundle's contracts, read from the catalog's
// index through `doric.catalog/v1.Descriptors` (S41a), for
// `CoreServicesOptions.types` in `main.ts`'s `activate` (slice S41c).

import {
  createFileRegistry,
  type FileRegistry,
  fromBinary,
} from '@bufbuild/protobuf';
import {
  type FileDescriptorSet,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import type { HostServices } from 'bundle/host';

/**
 * The message types of every bundle's contracts, for
 * `CoreServicesOptions.types`: `doric.catalog/v1.Descriptors` read through
 * `services.use(CatalogService)` and its chunks joined, decoded as a
 * `google.protobuf.FileDescriptorSet` and built into a registry
 * (`createFileRegistry`). Settings values, event payloads and hooks
 * contracts of other bundles resolve through it; core's own
 * `core.event-hooks/v1` and `doric.app.hooks/v1` are always known as well.
 *
 * One call per process: the index does not change while the host runs.
 * Rejects with the call's `ContractError` (`fromConnectError`) when the read
 * fails, and with a `ContractError` `invalid_output` naming the problem when
 * the bytes are not a `FileDescriptorSet` or a file imports one the set does
 * not hold. Reads nothing else and keeps nothing.
 */
export const loadCatalogTypes = async (
  services: Pick<HostServices, 'use'>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<FileRegistry> => {
  const chunks: Uint8Array[] = [];

  try {
    const stream = services
      .use(CatalogService)
      .descriptors(
        {},
        options.signal === undefined ? {} : { signal: options.signal },
      );

    for await (const { chunk } of stream) {
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof ConnectError ? fromConnectError(error) : error;
  }

  const bytes = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  let set: FileDescriptorSet;

  try {
    set = fromBinary(FileDescriptorSetSchema, bytes);
  } catch (error) {
    throw new ContractError(
      'invalid_output',
      `The catalog's descriptors are not a FileDescriptorSet: ${messageOf(error)}`,
    );
  }

  try {
    return createFileRegistry(set);
  } catch (error) {
    throw new ContractError(
      'invalid_output',
      `The catalog's descriptors cannot be built: ${messageOf(error)}`,
    );
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
