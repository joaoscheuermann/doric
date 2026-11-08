# Spec: pre-registered OAuth clients for MCP servers

- Ticket: none; recorded at the user's request of 2026-11-08, when the
  `mcp` bundle's OAuth client name, scopes and MCP client info became
  advanced settings (`mcp/v1` 1.2.0). This part was left for later.
- Status: `proposed`. Nothing here is implemented.
- Scope: the `mcp` bundle (`bundles/features/mcp/`) only. Paths below are
  under it unless written in full.
- Builds on: `mcp/v1` 1.2.0 and `mcp.server/v1` 1.1.0, both uncommitted on
  `feature/mcp-client-name` when this was written.

## Problem

An `http` server's sign-in always gets its OAuth client through dynamic
client registration (RFC 7591). `prepare` in `src/host/oauth.ts` drops a
stored client whose redirect URI or client name differs, and the SDK's
`auth()` then posts the provider's `clientMetadata` to the authorization
server's `registration_endpoint`, with `token_endpoint_auth_method: 'none'`.

Many authorization servers offer no registration endpoint, or register only
the clients they allow: GitHub, Slack, Google, Atlassian and most corporate
identity providers (Okta, Entra ID, a locked-down Keycloak). There the user
creates an app in the provider's console. The console gives a `client_id`,
often a `client_secret`, and requires an exact redirect URI such as
`http://127.0.0.1:33418/callback`. Doric has nowhere to put these values, so
the sign-in fails at registration.

The callback is also bound on a fresh port for every sign-in
(`createLocalCallbackServer({ host: '127.0.0.1', port: 0 })` in `signIns.start`).
With dynamic registration that costs nothing, since a client is registered
again for the new redirect. A console-created client names one redirect URI,
and most providers compare it character by character, despite RFC 8252 §7.3
asking them to accept any loopback port.

## Goals

- G1. A server whose authorization server has no dynamic registration can be
  signed in to with a client the user created in its console.
- G2. A confidential client (one with a secret) authenticates at the token
  endpoint as the authorization server's metadata asks.
- G3. The secret is stored as a credential, never in the server document or a
  view, and is masked like other secrets.
- G4. Servers without these settings behave exactly as they do now.

## Non-goals

- Client ID metadata documents (SEP-991, `clientMetadataUrl`). The SDK
  supports them; they need an HTTPS URL Doric would host.
- `client_credentials` or JWT-bearer grants (no browser).
- A redirect other than the host's `127.0.0.1` loopback.

## Design

### Contract (`src/contracts/index.ts`)

The `http` transport gains three optional fields, in a new minor version of
`mcp/v1` and `mcp.server/v1`:

```ts
/** A client created in the authorization server's console: no registration. */
readonly oauthClient?: {
  readonly clientId: string;
  /** A literal value or a stored credential's id, as a header's. */
  readonly clientSecret?: McpEntry['value' | 'credentialId'];
  /** The loopback port its redirect URI names; a fresh one when absent. */
  readonly callbackPort?: number;
};
```

The exact shape of `clientSecret` is an open question (Q1). `callbackPort` is
an integer from 1024 to 65535. `clientName` still applies to dynamic
registration only; with `oauthClient` it is ignored.

### Sign-in (`src/host/oauth.ts`)

- `signIns.start` binds the callback on `callbackPort` when it is set. A port
  already in use fails the sign-in with `mcp_signin_failed` and a message
  naming the port, rather than falling back to another port the provider would
  refuse.
- With `oauthClient`, `prepare` neither drops nor registers a client. The
  provider's `clientInformation()` answers
  `{ client_id, client_secret? }` from the transport, with the secret
  resolved through the same path as header credentials (`credentials.ts`), and
  `saveClientInformation` is never reached. The SDK skips registration when
  `clientInformation()` answers a client (`authInternal` in
  `@modelcontextprotocol/sdk/dist/esm/client/auth.js`).
- Token-endpoint authentication already works for a client with a secret:
  `addClientAuthentication` calls `authenticateClient` (`src/host/oauth.ts`),
  which uses the SDK's `selectClientAuthMethod` to choose
  `client_secret_basic`, `client_secret_post` or `none` from the
  authorization server's `token_endpoint_auth_methods_supported` and the
  client information. No new code is expected there; a test must prove it.
- `clientMetadata.token_endpoint_auth_method` stays `none` for dynamic
  registration only.

### Background connections (`src/host/manager.ts`)

The background provider (`mode: 'background'`) needs the same client
information to refresh tokens. Today it reads the client from the vault.
With `oauthClient` it reads it from the transport, resolving the secret
at connect time like the headers.

### Invalidation (`src/host/index.ts`)

`movedServer` decides when stored OAuth state is dropped. Changing
`oauthClient.clientId`, or switching between a pre-registered and a
dynamically registered client, must drop the tokens and cancel a waiting
sign-in, as a URL change does: tokens belong to the client that earned them.
Changing only the secret or the port keeps the tokens.

### Dialog (`src/client/server-dialog.tsx`, `src/client/draft.ts`)

In the `http` Advanced section: "OAuth client ID", "OAuth client secret"
(with the key button, as an entry) and "Callback port". Under the port, the
redirect URI to paste in the provider's console:
`http://127.0.0.1:<port>/callback`. When a client ID is typed, the
OAuth client name field is disabled, with a note that it applies to
registration only.

## Test plan

Use the fake authorization server in `tests/support/oauth-server.ts`. It needs
an option to omit `registration_endpoint` and to require client
authentication at `/token`.

- With a client ID, a sign-in completes against a server without
  `registration_endpoint`, and nothing is posted to `/register`.
- With a secret and `client_secret_basic` (and separately `client_secret_post`)
  advertised, `/token` receives the secret that way, and the secret appears in
  no view, log line or status message.
- With `callbackPort`, the authorization URL's `redirect_uri` names that port;
  with the port taken, `signIn` fails with `mcp_signin_failed`.
- A background connection refreshes with the pre-registered client.
- Changing the client ID drops the tokens; changing only the secret or the
  port keeps them.
- Draft: the ID, secret and port round-trip, a blank ID leaves the block out,
  and a port outside 1024–65535 is refused on its field.

## Risks

- A fixed port collides with another process, or with a second Doric server
  configured on the same port. Two servers sharing one port can sign in only
  one at a time; the sign-in serialisation is per server today.
- A literal secret in the document would be readable by anything that reads
  storage. Requiring a credential (Q1) avoids this.
- Providers that issue tokens to confidential clients only, without PKCE,
  are out of scope: the sign-in keeps refusing an authorization server without
  `S256`.

## Open questions

- Q1. Should `clientSecret` accept a literal value, or only a stored
  credential's id? A credential only is safer and matches G3.
- Q2. Should the secret be a new credential kind, or a plain `API_TOKEN` picked
  with the key button like headers? The host refuses `MCP_TOKEN` entries;
  that rule must still hold.
- Q3. Is a per-server fixed port enough, or should Doric have one global
  callback port that all pre-registered clients name?

## Docs to update when implemented

- `bundles/features/mcp/README.md`: the OAuth section and the Limits bullet
  that links here.
- `GROUNDING.md`: the `mcp` paragraph's "it needs dynamic client
  registration" clause.
- This spec's status.
