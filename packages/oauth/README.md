# oauth

OAuth 2 authorization-code with PKCE for desktop and CLI hosts: open the
browser, catch the redirect on a local callback server, exchange and refresh
tokens, and hand back a ready-to-send `authorization` header. Token storage,
the browser, the callback server, and HTTP are all injected, so a host keeps
control of where credentials live and tests run without a network or browser.
It ships a Codex profile and works with any provider you describe with an
`OAuthProfile`.

Part of [Doric](../../README.md).

## Highlights

- **Profile-driven.** `createOAuthClient` takes an `OAuthProfile`;
  `createCodexOAuth` fills in Codex's endpoints, client ID, and scopes.
- **Automatic refresh.** `credential()` refreshes a token that is about to
  expire when a refresh token is available.
- **Injectable boundaries.** Token store, browser opener, callback server,
  transport, random source, and clock can all be replaced.
- **Provider-agnostic.** OAuth stays out of provider packages; hosts pass the
  rendered `authorization` value into provider configuration.
- **No dependencies** beyond `tslib`.

## Usage

```ts
import {
  createCodexOAuth,
  createFetchTransport,
  createLocalCallbackServer,
  openBrowser,
  type OAuthTokenRecord,
  type OAuthTokenStore,
} from 'oauth';

let stored: OAuthTokenRecord | undefined;
const tokenStore: OAuthTokenStore = {
  load: async () => stored,
  save: async (record) => {
    stored = record;
  },
};

const callbackServer = await createLocalCallbackServer();
const codex = createCodexOAuth({
  transport: createFetchTransport(),
  tokenStore,
  redirectUri: callbackServer.redirectUri,
  browserOpener: openBrowser,
  callbackServer,
});

try {
  await codex.authorize();
  const credential = await codex.credential();
  const authorization = credential.authorization;
  // Pass authorization to the provider transport; never log it.
} finally {
  await callbackServer.close();
}
```

The in-memory token store above is only an example. A real host should inject
storage appropriate for OAuth credentials and must not log or commit tokens.

## API

| Export                               | Purpose                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `createOAuthClient(options)`         | Authorization-code + PKCE client for any `OAuthProfile`.                                    |
| `createCodexOAuth(options)`          | The same client with Codex defaults (`codexOAuthProfile`, `CODEX_OAUTH_CLIENT_ID`).         |
| `createLocalCallbackServer(options)` | Starts a localhost redirect listener (`127.0.0.1`, `/callback`, ephemeral port by default). |
| `openBrowser(url, options)`          | Opens a URL in the platform browser through an injectable spawn.                            |
| `createFetchTransport(fetch?)`       | Production `OAuthTransport` over Fetch.                                                     |
| `renderCredential(profile, record)`  | Renders a token record as an `OAuthCredential` with its `authorization` header.             |
| `resolveCodexAuth(options)`          | Resolves existing Codex CLI credentials without a browser flow.                             |
| `OAuthErrorObject`                   | Error carrying an `OAuthError` with a stable `code`.                                        |

An `OAuthClient` exposes:

- `authorize()`: opens the browser, waits for the callback, checks `state`,
  exchanges the code, and saves the token record.
- `refresh()`: exchanges the stored refresh token and saves the result,
  keeping the previous refresh token if the server does not return one.
- `credential({ forceRefresh })`: loads the stored record, refreshes it when it
  expires within the refresh skew (60 seconds by default, `refreshSkewMs`) or
  when forced, and returns a ready-to-use `authorization` header value.

All three accept an `AbortSignal`.

## Existing Codex credentials

`resolveCodexAuth` is the separate helper for resolving existing Codex CLI
credentials without starting a browser flow. It checks, in order, the
`CODEX_AUTHORIZATION`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` environment
variables, then `auth.json` under `codexHome`, `CODEX_HOME`, or `~/.codex`.

## Development

```console
npx nx build oauth
npx nx typecheck oauth
npx nx test oauth
```
