# Claude login bundle

`claude-login` signs the settings window in to a Claude Code subscription.
The provider page of the `claude` kind offers a sign-in no other kind draws:
the browser opens Claude's authorization page, and the credential the sign-in
stores becomes the provider's `token` field.

It is a feature bundle with a host part and a client part, loaded by the
`bundle` platform. It needs the desktop app of platform 1.7.0 or later
(`engines.doric` `^1.7.0`, since 1.1.0) and requires `secrets/v1`, `ui/v1` and
`regions/v1`.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `claude.login/v1`, with `start` and `finish`.
- **Element:** `<claude-login-field>`, the sign-in row of the `claude` kind's
  provider page, added to `settings.provider.field` (from 1.1.0).

## Host

The host may run where no browser does (a container, another machine), so it
never opens one; the window does, through `doric.browser/v1`.

- **`start()`.** Binds Claude Code's own loopback callback,
  `localhost:54545/callback` (falling back to `:54546` when the port is busy),
  prepares the authorization and answers its `https:` URL. A new `start()`
  cancels and replaces a sign-in still waiting; one nobody finishes is
  cancelled after ten minutes, and when the bundle deactivates.
- **`finish()`.** Waits for the browser's callback, exchanges the code for the
  long login (`expires_in` of a year) and stores the authorization value —
  only its `authorization` header form — through `secrets/v1` as the
  `API_TOKEN` credential named `Claude`. A `credential_name_taken` refusal
  re-reads the store and replaces the secret of the same-name credential. The
  value is never logged, and `finish()` answers the credential's public view,
  never the secret.
- **Refusals.** `claude_login_not_started` with no sign-in waiting,
  `claude_login_busy` while another `finish()` waits on it,
  `claude_login_aborted` when the call is cancelled or a newer `start()`
  replaced it (nothing is stored), and `claude_login_failed` when the
  authorization itself fails (for example, the user denied it).
- **No reuse.** An existing Claude Code login (`~/.claude`) is never reused:
  its access token expires within hours, and nothing would refresh a stored
  copy. The callback server is closed however the sign-in ends.

## Settings integration

The client part (`src/client/`) draws the sign-in in the `settings` bundle's
provider page; `settings` names neither this bundle nor the `claude` kind.

- **The item.** `activate` defines `<claude-login-field>` and adds
  `{ id: 'claude-login', tag: 'claude-login-field', props: { kind: 'claude', field: 'token' } }`
  to the slot `settings.provider.field`, so `settings` draws the element in
  place of the `claude` kind's `token` field. It imports `settings/contracts`
  as types only, and the slot name as a checked literal.
- **The element.** `settings` sets its `view` (`ProviderFieldView`). The row
  reads "Claude login", with "Sign in with Claude" (or "Sign in again" once
  `view.label` names the stored credential) and, while a sign-in waits,
  "Waiting for the browser…", Cancel and the authorization URL. While
  `view.problem` is set it shows the message in its own row: "Sign in with
  Claude to finish this provider." (`missing`) or "The credential this
  provider names is no longer stored: sign in with Claude again."
  (`unknown`).
- **The sign-in.** The `useClaudeLogin` hook calls `claude.login/v1`'s
  `start`, opens the URL in the system browser through `doric.browser/v1` (a
  browser that fails to open leaves the URL on screen), and waits on `finish`.
  A finished sign-in dispatches the bubbling, composed DOM event
  `settings-provider-field` with `detail: { value: credential.id }`, on which
  `settings` reads its credentials again and writes the id into the `token`
  field; then it toasts "Claude is signed in." (id `claude-login`), after
  dismissing a failure. A failure toasts under `claude-login-failed` with
  the bundle's own catalog (`sign_in_failed`, "Sign-in failed"); the hook's
  own Cancel aborts the call without a failure toast. A sign-in that finishes
  after its element is disposed (from 1.1.1) writes nothing and toasts no
  success, since nothing would select the credential: it shows the info toast
  "Claude sign-in finished after its page closed; sign in again from the
  provider page to use it." (id `claude-login-finished`), and the user signs
  in again.
- **The adapter.** `src/client/api.ts` makes the calls over the element's
  services, a child scope that ends when the element is released. A refusal
  other than `internal` keeps its code and message with the error as `cause`;
  anything else is `internal`.

Without `settings` the item is added to a slot nobody draws. Before `settings`
1.12.0 it drew the row itself and listed `claude.login/v1` under `optional`.

## Limits

The callback reaches the host only where the browser's `localhost` is the
host's: a host on the same machine, natively or in Docker with
`network_mode: host`. For a remote host, the `npm run claude:oauth` CLI flow
writes the authorization value into the environment instead.

## Development

```console
npx nx build bundle-claude-login
npx nx typecheck bundle-claude-login
npx nx test bundle-claude-login
```

`tests/*.test.ts` test the host part and the manifest; `tests/client/*.test.ts`
test the activation and mount `<claude-login-field>` alone in a happy-dom
window. `tests/client/api.test.ts` serves `doric.browser/v1` by hand, since a
bundle cannot define a platform contract.

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
