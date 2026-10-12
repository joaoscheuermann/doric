import {
  type CredentialCreate,
  type CredentialKind,
  type CredentialUpdate,
  type CredentialWrite as DescribedCredential,
  isContractError,
  type Secrets,
} from 'bundle/contracts';

import type { Credential } from './kind.js';
import { credentialById, credentialByKind } from './resolve.js';

export type CredentialWrite =
  | { readonly status: 'saved'; readonly credential: Credential }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'missing' | 'conflict' | 'immutable' };

export type CredentialRemoval = 'deleted' | 'missing' | 'referenced';

/** The host holds no write access to credential secrets without this key. */
export class MissingKeyError extends Error {
  constructor() {
    super('DORIC_CREDENTIAL_KEY is required to store a credential secret.');
    this.name = 'MissingKeyError';
  }
}

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
  /**
   * Every secret the host holds, so no event, log line, or message can carry
   * one: each stored secret, and each one the host registered after storing it.
   */
  secrets(): readonly string[];
  /**
   * Records a secret the host learned outside the store — a credential it wrote
   * into a running sandbox — so redaction covers it for as long as the host runs,
   * whatever configuration is in force.
   */
  register(secret: string): void;
  create(input: CredentialCreate): Promise<CredentialWrite>;
  update(id: string, input: CredentialUpdate): Promise<CredentialWrite>;
  remove(id: string): Promise<CredentialRemoval>;
}

interface Options {
  /** The `secrets/v1` provider: its cache, rules and references. */
  readonly secrets: Secrets;
}

/**
 * The credential service over `secrets/v1`. Reading the list loads the
 * provider's cache, so a missing or unusable key with a secret at rest fails
 * here, at startup, rather than serving a stored secret as an empty one. Every
 * read after that is the provider's synchronous in-process view.
 */
export const createCredentialService = async ({
  secrets,
}: Options): Promise<CredentialService> => {
  await secrets.list();
  const view = secrets.view();
  const list = (): readonly Credential[] => view.list();

  /** One create or update, with the provider's refusals as write outcomes. */
  const write = async (
    run: () => Promise<DescribedCredential>,
  ): Promise<CredentialWrite> => {
    try {
      const { id } = await run();
      const credential = list().find((candidate) => candidate.id === id);

      return credential === undefined
        ? { status: 'missing' }
        : { status: 'saved', credential };
    } catch (error) {
      if (!isContractError(error)) throw error;

      switch (error.code) {
        case 'credential_invalid':
          return { status: 'invalid', message: error.message };
        case 'credential_missing':
          return { status: 'missing' };
        case 'credential_name_taken':
          return { status: 'conflict' };
        case 'credential_kind_immutable':
          return { status: 'immutable' };
        case 'credential_storage_unavailable':
          throw new MissingKeyError();
        default:
          throw error;
      }
    }
  };

  return {
    list,
    find: (id) => list().find((credential) => credential.id === id),
    byId: (id) => credentialById(list(), id),
    byKind: (kind) => credentialByKind(list(), kind),
    byUnclaimedKind: (kind, claimed) =>
      credentialByKind(
        list().filter((credential) => !claimed.has(credential.id)),
        kind,
      ),
    secrets: () => view.redactions(),

    register(secret) {
      if (secret !== '') view.addRedaction(secret);
    },

    create: (input) => write(() => secrets.create(input)),
    update: (id, input) => write(() => secrets.update({ id }, input)),
    // A deleted credential stops resolving at once, and one a configuration
    // still names is refused before the store is touched.
    remove: (id) => secrets.delete({ id }),
  };
};
