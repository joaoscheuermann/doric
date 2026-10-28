import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import test from 'node:test';

import {
  type BrowserSpawn,
  createLocalCallbackServer,
  OAuthErrorObject,
  openBrowser,
} from '../src/index.js';

void test('parses local OAuth callback paths and query parameters', async () => {
  const server = await createLocalCallbackServer({ path: '/oauth/callback' });

  try {
    const waiting = server.waitForCallback('state-123');

    const response = await fetch(
      `${server.redirectUri}?code=code-123&state=state-123`,
    );
    const callback = await waiting;

    assert.equal(response.status, 200);

    assert.equal(callback.code, 'code-123');

    assert.equal(callback.state, 'state-123');
  } finally {
    await server.close();
  }
});

void test('passes the redirect iss parameter through to the callback', async () => {
  const server = await createLocalCallbackServer({ path: '/oauth/callback' });

  try {
    const waiting = server.waitForCallback('state-123');

    const response = await fetch(
      `${server.redirectUri}?code=code-123&state=state-123&iss=${encodeURIComponent('https://as.example')}`,
    );
    const callback = await waiting;

    assert.equal(response.status, 200);

    assert.equal(callback.code, 'code-123');

    assert.equal(callback.iss, 'https://as.example');
  } finally {
    await server.close();
  }
});

void test('closes local OAuth callback connections after a completed callback', async () => {
  const server = await createLocalCallbackServer({ path: '/oauth/callback' });
  const agent = new Agent({ keepAlive: true });

  try {
    const waiting = server.waitForCallback('state-123');

    const response = await requestCallback(
      `${server.redirectUri}?code=code-123&state=state-123`,
      agent,
    );

    assert.equal(response.status, 200);

    assert.equal(response.connection, 'close');

    await waiting;

    await withTimeout(server.close(), 1_000);
  } finally {
    agent.destroy();

    await server.close().catch(() => undefined);
  }
});

void test('refuses a callback with a foreign state and keeps the sign-in waiting', async () => {
  const server = await createLocalCallbackServer();
  const waiting = server.waitForCallback('state-123');
  let settled = false;
  void waiting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  try {
    // A stray or hostile request: no state, a wrong one, an error with a
    // wrong state. None of them may end the sign-in.
    for (const query of [
      '?code=evil',
      '?code=evil&state=other',
      '?error=access_denied&state=other',
    ]) {
      const refused = await fetch(`${server.redirectUri}${query}`);
      assert.equal(refused.status, 400, query);
    }
    await new Promise((done) => setImmediate(done));
    assert.equal(settled, false);

    const answered = await fetch(
      `${server.redirectUri}?code=code-123&state=state-123`,
    );
    assert.equal(answered.status, 200);
    assert.equal((await waiting).code, 'code-123');
  } finally {
    await server.close();
  }
});

void test('settles the wait with an error the authorization server sent under the pending state', async () => {
  const server = await createLocalCallbackServer();
  const waiting = server.waitForCallback('state-123');

  try {
    const response = await fetch(
      `${server.redirectUri}?error=access_denied&state=state-123`,
    );

    assert.equal(response.status, 400);
    assert.equal((await waiting).error, 'access_denied');
  } finally {
    await server.close();
  }
});

void test('rejects pending local OAuth callbacks when the server closes', async () => {
  const server = await createLocalCallbackServer();
  const waiting = server.waitForCallback('state-123');

  await server.close();

  await assert.rejects(waiting, hasCode('oauth_callback_server_closed'));
});

void test('rejects pending local OAuth callbacks when the signal aborts', async () => {
  const server = await createLocalCallbackServer();
  const controller = new AbortController();
  const waiting = server.waitForCallback('state-123', controller.signal);

  controller.abort();

  try {
    await assert.rejects(waiting, hasCode('oauth_callback_aborted'));
  } finally {
    await server.close();
  }
});

void test('selects browser opener commands by platform', async () => {
  const url = 'https://example.test/callback?code=abc&state=xyz';
  const calls: { command: string; args: readonly string[] }[] = [];

  const spawn: BrowserSpawn = (command, args) => {
    calls.push({ command, args });

    return {
      unref() {
        return undefined;
      },
    };
  };

  await openBrowser(url, { platform: 'win32', spawn });

  await openBrowser(url, { platform: 'darwin', spawn });

  await openBrowser(url, { platform: 'linux', spawn });

  assert.deepEqual(calls, [
    {
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    },
    { command: 'open', args: [url] },
    { command: 'xdg-open', args: [url] },
  ]);
});

void test('answers a missing browser opener as oauth_browser_unavailable instead of an unhandled error', async () => {
  // A headless host has no `xdg-open`: the real spawn reports ENOENT as an
  // `error` event, which ends the process when nothing listens for it.
  const spawn: BrowserSpawn = (_command, args, options) =>
    nodeSpawn('doric-test-missing-browser-opener', [...args], options);

  await assert.rejects(
    openBrowser('https://example.test/authorize', { platform: 'linux', spawn }),
    hasCode('oauth_browser_unavailable'),
  );
});

void test('answers a spawn that throws as oauth_browser_unavailable', async () => {
  const spawn: BrowserSpawn = () => {
    throw new Error('spawn refused');
  };

  await assert.rejects(
    openBrowser('https://example.test/authorize', { platform: 'linux', spawn }),
    hasCode('oauth_browser_unavailable'),
  );
});

const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof OAuthErrorObject && error.data.code === code;

const requestCallback = (
  url: string,
  agent: Agent,
): Promise<{
  readonly status: number | undefined;
  readonly connection: string | undefined;
}> =>
  new Promise((resolve, reject) => {
    const callback = request(url, { agent }, (response) => {
      response.resume();

      response.on('end', () => {
        resolve({
          status: response.statusCode,
          connection: response.headers.connection,
        });
      });
    });

    callback.on('error', reject);

    callback.end();
  });

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms.`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};
