import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OAuthErrorObject } from './classes/oauth-error.js';
import { CLAUDE_OAUTH_CLIENT_ID, claudeOAuthProfile } from './claude-oauth.js';
import { createFetchTransport, type OAuthTransport } from './http.js';
import {
  asRecord,
  diagnosticExcerpt,
  numberField,
  stringField,
} from './utils/json.js';

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** A credential resolved from Claude Code env or credentials state. */
export interface ClaudeCredential {
  readonly source: 'claude';
  readonly kind: 'authorization' | 'oauth';
  readonly token: string;
  readonly authorization: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  readonly subscriptionType?: string;
}

/** Options that steer how Claude credentials are read and refreshed. */
export interface ResolveClaudeAuthOptions {
  readonly claudeHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly transport?: OAuthTransport;
  readonly signal?: AbortSignal;
}

interface ClaudeAiOauth {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** Expiry the login carries: an ISO-8601 timestamp or an epoch in milliseconds. */
  readonly expiresAt?: string | number;
  readonly scopes?: readonly string[];
  readonly subscriptionType?: string;
}

interface ClaudeCredentialsFile {
  readonly claudeAiOauth?: ClaudeAiOauth;
}

interface RefreshResponse {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
}

/** Resolves credentials from Claude Code-compatible env and credentials state. */
export const resolveClaudeAuth = async (
  options: ResolveClaudeAuthOptions = {},
): Promise<ClaudeCredential> => {
  const env = options.env ?? process.env;
  const authorization = clean(env.CLAUDE_AUTHORIZATION);

  if (authorization !== undefined) {
    return authorizationCredential(authorization);
  }

  const accessToken = clean(env.CLAUDE_CODE_OAUTH_TOKEN);

  if (accessToken !== undefined) {
    return oauthCredential(accessToken);
  }

  const credentialsPath = join(claudeHome(options, env), '.credentials.json');
  const file = await readCredentialsFile(credentialsPath);

  if (file === undefined) {
    return error(
      'claude_credentials_missing',
      `Claude credentials were not found at ${credentialsPath}.`,
    );
  }

  return credentialFromLogin(file.claudeAiOauth ?? {}, {
    ...options,
    file,
    credentialsPath,
    transport: options.transport ?? createFetchTransport(),
    now: options.now ?? Date.now,
  });
};

/** A login that is close to expiry becomes the refreshed login written back. */
const credentialFromLogin = async (
  login: ClaudeAiOauth,
  options: ResolveClaudeAuthOptions & {
    readonly file: ClaudeCredentialsFile;
    readonly credentialsPath: string;
    readonly transport: OAuthTransport;
    readonly now: () => number;
  },
): Promise<ClaudeCredential> => {
  const nextLogin =
    shouldRefresh(login, options.now()) && login.refreshToken !== undefined
      ? await refreshClaudeLogin(options.file, login, options)
      : login;

  return credential(nextLogin);
};

/** Refreshes an expiring login through the JSON refresh grant and writes it back. */
const refreshClaudeLogin = async (
  file: ClaudeCredentialsFile,
  login: ClaudeAiOauth,
  options: {
    readonly credentialsPath: string;
    readonly transport: OAuthTransport;
    readonly now: () => number;
    readonly signal?: AbortSignal;
  },
): Promise<ClaudeAiOauth> => {
  const refreshToken = login.refreshToken;

  if (refreshToken === undefined) {
    return error(
      'claude_refresh_token_missing',
      'Claude access token is expiring and no refresh token is available.',
    );
  }

  const response = await options.transport.request({
    method: 'POST',
    url: claudeOAuthProfile.tokenEndpoint,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    signal: options.signal,
  });

  if (response.status >= 400) {
    return error('claude_refresh_failed', 'Claude token refresh failed.', {
      status: response.status,
      diagnostic: diagnosticExcerpt(response.body),
    });
  }

  const refreshed = parseRefreshResponse(response.body, options.now);
  const nextLogin: ClaudeAiOauth = {
    ...login,
    ...(refreshed.accessToken === undefined
      ? {}
      : { accessToken: refreshed.accessToken }),
    ...(refreshed.refreshToken === undefined
      ? {}
      : { refreshToken: refreshed.refreshToken }),
    ...(refreshed.expiresAt === undefined
      ? {}
      : { expiresAt: refreshed.expiresAt }),
    ...(refreshed.scopes === undefined ? {} : { scopes: refreshed.scopes }),
  };

  await writeFile(
    options.credentialsPath,
    `${JSON.stringify({ ...file, claudeAiOauth: nextLogin }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return nextLogin;
};

const parseRefreshResponse = (
  body: string,
  now: () => number,
): RefreshResponse => {
  let parsed: Record<string, unknown> | undefined;

  try {
    parsed = asRecord(JSON.parse(body));
  } catch (cause) {
    return error(
      'claude_refresh_invalid_response',
      'Claude token refresh response was not valid JSON.',
      { diagnostic: diagnosticExcerpt(body) },
      cause,
    );
  }

  if (parsed === undefined) {
    return error(
      'claude_refresh_invalid_response',
      'Claude token refresh response was not an object.',
      { diagnostic: diagnosticExcerpt(body) },
    );
  }

  const expiresIn = numberField(parsed, 'expires_in');
  const scope = stringField(parsed, 'scope');

  return {
    accessToken: stringField(parsed, 'access_token'),
    refreshToken: stringField(parsed, 'refresh_token'),
    expiresAt: expiresIn === undefined ? undefined : now() + expiresIn * 1000,
    scopes:
      scope === undefined
        ? undefined
        : scope.split(' ').filter((part) => part !== ''),
  };
};

const credential = (login: ClaudeAiOauth): ClaudeCredential => {
  const token = clean(login.accessToken);

  if (token === undefined) {
    return error(
      'claude_access_token_missing',
      'Claude credentials did not include an access token.',
    );
  }

  const expiresAt = expiresAtMs(login.expiresAt);

  return {
    source: 'claude',
    kind: 'oauth',
    token,
    authorization: `Bearer ${token}`,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(login.scopes === undefined ? {} : { scopes: login.scopes }),
    ...(login.subscriptionType === undefined
      ? {}
      : { subscriptionType: login.subscriptionType }),
  };
};

const authorizationCredential = (value: string): ClaudeCredential => ({
  source: 'claude',
  kind: 'authorization',
  token: bearerToken(value),
  authorization: /^bearer\s/i.test(value)
    ? value
    : `Bearer ${bearerToken(value)}`,
});

const oauthCredential = (token: string): ClaudeCredential => ({
  source: 'claude',
  kind: 'oauth',
  token,
  authorization: `Bearer ${token}`,
});

const shouldRefresh = (login: ClaudeAiOauth, now: number): boolean => {
  const expiresAt = expiresAtMs(login.expiresAt);

  return expiresAt !== undefined && expiresAt - now <= DEFAULT_REFRESH_SKEW_MS;
};

const expiresAtMs = (
  value: string | number | undefined,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
};

const readCredentialsFile = async (
  path: string,
): Promise<ClaudeCredentialsFile | undefined> => {
  try {
    return asRecord(JSON.parse(await readFile(path, 'utf8'))) ?? {};
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    return error(
      'claude_credentials_read_failed',
      `Failed to read Claude credentials at ${path}.`,
      {},
      cause,
    );
  }
};

const claudeHome = (
  options: ResolveClaudeAuthOptions,
  env: Readonly<Record<string, string | undefined>>,
): string =>
  options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

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
      provider: 'anthropic',
      profile: 'claude-code',
      code,
      message,
      status: extra.status,
      diagnostic: extra.diagnostic,
    },
    cause === undefined ? undefined : { cause },
  );
};
