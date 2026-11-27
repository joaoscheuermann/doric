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

import { ContractError, isContractError } from 'bundle/contracts';
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

import type { ClaudeLoginStart } from '../contracts/index.js';

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
 * One Claude sign-in at a time, which the routed service drives. No I/O
 * until `start`.
 */
export interface ClaudeLoginSessions {
  /**
   * As `claude.login/v1.Start`:
   * - cancels a waiting sign-in (its `finish` then fails `claude_login_aborted`);
   * - binds the loopback callback (port 54545, else 54546 when busy);
   * - answers the `https:` authorization URL, with the sign-in waiting until
   *   `finish`, a newer `start`, `cancel`, or `deps.timeoutMs`.
   *
   * Failures:
   * - `claude_login_failed` when the authorization cannot be prepared (nothing
   *   waits);
   * - `claude_login_aborted` when `signal` is aborted once it is prepared (it
   *   is cancelled and nothing waits).
   */
  start(signal: AbortSignal): Promise<ClaudeLoginStart>;
  /**
   * As `claude.login/v1.Finish`: waits for the waiting sign-in's callback,
   * then calls `store(authorization)` once and answers what it answers. The
   * sign-in no longer waits afterwards, whatever the outcome.
   *
   * Failures:
   * - `claude_login_not_started`: none waits;
   * - `claude_login_busy`: another `finish` waits on it;
   * - `claude_login_aborted`: `signal` aborted (this cancels the sign-in), a
   *   newer `start`, `cancel` or the timeout ended it; `store` is then never
   *   called;
   * - `claude_login_failed`: the authorization failed;
   * - `store`'s rejection, unchanged.
   *
   * The authorization value is passed only to `store`; it is never logged or
   * answered.
   */
  finish<C>(
    signal: AbortSignal,
    store: (authorization: string) => Promise<C>,
  ): Promise<C>;
  /** Cancels the waiting sign-in, if any; its callback server closes. Idempotent. */
  cancel(): void;
}

/** Creates the sessions with `deps`' seams (each defaults to the real OAuth piece). */
export const createLoginSessions = (
  deps: ClaudeLoginDeps = {},
): ClaudeLoginSessions => {
  const resolved = depsOf(deps);
  /** The sign-in waiting for the browser, when one is. */
  let pending: Pending | undefined;

  /** Cancels a sign-in: the authorization aborts and its server closes. */
  const cancelSession = (session: Pending): void => {
    clearTimeout(session.timer);
    session.controller.abort();
    if (pending === session) pending = undefined;
  };

  return {
    start: async (signal) => {
      if (pending !== undefined) cancelSession(pending);
      const controller = new AbortController();
      let started: Awaited<ReturnType<typeof begin>>;
      try {
        started = await begin(resolved, controller);
      } catch (error) {
        controller.abort();
        throw failed(error);
      }
      if (signal.aborted) {
        controller.abort();
        throw aborted();
      }
      const session: Pending = {
        controller,
        authorization: started.authorization,
        timer: setTimeout(() => cancelSession(session), resolved.timeoutMs),
        finishing: false,
      };
      session.timer.unref?.();
      pending = session;
      return { url: started.url };
    },
    finish: async (signal, store) => {
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
      const onAbort = (): void => cancelSession(session);
      signal.addEventListener('abort', onAbort, { once: true });
      let authorization: string;
      try {
        authorization = await session.authorization;
      } catch (error) {
        if (signal.aborted || session.controller.signal.aborted) {
          throw aborted();
        }
        throw failed(error);
      } finally {
        signal.removeEventListener('abort', onAbort);
        clearTimeout(session.timer);
        if (pending === session) pending = undefined;
      }
      // A cancel that arrived with the callback still stores nothing.
      if (signal.aborted) throw aborted();
      return store(authorization);
    },
    cancel: () => {
      if (pending !== undefined) cancelSession(pending);
    },
  };
};
