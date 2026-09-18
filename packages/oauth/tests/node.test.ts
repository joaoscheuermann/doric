import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import test from 'node:test';

import {
  type BrowserSpawn,
  createLocalCallbackServer,
  OAuthErrorObject,
  openBrowser,
} from '../src/index.js';

test('parses local OAuth callback paths and query parameters', async () => {
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

test('closes local OAuth callback connections after a completed callback', async () => {
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

test('rejects pending local OAuth callbacks when the server closes', async () => {
  const server = await createLocalCallbackServer();
  const waiting = server.waitForCallback('state-123');

  await server.close();

  await assert.rejects(waiting, hasCode('oauth_callback_server_closed'));
});

test('rejects pending local OAuth callbacks when the signal aborts', async () => {
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

test('selects browser opener commands by platform', async () => {
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
