// The Versioning section's credential rules (moved from the settings
// bundle's `domain/config.ts`): the stored credentials it chooses between,
// how a choice reads, and how a choice is written into the draft.

/** The closed set of credential kinds. */
export const credentialKinds = [
  'API_TOKEN',
  'USERNAME_PASSWORD',
  'GIT',
] as const;

export type CredentialKind = (typeof credentialKinds)[number];

/** A stored credential as the host answers it; the secret never arrives. */
export type Credential = {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly hasSecret: boolean;
};

export const credentialsOfKind = (
  credentials: readonly Credential[],
  kind: CredentialKind,
): readonly Credential[] =>
  credentials.filter((credential) => credential.kind === kind);

/**
 * What a selection shows for one credential: its name, with what it carries, so
 * two credentials of a kind are told apart without revealing either secret.
 */
export const credentialLabel = (credential: Credential): string =>
  credential.username === undefined
    ? credential.name
    : `${credential.name} (${credential.username})`;

/**
 * Writes one integration's credential choice. Choosing none deletes the key,
 * because the host reads "no id" as unconfigured and an empty id as a
 * reference that cannot resolve.
 */
export const updateCredentialChoice = <
  D extends {
    readonly gitCredentialId?: string;
    readonly githubCredentialId?: string;
  },
>(
  configuration: D,
  field: 'gitCredentialId' | 'githubCredentialId',
  id: string | undefined,
): D => {
  const next: Record<string, unknown> = { ...configuration };
  if (id === undefined || id === '') delete next[field];
  else next[field] = id;
  return next as D;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isCredentialKind = (value: unknown): value is CredentialKind =>
  typeof value === 'string' &&
  (credentialKinds as readonly string[]).includes(value);

/** One `secrets/v1.list` entry as the settings window read it, else undefined. */
export const credentialFrom = (value: unknown): Credential | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isCredentialKind(value.kind) ||
    typeof value.hasSecret !== 'boolean' ||
    (value.username !== undefined && typeof value.username !== 'string') ||
    (value.email !== undefined && typeof value.email !== 'string')
  ) {
    return undefined;
  }
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.email === undefined ? {} : { email: value.email }),
    hasSecret: value.hasSecret,
  };
};

/**
 * The listed credentials, read as the settings window read them: a shape it
 * refused is a failed read, and the section then has none to offer.
 */
export const credentialsFrom = (listed: unknown): readonly Credential[] => {
  if (!Array.isArray(listed))
    throw new Error('Doric returned an invalid response.');
  return listed.map((entry) => {
    const credential = credentialFrom(entry);
    if (credential === undefined)
      throw new Error('Doric returned an invalid response.');
    return credential;
  });
};
