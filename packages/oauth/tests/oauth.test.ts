import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CODEX_OAUTH_CALLBACK_PATH,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ORIGINATOR,
  codexOAuthProfile,
  createCodexOAuth,
  createOAuthClient,
  type OAuthCallbackServer,
  OAuthErrorObject,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type OAuthProfile,
  type OAuthTokenRecord,
  type OAuthTokenStore,
  type OAuthTransport,
  resolveCodexAuth,
} from '../src/index.js';

test('builds PKCE authorization URL and exchanges callback code', async () => {
  let opened = '';
  const saved: OAuthTokenRecord[] = [];
  const store = memoryStore();

  const transport = fakeTransport({
    responses: [
      response({
        access_token: 'new.token.value',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email',
      }),
    ],
  });

  store.onSave = (record) => saved.push(record);

  const record = await createOAuthClient({
    profile: testProfile,
    transport,
    tokenStore: store,
    clientId: 'client',
    redirectUri: 'http://127.0.0.1/callback',
    browserOpener(url) {
      opened = url;
    },
    callbackServer: callbackServer((expectedState) => ({
      code: 'code-123',
      state: expectedState,
    })),
    random: sequentialRandom(),
    clock: () => 1_000,
  }).authorize();
  const authUrl = new URL(opened);
  const body = new URLSearchParams(transport.requests[0]?.body);
  const verifier = body.get('code_verifier') ?? '';

  assert.equal(
    authUrl.origin + authUrl.pathname,
    testProfile.authorizationEndpoint,
  );

  assert.equal(authUrl.searchParams.get('response_type'), 'code');

  assert.equal(authUrl.searchParams.get('client_id'), 'client');

  assert.equal(
    authUrl.searchParams.get('redirect_uri'),
    'http://127.0.0.1/callback',
  );

  assert.equal(authUrl.searchParams.get('scope'), testProfile.defaultScope);

  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');

  assert.equal(
    authUrl.searchParams.get('code_challenge'),
    pkceChallenge(verifier),
  );

  assert.equal(transport.requests[0]?.url, testProfile.tokenEndpoint);

  assert.equal(body.get('grant_type'), 'authorization_code');

  assert.equal(body.get('code'), 'code-123');

  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1/callback');

  assert.equal(record.accessToken, 'new.token.value');

  assert.equal(record.expiresAt, 3_601_000);

  assert.equal(saved.length, 1);
});

test('rejects OAuth callback state mismatch before token exchange', async () => {
  const transport = fakeTransport({});

  await assert.rejects(
    createOAuthClient({
      profile: testProfile,
      transport,
      tokenStore: memoryStore(),
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      browserOpener() {
        return undefined;
      },
      callbackServer: callbackServer(() => ({
        code: 'code-123',
        state: 'wrong',
      })),
      random: sequentialRandom(),
    }).authorize(),
    hasCode('oauth_state_mismatch'),
  );

  assert.equal(transport.requests.length, 0);
});

test('rejects OAuth callback provider errors', async () => {
  await assert.rejects(
    createOAuthClient({
      profile: testProfile,
      transport: fakeTransport({}),
      tokenStore: memoryStore(),
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      browserOpener() {
        return undefined;
      },
      callbackServer: callbackServer(() => ({
        error: 'access_denied',
        errorDescription: 'Denied by provider.',
      })),
      random: sequentialRandom(),
    }).authorize(),
    hasCode('oauth_callback_error'),
  );
});

test('rejects invalid OAuth token responses', async () => {
  await assert.rejects(
    authWithResponse(response('not-json')).authorize(),
    hasCode('oauth_invalid_token_response'),
  );

  await assert.rejects(
    authWithResponse(response({ refresh_token: 'refresh-only' })).authorize(),
    hasCode('oauth_invalid_token_response'),
  );
});

test('refreshes OAuth credentials before use when expiry is inside skew', async () => {
  const saved: OAuthTokenRecord[] = [];

  const store = memoryStore({
    accessToken: 'old.token.value',
    refreshToken: 'refresh-token',
    expiresAt: 1_050,
  });

  const transport = fakeTransport({
    responses: [
      response({
        access_token: 'new.token.value',
        refresh_token: 'new-refresh',
        expires_in: 10,
        token_type: 'Bearer',
        scope: 'openid',
      }),
    ],
  });

  store.onSave = (record) => saved.push(record);

  const credential = await createOAuthClient({
    profile: testProfile,
    transport,
    tokenStore: store,
    clientId: 'client',
    redirectUri: 'http://127.0.0.1/callback',
    browserOpener() {
      return undefined;
    },
    callbackServer: callbackServer(() => ({ code: 'unused', state: 'unused' })),
    clock: () => 1_000,
    refreshSkewMs: 100,
  }).credential();

  assert.equal(credential.authorization, 'Bearer new.token.value');

  assert.equal(saved[0]?.refreshToken, 'new-refresh');

  assert.equal(saved[0]?.expiresAt, 11_000);
});

test('forces OAuth refresh even when stored credentials are not expiring', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        access_token: 'forced.token.value',
        expires_in: 3600,
      }),
    ],
  });

  const credential = await createOAuthClient({
    profile: testProfile,
    transport,
    tokenStore: memoryStore({
      accessToken: 'current.token.value',
      refreshToken: 'refresh-token',
      expiresAt: 100_000,
    }),
    clientId: 'client',
    redirectUri: 'http://127.0.0.1/callback',
    browserOpener() {
      return undefined;
    },
    callbackServer: callbackServer(() => ({ code: 'unused', state: 'unused' })),
    clock: () => 1_000,
  }).credential({ forceRefresh: true });

  assert.equal(credential.authorization, 'Bearer forced.token.value');

  assert.equal(transport.requests.length, 1);
});

test('rejects OAuth refresh when the stored credential lacks a refresh token', async () => {
  await assert.rejects(
    createOAuthClient({
      profile: testProfile,
      transport: fakeTransport({}),
      tokenStore: memoryStore({
        accessToken: 'current.token.value',
        expiresAt: 1_050,
      }),
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      browserOpener() {
        return undefined;
      },
      callbackServer: callbackServer(() => ({
        code: 'unused',
        state: 'unused',
      })),
      clock: () => 1_000,
      refreshSkewMs: 100,
    }).credential(),
    hasCode('oauth_missing_refresh_token'),
  );
});

test('parses JWT claims and renders OAuth credentials', async () => {
  const accessToken = jwt({ sub: 'user_1', email: 'a@example.com' });
  const store = memoryStore();

  const client = authWithResponse(
    response({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'openid email',
    }),
    store,
  );
  const record = await client.authorize();
  const credential = await client.credential();

  assert.deepEqual(record.claims, { sub: 'user_1', email: 'a@example.com' });

  assert.deepEqual(credential, {
    source: 'oauth',
    scheme: 'Bearer',
    token: accessToken,
    authorization: `Bearer ${accessToken}`,
    expiresAt: undefined,
    scope: 'openid email',
    claims: { sub: 'user_1', email: 'a@example.com' },
  });
});

test('uses Codex OAuth profile defaults', async () => {
  let opened = '';

  const client = createCodexOAuth({
    transport: fakeTransport({
      responses: [response({ access_token: 'openai.token.value' })],
    }),
    tokenStore: memoryStore(),
    redirectUri: `http://localhost:1455${CODEX_OAUTH_CALLBACK_PATH}`,
    browserOpener(url) {
      opened = url;
    },
    callbackServer: callbackServer((expectedState) => ({
      code: 'code-123',
      state: expectedState,
    })),
    random: sequentialRandom(),
  });

  await client.authorize();

  const url = new URL(opened);

  assert.deepEqual(client.profile, codexOAuthProfile);

  assert.equal(
    url.origin + url.pathname,
    codexOAuthProfile.authorizationEndpoint,
  );

  assert.equal(url.searchParams.get('client_id'), CODEX_OAUTH_CLIENT_ID);

  assert.equal(
    url.searchParams.get('scope'),
    'openid profile email offline_access api.connectors.read api.connectors.invoke',
  );

  assert.equal(
    url.searchParams.get('redirect_uri'),
    `http://localhost:1455${CODEX_OAUTH_CALLBACK_PATH}`,
  );

  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');

  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');

  assert.equal(url.searchParams.get('originator'), CODEX_OAUTH_ORIGINATOR);
});

test('resolves Codex ChatGPT auth from auth.json with account headers', async () => {
  await withTempDir(async (dir) => {
    const accessToken = jwt({
      exp: 10_000,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
        chatgpt_account_is_fedramp: true,
      },
    });

    await writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({}),
        access_token: accessToken,
        refresh_token: 'refresh-token',
      },
    });

    const credential = await resolveCodexAuth({
      codexHome: dir,
      env: {},
      now: () => 1_000,
      transport: fakeTransport({}),
    });

    assert.equal(credential.kind, 'chatgpt');

    assert.equal(credential.authorization, `Bearer ${accessToken}`);

    assert.equal(credential.accountId, 'acct_123');

    assert.equal(credential.fedramp, true);
  });
});

test('resolves Codex authorization header from env', async () => {
  const accessToken = jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_env',
    },
  });

  const credential = await resolveCodexAuth({
    env: { CODEX_AUTHORIZATION: `Bearer ${accessToken}` },
    transport: fakeTransport({}),
  });

  assert.equal(credential.authorization, `Bearer ${accessToken}`);

  assert.equal(credential.accountId, 'acct_env');
});

test('refreshes expiring Codex ChatGPT auth.json tokens with Codex client id', async () => {
  await withTempDir(async (dir) => {
    await writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: 1_001 }),
        refresh_token: 'old-refresh',
        account_id: 'acct_existing',
      },
    });

    const transport = fakeTransport({
      responses: [
        response({
          access_token: jwt({ exp: 2_000 }),
          refresh_token: 'new-refresh',
        }),
      ],
    });

    const credential = await resolveCodexAuth({
      codexHome: dir,
      env: {},
      now: () => 1_000_000,
      transport,
    });
    const requestBody = JSON.parse(transport.requests[0]?.body ?? '{}');
    const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));

    assert.equal(
      transport.requests[0]?.url,
      'https://auth.openai.com/oauth/token',
    );

    assert.equal(requestBody.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');

    assert.equal(requestBody.grant_type, 'refresh_token');

    assert.equal(requestBody.refresh_token, 'old-refresh');

    assert.equal(credential.accountId, 'acct_existing');

    assert.equal(saved.tokens.refresh_token, 'new-refresh');

    assert.equal(saved.tokens.access_token, credential.token);
  });
});

type MutableStore = OAuthTokenStore & {
  onSave?: (record: OAuthTokenRecord) => void;
};

type FakeTransport = OAuthTransport & {
  readonly requests: readonly OAuthHttpRequest[];
};

const testProfile: OAuthProfile = {
  provider: 'test-provider',
  profile: 'test',
  authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
  tokenEndpoint: 'https://auth.example.test/oauth/token',
  defaultScope: 'openid email',
  defaultTokenScheme: 'Bearer',
};

const authWithResponse = (
  tokenResponse: OAuthHttpResponse,
  tokenStore = memoryStore(),
): ReturnType<typeof createOAuthClient> =>
  createOAuthClient({
    profile: testProfile,
    transport: fakeTransport({ responses: [tokenResponse] }),
    tokenStore,
    clientId: 'client',
    redirectUri: 'http://127.0.0.1/callback',
    browserOpener() {
      return undefined;
    },
    callbackServer: callbackServer((expectedState) => ({
      code: 'code-123',
      state: expectedState,
    })),
    random: sequentialRandom(),
  });

const memoryStore = (initial?: OAuthTokenRecord): MutableStore => {
  let record = initial;

  return {
    async load() {
      return record;
    },

    async save(next) {
      record = next;

      this.onSave?.(next);
    },
  };
};

const callbackServer = (
  callback: (
    expectedState: string,
  ) => Awaited<ReturnType<OAuthCallbackServer['waitForCallback']>>,
): OAuthCallbackServer => ({
  async waitForCallback(expectedState) {
    return callback(expectedState);
  },
});

const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): OAuthHttpResponse => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const fakeTransport = (options: {
  readonly responses?: readonly OAuthHttpResponse[];
}): FakeTransport => {
  const requests: OAuthHttpRequest[] = [];
  const responses = [...(options.responses ?? [])];

  return {
    requests,

    async request(request: OAuthHttpRequest): Promise<OAuthHttpResponse> {
      requests.push(request);

      const next = responses.shift();

      if (next === undefined) {
        throw new Error('Fake transport response was not configured.');
      }

      return next;
    },
  };
};

const sequentialRandom = () => ({
  bytes(length: number): Uint8Array {
    return new Uint8Array(Array.from({ length }, (_, index) => index + 1));
  },
});

const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest().toString('base64url');

const jwt = (claims: Record<string, unknown>): string =>
  [
    'header',
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.');

const withTempDir = async (
  action: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-oauth-'));

  try {
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const writeCodexAuth = async (
  dir: string,
  auth: Record<string, unknown>,
): Promise<void> => {
  await writeFile(join(dir, 'auth.json'), `${JSON.stringify(auth, null, 2)}\n`);
};

const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof OAuthErrorObject && error.data.code === code;
