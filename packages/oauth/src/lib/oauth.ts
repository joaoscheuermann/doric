import { OAuthErrorObject } from './classes/oauth-error.js';
import type { OAuthTransport } from './http.js';
import type {
  CreateOAuthClientOptions,
  OAuthCallback,
  OAuthClient,
  OAuthCredential,
  OAuthProfile,
  OAuthTokenRecord,
} from './types/oauth.js';
import {
  asRecord,
  diagnosticExcerpt,
  numberField,
  stringField,
} from './utils/json.js';
import { parseTokenClaims } from './utils/jwt.js';
import { challenge, nodeRandomSource, token } from './utils/pkce.js';

export { parseTokenClaims } from './utils/jwt.js';

const DEFAULT_REFRESH_SKEW_MS = 60_000;

/** Creates a profile-driven authorization-code + PKCE OAuth client. */
export const createOAuthClient = (
  options: CreateOAuthClientOptions,
): OAuthClient => {
  const random = options.random ?? nodeRandomSource;
  const clock = options.clock ?? Date.now;

  const exchange = async (
    callback: OAuthCallback,
    verifier: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRecord> => {
    const record = await exchangeToken(options.transport, {
      profile: options.profile,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      code: callback.code ?? '',
      codeVerifier: verifier,
      redirectUri: options.redirectUri,
      now: clock,
      signal,
    });

    await options.tokenStore.save(record);

    return record;
  };

  const refresh = async (
    signal?: AbortSignal,
    current?: OAuthTokenRecord,
  ): Promise<OAuthTokenRecord> => {
    const existing = current ?? (await options.tokenStore.load());

    if (existing?.refreshToken === undefined) {
      throw error(options.profile, {
        code: 'oauth_missing_refresh_token',
        message: 'OAuth refresh token is missing.',
      });
    }

    const next = await refreshToken(options.transport, {
      profile: options.profile,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: existing.refreshToken,
      now: clock,
      signal,
    });

    const saved = {
      ...next,
      refreshToken: next.refreshToken ?? existing.refreshToken,
    };

    await options.tokenStore.save(saved);

    return saved;
  };

  const credential = async (
    credentialOptions: {
      readonly forceRefresh?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<OAuthCredential> => {
    const record = await options.tokenStore.load();

    if (record === undefined) {
      throw error(options.profile, {
        code: 'oauth_missing_record',
        message: 'OAuth credentials are missing.',
      });
    }

    if (
      credentialOptions.forceRefresh === true ||
      shouldRefresh(record, clock, options.refreshSkewMs)
    ) {
      return renderCredential(
        options.profile,
        await refresh(credentialOptions.signal, record),
      );
    }

    return renderCredential(options.profile, record);
  };

  return {
    profile: options.profile,

    async authorize(authorizeOptions = {}): Promise<OAuthTokenRecord> {
      const verifier = token(random, 32);
      const state = token(random, 16);
      const url = authorizationUrl(options, state, verifier);

      await options.browserOpener(url.toString());

      const callback = await options.callbackServer.waitForCallback(
        state,
        authorizeOptions.signal,
      );

      assertCallback(options.profile, callback, state);

      return exchange(callback, verifier, authorizeOptions.signal);
    },

    async refresh(refreshOptions = {}): Promise<OAuthTokenRecord> {
      return refresh(refreshOptions.signal);
    },

    credential,
  };
};

export const renderCredential = (
  profile: OAuthProfile,
  record: OAuthTokenRecord,
): OAuthCredential => {
  const scheme = record.tokenType ?? profile.defaultTokenScheme ?? 'Bearer';

  return {
    source: 'oauth',
    scheme,
    token: record.accessToken,
    authorization: `${scheme} ${record.accessToken}`,
    expiresAt: record.expiresAt,
    scope: record.scope,
    claims: record.claims === undefined ? undefined : { ...record.claims },
  };
};

const authorizationUrl = (
  options: CreateOAuthClientOptions,
  state: string,
  verifier: string,
): URL => {
  const url = new URL(options.profile.authorizationEndpoint);

  url.searchParams.set('response_type', 'code');

  url.searchParams.set('client_id', options.clientId);

  url.searchParams.set('redirect_uri', options.redirectUri);

  url.searchParams.set(
    'scope',
    options.scope ?? options.profile.defaultScope ?? '',
  );

  for (const [key, value] of Object.entries(
    options.profile.authorizationParams ?? {},
  )) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set('state', state);

  url.searchParams.set('code_challenge', challenge(verifier));

  url.searchParams.set('code_challenge_method', 'S256');

  return url;
};

const assertCallback = (
  profile: OAuthProfile,
  callback: OAuthCallback,
  expectedState: string,
): void => {
  if (callback.error !== undefined) {
    throw error(profile, {
      code: 'oauth_callback_error',
      message: callback.errorDescription ?? callback.error,
    });
  }

  if (callback.state !== expectedState) {
    throw error(profile, {
      code: 'oauth_state_mismatch',
      message: 'OAuth callback state did not match.',
    });
  }

  if (callback.code === undefined || callback.code === '') {
    throw error(profile, {
      code: 'oauth_missing_code',
      message: 'OAuth callback did not include a code.',
    });
  }
};

const exchangeToken = async (
  transport: OAuthTransport,
  request: {
    readonly profile: OAuthProfile;
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly now: () => number;
    readonly signal?: AbortSignal;
  },
): Promise<OAuthTokenRecord> => {
  const body = form({
    grant_type: 'authorization_code',
    client_id: request.clientId,
    client_secret: request.clientSecret,
    code: request.code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectUri,
  });

  const response = await transport.request({
    method: 'POST',
    url: request.profile.tokenEndpoint,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: request.signal,
  });

  if (response.status >= 400) {
    throw error(request.profile, {
      code: 'oauth_token_exchange_failed',
      message: 'OAuth token exchange failed.',
      status: response.status,
      diagnostic: diagnosticExcerpt(response.body),
    });
  }

  return tokenResponse(request.profile, response.body, request.now);
};

const refreshToken = async (
  transport: OAuthTransport,
  request: {
    readonly profile: OAuthProfile;
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly refreshToken: string;
    readonly now: () => number;
    readonly signal?: AbortSignal;
  },
): Promise<OAuthTokenRecord> => {
  const response = await transport.request({
    method: 'POST',
    url: request.profile.tokenEndpoint,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form({
      grant_type: 'refresh_token',
      refresh_token: request.refreshToken,
      client_id: request.clientId,
      client_secret: request.clientSecret,
    }),
    signal: request.signal,
  });

  if (response.status >= 400) {
    throw error(request.profile, {
      code: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed.',
      status: response.status,
      diagnostic: diagnosticExcerpt(response.body),
    });
  }

  return tokenResponse(request.profile, response.body, request.now);
};

const tokenResponse = (
  profile: OAuthProfile,
  body: string,
  now: () => number,
): OAuthTokenRecord => {
  let parsed: Record<string, unknown> | undefined;

  try {
    parsed = asRecord(JSON.parse(body));
  } catch (cause) {
    throw error(
      profile,
      {
        code: 'oauth_invalid_token_response',
        message: 'OAuth token response was not valid JSON.',
        diagnostic: diagnosticExcerpt(body),
      },
      cause,
    );
  }

  if (parsed === undefined) {
    throw error(profile, {
      code: 'oauth_invalid_token_response',
      message: 'OAuth token response was not an object.',
      diagnostic: diagnosticExcerpt(body),
    });
  }

  const accessToken = stringField(parsed, 'access_token');

  if (accessToken === undefined) {
    throw error(profile, {
      code: 'oauth_invalid_token_response',
      message: 'OAuth token response lacked access_token.',
      diagnostic: diagnosticExcerpt(body),
    });
  }

  const expiresIn = numberField(parsed, 'expires_in');
  const tokenType = stringField(parsed, 'token_type');

  return {
    accessToken,
    refreshToken: stringField(parsed, 'refresh_token'),
    expiresAt: expiresIn === undefined ? undefined : now() + expiresIn * 1000,
    tokenType,
    scope: stringField(parsed, 'scope'),
    claims: parseTokenClaims(accessToken),
  };
};

const shouldRefresh = (
  record: OAuthTokenRecord,
  clock: () => number,
  refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
): boolean =>
  record.expiresAt !== undefined && record.expiresAt - clock() <= refreshSkewMs;

const form = (
  entries: Readonly<Record<string, string | undefined>>,
): string => {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      body.set(key, value);
    }
  }

  return body.toString();
};

const error = (
  profile: OAuthProfile,
  data: {
    readonly code: string;
    readonly message: string;
    readonly status?: number;
    readonly diagnostic?: string;
  },
  cause?: unknown,
): OAuthErrorObject =>
  new OAuthErrorObject(
    {
      provider: profile.provider,
      profile: profile.profile,
      code: data.code,
      message: data.message,
      status: data.status,
      retryable:
        data.status === 429 ||
        (data.status !== undefined && data.status >= 500),
      diagnostic: data.diagnostic,
    },
    cause === undefined ? undefined : { cause },
  );
