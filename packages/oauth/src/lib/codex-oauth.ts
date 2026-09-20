import { createOAuthClient } from './oauth.js';
import type {
  CreateOAuthClientOptions,
  OAuthClient,
  OAuthProfile,
} from './types/oauth.js';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export const CODEX_OAUTH_CALLBACK_HOST = 'localhost';

export const CODEX_OAUTH_CALLBACK_PORT = 1455;

export const CODEX_OAUTH_FALLBACK_CALLBACK_PORT = 1457;

export const CODEX_OAUTH_CALLBACK_PATH = '/auth/callback';

export const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs';

export const CODEX_AUTHORIZATION_ENV_KEY = 'CODEX_AUTHORIZATION';

export const codexOAuthProfile: OAuthProfile = {
  provider: 'openai',
  profile: 'codex',
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  authorizationParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: CODEX_OAUTH_ORIGINATOR,
  },
  defaultScope:
    'openid profile email offline_access api.connectors.read api.connectors.invoke',
  defaultTokenScheme: 'Bearer',
};

export type CreateCodexOAuthOptions = Omit<
  CreateOAuthClientOptions,
  'clientId' | 'profile'
> & {
  readonly clientId?: string;
  readonly profile?: Partial<OAuthProfile>;
};

/** Creates a Codex OAuth client with OpenAI auth endpoint and scope defaults. */
export const createCodexOAuth = (
  options: CreateCodexOAuthOptions,
): OAuthClient =>
  createOAuthClient({
    ...options,
    clientId: options.clientId ?? CODEX_OAUTH_CLIENT_ID,
    profile: {
      ...codexOAuthProfile,
      ...options.profile,
    },
  });
