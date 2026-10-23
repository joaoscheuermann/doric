import { createOAuthClient } from './oauth.js';
import type {
  CreateOAuthClientOptions,
  OAuthClient,
  OAuthProfile,
} from './types/oauth.js';

/** Claude Code's public OAuth client id, used for subscription logins. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** The loopback host the callback server binds by default. */
export const CLAUDE_OAUTH_CALLBACK_HOST = 'localhost';

/** The port Claude Code's CLI uses for its loopback callback server. */
export const CLAUDE_OAUTH_CALLBACK_PORT = 54545;

/** The port used when the default callback port is busy. */
export const CLAUDE_OAUTH_FALLBACK_CALLBACK_PORT = 54546;

/** The path the loopback callback server serves the redirect on. */
export const CLAUDE_OAUTH_CALLBACK_PATH = '/callback';

/** The hosted redirect Claude's paste-mode flow lands on. */
export const CLAUDE_OAUTH_HOSTED_REDIRECT_URI =
  'https://platform.claude.com/oauth/code/callback';

/** The env key a Claude authorization value travels under. */
export const CLAUDE_AUTHORIZATION_ENV_KEY = 'CLAUDE_AUTHORIZATION';

/** The Claude Code subscription OAuth profile: authorize at claude.com, tokens at platform.claude.com. */
export const claudeOAuthProfile: OAuthProfile = {
  provider: 'anthropic',
  profile: 'claude-code',
  authorizationEndpoint: 'https://claude.com/cai/oauth/authorize',
  tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
  authorizationParams: { code: 'true' },
  defaultScope: 'user:inference',
  defaultTokenScheme: 'Bearer',
  tokenRequest: 'json',
  tokenExchangeParams: { expires_in: 31536000 },
};

/** Options for a Claude OAuth client; the client id and profile default when absent. */
export type CreateClaudeOAuthOptions = Omit<
  CreateOAuthClientOptions,
  'clientId' | 'profile'
> & {
  readonly clientId?: string;
  readonly profile?: Partial<OAuthProfile>;
};

/** Creates a Claude Code OAuth client with Claude's endpoints and scope defaults. */
export const createClaudeOAuth = (
  options: CreateClaudeOAuthOptions,
): OAuthClient =>
  createOAuthClient({
    ...options,
    clientId: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
    profile: {
      ...claudeOAuthProfile,
      ...options.profile,
    },
  });
