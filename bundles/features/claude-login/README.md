# claude-login

`claude-login` is the in-app Claude Code sign-in. It signs the settings window
in to a Claude Code subscription through Claude's OAuth authorization in the
system browser, and stores the result as the `API_TOKEN` credential named
`Claude`, which the provider page of the `claude` kind names as its `token`
field. It has a host part, which runs the authorization and stores the
credential, and a client part, which draws the sign-in row in the provider
page of the [`settings`](../../desktop/settings/README.md) bundle.

The feature across bundles is described in
[Provider sign-in](../../../docs/features/provider-sign-in.md); how a
credential is stored is in [Credentials](../../../docs/features/credentials.md).
How its toasts follow the shared rules is in
[Error messages](../../../docs/features/error-messages.md); the slot it fills
is in [Settings](../../../docs/features/settings.md). For how bundles are
built and loaded, see
[`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| `manifestVersion` | `1`                                                      |
| `description`     | see below                                                |
| `id`              | `claude-login`                                           |
| `version`         | `1.1.1`                                                  |
| `engines`         | `doric` `^1.7.0`                                         |
| `provides`        | `claude.login/v1@1.1.0`                                  |
| `requires`        | `secrets/v1@^1.0.0`, `ui/v1@^1.0.0`, `regions/v1@^1.0.0` |
| `optional`        | `log/v1`                                                 |
| `desktopScope`    | `claude.login/v1`: `projectId`, `threadId`, `promptId`   |

`description` is the string "The in-app Claude Code sign-in: reuse an existing
login or open a fresh browser authorization, stored as the 'Claude' API token
credential." `doric.catalog/v1` publishes it in its catalog snapshot
([`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts));
the host part never reuses an existing login
([`src/host/login.ts`](src/host/login.ts)).
`desktopScope` names the scope keys a desktop window may send with a call to
`claude.login/v1`; the desktop process refuses a call whose scope holds any
other key
([manifest](../../../docs/architecture/bundles/manifest.md#desktopscope)).

The bundle has two parts, `src/host/` and `src/client/`, and no desktop part.
The package exports `./contracts`, `./contracts/gen/*` (the protobuf-es code `generate-proto` writes from `proto/`) and `./package.json`
([`package.json`](package.json)). The host of Doric loads the bundle because
its composition lists it
([`composition.json`](../../../app/backend/doric-host/composition.json)).

The client part also uses, without declaring them, the platform contract
`doric.browser/v1` and the slot `settings.provider.field` of `settings`, whose
name and types it imports from `settings/contracts` as types only
([`src/client/index.ts`](src/client/index.ts),
[`src/client/api.ts`](src/client/api.ts)).

## Contract `claude.login/v1`

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as
`ClaudeLoginV1`, with the wire shapes `claudeLoginMethods`, and provided by the
host part. Both methods take no input (an empty tuple) and an optional call
(`CallArg`, whose `signal` cancels the call), and both are exposed to desktop
windows (`expose: 'desktop'`)
([`src/host/login.ts`](src/host/login.ts)).

```ts
interface ClaudeLoginStart {
  readonly url: string; // the https: authorization URL; it carries the sign-in's state
}

interface ClaudeLogin {
  start(call?: CallArg): Promise<ClaudeLoginStart>; // output: { url: string }, strict
  finish(call?: CallArg): Promise<CredentialDescription>;
}
```

`CredentialDescription` is the public view of a credential that `secrets/v1`
defines, a strict object `{ id: string; kind; name: string; username?: string;
email?: string; hasSecret: boolean }`; it never holds the secret
([`secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts)). The
contracts module re-exports its type.

Errors, each a `ContractError` with this code and message
([`src/host/login.ts`](src/host/login.ts)):

| Code                       | When                                                                                                                                                                                                                    | Message                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `claude_login_not_started` | `finish` with no sign-in waiting                                                                                                                                                                                        | `No Claude sign-in is waiting; start one first.` |
| `claude_login_busy`        | `finish` while another `finish` waits on the same sign-in                                                                                                                                                               | `A Claude sign-in is already in progress.`       |
| `claude_login_aborted`     | the call's signal aborts, a newer `start` replaces the sign-in, the sign-in times out while `finish` waits, or the bundle deactivates while `finish` waits                                                              | `The Claude sign-in was cancelled.`              |
| `claude_login_failed`      | the callback server cannot be bound, creating the transport or the OAuth client throws, the authorization ends before naming its URL, or the authorization or the code exchange fails (for example, the user denied it) | `The Claude sign-in failed: <cause's message>`   |

A `ContractError` raised inside the authorization passes through unchanged
instead of becoming `claude_login_failed`, and so does an error of
`secrets/v1` while the credential is stored.

## Host part

[`src/host/index.ts`](src/host/index.ts) exports `activate`, which provides
`claude.login/v1` and returns a cleanup that cancels a sign-in still waiting.
It also exports `createActivate(options?: LoginBundleOptions)`, the same
activation with injected seams, where
`LoginBundleOptions = { deps?: ClaudeLoginDeps }` and every member of
`ClaudeLoginDeps` is optional and defaults to the real piece of the
[`oauth`](../../../packages/oauth/README.md) package, so tests inject fakes
([`src/host/login.ts`](src/host/login.ts)):

```ts
interface ClaudeLoginDeps {
  createServer?(
    options: LocalCallbackServerOptions,
  ): Promise<LocalCallbackServer>; // createLocalCallbackServer
  createOAuth?(options: CreateClaudeOAuthOptions): OAuthClient; // createClaudeOAuth
  transport?(): OAuthTransport; // createFetchTransport()
  timeoutMs?: number; // CLAUDE_LOGIN_TIMEOUT_MS, 600000
}
```

Each activation keeps its own waiting sign-in.

The host never opens a browser, because it may run where none runs (a
container, another machine); the window opens the URL `start` answers.

### `start`

1. Cancels the sign-in already waiting, if one is.
2. Binds a loopback callback server at `localhost:54545/callback`, Claude
   Code's own callback; when that port is in use (`EADDRINUSE`), it binds
   `localhost:54546/callback` instead
   ([`claude-oauth.ts`](../../../packages/oauth/src/lib/claude-oauth.ts)).
3. Creates a Claude OAuth client (`createClaudeOAuth`) with that server's
   redirect URI, a token store held in memory only, and a browser opener that
   only records the URL. The client runs the authorization-code flow with
   PKCE against Claude's profile: authorization at
   `https://claude.com/cai/oauth/authorize`, tokens at
   `https://platform.claude.com/v1/oauth/token`, scope `user:inference`, and
   `expires_in: 31536000` (one year) sent with the code exchange
   ([`claude-oauth.ts`](../../../packages/oauth/src/lib/claude-oauth.ts)).
4. Starts the authorization in the background and answers `{ url }` once the
   client names the authorization URL. From then on, the callback server
   closes when the authorization ends, however it ends. When creating the
   transport or the OAuth client throws, before the authorization starts,
   `start` refuses with `claude_login_failed` and leaves the server it bound
   open.
5. Keeps the sign-in as the one waiting, with a timer of
   `CLAUDE_LOGIN_TIMEOUT_MS` (ten minutes) that cancels it. The timer does not
   keep the host process alive.

When the call's signal is already aborted after the authorization starts,
`start` cancels it and refuses with `claude_login_aborted`.

### `finish`

1. Refuses with `claude_login_not_started` when no sign-in waits, and with
   `claude_login_busy` when a `finish` already waits on it.
2. Waits for the browser's callback and the code exchange. An abort of the
   call's signal cancels the sign-in.
3. Once the wait ends, the sign-in is no longer waiting, whether it succeeded
   or failed, and its timer is cleared.
4. When the call's signal aborted, even with the callback already answered,
   refuses with `claude_login_aborted` and stores nothing.
5. Stores the authorization value, the `authorization` header form
   `<scheme> <access token>` (`Bearer …` unless the token response names
   another type), through `secrets/v1`:
   `create({ kind: 'API_TOKEN', name: 'Claude', secret })`. When that is
   refused with `credential_name_taken`, it lists the credentials, finds the
   `API_TOKEN` credential named `Claude` and replaces its secret with
   `update({ id }, { secret })`; when none is found, the refusal stands.
6. Answers the stored credential's `CredentialDescription`.

The authorization value is passed only to `secrets/v1` and is never logged.
The token record of the sign-in lives only in its memory and ends with it:
nothing refreshes the stored value, which stops working when the
login expires or is revoked. The bundle never reads an existing Claude Code
login (`~/.claude`).

### Cancellation

A sign-in is cancelled by aborting its authorization, which closes its
callback server. That happens when a newer `start` replaces it, when its timer
fires, when the signal of the `finish` waiting on it aborts, and when the
bundle deactivates. A cancelled sign-in stores nothing.

### Process entry (S50b)

The bundle also has a process entry, [`src/host/main.ts`](src/host/main.ts),
built to `dist/host/main.mjs`, for the bundle-process runtime
([bundle processes](../../../docs/features/bundle-processes.md)). It calls
`runBundle` with `LoginService` (`claude.login/v1`) listed statically. The
sign-in logic lives in `createLoginSessions`; the kernel `loginService`
delegates to it, so its behaviour is unchanged.

- Before activation the routed service fails `unavailable` with "The Claude
  sign-in is not ready."; deactivation cancels a waiting sign-in.
- `Finish` stores the authorization through `secrets/v1`: `Create`; on
  `credential_name_taken` it lists the credentials and updates the
  `API_TOKEN` credential named `Claude`, or rethrows when there is none. An
  answer without `credentialDescription` fails `invalid_output`.
- The callback server listens on port 54545, falling back to 54546. `Finish`
  can wait up to 10 minutes; the process transport (S60) must not shorten it.

The kernel entry stays until S62. Since S62c1 the manifest provides
`claude.login/v1@1.1.0`; `secrets/v1` stays required.

## Client part

[`src/client/index.ts`](src/client/index.ts) `activate` uses `ui/v1` and
`regions/v1` to:

- define the element `claude-login-field`
  ([`src/client/claude-login-field.tsx`](src/client/claude-login-field.tsx));
- add to the slot `settings.provider.field` the item
  `{ id: 'claude-login', tag: 'claude-login-field', props: { kind: 'claude', field: 'token' } }`.

Its cleanup removes both, in reverse order. `settings` draws the element in
place of the `claude` kind's `token` field and names neither this bundle nor
the kind ([`slots.ts`](../../desktop/settings/src/contracts/slots.ts)). In a
composition without `settings`, nothing draws the item. The part has no
stylesheet of its own: it uses components of `desktop/ui` and utility
classes, which the renderer's stylesheet emits for every bundle's
`src/client/`.

### The element `claude-login-field`

Props: `view?: ProviderFieldView`, which `settings` sets: `{ kind; field;
value?; label?; problem?: 'missing' | 'unknown' }`, where `label` is the name
of the stored credential `value` names
([`slots.ts`](../../desktop/settings/src/contracts/slots.ts)). The element
draws nothing until `view` is set. Then it draws one field
([`src/client/claude-login-field.tsx`](src/client/claude-login-field.tsx)):

- The label "Claude login".
- A button: "Sign in with Claude" when `view.label` is absent, "Sign in again"
  when it is present, and "Waiting for the browser…", disabled, while a
  sign-in waits. Beside it, while a sign-in waits, a "Cancel" button.
- A description: with no `view.label`, "Signs in with a Claude Code
  subscription: the browser opens, and the login is stored as a credential
  this provider uses."; with one, "Signed in: this provider uses the
  '<label>' credential. When Claude requests fail with an authentication
  error, the login expired or was revoked: sign in again."
- While a sign-in waits and its URL is known, "If the browser did not open,
  visit <url>", with the URL selectable.
- While `view.problem` is set, an error line: "Sign in with Claude to finish
  this provider." for `missing`, and "The credential this provider names is
  no longer stored: sign in with Claude again." for `unknown`.

### The sign-in

The hook `useClaudeLogin` drives one sign-in
([`src/client/use-claude-login.ts`](src/client/use-claude-login.ts)), through
the adapter of [`src/client/api.ts`](src/client/api.ts) over the element's
services:

1. The button calls `start` of `claude.login/v1` with the hook's own abort
   signal, and shows the answered URL.
2. It asks `doric.browser/v1` to open the URL in the system browser. When the
   browser does not open, the sign-in goes on waiting, with the URL shown.
3. It calls `finish` with the same signal.
4. When `finish` answers, it dismisses the toast `claude-login-failed`. With
   the element still mounted, it dispatches the DOM event
   `settings-provider-field`, bubbling and composed, with
   `detail: { value: credential.id }`, from the `div` with the class
   `contents` that wraps the row, then shows the success toast "Claude is
   signed in." (id `claude-login`). When `view` is unset at that moment, the
   row is not drawn, so no event is sent, and the success toast still shows.
   `settings` answers the event by reading its credentials again and writing
   the id into the `token` field
   ([`use-provider-page.ts`](../../desktop/settings/src/client/hooks/use-provider-page.ts)).
   Unmounting the element does not cancel the sign-in: the hook aborts
   nothing on unmount. When `finish` answers after the element is unmounted,
   the hook dispatches nothing and shows no success; it shows the info toast
   "Claude sign-in finished after its page closed; sign in again from the
   provider page to use it." (id `claude-login-finished`).
5. When a call fails, it shows an error toast under the id
   `claude-login-failed` through `toastError` of `desktop/ui/error-notice`,
   with the catalog `claudeLoginErrorCatalog` and the fallback code
   `sign_in_failed` ([`src/client/error-catalog.ts`](src/client/error-catalog.ts),
   [`error-notice.tsx`](../../../packages/desktop/src/error-notice.tsx)). The
   catalog's one entry is `sign_in_failed`, titled "Sign-in failed" and not
   retryable; it has no explanation, so the toast shows the error's own
   message. A failure after the hook's own Cancel shows no toast.
6. However it ends, the row leaves its waiting state and forgets the URL.

Cancel aborts the hook's signal, which cancels the call in flight and, on the
host, the sign-in.

The adapter `createClaudeLoginApi(services)` has three members:
`start(call?)` answers the URL, `finish(call?)` answers the
`CredentialDescription`, and `openBrowser(url)` calls `doric.browser/v1`'s
`open`. `openBrowser` passes its rejection through as it is. `start` and
`finish` turn each rejection into a `ClientError` of `desktop/reads`: a `ContractError` keeps its code and message,
with the error as `cause` unless its code is `internal`; any other error
becomes `internal` with the message "The request could not be completed."
([`src/client/api.ts`](src/client/api.ts)).

## Limits

- One sign-in waits at a time per activation; a second `start` cancels the
  first.
- A sign-in waits at most ten minutes for `finish` and the browser.
- The callback reaches the host only where the browser's `localhost` is the
  host's: a host on the same machine, run natively or in Docker with
  `network_mode: host`. For a remote host, `npm run claude:oauth`
  ([`scripts/claude-oauth.mjs`](../../../scripts/claude-oauth.mjs)) runs the
  authorization on the machine with the browser and writes the authorization
  value into the root `.env` under the key `CLAUDE_AUTHORIZATION`, or the key
  `CLAUDE_OAUTH_OUTPUT_KEY` names, from where it can be stored as a credential
  by hand.

## Build and test

Run from the repository root:

```console
npx nx run bundle-claude-login:build
npx nx run bundle-claude-login:typecheck
npx nx run bundle-claude-login:test
```

`build` compiles the contracts and host part with `tsc --build`, type-checks
the client part with `tsconfig.client.json`, and runs the bundle build, which
writes `dist/` ([`project.json`](project.json)). `typecheck` runs
`tsc --build tsconfig.json --emitDeclarationOnly` for the contracts and host
part and `tsc -p tsconfig.client.json` for the client part. `test` compiles the tests
into `dist-tests/` and runs them with `node --test`:

- [`tests/login.test.ts`](tests/login.test.ts) activates the host part through
  `createActivate` with fake OAuth seams
  ([`tests/support/world.ts`](tests/support/world.ts)) and covers each answer
  and each refusal of `finish`, the replacement of a waiting sign-in, the
  fallback port, the timeout and deactivation.
- [`tests/manifest.test.ts`](tests/manifest.test.ts) checks the manifest's
  version, engine range, `provides` and `requires`.
- [`tests/client/`](tests/client/) runs in a `happy-dom` window, with
  `--test-force-exit`: the activation
  ([`activate.test.ts`](tests/client/activate.test.ts)), the adapter and its
  error mapping, with `doric.browser/v1` served by hand
  ([`api.test.ts`](tests/client/api.test.ts)), and the element mounted alone
  ([`claude-login.test.ts`](tests/client/claude-login.test.ts)).
