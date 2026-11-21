# oauth

The OAuth 2 authorization-code flow with PKCE for Node hosts and command-line scripts, the Claude Code and Codex OAuth profiles, and the readers of the logins the Claude Code and Codex CLIs already hold. A client opens the browser, catches the redirect on a loopback callback server, exchanges and refreshes tokens, and answers a ready-to-send `authorization` header value. Token storage, the browser, the callback server, HTTP, randomness and the clock are injected, so the caller decides where credentials live, and tests run with no network and no browser.

The package depends on nothing but `tslib` and Node's built-in modules ([package.json](package.json)). It holds no provider's request logic: a caller passes the `authorization` value it gets into the provider's configuration.

Part of [Doric](../../README.md). The flows across units that use it are described in the feature docs [Provider sign-in](../../docs/features/provider-sign-in.md) and [MCP](../../docs/features/mcp.md).

## Who uses it

| User                                                                       | What it uses                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The bundle [`claude-login`](../../bundles/features/claude-login/README.md) | `createClaudeOAuth`, the Claude callback constants, `createLocalCallbackServer`, `createFetchTransport` and the client types, for the in-app Claude sign-in ([login.ts](../../bundles/features/claude-login/src/host/login.ts))                                         |
| The bundle [`mcp`](../../bundles/features/mcp/README.md)                   | `createLocalCallbackServer` and `OAuthCallback`, for the redirect of an MCP server's OAuth sign-in ([oauth.ts](../../bundles/features/mcp/src/host/oauth.ts))                                                                                                           |
| `npm run claude:oauth`                                                     | `createClaudeOAuth`, `resolveClaudeAuth`, `createFetchTransport`, `createLocalCallbackServer`, `openBrowser`, the Claude callback constants, `CLAUDE_OAUTH_HOSTED_REDIRECT_URI` and `CLAUDE_AUTHORIZATION_ENV_KEY` ([claude-oauth.mjs](../../scripts/claude-oauth.mjs)) |
| `npm run codex:oauth`                                                      | `createCodexOAuth`, `createFetchTransport`, `createLocalCallbackServer`, `openBrowser`, the Codex callback constants and `CODEX_AUTHORIZATION_ENV_KEY` ([codex-oauth.mjs](../../scripts/codex-oauth.mjs))                                                               |

## Entry point

The package is private and ESM (`"type": "module"`). It has one entry point, `oauth` (`"."` in `exports`): under the `@org/source` condition it resolves to [src/index.ts](src/index.ts), otherwise to `dist/index.js` with the types of `dist/index.d.ts`; `oauth/package.json` is also exported ([package.json](package.json)). The entry re-exports every module below ([src/index.ts](src/index.ts)); the helpers under `src/lib/utils/` are private, except `parseTokenClaims`.

## Data shapes

All in [types/oauth.ts](src/lib/types/oauth.ts) unless noted. Every field is `readonly`.

```ts
interface OAuthProfile {
  provider: string; // e.g. 'anthropic', 'openai'; copied into errors
  profile: string; // e.g. 'claude-code', 'codex'; copied into errors
  authorizationEndpoint: string;
  tokenEndpoint: string;
  authorizationParams?: Record<string, string>; // extra authorize-URL parameters
  defaultScope?: string;
  defaultTokenScheme?: string; // scheme when the token response has no token_type
  tokenRequest?: 'form' | 'json'; // token request body encoding; default 'form'
  tokenExchangeParams?: Record<string, string | number>; // extra code-exchange fields (JSON only)
}

interface OAuthTokenRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch milliseconds
  tokenType?: string;
  scope?: string;
  claims?: Record<string, unknown>; // the access token's JWT payload, when it is a JWT
}

interface OAuthTokenStore {
  load(): Promise<OAuthTokenRecord | undefined>;
  save(record: OAuthTokenRecord): Promise<void>;
}

interface OAuthCredential {
  source: 'oauth';
  scheme: string;
  token: string;
  authorization: string; // `${scheme} ${token}`
  expiresAt?: number;
  scope?: string;
  claims?: Record<string, unknown>;
}

interface OAuthError {
  provider?: string;
  profile?: string;
  code: string;
  message: string;
  status?: number; // HTTP status of a failed token call
  retryable?: boolean;
  diagnostic?: string; // response body excerpt, at most 500 characters
}

interface OAuthCallback {
  code?: string;
  state?: string;
  iss?: string; // RFC 9207 issuer, when the server sent one
  error?: string;
  errorDescription?: string;
}

interface OAuthCallbackServer {
  waitForCallback(
    expectedState: string,
    signal?: AbortSignal,
  ): Promise<OAuthCallback>;
  close?(): Promise<void>;
}

type OAuthBrowserOpener = (url: string) => Promise<void> | void;

interface OAuthRandomSource {
  bytes(length: number): Uint8Array;
}
```

The HTTP boundary is in [http.ts](src/lib/http.ts):

```ts
type OAuthHttpMethod = 'GET' | 'POST';
type OAuthHttpHeaders = Readonly<Record<string, string>>;
interface OAuthHttpRequest {
  method: OAuthHttpMethod;
  url: string;
  headers?: OAuthHttpHeaders;
  body?: string;
  signal?: AbortSignal;
}
interface OAuthHttpResponse {
  status: number;
  headers: OAuthHttpHeaders;
  body: string;
}
interface OAuthTransport {
  request(request: OAuthHttpRequest): Promise<OAuthHttpResponse>;
}
```

The package persists nothing itself, except the two CLI login files the resolvers refresh ([Existing Codex credentials](#existing-codex-credentials), [Existing Claude Code credentials](#existing-claude-code-credentials); [codex.ts](src/lib/codex.ts), [claude.ts](src/lib/claude.ts)). A client's tokens live wherever the caller's `OAuthTokenStore` keeps them ([oauth.ts](src/lib/oauth.ts)).

## Errors

Every failure the package detects is an `OAuthErrorObject` ([oauth-error.ts](src/lib/classes/oauth-error.ts)). Failures of the injected or Node boundaries pass through unwrapped: a rejection of the transport, the token store or the browser opener, a rejection of a custom `keychain` reader, a listen error of the callback server, a rejection of `LocalCallbackServer.close()` by Node's `server.close` (as on a second call), and a failed write of a CLI login file ([oauth.ts](src/lib/oauth.ts), [node.ts](src/lib/node.ts), [codex.ts](src/lib/codex.ts), [claude.ts](src/lib/claude.ts)).

```ts
class OAuthErrorObject extends Error {
  readonly data: OAuthError;
  constructor(data: OAuthError, options?: ErrorOptions);
}
```

Its `name` is `'OAuthError'`, its `message` is `data.message`, and the underlying error, when there is one, is its `cause`. Callers branch on `data.code`; each code is listed with the function that raises it. Errors of a client carry the profile's `provider` and `profile`, and `retryable` is `true` exactly when `status` is 429 or 500 and above ([oauth.ts](src/lib/oauth.ts)). Errors of `resolveCodexAuth` carry `openai`/`codex` and those of `resolveClaudeAuth` `anthropic`/`claude-code`; neither sets `retryable` ([codex.ts](src/lib/codex.ts), [claude.ts](src/lib/claude.ts)). Errors of the callback server and of `openBrowser` carry only `code` and `message` ([node.ts](src/lib/node.ts)). A `diagnostic` is the response body cut to 500 characters followed by `...[truncated]` when longer ([json.ts](src/lib/utils/json.ts)).

## The OAuth client

```ts
interface CreateOAuthClientOptions {
  profile: OAuthProfile;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string; // default: profile.defaultScope, else ''
  browserOpener: OAuthBrowserOpener;
  callbackServer: OAuthCallbackServer;
  transport: OAuthTransport;
  tokenStore: OAuthTokenStore;
  random?: OAuthRandomSource; // default: node:crypto randomBytes
  clock?: () => number; // default: Date.now
  refreshSkewMs?: number; // default: 60_000
}

interface OAuthClient {
  readonly profile: OAuthProfile;
  authorize(options?: { signal?: AbortSignal }): Promise<OAuthTokenRecord>;
  refresh(options?: { signal?: AbortSignal }): Promise<OAuthTokenRecord>;
  credential(options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<OAuthCredential>;
}

function createOAuthClient(options: CreateOAuthClientOptions): OAuthClient;
```

`createOAuthClient` builds a client for any profile ([oauth.ts](src/lib/oauth.ts)).

**`authorize()`** runs one sign-in ([oauth.ts](src/lib/oauth.ts), [pkce.ts](src/lib/utils/pkce.ts)):

1. It draws a PKCE verifier and a `state`, each 32 random bytes encoded as base64url. The challenge is the base64url SHA-256 of the verifier.
2. It builds the authorization URL from `profile.authorizationEndpoint` with, in this order, `response_type=code`, `client_id`, `redirect_uri`, `scope`, every entry of `profile.authorizationParams` (which may override the earlier ones), then `state`, `code_challenge` and `code_challenge_method=S256`.
3. It awaits `browserOpener(url)`, then `callbackServer.waitForCallback(state, signal)`.
4. It checks the callback: an `error` fails with `oauth_callback_error` and the message `errorDescription`, else `error`; a `state` other than its own fails with `oauth_state_mismatch`; a missing or empty `code` fails with `oauth_missing_code`. The `iss` field is not compared.
5. It exchanges the code at `profile.tokenEndpoint` (below), saves the record with `tokenStore.save` and returns it.

**`refresh()`** loads the stored record, fails with `oauth_missing_refresh_token` when there is no record or it has no refresh token, sends the refresh grant, and saves and returns the new record. When the response carries no `refresh_token`, the saved record keeps the previous one ([oauth.ts](src/lib/oauth.ts)).

**`credential()`** loads the stored record (`oauth_missing_record` when there is none). When `forceRefresh` is `true`, or the record has an `expiresAt` no more than `refreshSkewMs` after `clock()`, it refreshes first, as `refresh()` does. It returns the record rendered by `renderCredential`. A record without `expiresAt` is never refreshed on its own ([oauth.ts](src/lib/oauth.ts)).

### Token requests

Each token call is a `POST` to `profile.tokenEndpoint` with `accept: application/json` ([oauth.ts](src/lib/oauth.ts)):

| Call          | Fields                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| Code exchange | `grant_type=authorization_code`, `client_id`, `client_secret` (when set), `code`, `code_verifier`, `redirect_uri` |
| Refresh       | `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret` (when set)                              |

With `tokenRequest: 'form'` (the default) the body is `application/x-www-form-urlencoded` and holds exactly those fields. With `tokenRequest: 'json'` the body is `application/json`, unset fields are left out, and the code exchange body is `{ ...fields, state, ...profile.tokenExchangeParams }`: an entry of `tokenExchangeParams` overrides `state` or a field of the same name.

A response with status 400 or above fails with `oauth_token_exchange_failed` or `oauth_refresh_failed`, carrying `status` and `diagnostic`. A body that is not JSON, not a JSON object, or has no string `access_token` fails with `oauth_invalid_token_response`, carrying `diagnostic`, and the JSON parse error as `cause` when the body is not JSON. Otherwise the record is: `accessToken` from `access_token`; `refreshToken`, `tokenType` and `scope` from the string fields `refresh_token`, `token_type` and `scope`; `expiresAt` as `clock() + expires_in * 1000` when `expires_in` is a finite number; and `claims` from `parseTokenClaims(accessToken)` ([oauth.ts](src/lib/oauth.ts), [json.ts](src/lib/utils/json.ts)).

### `renderCredential` and `parseTokenClaims`

```ts
function renderCredential(
  profile: OAuthProfile,
  record: OAuthTokenRecord,
): OAuthCredential;
function parseTokenClaims(
  value: string,
): Readonly<Record<string, unknown>> | undefined;
```

`renderCredential` takes the scheme from `record.tokenType`, else `profile.defaultTokenScheme`, else `Bearer`, and answers `authorization: "<scheme> <accessToken>"` with `source: 'oauth'`, the record's `expiresAt` and `scope`, and a copy of its `claims` ([oauth.ts](src/lib/oauth.ts)).

`parseTokenClaims` decodes the second dot-separated segment of a JWT as base64url JSON and answers it when it is an object; any other value, or a decoding failure, answers `undefined`. It does not verify the signature ([jwt.ts](src/lib/utils/jwt.ts)).

## Profiles

`createClaudeOAuth` and `createCodexOAuth` are `createOAuthClient` with a profile's defaults. Their options are `CreateOAuthClientOptions` with `clientId` optional (the profile's client id by default) and `profile` a `Partial<OAuthProfile>` merged over the default profile ([claude-oauth.ts](src/lib/claude-oauth.ts), [codex-oauth.ts](src/lib/codex-oauth.ts)):

```ts
type CreateClaudeOAuthOptions = Omit<
  CreateOAuthClientOptions,
  'clientId' | 'profile'
> & {
  clientId?: string;
  profile?: Partial<OAuthProfile>;
};
function createClaudeOAuth(options: CreateClaudeOAuthOptions): OAuthClient;
// CreateCodexOAuthOptions and createCodexOAuth have the same shape.
```

The clients use only the `redirectUri` they are given ([oauth.ts](src/lib/oauth.ts)); the callback constants below are values a caller passes to `createLocalCallbackServer` to build it.

```ts
const claudeOAuthProfile: OAuthProfile;
const codexOAuthProfile: OAuthProfile;
```

| `OAuthProfile` field    | `claudeOAuthProfile`                                      | `codexOAuthProfile`                                                                            |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `provider` / `profile`  | `anthropic` / `claude-code`                               | `openai` / `codex`                                                                             |
| `authorizationEndpoint` | `https://claude.com/cai/oauth/authorize`                  | `https://auth.openai.com/oauth/authorize`                                                      |
| `tokenEndpoint`         | `https://platform.claude.com/v1/oauth/token`              | `https://auth.openai.com/oauth/token`                                                          |
| `authorizationParams`   | `code=true`                                               | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs` |
| `defaultScope`          | `user:inference`                                          | `openid profile email offline_access api.connectors.read api.connectors.invoke`                |
| `defaultTokenScheme`    | `Bearer`                                                  | `Bearer`                                                                                       |
| `tokenRequest`          | `json`                                                    | not set (form)                                                                                 |
| `tokenExchangeParams`   | `{ expires_in: 31536000 }` (asks for a login of one year) | not set                                                                                        |

The module constants ([claude-oauth.ts](src/lib/claude-oauth.ts), [codex-oauth.ts](src/lib/codex-oauth.ts)):

| Constant                                                                     | Value                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CLAUDE_OAUTH_CLIENT_ID`                                                     | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's public client id)                    |
| `CLAUDE_OAUTH_CALLBACK_HOST` / `_PORT` / `_FALLBACK_CALLBACK_PORT` / `_PATH` | `localhost` / `54545` / `54546`, for when the default port is busy / `/callback`           |
| `CLAUDE_OAUTH_HOSTED_REDIRECT_URI`                                           | `https://platform.claude.com/oauth/code/callback`, the redirect of the paste-the-code mode |
| `CLAUDE_AUTHORIZATION_ENV_KEY`                                               | `CLAUDE_AUTHORIZATION`                                                                     |
| `CODEX_OAUTH_CLIENT_ID`                                                      | `app_EMoamEEZ73f0CkXaXp7hrann`                                                             |
| `CODEX_OAUTH_CALLBACK_HOST` / `_PORT` / `_FALLBACK_CALLBACK_PORT` / `_PATH`  | `localhost` / `1455` / `1457` / `/auth/callback`                                           |
| `CODEX_OAUTH_ORIGINATOR`                                                     | `codex_cli_rs`, the `originator` parameter of `codexOAuthProfile`                          |
| `CODEX_AUTHORIZATION_ENV_KEY`                                                | `CODEX_AUTHORIZATION`                                                                      |

The two `*_AUTHORIZATION_ENV_KEY` constants name the environment variable an authorization value travels under. The package itself does not read them: the resolvers read `CLAUDE_AUTHORIZATION` and `CODEX_AUTHORIZATION` by name ([claude.ts](src/lib/claude.ts), [codex.ts](src/lib/codex.ts)), and the scripts use the constants as their default output key ([claude-oauth.mjs](../../scripts/claude-oauth.mjs), [codex-oauth.mjs](../../scripts/codex-oauth.mjs)).

## Node boundaries

[node.ts](src/lib/node.ts) holds the concrete callback server and browser opener; [http.ts](src/lib/http.ts) the concrete transport.

### `createLocalCallbackServer`

```ts
interface LocalCallbackServerOptions {
  host?: string; // default '127.0.0.1'
  port?: number; // default 0: an ephemeral port
  path?: string; // default '/callback'
}
type LocalCallbackServer = OAuthCallbackServer & {
  readonly redirectUri: string; // `http://${host}:${port}${path}`
  close(): Promise<void>;
};
function createLocalCallbackServer(
  options?: LocalCallbackServerOptions,
): Promise<LocalCallbackServer>;
```

It starts a Node HTTP server listening on `host:port` and resolves once it listens. A listen failure rejects with Node's own error, so a caller that tries a fallback port checks its `code`, `EADDRINUSE` ([node.ts](src/lib/node.ts), [login.ts](../../bundles/features/claude-login/src/host/login.ts)). A server with no TCP address fails with `oauth_callback_server_unavailable`.

At most one wait is pending at a time. Each request is answered with `connection: close` ([node.ts](src/lib/node.ts)):

| Request                                                   | Answer                                                    | The wait      |
| --------------------------------------------------------- | --------------------------------------------------------- | ------------- |
| A path other than `path`                                  | 404, `text/plain`, `Not found`                            | Unchanged     |
| `path`, with no wait pending                              | 409, `text/plain`, `No OAuth callback is pending.`        | —             |
| `path`, with a `state` other than the pending one         | 400, the failure HTML page                                | Keeps waiting |
| `path`, with the pending `state` and an `error` parameter | 400, the failure HTML page (`OAuth did not complete.`)    | Resolves      |
| `path`, with the pending `state`                          | 200, the success HTML page (`You can close this window.`) | Resolves      |

A wait resolves with the query parameters `code`, `state`, `iss`, `error` and `error_description` (as `errorDescription`); the caller judges an `error`. Because only the pending `state` settles the wait, a redirect without it, including an error redirect that carries no `state`, leaves the sign-in waiting.

`waitForCallback(expectedState, signal)` rejects with `oauth_callback_server_closed` after `close()`, with `oauth_callback_already_pending` while another wait is pending, and with `oauth_callback_aborted` when `signal` aborts, already or later. These errors have the code with spaces as their message. `close()` rejects a pending wait with `oauth_callback_server_closed`, closes idle connections, and closes every remaining connection after 100 ms.

### `openBrowser`

```ts
interface BrowserOpenOptions {
  platform?: string; // default process.platform
  spawn?: BrowserSpawn; // default node:child_process spawn
}
type BrowserSpawn = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' },
) => BrowserProcess;
interface BrowserProcess {
  unref?(): void;
  once?(event: 'spawn' | 'error', listener: (error?: Error) => void): unknown;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}
function openBrowser(url: string, options?: BrowserOpenOptions): Promise<void>;
```

It runs `rundll32 url.dll,FileProtocolHandler <url>` on `win32`, `open <url>` on `darwin`, and `xdg-open <url>` elsewhere, detached with ignored stdio, and unrefs the child. It resolves on the child's `spawn` event, or at once when the process has no `once`. A throwing `spawn` or an `error` event (no such command, as on a headless host) rejects with `oauth_browser_unavailable` and the message `Could not open a browser with <command>.`; the `error` listener stays attached, so a late error is dropped and never thrown at the process ([node.ts](src/lib/node.ts)).

### `createFetchTransport`

```ts
function createFetchTransport(fetcher?: typeof fetch): OAuthTransport; // default: global fetch
```

It forwards `method`, `headers`, `body` and `signal` to `fetcher`, and answers the status, the response headers as a plain object, and the body as text. It never throws on an HTTP status: callers judge `status` ([http.ts](src/lib/http.ts)).

## Existing Codex credentials

```ts
interface ResolveCodexAuthOptions {
  codexHome?: string;
  env?: Readonly<Record<string, string | undefined>>; // default process.env
  now?: () => number; // default Date.now
  transport?: OAuthTransport; // default createFetchTransport()
  signal?: AbortSignal;
}
interface CodexCredential {
  source: 'codex';
  kind: 'api-key' | 'chatgpt' | 'personal-access-token';
  token: string;
  authorization: string; // `Bearer ${token}`
  accountId?: string;
  fedramp?: boolean;
}
function resolveCodexAuth(
  options?: ResolveCodexAuthOptions,
): Promise<CodexCredential>;
function codexCredentialFromToken(value: string): CodexCredential;
```

`resolveCodexAuth` resolves the login the Codex CLI holds, with no browser. The values `CODEX_AUTHORIZATION`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`, `personal_access_token`, `tokens.access_token`, `tokens.account_id` and the `chatgpt_account_id` claim are trimmed, a blank one counts as absent, and a credential carries the trimmed value. `CODEX_HOME`, `codexHome` and `auth_mode` are used as given: a blank `CODEX_HOME` names the current directory, and a blank `auth_mode` is an unsupported mode ([codex.ts](src/lib/codex.ts), [text.ts](src/lib/utils/text.ts)). It takes the first of ([codex.ts](src/lib/codex.ts)):

1. `CODEX_AUTHORIZATION`: read by `codexCredentialFromToken`, which strips a leading `Bearer ` (any case) and answers a `personal-access-token` credential for a token starting `at-`, else a `chatgpt` credential. Called directly with a blank value, `codexCredentialFromToken` fails with `codex_auth_missing`.
2. `CODEX_API_KEY`: an `api-key` credential.
3. `CODEX_ACCESS_TOKEN`: a `personal-access-token` credential when it starts `at-`; any other value is an agent identity JWT and fails with `codex_agent_identity_unsupported`.
4. `auth.json` under `codexHome`, else `CODEX_HOME`, else `~/.codex`. A missing file, or one whose JSON is not an object, fails with `codex_auth_missing`; an unreadable file or invalid JSON with `codex_auth_read_failed`.

The file's mode is `auth_mode` with `-` and `_` removed and lowercased; without `auth_mode` it is `personalaccesstoken` when `personal_access_token` is present (even blank, which then fails with `codex_personal_access_token_missing`), `apikey` when `OPENAI_API_KEY` is present (even blank, which then fails with `codex_api_key_missing`), else `chatgpt`:

| Mode                           | Answer                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `apikey`                       | An `api-key` credential from `OPENAI_API_KEY`, else `codex_api_key_missing`                                   |
| `personalaccesstoken`          | A `personal-access-token` credential from `personal_access_token`, else `codex_personal_access_token_missing` |
| `agentidentity`                | `codex_agent_identity_unsupported`                                                                            |
| `chatgpt`, `chatgptauthtokens` | A `chatgpt` credential from `tokens.access_token`, else `codex_chatgpt_token_missing`                         |
| Any other                      | `codex_auth_mode_unsupported`                                                                                 |

A `chatgpt` credential's `accountId` is `tokens.account_id`, else the `chatgpt_account_id` claim; `fedramp: true` is set when the `chatgpt_account_is_fedramp` claim is `true`. Both claims are read from the `https://api.openai.com/auth` object of the access token's JWT payload, over that of `tokens.id_token`.

When the access token's `exp` claim is no more than five minutes after `now()` and the file has a `tokens.refresh_token`, the login is refreshed first: a JSON `POST` to the Codex token endpoint with `client_id`, `grant_type=refresh_token` and `refresh_token`. A status of 400 or above fails with `codex_refresh_failed` (with `status` and `diagnostic`); a body that is not a JSON object with `codex_refresh_invalid_response`. The returned `id_token`, `access_token` and `refresh_token` replace the ones in `tokens`, `last_refresh` is set to the ISO time of `now()`, and the whole file is overwritten in place, before the credential is answered, as JSON indented by two spaces with a trailing newline. An existing file keeps its permissions; mode 0600 applies only when the file no longer exists and the write creates it. An expiring token with no refresh token is answered as it is ([codex.ts](src/lib/codex.ts)).

## Existing Claude Code credentials

```ts
interface ResolveClaudeAuthOptions {
  claudeHome?: string;
  env?: Readonly<Record<string, string | undefined>>; // default process.env
  now?: () => number; // default Date.now
  transport?: OAuthTransport; // default createFetchTransport()
  signal?: AbortSignal;
  refresh?: boolean; // default true
  keychain?: false | (() => Promise<string | undefined>);
}
interface ClaudeCredential {
  source: 'claude';
  kind: 'authorization' | 'oauth';
  token: string;
  authorization: string;
  expiresAt?: number; // epoch milliseconds
  scopes?: readonly string[];
  subscriptionType?: string;
}
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
function resolveClaudeAuth(
  options?: ResolveClaudeAuthOptions,
): Promise<ClaudeCredential>;
```

`resolveClaudeAuth` resolves the login Claude Code holds, with no browser. The values `CLAUDE_AUTHORIZATION`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` and the login's `accessToken` are trimmed, a blank one counts as absent, and a credential carries the trimmed value; the `claudeHome` option is used as given ([claude.ts](src/lib/claude.ts), [text.ts](src/lib/utils/text.ts)). It takes the first of ([claude.ts](src/lib/claude.ts)):

1. `CLAUDE_AUTHORIZATION`: an `authorization` credential. A value starting `Bearer` and a space (any case) is the `authorization` as given; any other value is prefixed with `Bearer `. `token` is the value without the scheme.
2. `CLAUDE_CODE_OAUTH_TOKEN`: an `oauth` credential with `Bearer <token>`.
3. The macOS Keychain login. The reader is `options.keychain` when it is a function; none when it is `false`; otherwise, only on `darwin` with no `claudeHome` option and no `CLAUDE_CONFIG_DIR`, `security find-generic-password -s "Claude Code-credentials" -w`, with a 60-second timeout, where a failure or empty output means no entry. A Keychain value that is not a JSON object is ignored. A Keychain login is never refreshed or written: with `refresh` not `false`, one whose expiry has passed fails with `claude_keychain_login_expired`, whose message tells the reader to run `claude` to renew it.
4. `.credentials.json` under `claudeHome`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`. A missing file fails with `claude_credentials_missing`; an unreadable file or invalid JSON with `claude_credentials_read_failed`; a JSON value that is not an object counts as an empty file.

A login is the `claudeAiOauth` object: `accessToken`, `refreshToken`, `expiresAt` (an ISO-8601 string or epoch milliseconds), `scopes` and `subscriptionType`. Its credential is `kind: 'oauth'` with `Bearer <accessToken>`, the expiry in epoch milliseconds, and `scopes` and `subscriptionType` when present; a login without an access token fails with `claude_access_token_missing`. An `expiresAt` string `Date.parse` cannot read counts as no expiry: the login is never refreshed or refused as expired, and its credential has no `expiresAt` ([claude.ts](src/lib/claude.ts)).

A file login whose expiry is no more than five minutes after `now()` is refreshed, unless `refresh` is `false`, which answers the login as it is so a caller can judge `expiresAt` first. Without a refresh token, a login not yet expired is answered as it is and an expired one fails with `claude_refresh_token_missing`. The refresh is a JSON `POST` to `https://platform.claude.com/v1/oauth/token` with `grant_type=refresh_token`, `refresh_token` and `client_id`; a status of 400 or above fails with `claude_refresh_failed` (with `status` and `diagnostic`), a body that is not a JSON object with `claude_refresh_invalid_response`. The response's `access_token`, `refresh_token`, `expires_in` (as `expiresAt = now() + expires_in * 1000`) and space-separated `scope` (as `scopes`) replace the login's fields they are present for. The refreshed login is written back before the credential is answered: the file is read again and only its `claudeAiOauth` is replaced, and the result, JSON indented by two spaces with a trailing newline, is written to `.credentials.<pid>.<random>.tmp` beside it with mode 0600 and renamed over the file, so a reader never sees half a file; the temp file is removed and the error rethrown when the write or rename fails. When that second read finds no file or fails, the file is written with `claudeAiOauth` alone, and every other key it held is lost ([claude.ts](src/lib/claude.ts)).

## Build and test

Run each command from the repository root. The project is `oauth` ([project.json](project.json)):

| Target                       | What it runs                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run oauth:build`     | `tsc --build tsconfig.lib.json`: `src/` to `dist/` with declarations ([tsconfig.lib.json](tsconfig.lib.json))                                              |
| `npx nx run oauth:typecheck` | `tsc --build tsconfig.json --emitDeclarationOnly`                                                                                                          |
| `npx nx run oauth:test`      | `tsc -p packages/oauth/tsconfig.spec.json` to `dist-tests/`, then `node --test` on `dist-tests/tests/*.test.js` ([tsconfig.spec.json](tsconfig.spec.json)) |

`build` and `typecheck` are inferred by the `@nx/js/typescript` plugin; `test` is declared in [project.json](project.json). The tests, [oauth.test.ts](tests/oauth.test.ts) and [node.test.ts](tests/node.test.ts), use injected transports, stores, browsers and clocks; the callback server tests listen on the loopback interface, and no test reaches a remote host.
