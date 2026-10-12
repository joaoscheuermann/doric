import {
  ContractError,
  defineMethod,
  defineService,
  SecretsBackendV1,
  type StoredSecret,
  secretsBackendMethods,
} from 'bundle/contracts';

import { later } from './later.js';

export interface MemorySecretsOptions {
  /**
   * Whether an encryption key is configured (default `true`). Without one the
   * backend refuses as the PostgreSQL backend does: storing any secret is
   * `credential_storage_unavailable`, and reading while a stored credential
   * holds a non-empty secret is `credential_key_required`.
   */
  readonly keyConfigured?: boolean;
  /** Rows present before the first call, in plaintext. */
  readonly rows?: readonly StoredSecret[];
}

const holdsSecret = (row: StoredSecret): boolean =>
  row.secret !== undefined && row.secret !== '';

const keyRequired = (): ContractError =>
  new ContractError(
    'credential_key_required',
    'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
  );

/** Names compare by UTF-16 code unit, like a `COLLATE "C"` `ORDER BY name`. */
const byName = (left: StoredSecret, right: StoredSecret): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

/**
 * `secrets.backend/v1` in memory: the `credential` table without the
 * envelope. The ID is the key, `(kind, name)` is unique, and `list` is
 * ordered by name. Each call gets copies, so callers never share rows.
 */
export const memorySecretsBackend = (options: MemorySecretsOptions = {}) => {
  const keyConfigured = options.keyConfigured ?? true;
  const rows = new Map<string, StoredSecret>(
    (options.rows ?? []).map((row) => [row.id, { ...row }]),
  );
  const methods = secretsBackendMethods;

  return defineService(SecretsBackendV1, {
    get: defineMethod({
      ...methods.get,
      execute: (id) =>
        later(() => {
          const row = rows.get(id);

          if (row !== undefined && !keyConfigured && holdsSecret(row)) {
            throw keyRequired();
          }

          return row === undefined ? undefined : { ...row };
        }),
    }),
    list: defineMethod({
      ...methods.list,
      execute: () =>
        later(() => {
          const all = [...rows.values()];

          if (!keyConfigured && all.some(holdsSecret)) {
            throw keyRequired();
          }

          return all.sort(byName).map((row) => ({ ...row }));
        }),
    }),
    put: defineMethod({
      ...methods.put,
      execute: (record) =>
        later(() => {
          if (!keyConfigured && record.secret !== undefined) {
            throw new ContractError(
              'credential_storage_unavailable',
              'DORIC_CREDENTIAL_KEY is required to store a credential secret.',
            );
          }

          const current = rows.get(record.id);
          // An update never changes the kind; the facade refuses that first.
          const kind = current?.kind ?? record.kind;

          for (const other of rows.values()) {
            if (
              other.id !== record.id &&
              other.kind === kind &&
              other.name === record.name
            ) {
              throw new ContractError(
                'credential_name_taken',
                `A ${kind} credential named "${record.name}" is already stored.`,
              );
            }
          }

          const now = new Date().toISOString();
          const {
            createdAt: _created,
            updatedAt: _updated,
            ...fields
          } = record;

          rows.set(record.id, {
            ...fields,
            kind,
            createdAt: current?.createdAt ?? now,
            updatedAt: now,
          });
        }),
    }),
    delete: defineMethod({
      ...methods.delete,
      execute: (id) =>
        later(() =>
          rows.delete(id) ? ('deleted' as const) : ('missing' as const),
        ),
    }),
  });
};
