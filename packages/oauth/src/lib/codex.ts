import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OAuthErrorObject } from './classes/oauth-error.js';
import { CODEX_OAUTH_CLIENT_ID, codexOAuthProfile } from './codex-oauth.js';
import { createFetchTransport, type OAuthTransport } from './http.js';
import { asRecord, diagnosticExcerpt, stringField } from './utils/json.js';
import { parseTokenClaims } from './utils/jwt.js';

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type CodexCredential = {
  readonly source: 'codex';
  readonly kind: 'api-key' | 'chatgpt' | 'personal-access-token';
  readonly token: string;
  readonly authorization: string;
  readonly accountId?: string;
  readonly fedramp?: boolean;
};

export type ResolveCodexAuthOptions = {
  readonly codexHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly transport?: OAuthTransport;
  readonly signal?: AbortSignal;
};

type CodexAuthJson = {
  readonly auth_mode?: string;
  readonly OPENAI_API_KEY?: string;
  readonly tokens?: CodexTokenData;
  readonly last_refresh?: string;
  readonly personal_access_token?: string;
  readonly agent_identity?: unknown;
};

type CodexTokenData = {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly account_id?: string;
};

type RefreshResponse = {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
};

/** Resolves credentials from Codex CLI-compatible env and auth.json state. */
export const resolveCodexAuth = async (
  options: ResolveCodexAuthOptions = {},
): Promise<CodexCredential> => {
  const env = options.env ?? process.env;
  const authorization = clean(env['CODEX_AUTHORIZATION']);

  if (authorization !== undefined) {
    return codexCredentialFromToken(authorization);
  }

  const apiKey = clean(env['CODEX_API_KEY']);

  if (apiKey !== undefined) {
    return apiKeyCredential(apiKey);
  }

  const accessToken = clean(env['CODEX_ACCESS_TOKEN']);

  if (accessToken !== undefined) {
    return accessToken.startsWith('at-')
      ? personalAccessTokenCredential(accessToken)
      : error(
          'codex_agent_identity_unsupported',
          'CODEX_ACCESS_TOKEN contains an agent identity JWT, which requires Codex request signing and cannot be used as a plain OpenAI bearer token.',
        );
  }

  const authPath = join(codexHome(options, env), 'auth.json');
  const auth = await readAuthJson(authPath);

  if (auth === undefined) {
    return error(
      'codex_auth_missing',
      `Codex auth.json was not found at ${authPath}.`,
    );
  }

  return credentialFromAuthJson(auth, {
    ...options,
    authPath,
    transport: options.transport ?? createFetchTransport(),
    now: options.now ?? Date.now,
  });
};

export const codexCredentialFromToken = (value: string): CodexCredential => {
  const authorization = clean(value);

  if (authorization === undefined) {
    return error('codex_auth_missing', 'Codex authorization value is empty.');
  }

  const token = bearerToken(authorization);

  return token.startsWith('at-')
    ? personalAccessTokenCredential(token)
    : chatGptCredential({ access_token: token });
};

const credentialFromAuthJson = async (
  auth: CodexAuthJson,
  options: ResolveCodexAuthOptions & {
    readonly authPath: string;
    readonly transport: OAuthTransport;
    readonly now: () => number;
  },
): Promise<CodexCredential> => {
  const mode = normalizeMode(auth.auth_mode ?? resolvedMode(auth));

  if (mode === 'apikey') {
    const apiKey = clean(auth.OPENAI_API_KEY);

    return apiKey === undefined
      ? error(
          'codex_api_key_missing',
          'Codex auth.json selected API key auth but did not include OPENAI_API_KEY.',
        )
      : apiKeyCredential(apiKey);
  }

  if (mode === 'personalaccesstoken') {
    const token = clean(auth.personal_access_token);

    return token === undefined
      ? error(
          'codex_personal_access_token_missing',
          'Codex auth.json selected personal access token auth but did not include a token.',
        )
      : personalAccessTokenCredential(token);
  }

  if (mode === 'agentidentity') {
    return error(
      'codex_agent_identity_unsupported',
      'Codex auth.json uses agent identity auth, which requires Codex request signing and cannot be used as a plain OpenAI bearer token.',
    );
  }

  if (mode !== 'chatgpt' && mode !== 'chatgptauthtokens') {
    return error(
      'codex_auth_mode_unsupported',
      `Unsupported Codex auth mode "${auth.auth_mode ?? mode}".`,
    );
  }

  const tokens = auth.tokens;

  if (tokens?.access_token === undefined) {
    return error(
      'codex_chatgpt_token_missing',
      'Codex auth.json did not include a ChatGPT access token.',
    );
  }

  const nextTokens =
    shouldRefresh(tokens, options.now(), DEFAULT_REFRESH_SKEW_MS) &&
    tokens.refresh_token !== undefined
      ? await refreshChatGptToken(auth, options)
      : tokens;

  return chatGptCredential(nextTokens);
};

const refreshChatGptToken = async (
  auth: CodexAuthJson,
  options: ResolveCodexAuthOptions & {
    readonly authPath: string;
    readonly transport: OAuthTransport;
    readonly now?: () => number;
  },
): Promise<CodexTokenData> => {
  const refreshToken = auth.tokens?.refresh_token;

  if (refreshToken === undefined) {
    return error(
      'codex_refresh_token_missing',
      'Codex ChatGPT access token is expiring and no refresh token is available.',
    );
  }

  const response = await options.transport.request({
    method: 'POST',
    url: codexOAuthProfile.tokenEndpoint,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: options.signal,
  });

  if (response.status >= 400) {
    return error(
      'codex_refresh_failed',
      'Codex ChatGPT token refresh failed.',
      {
        status: response.status,
        diagnostic: diagnosticExcerpt(response.body),
      },
    );
  }

  const refreshed = parseRefreshResponse(response.body);

  const nextAuth = {
    ...auth,
    tokens: {
      ...auth.tokens,
      ...(refreshed.id_token === undefined
        ? {}
        : { id_token: refreshed.id_token }),
      ...(refreshed.access_token === undefined
        ? {}
        : { access_token: refreshed.access_token }),
      ...(refreshed.refresh_token === undefined
        ? {}
        : { refresh_token: refreshed.refresh_token }),
    },
    last_refresh: new Date(options.now?.() ?? Date.now()).toISOString(),
  };

  await writeFile(options.authPath, `${JSON.stringify(nextAuth, null, 2)}\n`, {
    mode: 0o600,
  });

  return nextAuth.tokens;
};

const parseRefreshResponse = (body: string): RefreshResponse => {
  let parsed: Record<string, unknown> | undefined;

  try {
    parsed = asRecord(JSON.parse(body));
  } catch (cause) {
    return error(
      'codex_refresh_invalid_response',
      'Codex token refresh response was not valid JSON.',
      {
        diagnostic: diagnosticExcerpt(body),
      },
      cause,
    );
  }

  if (parsed === undefined) {
    return error(
      'codex_refresh_invalid_response',
      'Codex token refresh response was not an object.',
      {
        diagnostic: diagnosticExcerpt(body),
      },
    );
  }

  return {
    id_token: stringField(parsed, 'id_token'),
    access_token: stringField(parsed, 'access_token'),
    refresh_token: stringField(parsed, 'refresh_token'),
  };
};

const chatGptCredential = (tokens: CodexTokenData): CodexCredential => {
  const token = clean(tokens.access_token);

  if (token === undefined) {
    return error(
      'codex_chatgpt_token_missing',
      'Codex auth.json did not include a ChatGPT access token.',
    );
  }

  const claims = {
    ...nestedAuthClaims(claimsFromToken(tokens.id_token)),
    ...nestedAuthClaims(claimsFromToken(token)),
  };
  const accountId =
    clean(tokens.account_id) ?? stringClaim(claims, 'chatgpt_account_id');

  return {
    source: 'codex',
    kind: 'chatgpt',
    token,
    authorization: `Bearer ${token}`,
    ...(accountId === undefined ? {} : { accountId }),
    ...(claims.chatgpt_account_is_fedramp === true ? { fedramp: true } : {}),
  };
};

const apiKeyCredential = (token: string): CodexCredential => ({
  source: 'codex',
  kind: 'api-key',
  token,
  authorization: `Bearer ${token}`,
});

const personalAccessTokenCredential = (token: string): CodexCredential => ({
  source: 'codex',
  kind: 'personal-access-token',
  token,
  authorization: `Bearer ${token}`,
});

const shouldRefresh = (
  tokens: CodexTokenData,
  now: number,
  refreshSkewMs: number,
): boolean => {
  const exp = numericClaim(claimsFromToken(tokens.access_token), 'exp');

  return exp !== undefined && exp * 1000 - now <= refreshSkewMs;
};

const claimsFromToken = (
  value: string | undefined,
): Readonly<Record<string, unknown>> | undefined =>
  value === undefined ? undefined : parseTokenClaims(value);

const nestedAuthClaims = (
  claims: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> => {
  const nested = claims?.['https://api.openai.com/auth'];

  return asRecord(nested) ?? {};
};

const numericClaim = (
  claims: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined => {
  const value = claims?.[key];

  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
};

const stringClaim = (
  claims: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = claims[key];

  return typeof value === 'string' ? clean(value) : undefined;
};

const resolvedMode = (auth: CodexAuthJson): string => {
  if (auth.personal_access_token !== undefined) {
    return 'personalaccesstoken';
  }

  if (auth.OPENAI_API_KEY !== undefined) {
    return 'apikey';
  }

  return 'chatgpt';
};

const normalizeMode = (mode: string): string =>
  mode.replaceAll(/[-_]/gu, '').toLowerCase();

const readAuthJson = async (
  path: string,
): Promise<CodexAuthJson | undefined> => {
  try {
    const parsed = asRecord(JSON.parse(await readFile(path, 'utf8')));

    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    return error(
      'codex_auth_read_failed',
      `Failed to read Codex auth.json at ${path}.`,
      {},
      cause,
    );
  }
};

const codexHome = (
  options: ResolveCodexAuthOptions,
  env: Readonly<Record<string, string | undefined>>,
): string =>
  options.codexHome ?? env['CODEX_HOME'] ?? join(homedir(), '.codex');

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

const bearerToken = (value: string): string =>
  value.toLowerCase().startsWith('bearer ')
    ? value.slice('bearer '.length).trimStart()
    : value;

const error = (
  code: string,
  message: string,
  extra: {
    readonly status?: number;
    readonly diagnostic?: string;
  } = {},
  cause?: unknown,
): never => {
  throw new OAuthErrorObject(
    {
      provider: 'openai',
      profile: 'codex',
      code,
      message,
      status: extra.status,
      diagnostic: extra.diagnostic,
    },
    cause === undefined ? undefined : { cause },
  );
};
