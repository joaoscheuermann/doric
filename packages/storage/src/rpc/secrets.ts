// `secrets.backend/v1` between a `SecretsBackend` and the router (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4"):
// four unary RPCs over today's plaintext rows. Phase 4 deletes this file
// with the contract.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import {
  ContractError,
  type SecretsBackend,
  type StoredSecret,
} from 'bundle/contracts';
import type {
  BackendService as SecretsBackendService,
  StoredSecretSchema,
  StoredSecret as WireSecret,
} from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';

import { backendCallOf, calling, connectOptionsOf } from './call.js';

/** The optional columns of a row, omitted when absent. */
const optionalFields = [
  'username',
  'email',
  'secret',
  'createdAt',
  'updatedAt',
] as const;

/** `row` with its absent optional fields omitted, never `undefined`. */
const rowOf = (
  row: StoredSecret | WireSecret,
): StoredSecret & MessageInitShape<typeof StoredSecretSchema> => {
  const result: StoredSecret = { id: row.id, kind: row.kind, name: row.name };

  for (const field of optionalFields) {
    const value = row[field];

    if (value !== undefined) {
      result[field] = value;
    }
  }

  return result;
};

/**
 * The implementation of `doric.secrets.backend.v1.BackendService` over
 * `backend`, for a `services` entry
 * `[SecretsBackendService, serveSecretsBackend(backend)]`. Each RPC calls the
 * matching method once with `callOf(context)`: `Get` answers
 * `stored_secret` absent when `backend.get` answers `undefined`; `List` the
 * rows in `backend.list`'s order; `Put` passes the row with its absent
 * optional fields omitted; `Delete` answers `result` `deleted` or `missing`.
 *
 * Fails a call with what `backend` threw, unchanged when it is a
 * `ContractError` (`credential_storage_unavailable`,
 * `credential_key_required`, `credential_unreadable`,
 * `credential_name_taken` and any other code reach the caller), as
 * `internal` otherwise. Holds no state between calls.
 */
export const serveSecretsBackend = (
  backend: SecretsBackend,
): ServiceImpl<typeof SecretsBackendService> => ({
  get: async ({ id }, context) => {
    const row = await backend.get(id, backendCallOf(context));

    return row === undefined ? {} : { storedSecret: rowOf(row) };
  },
  list: async (_request, context) => ({
    secrets: (await backend.list(backendCallOf(context))).map(rowOf),
  }),
  put: async ({ storedSecret }, context) => {
    if (storedSecret === undefined) {
      throw new ContractError('invalid_input', 'storedSecret is required.');
    }

    await backend.put(rowOf(storedSecret), backendCallOf(context));

    return {};
  },
  delete: async ({ id }, context) => ({
    result: await backend.delete(id, backendCallOf(context)),
  }),
});

/**
 * A `SecretsBackend` that calls `doric.secrets.backend.v1.BackendService`
 * through `client`. `get` answers `undefined` when `stored_secret` is
 * absent; rows have today's `StoredSecret` shape with absent optional fields
 * (`username`, `email`, `secret`, `createdAt`, `updatedAt`) omitted, never
 * present as `undefined`, and an empty string kept as `''`; `list` keeps the
 * provider's order; `delete` answers `'deleted' | 'missing'`.
 *
 * `call` as for `storageBackendClient`. Rejects with the provider's
 * `ContractError` as `fromConnectError` reads it; with `invalid_output` when
 * `Delete` answers another `result`. Never throws synchronously.
 */
export const secretsBackendClient = (
  client: Client<typeof SecretsBackendService>,
): SecretsBackend => ({
  get: (id, call) =>
    calling(async () => {
      const { storedSecret } = await client.get(
        { id },
        connectOptionsOf(call),
      );

      return storedSecret === undefined ? undefined : rowOf(storedSecret);
    }),
  list: (call) =>
    calling(async () =>
      (await client.list({}, connectOptionsOf(call))).secrets.map(rowOf),
    ),
  put: (record, call) =>
    calling(async () => {
      await client.put({ storedSecret: rowOf(record) }, connectOptionsOf(call));
    }),
  delete: (id, call) =>
    calling(async () => {
      const { result } = await client.delete({ id }, connectOptionsOf(call));

      if (result !== 'deleted' && result !== 'missing') {
        throw new ContractError(
          'invalid_output',
          `Delete answered the result ${JSON.stringify(result)}.`,
        );
      }

      return result;
    }),
});
