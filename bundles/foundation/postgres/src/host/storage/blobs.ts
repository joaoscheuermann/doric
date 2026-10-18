import { createHash } from 'node:crypto';

import { ContractError } from 'bundle/contracts';

import type { Database } from '../../prisma.js';

/**
 * Canonical base64: whole four-character groups, padding only at the end. A
 * single character-class scan, since a repeated group overflows the regex
 * engine's stack on a blob of a few megabytes.
 */
const base64 = {
  test: (value: string): boolean =>
    value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value),
};

/** Stores base64 bytes once under `sha256:<hex>`; storing them again is a no-op. */
export const putBlob = async (
  database: Database,
  encoded: string,
): Promise<{ hash: string }> => {
  if (!base64.test(encoded)) {
    throw new ContractError('invalid_input', 'A blob must be base64 bytes.');
  }

  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  await database.$executeRaw`
    INSERT INTO "storage_blob" ("hash", "bytes", "size")
    VALUES (${hash}, ${bytes}, ${bytes.length})
    ON CONFLICT ("hash") DO NOTHING`;

  return { hash };
};

/** The base64 bytes of a stored blob; an unknown or malformed hash is `undefined`. */
export const getBlob = async (
  database: Database,
  hash: string,
): Promise<string | undefined> => {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    return undefined;
  }

  const rows = await database.$queryRaw<{ bytes: Uint8Array }[]>`
    SELECT "bytes" FROM "storage_blob" WHERE "hash" = ${hash}`;
  const row = rows[0];

  return row === undefined
    ? undefined
    : Buffer.from(row.bytes).toString('base64');
};

/** Removes a stored blob; an unknown or malformed hash is a no-op. */
export const deleteBlob = async (
  database: Database,
  hash: string,
): Promise<void> => {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    return;
  }

  await database.$executeRaw`
    DELETE FROM "storage_blob" WHERE "hash" = ${hash}`;
};
