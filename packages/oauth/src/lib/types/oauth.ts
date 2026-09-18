import type { OAuthTransport } from '../http.js';

export type OAuthProfile = {
  readonly provider: string;
  readonly profile: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly authorizationParams?: Readonly<Record<string, string>>;
  readonly defaultScope?: string;
  readonly defaultTokenScheme?: string;
};

export type OAuthTokenRecord = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

export interface OAuthTokenStore {
  load(): Promise<OAuthTokenRecord | undefined>;

  save(record: OAuthTokenRecord): Promise<void>;
}

export type OAuthCredential = {
  readonly source: 'oauth';
  readonly scheme: string;
  readonly token: string;
  readonly authorization: string;
  readonly expiresAt?: number;
  readonly scope?: string;
  readonly claims?: Record<string, unknown>;
};

export type OAuthError = {
  readonly provider?: string;
  readonly profile?: string;
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly diagnostic?: string;
};

export type OAuthCallback = {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
};

export interface OAuthCallbackServer {
  waitForCallback(
    expectedState: string,
    signal?: AbortSignal,
  ): Promise<OAuthCallback>;

  close?(): Promise<void>;
}

export type OAuthBrowserOpener = (url: string) => Promise<void> | void;

export type OAuthRandomSource = {
  bytes(length: number): Uint8Array;
};

export type CreateOAuthClientOptions = {
  readonly profile: OAuthProfile;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly scope?: string;
  readonly browserOpener: OAuthBrowserOpener;
  readonly callbackServer: OAuthCallbackServer;
  readonly transport: OAuthTransport;
  readonly tokenStore: OAuthTokenStore;
  readonly random?: OAuthRandomSource;
  readonly clock?: () => number;
  readonly refreshSkewMs?: number;
};

export type OAuthClient = {
  readonly profile: OAuthProfile;
  authorize(options?: {
    readonly signal?: AbortSignal;
  }): Promise<OAuthTokenRecord>;

  refresh(options?: {
    readonly signal?: AbortSignal;
  }): Promise<OAuthTokenRecord>;

  credential(options?: {
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<OAuthCredential>;
};
