import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The one envelope version the host writes, so the key can rotate later. */
const version = 'v1';
const algorithm = 'aes-256-gcm';
const nonceBytes = 12;

/** A base64 string that decodes to exactly 32 bytes, padding included. */
const encodedKey = /^[A-Za-z0-9+/]{43}=$/u;

export interface SecretCipher {
  encrypt(secret: string): string;
  /** Decrypts one `v1:` envelope; the empty string is the empty secret. */
  decrypt(envelope: string): string;
}

/** The host holds no write access to credential secrets without this key. */
export class MissingKeyError extends Error {
  constructor() {
    super('DORIC_CREDENTIAL_KEY is required to store a credential secret.');
    this.name = 'MissingKeyError';
  }
}

/**
 * Builds the AES-256-GCM cipher from the base64 key, or `undefined` when none is
 * configured. An unset key is only a problem once a secret exists to serve; a
 * configured but unusable key is always a startup failure.
 */
export const createSecretCipher = (
  encoded: string | undefined,
): SecretCipher | undefined => {
  const key = encoded?.trim() ?? '';
  if (key.length === 0) return undefined;

  if (!encodedKey.test(key))
    throw new Error('DORIC_CREDENTIAL_KEY must be 32 base64-encoded bytes.');

  const material = Buffer.from(key, 'base64');

  return {
    encrypt(secret) {
      if (secret.length === 0) return '';

      const nonce = randomBytes(nonceBytes);
      const cipher = createCipheriv(algorithm, material, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(secret, 'utf8'),
        cipher.final(),
      ]);

      return [
        version,
        nonce.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      ].join(':');
    },

    decrypt(envelope) {
      if (envelope.length === 0) return '';

      const [prefix, nonce, tag, ciphertext] = envelope.split(':');
      if (
        prefix !== version ||
        nonce === undefined ||
        tag === undefined ||
        ciphertext === undefined
      )
        throw new Error(
          'A stored credential secret is not a supported envelope.',
        );

      const decipher = createDecipheriv(
        algorithm,
        material,
        Buffer.from(nonce, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
};
