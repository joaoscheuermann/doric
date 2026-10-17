import type { CredentialKind } from 'bundle/contracts';

import type { Credential } from '../../src/host/credentials/kind.js';
import {
  credentialById,
  credentialByKind,
} from '../../src/host/credentials/resolve.js';
import type { CredentialService } from '../../src/host/credentials/service.js';

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
