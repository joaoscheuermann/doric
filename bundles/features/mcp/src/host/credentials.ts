// What a server's entries resolve to, and where its OAuth state lives. A
// header or environment entry naming a credential reads its secret through
// secrets/v1 when the server connects, and only that server's entries are
// ever read. An OAuth sign-in's secrets (the access and refresh tokens, a
// client secret) are MCP_TOKEN credentials named `mcp:<serverId>:<part>`;
// the rest of the OAuth state is plain data in the server's document.

import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  type OAuthTokens,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  type CallArg,
  ContractError,
  type CredentialKindDefinition,
  isContractError,
  type Secrets,
} from 'bundle/contracts';

import type { McpEntry } from '../contracts/index.js';
import type { OAuthState } from './oauth.js';
import type { ServerStore, StoredOAuth } from './store.js';

/**
 * The `MCP_TOKEN` credential kind: one secret an MCP server's OAuth sign-in
 * stored (an access token, a refresh token or a client secret).
 */
export const mcpTokenKind: CredentialKindDefinition = {
  id: 'MCP_TOKEN',
  required: ['secret'],
  optional: [],
  label: 'MCP token',
};

export interface ResolvedEntries {
  readonly values: Readonly<Record<string, string>>;
  /** Non-empty values that came from credentials, in entry order: what callers mask. */
  readonly secrets: readonly string[];
}

/**
 * Resolves a server's entries through secrets/v1 under `call`; a later entry
 * of the same name wins. Rejects with the secrets/v1 error when a referenced
 * credential cannot be resolved, and with ContractError('invalid_input')
 * when it holds no secret. Reads nothing when no entry names a credential.
 */
export const resolveEntries = async (
  entries: readonly McpEntry[],
  secrets: Pick<Secrets, 'resolve'>,
  call?: CallArg,
): Promise<ResolvedEntries> => {
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      if ('value' in entry) {
        return { name: entry.name, value: entry.value, secret: false };
      }

      const credential = await secrets.resolve(
        { id: entry.credentialId },
        call,
      );

      if (credential.secret === undefined) {
        throw new ContractError(
          'invalid_input',
          `The credential of ${entry.name} holds no secret.`,
        );
      }

      return { name: entry.name, value: credential.secret, secret: true };
    }),
  );

  return {
    values: Object.fromEntries(
      resolved.map((entry) => [entry.name, entry.value]),
    ),
    secrets: resolved
      .filter((entry) => entry.secret && entry.value !== '')
      .map((entry) => entry.value),
  };
};

/** The marker a masked secret leaves (the platform's own, `[REDACTED]`). */
const REDACTED = '[REDACTED]';

/** `text` with every occurrence of each non-empty secret masked, longest first. */
export const redact = (text: string, secrets: readonly string[]): string =>
  [...secrets]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join(REDACTED), text);

/** What a server's OAuth state persistence can drop. */
export type OAuthScope = 'all' | 'client' | 'tokens' | 'discovery';

/** A server's OAuth state: secrets in secrets/v1, the rest in its document. */
export interface OAuthVault {
  /** The stored state; a credential deleted elsewhere reads as absent. */
  load(serverId: string): Promise<OAuthState>;
  /** Stores what `patch` carries, replacing those parts; a removed server stores nothing. */
  save(serverId: string, patch: OAuthState): Promise<void>;
  /** Drops a part of the stored state and deletes the credentials it named. */
  invalidate(serverId: string, scope: OAuthScope): Promise<void>;
  /** Deletes every credential the stored state names; the document is left as is. */
  forget(oauth: StoredOAuth | undefined): Promise<void>;
}

const authorizationServerMetadataOf = (value: unknown) =>
  OAuthMetadataSchema.safeParse(value).data ??
  OpenIdProviderDiscoveryMetadataSchema.safeParse(value).data;

const clientOf = (
  stored: NonNullable<StoredOAuth['clientInformation']>,
  secret: string | undefined,
): OAuthClientInformationMixed | undefined => {
  const value = {
    ...stored,
    ...(secret === undefined ? {} : { client_secret: secret }),
  };

  return (
    OAuthClientInformationFullSchema.safeParse(value).data ??
    OAuthClientInformationSchema.safeParse(value).data
  );
};

const discoveryOf = (
  stored: NonNullable<StoredOAuth['discoveryState']>,
): OAuthDiscoveryState => {
  const resourceMetadata = OAuthProtectedResourceMetadataSchema.safeParse(
    stored.resourceMetadata,
  ).data;
  const authorizationServerMetadata = authorizationServerMetadataOf(
    stored.authorizationServerMetadata,
  );

  return {
    authorizationServerUrl: stored.authorizationServerUrl,
    ...(typeof stored.resourceMetadataUrl === 'string'
      ? { resourceMetadataUrl: stored.resourceMetadataUrl }
      : {}),
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
    ...(authorizationServerMetadata === undefined
      ? {}
      : { authorizationServerMetadata }),
  };
};

/** The discovery state as the document keeps it: plain data. */
const storedDiscovery = ({
  authorizationServerUrl,
  resourceMetadataUrl,
  resourceMetadata,
  authorizationServerMetadata,
}: OAuthDiscoveryState): NonNullable<StoredOAuth['discoveryState']> => ({
  authorizationServerUrl,
  ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
  ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
  ...(authorizationServerMetadata === undefined
    ? {}
    : { authorizationServerMetadata }),
});

const isCode = (error: unknown, code: string): boolean =>
  isContractError(error) && error.code === code;

export const createOAuthVault = ({
  store,
  secrets,
}: {
  readonly store: ServerStore;
  readonly secrets: Pick<
    Secrets,
    'resolve' | 'create' | 'update' | 'delete' | 'list'
  >;
}): OAuthVault => {
  const secretOf = async (
    id: string | undefined,
  ): Promise<string | undefined> => {
    if (id === undefined) {
      return undefined;
    }

    try {
      return (await secrets.resolve({ id })).secret;
    } catch (error) {
      // A token credential the reader deleted means no token: the server
      // then asks for a sign-in again.
      if (isCode(error, 'credential_missing')) {
        return undefined;
      }

      throw error;
    }
  };

  /** Writes one secret into its credential, creating it when needed; answers its id. */
  const writeSecret = async (
    id: string | undefined,
    name: string,
    secret: string,
  ): Promise<string> => {
    if (id !== undefined) {
      try {
        await secrets.update({ id }, { secret });
        return id;
      } catch (error) {
        if (!isCode(error, 'credential_missing')) throw error;
      }
    }

    try {
      return (await secrets.create({ kind: mcpTokenKind.id, name, secret })).id;
    } catch (error) {
      if (!isCode(error, 'credential_name_taken')) throw error;
      const existing = (await secrets.list()).find(
        (entry) => entry.kind === mcpTokenKind.id && entry.name === name,
      );
      if (existing === undefined) throw error;
      await secrets.update({ id: existing.id }, { secret });
      return existing.id;
    }
  };

  const deleteSecret = async (id: string | undefined): Promise<void> => {
    if (id !== undefined) {
      await secrets.delete({ id });
    }
  };

  const withTokens = async (
    serverId: string,
    oauth: StoredOAuth,
    tokens: OAuthTokens,
  ): Promise<StoredOAuth> => {
    const { refreshCredentialId, scope: _scope, ...rest } = oauth;
    const accessCredentialId = await writeSecret(
      oauth.accessCredentialId,
      `mcp:${serverId}:access`,
      tokens.access_token,
    );

    if (tokens.refresh_token === undefined) {
      await deleteSecret(refreshCredentialId);
    }

    const refreshed =
      tokens.refresh_token === undefined
        ? undefined
        : await writeSecret(
            refreshCredentialId,
            `mcp:${serverId}:refresh`,
            tokens.refresh_token,
          );

    return {
      ...rest,
      accessCredentialId,
      tokenType: tokens.token_type,
      ...(refreshed === undefined ? {} : { refreshCredentialId: refreshed }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    };
  };

  const withClient = async (
    serverId: string,
    oauth: StoredOAuth,
    information: OAuthClientInformationMixed,
  ): Promise<StoredOAuth> => {
    const { client_secret: secret, ...clientInformation } = information;
    const { clientSecretCredentialId, ...rest } = oauth;

    if (secret === undefined) {
      await deleteSecret(clientSecretCredentialId);
      return { ...rest, clientInformation };
    }

    return {
      ...rest,
      clientInformation,
      clientSecretCredentialId: await writeSecret(
        clientSecretCredentialId,
        `mcp:${serverId}:client`,
        secret,
      ),
    };
  };

  /** Drops one part of the state, deleting the credentials it named. */
  const without = async (
    oauth: StoredOAuth,
    scope: Exclude<OAuthScope, 'all'>,
  ): Promise<StoredOAuth> => {
    if (scope === 'tokens') {
      const {
        accessCredentialId,
        refreshCredentialId,
        tokenType: _tokenType,
        scope: _scope,
        ...rest
      } = oauth;
      await deleteSecret(accessCredentialId);
      await deleteSecret(refreshCredentialId);
      return rest;
    }

    if (scope === 'client') {
      const {
        clientSecretCredentialId,
        clientInformation: _clientInformation,
        ...rest
      } = oauth;
      await deleteSecret(clientSecretCredentialId);
      return rest;
    }

    const { discoveryState: _discoveryState, ...rest } = oauth;
    return rest;
  };

  const forget = async (oauth: StoredOAuth | undefined): Promise<void> => {
    await deleteSecret(oauth?.accessCredentialId);
    await deleteSecret(oauth?.refreshCredentialId);
    await deleteSecret(oauth?.clientSecretCredentialId);
  };

  /** Rewrites the stored state of a server that still exists. */
  const change = (
    serverId: string,
    next: (oauth: StoredOAuth) => Promise<StoredOAuth | undefined>,
  ): Promise<void> =>
    store.lock(serverId, async () => {
      const document = await store.get(serverId);

      if (document === undefined) {
        return;
      }

      const { oauth, ...rest } = document;
      const changed = await next(oauth ?? {});

      await store.put({
        ...rest,
        ...(changed === undefined ? {} : { oauth: changed }),
        updatedAt: new Date().toISOString(),
      });
    });

  return {
    load: async (serverId) => {
      const oauth = (await store.get(serverId))?.oauth;

      if (oauth === undefined) {
        return {};
      }

      const [access, refresh, clientSecret] = await Promise.all([
        secretOf(oauth.accessCredentialId),
        secretOf(oauth.refreshCredentialId),
        secretOf(oauth.clientSecretCredentialId),
      ]);
      const clientInformation =
        oauth.clientInformation === undefined
          ? undefined
          : clientOf(oauth.clientInformation, clientSecret);

      return {
        ...(clientInformation === undefined ? {} : { clientInformation }),
        ...(oauth.discoveryState === undefined
          ? {}
          : { discoveryState: discoveryOf(oauth.discoveryState) }),
        ...(access === undefined || access === ''
          ? {}
          : {
              tokens: {
                access_token: access,
                token_type: oauth.tokenType ?? 'Bearer',
                ...(refresh === undefined || refresh === ''
                  ? {}
                  : { refresh_token: refresh }),
                ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
              },
            }),
      };
    },
    save: (serverId, patch) =>
      change(serverId, async (oauth) => {
        const { tokens, clientInformation, discoveryState } = patch;
        const tokened =
          tokens === undefined
            ? oauth
            : await withTokens(serverId, oauth, tokens);
        const registered =
          clientInformation === undefined
            ? tokened
            : await withClient(serverId, tokened, clientInformation);

        return discoveryState === undefined
          ? registered
          : { ...registered, discoveryState: storedDiscovery(discoveryState) };
      }),
    invalidate: (serverId, scope) =>
      change(serverId, async (oauth) => {
        if (scope === 'all') {
          await forget(oauth);
          return undefined;
        }

        return without(oauth, scope);
      }),
    forget,
  };
};
