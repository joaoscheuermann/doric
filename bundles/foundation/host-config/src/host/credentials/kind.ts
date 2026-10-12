import type { CredentialKind } from 'bundle/contracts';

/** A stored credential with its secret decrypted for host use. */
export interface Credential {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
}

/**
 * The API view of a credential. The secret itself never leaves the host: the
 * value is replaced by whether there is one to use.
 */
export interface PublicCredential {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly hasSecret: boolean;
}

export const publicCredential = ({
  id,
  kind,
  name,
  username,
  email,
  secret,
}: Credential): PublicCredential => ({
  id,
  kind,
  name,
  ...(username ? { username } : {}),
  ...(email ? { email } : {}),
  hasSecret: secret !== undefined && secret !== '',
});
