import type { Credential, CredentialKind } from './kind.js';

/** Nothing asks for a kind unless the host can actually answer it. */
export class MissingCredentialError extends Error {
  constructor(readonly id: string) {
    super(`Credential ${id} is not stored.`);
    this.name = 'MissingCredentialError';
  }
}

/**
 * More than one credential answers a requested kind, and taking one of them
 * would be a guess about which secret to authenticate with.
 */
export class AmbiguousCredentialError extends Error {
  constructor(readonly kind: CredentialKind) {
    super(`More than one ${kind} credential is stored; name the one to use.`);
    this.name = 'AmbiguousCredentialError';
  }
}

/** Resolves one explicit reference. A broken reference is never a guess. */
export const credentialById = (
  credentials: readonly Credential[],
  id: string,
): Credential => {
  const credential = credentials.find((candidate) => candidate.id === id);
  if (credential === undefined) throw new MissingCredentialError(id);

  return credential;
};

/**
 * Resolves the one credential of a requested kind. None means the integration
 * stays off; several means the host refuses to guess which one to use.
 */
export const credentialByKind = (
  credentials: readonly Credential[],
  kind: CredentialKind,
): Credential | undefined => {
  const matches = credentials.filter((candidate) => candidate.kind === kind);
  if (matches.length > 1) throw new AmbiguousCredentialError(kind);

  return matches[0];
};
