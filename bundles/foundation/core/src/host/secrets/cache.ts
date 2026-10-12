import type {
  CredentialDescription,
  Secret,
  SecretsView,
  StoredSecret,
} from 'bundle/contracts';

/** The host view of one stored row: the fields it holds, without timestamps. */
export const toSecret = (row: StoredSecret): Secret => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  ...(row.username === undefined ? {} : { username: row.username }),
  ...(row.email === undefined ? {} : { email: row.email }),
  ...(row.secret === undefined ? {} : { secret: row.secret }),
});

/** The public view: empty username and email are omitted, the secret is a flag. */
export const describe = ({
  id,
  kind,
  name,
  username,
  email,
  secret,
}: Secret): CredentialDescription => ({
  id,
  kind,
  name,
  ...(username ? { username } : {}),
  ...(email ? { email } : {}),
  hasSecret: secret !== undefined && secret !== '',
});

export interface SecretsCache {
  /** The in-process view handed out by `secrets/v1.view()`. */
  readonly view: SecretsView;
  list(): readonly Secret[];
  /** Replaces (or adds) a credential, then orders the cache by name. */
  save(credential: Secret): void;
  /** Drops a credential without reordering the rest. */
  remove(id: string): void;
}

/**
 * The credential cache, the only read path at runtime. It starts in the
 * backend's order; every save re-sorts by `localeCompare` of the name and a
 * removal keeps the order, as the host's credential service always did.
 */
export const createSecretsCache = (
  rows: readonly StoredSecret[],
  /** Told after an added redaction changed the list (secrets/v1 1.1.0). */
  onRedactionAdded?: () => void,
): SecretsCache => {
  let cache: readonly Secret[] = rows.map(toSecret);
  const added: string[] = [];
  const view: SecretsView = Object.freeze({
    list: () => cache,
    redactions: () => [
      ...cache
        .map(({ secret }) => secret)
        .filter(
          (secret): secret is string => secret !== undefined && secret !== '',
        ),
      ...added,
    ],
    addRedaction: (secret: string) => {
      if (secret !== '') {
        added.push(secret);
        onRedactionAdded?.();
      }
    },
  });

  return {
    view,
    list: () => cache,
    save: (credential) => {
      cache = [
        ...cache.filter(({ id }) => id !== credential.id),
        credential,
      ].sort((left, right) => left.name.localeCompare(right.name));
    },
    remove: (id) => {
      cache = cache.filter((credential) => credential.id !== id);
    },
  };
};
