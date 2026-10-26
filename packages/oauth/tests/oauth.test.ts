import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLAUDE_OAUTH_CALLBACK_HOST,
  CLAUDE_OAUTH_CALLBACK_PATH,
  CLAUDE_OAUTH_CALLBACK_PORT,
  CLAUDE_OAUTH_CLIENT_ID,
  CODEX_OAUTH_CALLBACK_PATH,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ORIGINATOR,
  claudeOAuthProfile,
  codexOAuthProfile,
  createClaudeOAuth,
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
  resolveClaudeAuth,
  resolveCodexAuth,
} from '../src/index.js';

void test('builds PKCE authorization URL and exchanges callback code', async () => {
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

void test('rejects OAuth callback state mismatch before token exchange', async () => {
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

void test('rejects OAuth callback provider errors', async () => {
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

void test('rejects invalid OAuth token responses', async () => {
  await assert.rejects(
    authWithResponse(response('not-json')).authorize(),
    hasCode('oauth_invalid_token_response'),
  );

  await assert.rejects(
    authWithResponse(response({ refresh_token: 'refresh-only' })).authorize(),
    hasCode('oauth_invalid_token_response'),
  );
});

void test('refreshes OAuth credentials before use when expiry is inside skew', async () => {
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

void test('forces OAuth refresh even when stored credentials are not expiring', async () => {
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

void test('rejects OAuth refresh when the stored credential lacks a refresh token', async () => {
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

void test('parses JWT claims and renders OAuth credentials', async () => {
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

void test('uses Codex OAuth profile defaults', async () => {
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

void test('resolves Codex ChatGPT auth from auth.json with account headers', async () => {
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

void test('resolves Codex authorization header from env', async () => {
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

void test('refreshes expiring Codex ChatGPT auth.json tokens with Codex client id', async () => {
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
    const requestBody = JSON.parse(
      transport.requests[0]?.body ?? '{}',
    ) as Record<string, unknown>;
    const saved = JSON.parse(
      await readFile(join(dir, 'auth.json'), 'utf8'),
    ) as { tokens: Record<string, unknown> };

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

void test('exchanges and refreshes with JSON token bodies when the profile asks for them', async () => {
  let opened = '';

  const jsonProfile: OAuthProfile = {
    provider: 'test-provider',
    profile: 'json',
    authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
    tokenEndpoint: 'https://auth.example.test/oauth/token',
    defaultScope: 'openid email',
    defaultTokenScheme: 'Bearer',
    tokenRequest: 'json',
    tokenExchangeParams: { expires_in: 999 },
  };

  const transport = fakeTransport({
    responses: [
      response({
        access_token: 'json.token.value',
        refresh_token: 'json-refresh',
        token_type: 'Bearer',
      }),
      response({
        access_token: 'refreshed.token.value',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
      }),
    ],
  });

  const client = createOAuthClient({
    profile: jsonProfile,
    transport,
    tokenStore: memoryStore(),
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
  });

  await client.authorize();

  const authUrl = new URL(opened);
  const exchangeBody = JSON.parse(
    transport.requests[0]?.body ?? '{}',
  ) as Record<string, unknown>;

  assert.equal(
    transport.requests[0]?.headers?.['content-type'],
    'application/json',
  );

  assert.equal(exchangeBody.grant_type, 'authorization_code');

  assert.equal(exchangeBody.code, 'code-123');

  assert.equal(exchangeBody.redirect_uri, 'http://127.0.0.1/callback');

  assert.equal(exchangeBody.client_id, 'client');

  assert.equal(exchangeBody.expires_in, 999);

  assert.equal(typeof exchangeBody.code_verifier, 'string');

  assert.equal(exchangeBody.state, authUrl.searchParams.get('state'));

  // The state is 32 random bytes, base64url: the length Claude Code sends.
  assert.equal(authUrl.searchParams.get('state')?.length, 43);

  await client.refresh();

  const refreshBody = JSON.parse(transport.requests[1]?.body ?? '{}') as Record<
    string,
    unknown
  >;

  assert.deepEqual(refreshBody, {
    grant_type: 'refresh_token',
    refresh_token: 'json-refresh',
    client_id: 'client',
  });
});

void test('keeps urlencoded form token bodies free of state', async () => {
  const transport = fakeTransport({
    responses: [response({ access_token: 'form.token.value' })],
  });

  await createOAuthClient({
    profile: testProfile,
    transport,
    tokenStore: memoryStore(),
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
  }).authorize();

  const body = new URLSearchParams(transport.requests[0]?.body);

  assert.equal(
    transport.requests[0]?.headers?.['content-type'],
    'application/x-www-form-urlencoded',
  );

  assert.equal(body.get('state'), null);
});

void test('uses Claude OAuth profile defaults', async () => {
  let opened = '';

  const transport = fakeTransport({
    responses: [
      response({
        access_token: 'claude.token.value',
        refresh_token: 'claude-refresh',
        token_type: 'Bearer',
      }),
    ],
  });

  const client = createClaudeOAuth({
    transport,
    tokenStore: memoryStore(),
    redirectUri: `http://${CLAUDE_OAUTH_CALLBACK_HOST}:${CLAUDE_OAUTH_CALLBACK_PORT}${CLAUDE_OAUTH_CALLBACK_PATH}`,
    browserOpener(url: string) {
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
  const body = JSON.parse(transport.requests[0]?.body ?? '{}') as Record<
    string,
    unknown
  >;

  assert.deepEqual(client.profile, claudeOAuthProfile);

  assert.equal(
    url.origin + url.pathname,
    claudeOAuthProfile.authorizationEndpoint,
  );

  assert.equal(url.searchParams.get('client_id'), CLAUDE_OAUTH_CLIENT_ID);

  assert.equal(url.searchParams.get('scope'), 'user:inference');

  assert.equal(url.searchParams.get('code'), 'true');

  assert.equal(
    url.searchParams.get('redirect_uri'),
    `http://${CLAUDE_OAUTH_CALLBACK_HOST}:${CLAUDE_OAUTH_CALLBACK_PORT}${CLAUDE_OAUTH_CALLBACK_PATH}`,
  );

  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  assert.equal(
    url.searchParams.get('code_challenge'),
    pkceChallenge(String(body.code_verifier)),
  );

  assert.equal(
    transport.requests[0]?.url,
    'https://platform.claude.com/v1/oauth/token',
  );

  assert.equal(
    transport.requests[0]?.headers?.['content-type'],
    'application/json',
  );

  assert.equal(body.grant_type, 'authorization_code');

  assert.equal(body.expires_in, 31536000);

  const credential = await client.credential();

  assert.equal(credential.authorization, 'Bearer claude.token.value');
});

void test('resolves Claude authorization from env', async () => {
  const bearer = await resolveClaudeAuth({
    env: { CLAUDE_AUTHORIZATION: 'Bearer abc' },
  });

  assert.equal(bearer.source, 'claude');

  assert.equal(bearer.kind, 'authorization');

  assert.equal(bearer.token, 'abc');

  assert.equal(bearer.authorization, 'Bearer abc');

  const bare = await resolveClaudeAuth({
    env: { CLAUDE_AUTHORIZATION: 'abc' },
  });

  assert.equal(bare.kind, 'authorization');

  assert.equal(bare.token, 'abc');

  assert.equal(bare.authorization, 'Bearer abc');
});

void test('resolves a bare Claude Code override token from CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const credential = await resolveClaudeAuth({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'override-token' },
  });

  assert.equal(credential.source, 'claude');

  assert.equal(credential.kind, 'oauth');

  assert.equal(credential.token, 'override-token');

  assert.equal(credential.authorization, 'Bearer override-token');
});

void test('reads a fresh Claude Code login from credentials.json', async () => {
  await withTempDir(async (dir) => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    await writeClaudeCredentials(dir, {
      claudeAiOauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
      },
    });

    const transport = fakeTransport({ responses: [] });

    const credential = await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport,
    });

    assert.equal(credential.source, 'claude');

    assert.equal(credential.kind, 'oauth');

    assert.equal(credential.token, 'claude-access');

    assert.equal(credential.authorization, 'Bearer claude-access');

    assert.deepEqual(credential.scopes, ['user:inference']);

    assert.equal(credential.subscriptionType, 'pro');

    assert.equal(credential.expiresAt, Date.parse(expiresAt));

    assert.equal(transport.requests.length, 0);
  });
});

void test('refreshes an expiring Claude login and writes the rotated token back', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt: 1_060_000,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
      },
    });

    const transport = fakeTransport({
      responses: [
        response({
          access_token: 'next',
          refresh_token: 'rotated',
          expires_in: 3600,
          scope: 'user:inference',
        }),
      ],
    });

    const credential = await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport,
    });
    const requestBody = JSON.parse(
      transport.requests[0]?.body ?? '{}',
    ) as Record<string, unknown>;
    const saved = JSON.parse(
      await readFile(join(dir, '.credentials.json'), 'utf8'),
    ) as {
      claudeAiOauth: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    };

    assert.equal(
      transport.requests[0]?.url,
      'https://platform.claude.com/v1/oauth/token',
    );

    assert.equal(
      transport.requests[0]?.headers?.['content-type'],
      'application/json',
    );

    assert.deepEqual(requestBody, {
      grant_type: 'refresh_token',
      refresh_token: 'claude-refresh',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });

    assert.equal(saved.claudeAiOauth.accessToken, 'next');

    assert.equal(saved.claudeAiOauth.refreshToken, 'rotated');

    assert.equal(saved.claudeAiOauth.expiresAt, 4_600_000);

    assert.equal(credential.token, 'next');

    assert.equal(credential.authorization, 'Bearer next');

    assert.deepEqual(credential.scopes, ['user:inference']);
  });
});

void test('refuses an expired Claude login that cannot be refreshed', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: { accessToken: 'claude-expired', expiresAt: 999_000 },
    });
    const transport = fakeTransport({});

    await assert.rejects(
      resolveClaudeAuth({
        claudeHome: dir,
        env: {},
        now: () => 1_000_000,
        transport,
      }),
      hasCode('claude_refresh_token_missing'),
    );
    assert.equal(transport.requests.length, 0);
  });
});

void test('answers a still-valid Claude login inside the refresh window when it cannot be refreshed', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: { accessToken: 'claude-soon', expiresAt: 1_060_000 },
    });

    const credential = await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport: fakeTransport({}),
    });

    assert.equal(credential.authorization, 'Bearer claude-soon');
  });
});

void test('keeps what Claude Code wrote during a refresh and replaces the file whole', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt: 1_060_000,
      },
    });
    const transport = {
      async request() {
        // Claude Code writes the file while the refresh is in flight.
        await writeClaudeCredentials(dir, {
          claudeAiOauth: {
            accessToken: 'claude-access',
            refreshToken: 'claude-refresh',
            expiresAt: 1_060_000,
          },
          mcpOAuth: { server: 'kept' },
        });
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: 'next',
            refresh_token: 'rotated',
            expires_in: 3600,
          }),
        };
      },
    };

    await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport,
    });

    const path = join(dir, '.credentials.json');
    const saved = JSON.parse(await readFile(path, 'utf8')) as {
      claudeAiOauth: { accessToken?: string };
      mcpOAuth?: unknown;
    };

    assert.equal(saved.claudeAiOauth.accessToken, 'next');
    assert.deepEqual(saved.mcpOAuth, { server: 'kept' });
    assert.deepEqual(await readdir(dir), ['.credentials.json']);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

void test('reads an expiring Claude login as it is when asked not to refresh', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt: 1_060_000,
      },
    });
    const transport = fakeTransport({});

    const credential = await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport,
      refresh: false,
    });

    assert.equal(credential.authorization, 'Bearer claude-access');
    assert.equal(credential.expiresAt, 1_060_000);
    assert.equal(transport.requests.length, 0);
  });
});

void test("reads Claude Code's Keychain login before the file, and never refreshes it", async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: { accessToken: 'file-access', expiresAt: 9_000_000 },
    });
    const transport = fakeTransport({});

    const credential = await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport,
      keychain: async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'keychain-access',
            refreshToken: 'keychain-refresh',
            expiresAt: 1_060_000,
          },
        }),
    });

    assert.equal(credential.authorization, 'Bearer keychain-access');
    assert.equal(transport.requests.length, 0);
  });
});

void test('refuses an expired Keychain login with a stable code', async () => {
  await assert.rejects(
    resolveClaudeAuth({
      env: {},
      now: () => 1_000_000,
      transport: fakeTransport({}),
      keychain: async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'keychain-access',
            refreshToken: 'keychain-refresh',
            expiresAt: 999_000,
          },
        }),
    }),
    hasCode('claude_keychain_login_expired'),
  );
});

void test('falls back to the credentials file when the Keychain has no login', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: { accessToken: 'file-access', expiresAt: 9_000_000 },
    });

    const credential = await resolveClaudeAuth({
      claudeHome: dir,
      env: {},
      now: () => 1_000_000,
      transport: fakeTransport({}),
      keychain: async () => undefined,
    });

    assert.equal(credential.authorization, 'Bearer file-access');
  });
});

void test('fails with a stable code when the Claude credentials are missing', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      resolveClaudeAuth({
        claudeHome: dir,
        env: {},
        transport: fakeTransport({}),
      }),
      hasCode('claude_credentials_missing'),
    );
  });
});

void test('fails with a stable code when the stored login has no access token', async () => {
  await withTempDir(async (dir) => {
    await writeClaudeCredentials(dir, {
      claudeAiOauth: {
        refreshToken: 'claude-refresh',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    });

    await assert.rejects(
      resolveClaudeAuth({
        claudeHome: dir,
        env: {},
        now: () => 1_000_000,
        transport: fakeTransport({}),
      }),
      hasCode('claude_access_token_missing'),
    );
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

const writeClaudeCredentials = async (
  dir: string,
  credentials: Record<string, unknown>,
): Promise<void> => {
  await writeFile(
    join(dir, '.credentials.json'),
    `${JSON.stringify(credentials, null, 2)}\n`,
  );
};

const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof OAuthErrorObject && error.data.code === code;
