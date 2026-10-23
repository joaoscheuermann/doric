// claude.login/v1: the in-app Claude sign-in, host side. Reuse first — a
// working Claude Code login (`~/.claude`, `CLAUDE_CONFIG_DIR` or
// `CLAUDE_AUTHORIZATION`) answers the call by itself; only its
// `authorization` header value is stored. Any resolve failure except an
// aborted signal falls through to the fresh browser flow, because the
// button's contract is "sign me in": a broken `~/.claude` login must never
// block a fresh sign-in. The fresh flow binds Claude Code's own loopback
// callback (54545, falling back to 54546 when busy), opens the browser and
// exchanges the code; the callback server is always closed, and the
// authorization value is never logged anywhere.
//
// One login runs at a time: a second `login()` while one waits answers
// `claude_login_busy`, and an aborted login answers `claude_login_aborted`
// and stores nothing.

import {
  type Call,
  ContractError,
  type CredentialUpdate,
  type CredentialWrite,
  defineMethod,
  defineService,
  isContractError,
  SecretsV1,
  type Services,
} from 'bundle/contracts';
import {
  CLAUDE_OAUTH_CALLBACK_HOST,
  CLAUDE_OAUTH_CALLBACK_PATH,
  CLAUDE_OAUTH_CALLBACK_PORT,
  CLAUDE_OAUTH_FALLBACK_CALLBACK_PORT,
  type ClaudeCredential,
  type CreateClaudeOAuthOptions,
  createClaudeOAuth,
  createFetchTransport,
  createLocalCallbackServer,
  type LocalCallbackServer,
  type LocalCallbackServerOptions,
  type OAuthBrowserOpener,
  type OAuthClient,
  type OAuthTokenRecord,
  type OAuthTokenStore,
  type OAuthTransport,
  openBrowser,
  type ResolveClaudeAuthOptions,
  resolveClaudeAuth,
} from 'oauth';

import { ClaudeLoginV1, claudeLoginMethods } from '../contracts/index.js';

/** The name the authorization is stored under: the settings list shows it. */
export const CLAUDE_CREDENTIAL_NAME = 'Claude';

/**
 * The seams the host reads Claude through; every one defaults to the real
 * OAuth piece, and tests inject fakes to drive or refuse each step.
 */
export interface ClaudeLoginDeps {
  /** Reads an existing Claude Code login; defaults to `resolveClaudeAuth`. */
  readonly resolveAuth?: (
    options: ResolveClaudeAuthOptions,
  ) => Promise<ClaudeCredential>;
  /** Starts the loopback callback server; defaults to `createLocalCallbackServer`. */
  readonly createServer?: (
    options: LocalCallbackServerOptions,
  ) => Promise<LocalCallbackServer>;
  /** Creates the OAuth client; defaults to `createClaudeOAuth`. */
  readonly createOAuth?: (options: CreateClaudeOAuthOptions) => OAuthClient;
  /** Opens the authorization URL in the browser; defaults to `openBrowser`. */
  readonly browserOpener?: OAuthBrowserOpener;
  /** Creates the transport a fresh flow exchanges tokens over. */
  readonly transport?: () => OAuthTransport;
}

/** The deps with every default applied. */
const depsOf = (deps: ClaudeLoginDeps): Required<ClaudeLoginDeps> => ({
  resolveAuth: deps.resolveAuth ?? resolveClaudeAuth,
  createServer: deps.createServer ?? createLocalCallbackServer,
  createOAuth: deps.createOAuth ?? createClaudeOAuth,
  browserOpener: deps.browserOpener ?? openBrowser,
  transport: deps.transport ?? (() => createFetchTransport()),
});

/** Whether the callback port was busy, so the fallback port is tried next. */
const isAddressInUse = (error: unknown): boolean =>
  error instanceof Error &&
  (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

/**
 * The in-memory token store a fresh flow keeps its token in: the durable
 * copy is the credential this bundle writes after the flow answers, so the
 * flow's own record never needs to survive it (the `scripts/claude-oauth.mjs`
 * idiom).
 */
const memoryTokenStore = (): OAuthTokenStore => {
  let record: OAuthTokenRecord | undefined;
  return {
    load: () => Promise.resolve(record),
    save: (next) => {
      record = next;
      return Promise.resolve();
    },
  };
};

/** The refusal an aborted login answers; nothing is ever stored after it. */
const aborted = (): never => {
  throw new ContractError(
    'claude_login_aborted',
    'The Claude sign-in was cancelled.',
  );
};

/**
 * The loopback callback server a fresh flow redirects to: Claude Code's own
 * port and path, with the fallback port when the default one is busy
 * (`scripts/claude-oauth.mjs`'s fallback idiom).
 */
const createCallbackServer = async (
  deps: Required<ClaudeLoginDeps>,
): Promise<LocalCallbackServer> => {
  const options = {
    host: CLAUDE_OAUTH_CALLBACK_HOST,
    port: CLAUDE_OAUTH_CALLBACK_PORT,
    path: CLAUDE_OAUTH_CALLBACK_PATH,
  };
  try {
    // `await` inside the try — the real server binds asynchronously, so
    // `EADDRINUSE` arrives as a rejection, not a synchronous throw.
    return await deps.createServer(options);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    return deps.createServer({
      ...options,
      port: CLAUDE_OAUTH_FALLBACK_CALLBACK_PORT,
    });
  }
};

/**
 * A fresh browser authorization: opens the callback server, the browser and
 * the token exchange, and answers the authorization value. The callback
 * server is closed however the flow ends.
 */
const freshAuthorization = async (
  deps: Required<ClaudeLoginDeps>,
  call: Call,
): Promise<string> => {
  let server: LocalCallbackServer | undefined;
  try {
    server = await createCallbackServer(deps);
    const client = deps.createOAuth({
      transport: deps.transport(),
      tokenStore: memoryTokenStore(),
      redirectUri: server.redirectUri,
      browserOpener: deps.browserOpener,
      callbackServer: server,
    });
    await client.authorize({ signal: call.signal });
    return (await client.credential()).authorization;
  } finally {
    await server?.close();
  }
};

/**
 * The authorization value this login answers with: the existing login's when
 * one resolves, else a fresh browser flow's. An aborted signal answers
 * `claude_login_aborted`; a resolve failure falls through to the fresh flow.
 */
const authorizationOf = async (
  deps: Required<ClaudeLoginDeps>,
  call: Call,
): Promise<string> => {
  // Reuse first: a working Claude Code login is the answer itself, and it
  // never opens a browser. The authorization value travels from here into
  // the credential store only; it is never logged.
  try {
    const { authorization } = await deps.resolveAuth({ signal: call.signal });
    return authorization;
  } catch {
    if (call.signal.aborted) throw aborted();
    // Fall through: any other resolve failure means no reusable login, which
    // is exactly what the fresh flow is for.
  }
  const authorization = await freshAuthorization(deps, call);
  if (call.signal.aborted) throw aborted();
  return authorization;
};

/**
 * Stores the authorization as the `API_TOKEN` credential named `Claude`, or
 * replaces the secret of the same-name `API_TOKEN` credential when another
 * bundle already stored one under that name. The value itself is only ever
 * passed into `secrets/v1`; nothing here logs it.
 */
const storeAuthorization = async (
  services: Services,
  call: Call,
  authorization: string,
): Promise<CredentialWrite> => {
  const secrets = services.use(SecretsV1);
  try {
    return await secrets.create(
      {
        kind: 'API_TOKEN',
        name: CLAUDE_CREDENTIAL_NAME,
        secret: authorization,
      },
      call,
    );
  } catch (error) {
    if (!isContractError(error) || error.code !== 'credential_name_taken') {
      throw error;
    }
    const listed = await secrets.list(call);
    const existing = listed.find(
      (credential) =>
        credential.kind === 'API_TOKEN' &&
        credential.name === CLAUDE_CREDENTIAL_NAME,
    );
    if (existing === undefined) throw error;
    const update: CredentialUpdate = { secret: authorization };
    return secrets.update({ id: existing.id }, update, call);
  }
};

/** One sign-in: an authorization value, then the credential it is stored as. */
const runLogin = async (
  deps: Required<ClaudeLoginDeps>,
  call: Call,
  services: Services,
): Promise<CredentialWrite> =>
  storeAuthorization(services, call, await authorizationOf(deps, call));

/**
 * The `claude.login/v1` service: `login()`, exposed to the desktop, one at
 * a time. The `inFlight` guard lives in this factory, so each activation
 * gets its own; it is cleared in a `finally`, so a refused or aborted login
 * never leaves the bundle busy.
 */
export const loginService = (deps: ClaudeLoginDeps = {}) => {
  const resolved = depsOf(deps);
  /** The login in progress, when one is. */
  let inFlight: Promise<CredentialWrite> | undefined;
  return defineService(ClaudeLoginV1, {
    login: defineMethod({
      expose: 'desktop',
      ...claudeLoginMethods.login,
      execute: async (_input: readonly [], call: Call, services) => {
        if (inFlight !== undefined) {
          throw new ContractError(
            'claude_login_busy',
            'A Claude sign-in is already in progress.',
          );
        }
        inFlight = runLogin(resolved, call, services);
        try {
          return await inFlight;
        } catch (error) {
          // Any failure of an aborted call answers `claude_login_aborted`,
          // so the end-to-end abort promise holds on every path (resolve,
          // fresh flow, store).
          if (call.signal.aborted) throw aborted();
          throw error;
        } finally {
          inFlight = undefined;
        }
      },
    }),
  });
};
