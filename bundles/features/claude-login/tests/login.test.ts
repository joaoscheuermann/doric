// The host flow of `claude.login/v1`: `start()` binds Claude Code's loopback
// callback and answers the authorization URL without opening any browser;
// `finish()` waits for the browser's callback, stores the authorization and
// answers the public credential view, never the secret. A cancelled or
// replaced sign-in answers `claude_login_aborted` and stores nothing, and
// the callback server never outlives its sign-in.
//
// The OAuth client and the callback server are the real ones on a free
// port; only the token endpoint is faked, so a test "is the browser" by
// requesting the redirect URI the authorization URL names.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isContractError } from 'bundle/contracts';
import {
  createLocalCallbackServer,
  type LocalCallbackServerOptions,
  type OAuthHttpRequest,
  type OAuthTransport,
} from 'oauth';

import {
  CLAUDE_CREDENTIAL_NAME,
  type ClaudeLoginDeps,
} from '../src/host/login.js';
import { loginWorld } from './support/world.js';

/** Whether a rejection carries one contract refusal code; never `instanceof`. */
const refusal =
  (code: string) =>
  (error: unknown): boolean =>
    isContractError(error) && error.code === code;

/** A token endpoint that answers every exchange with the given access token. */
const tokenEndpoint = (
  accessToken: string,
  exchanges: OAuthHttpRequest[] = [],
): (() => OAuthTransport) => {
  return () => ({
    request: async (request) => {
      exchanges.push(request);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh',
          token_type: 'Bearer',
          expires_in: 31536000,
        }),
      };
    },
  });
};

/** The real callback server on a free port, recording the options asked for. */
const freePort =
  (asked: LocalCallbackServerOptions[] = []): ClaudeLoginDeps['createServer'] =>
  (options) => {
    asked.push(options);
    return createLocalCallbackServer({ ...options, port: 0 });
  };

/** What the browser does once the user approves: request the redirect URI. */
const approve = async (
  authorizeUrl: string,
  answer: Readonly<Record<string, string>> = { code: 'code-1' },
): Promise<number> => {
  const url = new URL(authorizeUrl);
  const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
  callback.searchParams.set('state', url.searchParams.get('state') ?? '');
  for (const [key, value] of Object.entries(answer)) {
    callback.searchParams.set(key, value);
  }
  return (await fetch(callback)).status;
};

/** Whether the redirect URI an authorization URL names still answers. */
const callbackListening = async (authorizeUrl: string): Promise<boolean> => {
  const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri');
  try {
    await fetch(redirect ?? '');
    return true;
  } catch {
    return false;
  }
};

const stored = {
  id: '00000000-0000-4000-8000-90000000001',
  kind: 'API_TOKEN',
  name: CLAUDE_CREDENTIAL_NAME,
  hasSecret: true,
};

describe('claude.login/v1', () => {
  test('a started sign-in answers the authorization URL, and the browser callback stores the login', async () => {
    const asked: LocalCallbackServerOptions[] = [];
    const exchanges: OAuthHttpRequest[] = [];
    const { world, secrets, providers } = await loginWorld({
      createServer: freePort(asked),
      transport: tokenEndpoint('fresh-token', exchanges),
    });

    try {
      const { url } = await providers.start();
      const authorize = new URL(url);

      assert.equal(authorize.origin, 'https://claude.com');
      assert.deepEqual(asked, [
        { host: 'localhost', port: 54545, path: '/callback' },
      ]);
      assert.equal(
        new URL(authorize.searchParams.get('redirect_uri') ?? '').pathname,
        '/callback',
      );

      const finished = providers.finish();
      assert.equal(await approve(url), 200);
      const answered = await finished;

      assert.deepEqual(answered, stored);
      assert.equal('secret' in answered, false);
      assert.equal(exchanges.length, 1);
      assert.equal(JSON.parse(exchanges[0]?.body ?? '{}').code, 'code-1');
      assert.deepEqual(secrets.created, [
        {
          kind: 'API_TOKEN',
          name: CLAUDE_CREDENTIAL_NAME,
          secret: 'Bearer fresh-token',
        },
      ]);
      assert.equal(await callbackListening(url), false);
    } finally {
      await world.dispose();
    }
  });

  test('a second sign-in replaces the secret of the stored Claude credential', async () => {
    let issued = 0;
    const { world, secrets, providers } = await loginWorld({
      createServer: freePort(),
      transport: () => {
        issued += 1;
        return tokenEndpoint(`token-${issued}`)();
      },
    });

    try {
      for (let round = 0; round < 2; round += 1) {
        const { url } = await providers.start();
        const finished = providers.finish();
        await approve(url);
        assert.deepEqual(await finished, stored);
      }

      assert.deepEqual(secrets.updated, [
        { ref: { id: stored.id }, input: { secret: 'Bearer token-2' } },
      ]);
    } finally {
      await world.dispose();
    }
  });

  test('finishing with no sign-in started answers claude_login_not_started', async () => {
    const { world, providers } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('unused'),
    });

    try {
      await assert.rejects(
        providers.finish(),
        refusal('claude_login_not_started'),
      );
    } finally {
      await world.dispose();
    }
  });

  test('a cancelled finish answers claude_login_aborted, stores nothing and closes the callback', async () => {
    const controller = new AbortController();
    const { world, secrets, providers } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('never'),
    });

    try {
      const { url } = await providers.start();
      const finished = providers.finish(
        world.call(undefined, controller.signal),
      );
      controller.abort();

      await assert.rejects(finished, refusal('claude_login_aborted'));
      assert.equal(await callbackListening(url), false);
      assert.deepEqual(secrets.created, []);
      await assert.rejects(
        providers.finish(),
        refusal('claude_login_not_started'),
      );
    } finally {
      await world.dispose();
    }
  });

  test('a new start replaces the waiting sign-in, whose finish answers claude_login_aborted', async () => {
    const { world, secrets, providers } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('second'),
    });

    try {
      const first = await providers.start();
      // Asserted from the start: it rejects while the second start runs.
      const abandoned = assert.rejects(
        providers.finish(),
        refusal('claude_login_aborted'),
      );
      const second = await providers.start();

      await abandoned;
      assert.equal(await callbackListening(first.url), false);

      const finished = providers.finish();
      await approve(second.url);
      assert.deepEqual(await finished, stored);
      assert.equal(secrets.created.length, 1);
    } finally {
      await world.dispose();
    }
  });

  test('a refused authorization answers claude_login_failed and stores nothing', async () => {
    const { world, secrets, providers } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('never'),
    });

    try {
      const { url } = await providers.start();
      const finished = assert.rejects(
        providers.finish(),
        refusal('claude_login_failed'),
      );
      await approve(url, { error: 'access_denied' });

      await finished;
      assert.deepEqual(secrets.created, []);
    } finally {
      await world.dispose();
    }
  });

  test('a second finish while one waits answers claude_login_busy', async () => {
    const { world, providers } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('once'),
    });

    try {
      const { url } = await providers.start();
      const finished = providers.finish();

      await assert.rejects(providers.finish(), refusal('claude_login_busy'));
      await approve(url);
      assert.deepEqual(await finished, stored);
    } finally {
      await world.dispose();
    }
  });

  test('falls back to the spare port when the default one is in use', async () => {
    const asked: LocalCallbackServerOptions[] = [];
    const { world, providers } = await loginWorld({
      createServer: async (options) => {
        asked.push(options);
        if (options.port === 54545) {
          throw Object.assign(new Error('listen EADDRINUSE'), {
            code: 'EADDRINUSE',
          });
        }
        return createLocalCallbackServer({ ...options, port: 0 });
      },
      transport: tokenEndpoint('spare'),
    });

    try {
      const { url } = await providers.start();

      assert.deepEqual(
        asked.map((options) => options.port),
        [54545, 54546],
      );
      const finished = providers.finish();
      await approve(url);
      assert.deepEqual(await finished, stored);
    } finally {
      await world.dispose();
    }
  });

  test('a sign-in nobody finishes in time is cancelled and closes its callback', async () => {
    const { world, providers } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('late'),
      timeoutMs: 20,
    });

    try {
      const { url } = await providers.start();
      const finished = providers.finish();

      await assert.rejects(finished, refusal('claude_login_aborted'));
      assert.equal(await callbackListening(url), false);
    } finally {
      await world.dispose();
    }
  });

  test('deactivating the bundle closes a waiting sign-in', async () => {
    const { world, providers, deactivate } = await loginWorld({
      createServer: freePort(),
      transport: tokenEndpoint('gone'),
    });

    try {
      const { url } = await providers.start();
      await deactivate();

      // The server closes as the aborted authorization unwinds.
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(await callbackListening(url), false);
    } finally {
      await world.dispose();
    }
  });
});
