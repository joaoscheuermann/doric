import {
  ContractError,
  defineMethod,
  defineService,
  SecretsBackendV1,
  type StoredSecret,
  secretsBackendMethods,
} from 'bundle/contracts';

import type { Database } from '../../prisma.js';
import type { Environment } from '../options.js';
import { createSecretCipher, type SecretCipher } from './envelope.js';
import {
  createCredentialTable,
  isNameConflict,
  type StoredCredential,
} from './table.js';

const holdsSecret = ({ secret }: StoredCredential): boolean =>
  secret !== null && secret !== '';

const keyRequired = (): ContractError =>
  new ContractError(
    'credential_key_required',
    'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
  );

const storageUnavailable = (): ContractError =>
  new ContractError(
    'credential_storage_unavailable',
    'DORIC_CREDENTIAL_KEY is required to store a credential secret.',
  );

/** A row the host cannot decrypt is an error, never an empty secret. */
const decrypt = (
  cipher: SecretCipher | undefined,
  envelope: string,
): string => {
  if (envelope === '') {
    return '';
  }

  if (cipher === undefined) {
    throw keyRequired();
  }

  try {
    return cipher.decrypt(envelope);
  } catch (error) {
    throw new ContractError(
      'credential_unreadable',
      error instanceof Error
        ? error.message
        : 'A stored credential secret cannot be read.',
    );
  }
};

/** `undefined` is no secret; any defined value, even `''`, needs the key. */
const encrypt = (
  cipher: SecretCipher | undefined,
  secret: string | undefined,
): string | null => {
  if (secret === undefined) {
    return null;
  }

  if (cipher === undefined) {
    throw storageUnavailable();
  }

  return cipher.encrypt(secret);
};

/** The row with its secret decrypted: `null` columns are absent, `''` stays `''`. */
const reveal = (
  row: StoredCredential,
  cipher: SecretCipher | undefined,
): StoredSecret => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  ...(row.username === null ? {} : { username: row.username }),
  ...(row.email === null ? {} : { email: row.email }),
  ...(row.secret === null ? {} : { secret: decrypt(cipher, row.secret) }),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * `secrets.backend/v1` over the `credential` table. Secrets cross the
 * contract in plaintext and are sealed in the AES-256-GCM envelope under
 * `DORIC_CREDENTIAL_KEY` inside it. The cipher is built on first use: an
 * unusable key fails every call, a missing key fails reads only while a
 * stored credential holds a secret, and writes of any secret.
 */
export const secretsBackend = (
  database: () => Database,
  environment: Environment,
) => {
  const table = createCredentialTable(database);
  let cipher: { readonly value: SecretCipher | undefined } | undefined;
  const cipherOf = (): SecretCipher | undefined => {
    cipher ??= {
      value: createSecretCipher(environment.DORIC_CREDENTIAL_KEY),
    };

    return cipher.value;
  };
  const methods = secretsBackendMethods;

  return defineService(SecretsBackendV1, {
    list: defineMethod({
      ...methods.list,
      execute: async () => {
        const key = cipherOf();
        const rows = await table.list();

        if (key === undefined && rows.some(holdsSecret)) {
          throw keyRequired();
        }

        return rows.map((row) => reveal(row, key));
      },
    }),
    get: defineMethod({
      ...methods.get,
      execute: async (id) => {
        const key = cipherOf();
        const row = await table.get(id);

        if (row === undefined) {
          return undefined;
        }

        if (key === undefined && holdsSecret(row)) {
          throw keyRequired();
        }

        return reveal(row, key);
      },
    }),
    put: defineMethod({
      ...methods.put,
      execute: async (record) => {
        const secret = encrypt(cipherOf(), record.secret);

        try {
          await table.put({
            id: record.id,
            kind: record.kind,
            name: record.name,
            username: record.username ?? null,
            email: record.email ?? null,
            secret,
          });
        } catch (error) {
          if (isNameConflict(error)) {
            throw new ContractError(
              'credential_name_taken',
              `A ${record.kind} credential named "${record.name}" is already stored.`,
            );
          }

          throw error;
        }
      },
    }),
    delete: defineMethod({
      ...methods.delete,
      execute: (id) => table.delete(id),
    }),
  });
};
