import type {
  Credential,
  CredentialKind,
} from '../../src/lib/credentials/kind.js';
import {
  credentialById,
  credentialByKind,
} from '../../src/lib/credentials/resolve.js';
import type { CredentialService } from '../../src/lib/credentials/service.js';

/** A credential service over a fixed list, for cases that never write one. */
export const credentialResolver = (
  list: () => readonly Credential[] = () => [],
  registered: string[] = [],
): CredentialService =>
  ({
    list,
    find: (id: string) => list().find(({ id: stored }) => stored === id),
    byId: (id: string) => credentialById(list(), id),
    byKind: (kind: CredentialKind) => credentialByKind(list(), kind),
    byUnclaimedKind: (kind: CredentialKind, claimed: ReadonlySet<string>) =>
      credentialByKind(
        list().filter(({ id }) => !claimed.has(id)),
        kind,
      ),
    secrets: () => [
      ...list().flatMap(({ secret }) =>
        secret === undefined || secret === '' ? [] : [secret],
      ),
      ...registered,
    ],
    register: (secret: string) => {
      if (secret !== '') registered.push(secret);
    },
  }) as unknown as CredentialService;

export const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
