// claude.login/v1: the in-app Claude sign-in, host side. The host may run
// where no browser does (a container, another machine), so it never opens
// one: `start()` binds Claude Code's own loopback callback (54545, falling
// back to 54546 when busy), prepares the authorization and answers its URL,
// which the window opens in the system browser. `finish()` waits for the
// callback, exchanges the code for a long-lived login and stores only its
// `authorization` header value. An existing Claude Code login is never
// reused: its access token expires within hours and nothing here would
// refresh it, so a stored copy would stop working the same day.
//
// One sign-in waits at a time: a new `start()` cancels and replaces it, and
// one nobody finishes is cancelled after a deadline. The callback server is
// closed however the sign-in ends, and the authorization value is never
// logged anywhere.

import {
  type Call,
  type Cleanup,
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
  type CreateClaudeOAuthOptions,
  createClaudeOAuth,
  createFetchTransport,
  createLocalCallbackServer,
  type LocalCallbackServer,
  type LocalCallbackServerOptions,
  type OAuthClient,
  type OAuthTokenRecord,
  type OAuthTokenStore,
  type OAuthTransport,
} from 'oauth';

import {
  type ClaudeLoginStart,
  ClaudeLoginV1,
  claudeLoginMethods,
} from '../contracts/index.js';

/** The name the authorization is stored under: the settings list shows it. */
export const CLAUDE_CREDENTIAL_NAME = 'Claude';

/** How long a started sign-in waits for the browser before it is cancelled. */
export const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The seams the host reads Claude through; every one defaults to the real
 * OAuth piece, and tests inject fakes to drive or refuse each step.
 */
export interface ClaudeLoginDeps {
  /** Starts the loopback callback server; defaults to `createLocalCallbackServer`. */
  readonly createServer?: (
    options: LocalCallbackServerOptions,
  ) => Promise<LocalCallbackServer>;
  /** Creates the OAuth client; defaults to `createClaudeOAuth`. */
  readonly createOAuth?: (options: CreateClaudeOAuthOptions) => OAuthClient;
  /** Creates the transport a sign-in exchanges tokens over. */
  readonly transport?: () => OAuthTransport;
  /** How long a started sign-in waits; `CLAUDE_LOGIN_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
}

/** The deps with every default applied. */
const depsOf = (deps: ClaudeLoginDeps): Required<ClaudeLoginDeps> => ({
  createServer: deps.createServer ?? createLocalCallbackServer,
  createOAuth: deps.createOAuth ?? createClaudeOAuth,
  transport: deps.transport ?? (() => createFetchTransport()),
  timeoutMs: deps.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS,
});

/** Whether the callback port was busy, so the fallback port is tried next. */
const isAddressInUse = (error: unknown): boolean =>
  error instanceof Error &&
  (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

/**
 * The in-memory token store a sign-in keeps its token in: the durable copy
 * is the credential this bundle writes after the sign-in answers, so the
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

/** The refusal of a cancelled sign-in; nothing is ever stored after it. */
const aborted = (): ContractError =>
  new ContractError(
    'claude_login_aborted',
    'The Claude sign-in was cancelled.',
  );

/** The refusal of a sign-in the authorization itself failed. */
const failed = (error: unknown): ContractError =>
  isContractError(error)
    ? error
    : new ContractError(
        'claude_login_failed',
        `The Claude sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      );

/**
 * The loopback callback server a sign-in redirects to: Claude Code's own
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

/** A started sign-in, waiting for the browser's callback. */
interface Pending {
  /** Aborts the authorization; aborting it is how a sign-in is cancelled. */
  readonly controller: AbortController;
  /** The authorization value, once the callback answered and the code is exchanged. */
  readonly authorization: Promise<string>;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Whether a `finish()` already waits on it. */
  finishing: boolean;
}

/**
 * Starts the authorization in the background and answers its URL with the
 * sign-in still waiting. The OAuth client hands the URL to its browser
 * opener; here that opener only records it, because the window opens it.
 */
const begin = async (
  deps: Required<ClaudeLoginDeps>,
  controller: AbortController,
): Promise<{
  readonly url: string;
  readonly authorization: Promise<string>;
}> => {
  const server = await createCallbackServer(deps);
  let opened: (url: string) => void = () => undefined;
  const url = new Promise<string>((resolve) => {
    opened = resolve;
  });
  const client = deps.createOAuth({
    transport: deps.transport(),
    tokenStore: memoryTokenStore(),
    redirectUri: server.redirectUri,
    browserOpener: (target) => {
      opened(target);
      return Promise.resolve();
    },
    callbackServer: server,
  });
  const authorization = (async () => {
    try {
      await client.authorize({ signal: controller.signal });
      return (await client.credential()).authorization;
    } finally {
      await server.close();
    }
  })();
  // The sign-in may end with nobody waiting on it (cancelled, timed out):
  // its rejection is answered by `finish()` when one waits, and never left
  // unhandled, which would end the host process.
  authorization.catch(() => undefined);
  return {
    url: await Promise.race([
      url,
      authorization.then(() => {
        throw new Error('The authorization ended before it named its URL.');
      }),
    ]),
    authorization,
  };
};

/**
 * Stores the authorization as the `API_TOKEN` credential named `Claude`, or
 * replaces the secret of the same-name `API_TOKEN` credential when one is
 * already stored. The value itself is only ever passed into `secrets/v1`;
 * nothing here logs it.
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

/**
 * The `claude.login/v1` service and the cleanup that cancels a waiting
 * sign-in when the bundle deactivates. The waiting sign-in lives in this
 * factory, so each activation gets its own.
 */
export const loginService = (deps: ClaudeLoginDeps = {}) => {
  const resolved = depsOf(deps);
  /** The sign-in waiting for the browser, when one is. */
  let pending: Pending | undefined;

  /** Cancels a sign-in: the authorization aborts and its server closes. */
  const cancel = (session: Pending): void => {
    clearTimeout(session.timer);
    session.controller.abort();
    if (pending === session) pending = undefined;
  };

  const service = defineService(ClaudeLoginV1, {
    start: defineMethod({
      expose: 'desktop',
      ...claudeLoginMethods.start,
      execute: async (
        _input: readonly [],
        call: Call,
      ): Promise<ClaudeLoginStart> => {
        if (pending !== undefined) cancel(pending);
        const controller = new AbortController();
        let started: Awaited<ReturnType<typeof begin>>;
        try {
          started = await begin(resolved, controller);
        } catch (error) {
          controller.abort();
          throw failed(error);
        }
        if (call.signal.aborted) {
          controller.abort();
          throw aborted();
        }
        const session: Pending = {
          controller,
          authorization: started.authorization,
          timer: setTimeout(() => cancel(session), resolved.timeoutMs),
          finishing: false,
        };
        session.timer.unref?.();
        pending = session;
        return { url: started.url };
      },
    }),
    finish: defineMethod({
      expose: 'desktop',
      ...claudeLoginMethods.finish,
      execute: async (_input: readonly [], call: Call, services) => {
        const session = pending;
        if (session === undefined) {
          throw new ContractError(
            'claude_login_not_started',
            'No Claude sign-in is waiting; start one first.',
          );
        }
        if (session.finishing) {
          throw new ContractError(
            'claude_login_busy',
            'A Claude sign-in is already in progress.',
          );
        }
        session.finishing = true;
        const onAbort = (): void => cancel(session);
        call.signal.addEventListener('abort', onAbort, { once: true });
        let authorization: string;
        try {
          authorization = await session.authorization;
        } catch (error) {
          if (call.signal.aborted || session.controller.signal.aborted) {
            throw aborted();
          }
          throw failed(error);
        } finally {
          call.signal.removeEventListener('abort', onAbort);
          clearTimeout(session.timer);
          if (pending === session) pending = undefined;
        }
        // A cancel that arrived with the callback still stores nothing.
        if (call.signal.aborted) throw aborted();
        return storeAuthorization(services, call, authorization);
      },
    }),
  });

  const cleanup: Cleanup = () => {
    if (pending !== undefined) cancel(pending);
  };

  return { service, cleanup };
};
