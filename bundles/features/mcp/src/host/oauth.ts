// OAuth for `http` MCP servers, through the SDK's own flow (`auth`): the
// provider the SDK reads and writes a server's OAuth state through, and the
// browser sign-in, which follows the Claude login's shape. A background
// connection never registers a client or opens anything: it uses and
// refreshes stored tokens, and asks for a sign-in otherwise. A sign-in binds
// a loopback callback on 127.0.0.1, answers the authorization URL (PKCE S256,
// the server as the `resource`) for the window to open, and its finish waits
// for the browser's redirect, checks it and exchanges the code. One sign-in
// per server waits at a time: a newer one of the same server replaces it, and
// one nobody finishes is cancelled after ten minutes, when its server changes
// URL or is removed, and when the bundle deactivates. A provider reads and
// writes the state of one server URL only, and refreshes one at a time.

import { randomBytes } from 'node:crypto';

import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  selectClientAuthMethod,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { type Call, ContractError, type Log } from 'bundle/contracts';
import {
  createLocalCallbackServer,
  type LocalCallbackServer,
  type OAuthCallback,
} from 'oauth';

import {
  type OAuthScope,
  OAuthServerChanged,
  type OAuthVault,
} from './credentials.js';
import { keyedQueue, type ServerDocument } from './store.js';

/** A background connection met a server whose stored OAuth state cannot authorize it. */
export class SignInRequired extends Error {
  override readonly name = 'SignInRequired';

  constructor(serverId: string) {
    super(`MCP server ${serverId} needs a sign-in.`);
  }
}

/** A server's OAuth state as the SDK reads it. */
export interface OAuthState {
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly discoveryState?: OAuthDiscoveryState;
  readonly tokens?: OAuthTokens;
  /**
   * The http URL of the server the state belongs to: a loaded state names
   * it, and a patch naming it is stored only while the server has that URL.
   */
  readonly serverUrl?: string;
}

interface McpOAuthProviderOptions {
  readonly serverId: string;
  /**
   * The server URL the provider authorizes, else the one its first load
   * names: it reads and writes only that URL's state.
   */
  readonly serverUrl?: string;
  /**
   * `background` never registers a client nor redirects: either throws
   * SignInRequired. `interactive` does both, for a sign-in.
   */
  readonly mode: 'background' | 'interactive';
  /** The loopback callback of a sign-in. */
  readonly redirectUrl?: string;
  /** The OAuth `state` the authorization URL carries. */
  readonly state?: string;
  readonly load: () => Promise<OAuthState>;
  readonly save: (patch: OAuthState) => Promise<void>;
  /** `serverUrl` is the provider's: another URL's state is left alone. */
  readonly invalidate: (scope: OAuthScope, serverUrl?: string) => Promise<void>;
}

export interface McpOAuthProvider extends OAuthClientProvider {
  /** The authorization URL the SDK prepared, once it redirected. */
  authorizationUrl(): URL | undefined;
}

/**
 * Where a background provider claims to redirect. It never does (it throws
 * SignInRequired instead), but a defined redirect URL keeps the SDK on the
 * authorization-code path, whose refresh it needs, rather than the
 * client-credentials one.
 */
const BACKGROUND_REDIRECT = 'http://127.0.0.1/callback';

/**
 * How long a refresh waits for the one before it to end. A refresh whose
 * failure the SDK reports to no provider method never ends otherwise.
 */
const REFRESH_WAIT_MS = 30_000;

/** Waits for `promise`, but never longer than `ms`. */
const waitAtMost = (promise: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Authenticates the client at the token endpoint as the SDK does when a
 * provider leaves it to it: the method the registration and the metadata
 * agree on, the secret by HTTP Basic or in the body, else the id alone.
 */
const authenticateClient = (
  information: OAuthClientInformationMixed,
  metadata: AuthorizationServerMetadata | undefined,
  headers: Headers,
  params: URLSearchParams,
): void => {
  const { client_id: clientId, client_secret: secret } = information;
  const method = selectClientAuthMethod(
    information,
    metadata?.token_endpoint_auth_methods_supported ?? [],
  );

  if (method === 'client_secret_basic') {
    if (!secret) {
      throw new Error(
        'client_secret_basic authentication requires a client_secret',
      );
    }

    headers.set('Authorization', `Basic ${btoa(`${clientId}:${secret}`)}`);
    return;
  }

  params.set('client_id', clientId);
  if (method === 'client_secret_post' && secret) {
    params.set('client_secret', secret);
  }
};

/**
 * The `resource` a sign-in names: the server's URL, or the one its protected
 * resource metadata names when that one is allowed for it. Never absent, so
 * a token is always bound to its server.
 */
const resourceOf = (serverUrl: string | URL, resource?: string): URL => {
  const requested = resourceUrlFromServerUrl(serverUrl);

  if (resource === undefined) {
    return requested;
  }

  if (
    !checkResourceAllowed({
      requestedResource: requested,
      configuredResource: resource,
    })
  ) {
    throw new Error(
      `The protected resource ${resource} does not match ${requested.href}.`,
    );
  }

  return new URL(resource);
};

/**
 * The SDK's view of one server's OAuth state. Discovery is refused when the
 * authorization server publishes no metadata or no PKCE `S256`; the
 * `resource` is always sent (the server's URL, or the one its protected
 * resource metadata names, when that one is allowed for it); the PKCE
 * verifier lives in memory only.
 *
 * The provider is bound to one server URL: a state stored for another reads
 * as none and is never written, so tokens never follow a server to a new
 * URL. Its refreshes run one at a time, each sending the latest stored
 * refresh token, and an invalidation keeps tokens no refresh of it spent:
 * those are newer than the ones that failed.
 */
export const createOAuthProvider = (
  options: McpOAuthProviderOptions,
): McpOAuthProvider => {
  const interactive = options.mode === 'interactive';
  const redirectUrl = options.redirectUrl ?? BACKGROUND_REDIRECT;
  const { state } = options;
  let serverUrl = options.serverUrl;
  let loaded: Promise<OAuthState> | undefined;
  let verifier: string | undefined;
  let authorization: URL | undefined;
  /** The refresh tokens this provider sent to the token endpoint. */
  const spent = new Set<string>();
  /** Settles when the latest refresh ended; the next one waits for it. */
  let refreshed: Promise<void> = Promise.resolve();
  let endRefresh: (() => void) | undefined;

  /** The stored state, and whether it is this provider's URL's. */
  const read = async (): Promise<{
    readonly stored: OAuthState;
    readonly ours: boolean;
  }> => {
    const stored = await options.load();
    serverUrl ??= stored.serverUrl;

    return { stored, ours: stored.serverUrl === serverUrl };
  };

  const current = (): Promise<OAuthState> => {
    loaded ??= read().then(({ stored, ours }) => (ours ? stored : {}));
    return loaded;
  };

  const persist = async (patch: OAuthState): Promise<void> => {
    if (serverUrl === undefined) await current();

    try {
      await options.save(
        serverUrl === undefined ? patch : { ...patch, serverUrl },
      );
    } finally {
      loaded = undefined;
    }
  };

  /** Ends the refresh under way, if any: the SDK reported its outcome. */
  const ended = (): void => {
    endRefresh?.();
    endRefresh = undefined;
  };

  /**
   * Waits for the refresh before this one to end, which may have rotated
   * the refresh token, then sends the latest stored one: two refreshes never
   * spend the same token.
   */
  const takeRefreshTurn = async (params: URLSearchParams): Promise<void> => {
    const before = refreshed;
    let end!: () => void;
    refreshed = new Promise((resolve) => {
      end = resolve;
    });
    await waitAtMost(before, REFRESH_WAIT_MS);
    endRefresh = end;
    loaded = undefined;
    const latest = (await current()).tokens?.refresh_token;

    if (latest !== undefined) params.set('refresh_token', latest);
    spent.add(params.get('refresh_token') ?? '');
  };

  const refuse = (): never => {
    throw new SignInRequired(options.serverId);
  };

  const clientMetadata: OAuthClientMetadata = {
    client_name: 'Doric',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  return {
    redirectUrl,
    clientMetadata,
    ...(state === undefined ? {} : { state: () => state }),
    clientInformation: async () => {
      const information = (await current()).clientInformation;

      // Without a registered client the SDK would register one now: only a
      // sign-in does that.
      return information === undefined && !interactive ? refuse() : information;
    },
    saveClientInformation: (information) =>
      interactive ? persist({ clientInformation: information }) : refuse(),
    tokens: async () => (await current()).tokens,
    saveTokens: async (tokens) => {
      try {
        await persist({ tokens });
      } finally {
        ended();
      }
    },
    addClientAuthentication: async (headers, params, _url, metadata) => {
      if (params.get('grant_type') === 'refresh_token') {
        await takeRefreshTurn(params);
      }

      const information = (await current()).clientInformation;

      if (information !== undefined) {
        authenticateClient(information, metadata, headers, params);
      }
    },
    redirectToAuthorization: (url) => {
      ended();
      if (!interactive) refuse();
      authorization = url;
    },
    saveCodeVerifier: (codeVerifier) => {
      ended();
      verifier = codeVerifier;
    },
    codeVerifier: () => {
      if (verifier === undefined) {
        throw new Error(
          'No authorization was started: there is no PKCE verifier.',
        );
      }

      return verifier;
    },
    validateResourceURL: (url, resource) =>
      Promise.resolve().then(() => resourceOf(url, resource)),
    invalidateCredentials: async (scope) => {
      if (scope === 'verifier' || scope === 'all') verifier = undefined;
      if (scope === 'verifier') return;

      try {
        const { stored, ours } = await read();
        const refresh = stored.tokens?.refresh_token;

        // Another URL's state is not this provider's to drop, and tokens no
        // refresh of it spent came after the request that failed: the SDK's
        // retry uses them.
        if (
          !ours ||
          ((scope === 'tokens' || scope === 'all') &&
            refresh !== undefined &&
            !spent.has(refresh))
        ) {
          return;
        }

        await options.invalidate(scope, serverUrl);
      } finally {
        loaded = undefined;
        ended();
      }
    },
    saveDiscoveryState: async (discovered) => {
      const metadata = discovered.authorizationServerMetadata;

      if (metadata === undefined) {
        throw new Error(
          `The authorization server ${discovered.authorizationServerUrl} publishes no metadata.`,
        );
      }

      if (!(metadata.code_challenge_methods_supported ?? []).includes('S256')) {
        throw new Error(
          `The authorization server ${discovered.authorizationServerUrl} does not support PKCE with S256.`,
        );
      }

      await persist({ discoveryState: discovered });
    },
    discoveryState: async () => (await current()).discoveryState,
    authorizationUrl: () => authorization,
  };
};

/** How long a started sign-in waits for the browser before it is cancelled. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** The browser sign-ins of `http` servers; one per server waits at a time. */
export interface SignIns {
  /**
   * Prepares the sign-in of an `http` server and answers the authorization
   * URL; a sign-in of the same server already waiting (or starting) is
   * cancelled first, another server's is left alone. Drops the server's
   * stored tokens first. `mcp_signin_unsupported`, `mcp_signin_aborted`,
   * `mcp_signin_failed`.
   */
  start(server: ServerDocument, call: Call): Promise<{ readonly url: string }>;
  /**
   * Waits for the browser's redirect of the server's waiting sign-in, checks
   * it and stores the tokens it earns. `mcp_signin_not_started`,
   * `mcp_signin_busy`, `mcp_signin_aborted` (also when the server changed
   * URL meanwhile), `mcp_signin_failed`.
   */
  finish(server: ServerDocument, call: Call): Promise<void>;
  /** Cancels the server's waiting sign-in, once a start of it under way ended. */
  cancel(serverId: string): Promise<void>;
  /** Cancels every waiting sign-in and closes its callback. */
  dispose(): Promise<void>;
}

/** A started sign-in, waiting for the browser's redirect. */
interface Pending {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly provider: McpOAuthProvider;
  /** Aborting it cancels the sign-in. */
  readonly controller: AbortController;
  readonly callback: Promise<OAuthCallback>;
  readonly closed: Promise<void>;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Whether a `finish` already waits on it. */
  finishing: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failed = (reason: string, error?: unknown): ContractError =>
  new ContractError(
    'mcp_signin_failed',
    `The MCP sign-in failed: ${reason}${error === undefined ? '' : ` (${messageOf(error)})`}.`,
  );

const aborted = (): ContractError =>
  new ContractError('mcp_signin_aborted', 'The MCP sign-in was cancelled.');

const redirectUrisOf = (information: OAuthClientInformationMixed) =>
  'redirect_uris' in information ? information.redirect_uris : [];

export const createSignIns = ({
  vault,
  log,
}: {
  readonly vault: OAuthVault;
  readonly log: () => Log;
}): SignIns => {
  /** The waiting sign-in of each server. */
  const pending = new Map<string, Pending>();
  /** Starts and cancels of one server, one after another. */
  const serially = keyedQueue();
  let disposed = false;

  /** Closes a callback server; a failure to close is logged, never thrown. */
  const close = (server: LocalCallbackServer): Promise<void> =>
    server.close().catch((error: unknown) => {
      log().warn('The MCP sign-in callback did not close', {
        error: messageOf(error),
      });
    });

  const cancel = (session: Pending): Promise<void> => {
    clearTimeout(session.timer);
    session.controller.abort();
    if (pending.get(session.serverId) === session) {
      pending.delete(session.serverId);
    }

    return session.closed;
  };

  const cancelServer = async (serverId: string): Promise<void> => {
    const session = pending.get(serverId);
    if (session !== undefined) await cancel(session);
  };

  /** Binds the callback and lets the SDK prepare the authorization URL. */
  const prepare = async (
    serverId: string,
    serverUrl: string,
    callback: LocalCallbackServer,
    state: string,
  ): Promise<{ readonly url: URL; readonly provider: McpOAuthProvider }> => {
    const stored = await vault.load(serverId);

    if (stored.serverUrl !== serverUrl) {
      throw new OAuthServerChanged(serverId);
    }

    const client = stored.clientInformation;

    // A client registered for another loopback port cannot use this one.
    if (
      client !== undefined &&
      !redirectUrisOf(client).includes(callback.redirectUri)
    ) {
      await vault.invalidate(serverId, 'client', serverUrl);
    }

    const provider = createOAuthProvider({
      serverId,
      serverUrl,
      mode: 'interactive',
      redirectUrl: callback.redirectUri,
      state,
      load: () => vault.load(serverId),
      save: (patch) => vault.save(serverId, patch),
      invalidate: (scope, url) => vault.invalidate(serverId, scope, url),
    });
    const result = await auth(provider, { serverUrl });
    const url = provider.authorizationUrl();

    if (result !== 'REDIRECT' || url === undefined) {
      throw new Error('the authorization server answered no authorization URL');
    }

    return { url, provider };
  };

  return {
    start: async (server, call) => {
      const { transport } = server;

      if (transport.kind !== 'http') {
        throw new ContractError(
          'mcp_signin_unsupported',
          'A stdio MCP server has no sign-in.',
        );
      }

      // One start of a server at a time, so two never bind two callbacks
      // or register two clients over each other.
      return await serially(server.id, async () => {
        await cancelServer(server.id);

        if (disposed) throw aborted();

        await vault.invalidate(server.id, 'tokens', transport.url);

        let callback: LocalCallbackServer;

        try {
          callback = await createLocalCallbackServer({
            host: '127.0.0.1',
            port: 0,
          });
        } catch (error) {
          throw failed('the local callback could not start', error);
        }

        const state = randomBytes(32).toString('base64url');
        let prepared: Awaited<ReturnType<typeof prepare>>;

        try {
          prepared = await prepare(server.id, transport.url, callback, state);
        } catch (error) {
          await close(callback);
          throw error instanceof OAuthServerChanged
            ? aborted()
            : failed('the authorization could not be prepared', error);
        }

        if (call.signal.aborted || disposed) {
          await close(callback);
          throw aborted();
        }

        const controller = new AbortController();
        const waiting = callback.waitForCallback(state, controller.signal);
        // The redirect may come with nobody waiting on it (cancelled, timed
        // out): its rejection is answered by `finish` when one waits, and
        // never left unhandled, which would end the host process.
        waiting.catch(() => undefined);
        const session: Pending = {
          serverId: server.id,
          serverUrl: transport.url,
          provider: prepared.provider,
          controller,
          callback: waiting,
          closed: waiting.then(
            () => close(callback),
            () => close(callback),
          ),
          timer: setTimeout(() => void cancel(session), SIGN_IN_TIMEOUT_MS),
          finishing: false,
        };
        session.timer.unref?.();
        pending.set(server.id, session);

        return { url: prepared.url.href };
      });
    },
    finish: async (server, call) => {
      const session = pending.get(server.id);

      if (
        session === undefined ||
        server.transport.kind !== 'http' ||
        session.serverUrl !== server.transport.url
      ) {
        throw new ContractError(
          'mcp_signin_not_started',
          'No sign-in of this MCP server is waiting; start one first.',
        );
      }

      if (session.finishing) {
        throw new ContractError(
          'mcp_signin_busy',
          'The sign-in of this MCP server is already being finished.',
        );
      }

      session.finishing = true;
      const onAbort = (): void => void cancel(session);
      call.signal.addEventListener('abort', onAbort, { once: true });
      let answer: OAuthCallback;

      try {
        answer = await session.callback;
      } catch (error) {
        if (call.signal.aborted || session.controller.signal.aborted) {
          throw aborted();
        }

        throw failed('the browser did not answer', error);
      } finally {
        call.signal.removeEventListener('abort', onAbort);
        clearTimeout(session.timer);
        if (pending.get(server.id) === session) pending.delete(server.id);
        await session.closed;
      }

      if (call.signal.aborted) throw aborted();

      if (answer.error !== undefined) {
        throw failed(
          `the authorization server answered ${answer.error}${answer.errorDescription === undefined ? '' : `: ${answer.errorDescription}`}`,
        );
      }

      const metadata = (await session.provider.discoveryState?.())
        ?.authorizationServerMetadata;
      const issRequired =
        metadata !== undefined &&
        'authorization_response_iss_parameter_supported' in metadata &&
        metadata.authorization_response_iss_parameter_supported === true;

      // RFC 9207: a redirect naming another issuer is a mix-up.
      if (
        (issRequired || answer.iss !== undefined) &&
        answer.iss !== metadata?.issuer
      ) {
        throw failed('the redirect names another authorization server');
      }

      if (answer.code === undefined) {
        throw failed('the redirect carries no authorization code');
      }

      try {
        await auth(session.provider, {
          serverUrl: session.serverUrl,
          authorizationCode: answer.code,
        });
      } catch (error) {
        // The server moved to another URL meanwhile: the tokens were the
        // former one's, and nothing kept them.
        if (error instanceof OAuthServerChanged) throw aborted();

        throw failed('the token exchange failed', error);
      }
    },
    cancel: (serverId) => serially(serverId, () => cancelServer(serverId)),
    dispose: async () => {
      disposed = true;
      await Promise.all([...pending.values()].map(cancel));
    },
  };
};
