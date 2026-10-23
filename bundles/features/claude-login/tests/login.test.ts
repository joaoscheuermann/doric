// The host flow of `claude.login/v1`: a stored Claude authorization is
// reused before any fresh sign-in, a resolve that fails falls through to a
// fresh sign-in on the loopback callback server, an aborted call answers
// `claude_login_aborted` and stores nothing, and one sign-in runs at a time.
// The answer is always the public credential view, never the secret.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isContractError } from 'bundle/contracts';
import type {
  ClaudeCredential,
  CreateClaudeOAuthOptions,
  LocalCallbackServer,
  LocalCallbackServerOptions,
  OAuthBrowserOpener,
  OAuthClient,
  OAuthTokenRecord,
  ResolveClaudeAuthOptions,
} from 'oauth';

import {
  CLAUDE_CREDENTIAL_NAME,
  type ClaudeLoginDeps,
} from '../src/host/login.js';
import { loginWorld } from './support/world.js';

/** A stored Claude login, as `resolveClaudeAuth` answers one. */
const credential = (authorization: string): ClaudeCredential => ({
  source: 'claude',
  kind: 'authorization',
  token: authorization,
  authorization,
});

/** Whether a rejection carries one contract refusal code; never `instanceof`. */
const refusal =
  (code: string) =>
  (error: unknown): boolean =>
    isContractError(error) && error.code === code;

/** One macrotask, so a login's own promises have reached the seam under test. */
const tick = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

/** A promise the test settles from outside. */
const gate = <T>(): {
  readonly promise: Promise<T>;
  readonly answer: (value: T) => void;
} => {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, answer: (value) => resolve?.(value) };
};

/** The authorize options the flow handed the OAuth client, one per call. */
type AskedAuthorize = ({ readonly signal?: AbortSignal } | undefined)[];

/** An OAuth client whose `authorize` the test controls, recording each call. */
const fakeClient = (
  authorize: (options: {
    readonly signal?: AbortSignal;
  }) => Promise<OAuthTokenRecord>,
  authorization: string,
  asked: AskedAuthorize,
): OAuthClient => ({
  profile: {
    provider: 'anthropic',
    profile: 'claude-code',
    authorizationEndpoint: 'https://claude.com/cai/oauth/authorize',
    tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
  },
  authorize: async (options) => {
    asked.push(options);
    return authorize(options ?? {});
  },
  refresh: async () => {
    throw new Error('A fresh sign-in never refreshes.');
  },
  credential: async () => ({
    source: 'oauth' as const,
    scheme: 'Bearer',
    token: authorization,
    authorization,
  }),
});

/** A loopback callback server that records its closes; nothing calls back. */
const callbackServer = (
  redirectUri: string,
  closes: boolean[],
): LocalCallbackServer => ({
  redirectUri,
  waitForCallback: async () => {
    throw new Error('The fake server never receives a callback.');
  },
  close: async () => {
    closes.push(true);
  },
});

/** A browser the flow must never open in these tests. */
const noBrowser: OAuthBrowserOpener = () => {
  throw new Error('No test opens a browser.');
};

describe('claude.login/v1', () => {
  test('reuses a stored Claude authorization without a fresh sign-in', async () => {
    const controller = new AbortController();
    let resolveSignal: AbortSignal | undefined;
    const serverOptions: LocalCallbackServerOptions[] = [];
    const opened: string[] = [];
    const deps: ClaudeLoginDeps = {
      resolveAuth: async (options: ResolveClaudeAuthOptions) => {
        resolveSignal = options.signal;
        return credential('claude-existing');
      },
      createServer: (options: LocalCallbackServerOptions) => {
        serverOptions.push(options);
        throw new Error('A stored login never starts a callback server.');
      },
      browserOpener: (url: string) => {
        opened.push(url);
      },
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      const answered = await providers.login(
        world.call(undefined, controller.signal),
      );

      // The call's own signal reaches the resolver, unchanged.
      assert.equal(resolveSignal, controller.signal);
      assert.deepEqual(answered, {
        id: '00000000-0000-4000-8000-90000000001',
        kind: 'API_TOKEN',
        name: CLAUDE_CREDENTIAL_NAME,
        hasSecret: true,
      });
      assert.equal('secret' in answered, false);
      assert.deepEqual(secrets.created, [
        {
          kind: 'API_TOKEN',
          name: CLAUDE_CREDENTIAL_NAME,
          secret: 'claude-existing',
        },
      ]);
      assert.deepEqual(secrets.updated, []);
      assert.deepEqual(serverOptions, []);
      assert.deepEqual(opened, []);
    } finally {
      await world.dispose();
    }
  });

  test('falls through to a fresh sign-in when no login is stored', async () => {
    const serverOptions: LocalCallbackServerOptions[] = [];
    const closes: boolean[] = [];
    const oauthOptions: CreateClaudeOAuthOptions[] = [];
    const asked: AskedAuthorize = [];
    const deps: ClaudeLoginDeps = {
      resolveAuth: async () => {
        throw new Error('No stored Claude login.');
      },
      createServer: async (options: LocalCallbackServerOptions) => {
        serverOptions.push(options);
        return callbackServer('http://localhost:54545/callback', closes);
      },
      createOAuth: (options: CreateClaudeOAuthOptions) => {
        oauthOptions.push(options);
        return fakeClient(
          async () => ({ accessToken: 'fresh' }),
          'claude-fresh',
          asked,
        );
      },
      browserOpener: noBrowser,
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      const answered = await providers.login();

      assert.deepEqual(serverOptions, [
        { host: 'localhost', port: 54545, path: '/callback' },
      ]);
      assert.equal(oauthOptions.length, 1);
      assert.equal(
        oauthOptions[0]?.redirectUri,
        'http://localhost:54545/callback',
      );
      assert.equal(asked.length, 1);
      assert.equal(secrets.listed, 0);
      assert.deepEqual(secrets.created, [
        {
          kind: 'API_TOKEN',
          name: CLAUDE_CREDENTIAL_NAME,
          secret: 'claude-fresh',
        },
      ]);
      assert.equal(answered.hasSecret, true);
      assert.deepEqual(closes, [true]);
    } finally {
      await world.dispose();
    }
  });

  test('answers the cancellation when the resolve is aborted, storing nothing', async () => {
    const controller = new AbortController();
    const serverOptions: LocalCallbackServerOptions[] = [];
    const deps: ClaudeLoginDeps = {
      resolveAuth: (options: ResolveClaudeAuthOptions) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      createServer: (options: LocalCallbackServerOptions) => {
        serverOptions.push(options);
        throw new Error('An aborted resolve never starts a server.');
      },
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      const login = providers.login(world.call(undefined, controller.signal));
      await tick();
      controller.abort();

      await assert.rejects(login, refusal('claude_login_aborted'));
      assert.deepEqual(secrets.created, []);
      assert.deepEqual(serverOptions, []);
    } finally {
      await world.dispose();
    }
  });

  test('answers the cancellation when the fresh sign-in is aborted, closing the server', async () => {
    const controller = new AbortController();
    const closes: boolean[] = [];
    const asked: AskedAuthorize = [];
    const deps: ClaudeLoginDeps = {
      resolveAuth: async () => {
        throw new Error('No stored Claude login.');
      },
      createServer: async () =>
        callbackServer('http://localhost:54545/callback', closes),
      createOAuth: () =>
        fakeClient(
          (options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => {
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            }),
          'claude-fresh',
          asked,
        ),
      browserOpener: noBrowser,
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      const login = providers.login(world.call(undefined, controller.signal));
      await tick();
      controller.abort();

      await assert.rejects(login, refusal('claude_login_aborted'));
      assert.deepEqual(closes, [true]);
      assert.deepEqual(secrets.created, []);
    } finally {
      await world.dispose();
    }
  });

  test('propagates a fresh sign-in failure that is not an abort', async () => {
    const closes: boolean[] = [];
    const deps: ClaudeLoginDeps = {
      resolveAuth: async () => {
        throw new Error('No stored Claude login.');
      },
      createServer: async () =>
        callbackServer('http://localhost:54545/callback', closes),
      createOAuth: () =>
        fakeClient(
          async () => {
            throw new Error('no browser');
          },
          'claude-fresh',
          [],
        ),
      browserOpener: noBrowser,
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      await assert.rejects(providers.login(), { message: 'no browser' });
      assert.deepEqual(closes, [true]);
      assert.deepEqual(secrets.created, []);
    } finally {
      await world.dispose();
    }
  });

  test('falls back to the spare port when the default one is in use', async () => {
    const serverOptions: LocalCallbackServerOptions[] = [];
    const oauthOptions: CreateClaudeOAuthOptions[] = [];
    const deps: ClaudeLoginDeps = {
      resolveAuth: async () => {
        throw new Error('No stored Claude login.');
      },
      createServer: (options: LocalCallbackServerOptions) => {
        serverOptions.push(options);
        // The caller awaits this seam, so the in-use port surfaces as a
        // refusal thrown here, exactly as the real listener would answer it.
        if (serverOptions.length === 1) {
          throw Object.assign(new Error('address already in use'), {
            code: 'EADDRINUSE',
          });
        }
        return Promise.resolve(
          callbackServer('http://localhost:54546/callback', []),
        );
      },
      createOAuth: (options: CreateClaudeOAuthOptions) => {
        oauthOptions.push(options);
        return fakeClient(
          async () => ({ accessToken: 'fresh' }),
          'claude-fresh',
          [],
        );
      },
      browserOpener: noBrowser,
    };
    const { world, providers } = await loginWorld(deps);

    try {
      await providers.login();

      assert.deepEqual(serverOptions, [
        { host: 'localhost', port: 54545, path: '/callback' },
        { host: 'localhost', port: 54546, path: '/callback' },
      ]);
      assert.equal(oauthOptions.length, 1);
      assert.equal(
        oauthOptions[0]?.redirectUri,
        'http://localhost:54546/callback',
      );
    } finally {
      await world.dispose();
    }
  });

  test('updates the stored credential when a second login finds its name taken', async () => {
    const answers = ['claude-one', 'claude-two'];
    const deps: ClaudeLoginDeps = {
      resolveAuth: async () => credential(answers.shift() ?? 'unanswered'),
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      await providers.login();
      assert.equal(secrets.listed, 0);

      const second = await providers.login();

      // The refused create makes the login read the store and move the
      // secret of the credential the first login stored.
      assert.equal(secrets.listed, 1);
      assert.deepEqual(secrets.updated, [
        {
          ref: { id: '00000000-0000-4000-8000-90000000001' },
          input: { secret: 'claude-two' },
        },
      ]);
      assert.deepEqual(second, {
        id: '00000000-0000-4000-8000-90000000001',
        kind: 'API_TOKEN',
        name: CLAUDE_CREDENTIAL_NAME,
        hasSecret: true,
      });
    } finally {
      await world.dispose();
    }
  });

  test('refuses a second sign-in while the first is still running', async () => {
    const first = gate<string>();
    const deps: ClaudeLoginDeps = {
      resolveAuth: () => first.promise.then(credential),
    };
    const { world, secrets, providers } = await loginWorld(deps);

    try {
      const login = providers.login();
      await tick();
      await assert.rejects(providers.login(), refusal('claude_login_busy'));
      assert.deepEqual(secrets.created, []);

      first.answer('claude-first');
      assert.deepEqual(await login, {
        id: '00000000-0000-4000-8000-90000000001',
        kind: 'API_TOKEN',
        name: CLAUDE_CREDENTIAL_NAME,
        hasSecret: true,
      });

      // The guard is cleared once the first sign-in settles, so a third
      // login runs — and lands on the update path the name it stored holds.
      const third = await providers.login();
      assert.equal(third.hasSecret, true);
      assert.equal(secrets.updated.length, 1);
    } finally {
      await world.dispose();
    }
  });
});
