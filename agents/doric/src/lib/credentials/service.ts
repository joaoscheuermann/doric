import {
  type Credential,
  type CredentialCreate,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
  type CredentialKind,
  type CredentialUpdate,
} from './kind.js';
import { credentialById, credentialByKind } from './resolve.js';
import {
  createSecretCipher,
  MissingKeyError,
  type SecretCipher,
} from './secret.js';
import {
  type CredentialRemoval,
  type CredentialStore,
  isNameConflict,
  type StoredCredential,
} from './store.js';

export type CredentialWrite =
  | { readonly status: 'saved'; readonly credential: Credential }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'missing' | 'conflict' | 'immutable' };

/**
 * The host's only way to read or write a credential. It answers the field rule,
 * decrypts secrets for host use, and never returns a secret to an HTTP client,
 * which reads the public view instead.
 */
export interface CredentialService {
  list(): readonly Credential[];
  find(id: string): Credential | undefined;
  byId(id: string): Credential;
  byKind(kind: CredentialKind): Credential | undefined;
  /**
   * The one credential of a kind no provider claims. The provider keys and the
   * GitHub token are both `API_TOKEN`, so an unconfigured fallback must not hand
   * a provider's key to another integration: the credentials named by a provider
   * are excluded first, and what is left follows the `byKind` rule.
   */
  byUnclaimedKind(
    kind: CredentialKind,
    claimed: ReadonlySet<string>,
  ): Credential | undefined;
  /** Every stored secret, so no event, log line, or message can carry one. */
  secrets(): readonly string[];
  create(input: CredentialCreate): Promise<CredentialWrite>;
  update(id: string, input: CredentialUpdate): Promise<CredentialWrite>;
  remove(id: string): Promise<CredentialRemoval>;
}

interface Options {
  readonly store: CredentialStore;
  readonly environment?: NodeJS.ProcessEnv;
}

const holdsSecret = ({ secret }: StoredCredential): boolean =>
  secret !== null && secret !== '';

/**
 * Initializes the credential store. A stored secret the host cannot decrypt is
 * never served as an empty one, so a missing or unusable key with any secret at
 * rest is a startup failure rather than a silent downgrade.
 */
export const createCredentialService = async ({
  store,
  environment = process.env,
}: Options): Promise<CredentialService> => {
  const cipher = createSecretCipher(environment.DORIC_CREDENTIAL_KEY);
  const stored = await store.list();

  if (cipher === undefined && stored.some(holdsSecret))
    throw new Error(
      'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
    );

  let cache = stored.map((row) => reveal(row, cipher));
  const save = (credential: Credential): void => {
    cache = [
      ...cache.filter(({ id }) => id !== credential.id),
      credential,
    ].sort((left, right) => left.name.localeCompare(right.name));
  };

  return {
    list: () => cache,
    find: (id) => cache.find((credential) => credential.id === id),
    byId: (id) => credentialById(cache, id),
    byKind: (kind) => credentialByKind(cache, kind),
    byUnclaimedKind: (kind, claimed) =>
      credentialByKind(
        cache.filter((credential) => !claimed.has(credential.id)),
        kind,
      ),
    secrets: () => storedSecrets(cache),

    async create(input) {
      if (!credentialFieldsSatisfied(input.kind, input))
        return {
          status: 'invalid',
          message: credentialFieldsMessage(input.kind),
        };

      try {
        const credential = reveal(
          await store.create({
            kind: input.kind,
            name: input.name,
            username: input.username ?? null,
            email: input.email ?? null,
            secret: encrypt(cipher, input.secret),
          }),
          cipher,
        );
        save(credential);
        return { status: 'saved', credential };
      } catch (error) {
        if (isNameConflict(error)) return { status: 'conflict' };
        throw error;
      }
    },

    async update(id, input) {
      const current = cache.find((credential) => credential.id === id);
      if (current === undefined) return { status: 'missing' };
      if (input.kind !== undefined && input.kind !== current.kind)
        return { status: 'immutable' };

      const next = {
        name: input.name ?? current.name,
        username: keep(input.username, current.username),
        email: keep(input.email, current.email),
        secret: keep(input.secret, current.secret),
      };
      if (!credentialFieldsSatisfied(current.kind, next))
        return {
          status: 'invalid',
          message: credentialFieldsMessage(current.kind),
        };

      try {
        const row = await store.update(id, {
          name: next.name,
          username: next.username ?? null,
          email: next.email ?? null,
          secret: encrypt(cipher, next.secret),
        });
        if (row === undefined) return { status: 'missing' };
        const credential = reveal(row, cipher);
        save(credential);
        return { status: 'saved', credential };
      } catch (error) {
        if (isNameConflict(error)) return { status: 'conflict' };
        throw error;
      }
    },

    async remove(id) {
      const outcome = await store.remove(id);
      // A deleted credential must stop resolving, or a running Project would
      // keep authenticating with a secret the host no longer holds.
      if (outcome === 'deleted')
        cache = cache.filter((credential) => credential.id !== id);

      return outcome;
    },
  };
};

/** The one clear/keep/set rule: absent or `null` keeps, and anything else sets. */
const keep = (
  requested: string | null | undefined,
  stored: string | undefined,
): string | undefined => requested ?? stored;

/**
 * The secrets the host must never emit, minus the empty ones a migration wrote
 * for a provider that has no stored key yet.
 */
const storedSecrets = (credentials: readonly Credential[]): readonly string[] =>
  credentials
    .map(({ secret }) => secret)
    .filter(
      (secret): secret is string => secret !== undefined && secret !== '',
    );

/** A row the host cannot decrypt is an error, never an empty secret. */
const decrypt = (
  cipher: SecretCipher | undefined,
  envelope: string,
): string => {
  if (envelope === '') return '';
  if (cipher === undefined) throw new MissingKeyError();

  return cipher.decrypt(envelope);
};

const encrypt = (
  cipher: SecretCipher | undefined,
  secret: string | undefined,
): string | null => {
  if (secret === undefined) return null;
  if (cipher === undefined) throw new MissingKeyError();

  return cipher.encrypt(secret);
};

/** The domain view of one stored row, with its secret decrypted. */
const reveal = (
  row: StoredCredential,
  cipher: SecretCipher | undefined,
): Credential => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  ...(row.username === null ? {} : { username: row.username }),
  ...(row.email === null ? {} : { email: row.email }),
  ...(row.secret === null ? {} : { secret: decrypt(cipher, row.secret) }),
});
