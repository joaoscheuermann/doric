# Claude login bundle

`claude-login` signs the settings window in to a Claude Code subscription.
The provider page of the `claude` kind offers a sign-in no other kind draws:
the browser opens Claude's authorization page, and the credential the sign-in
stores becomes the provider's `token` field.

It is a feature bundle with a host part only, loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `claude.login/v1`, with `start` and `finish`.

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

The `settings` bundle imports this package (`claude-login/contracts`), its
manifest requires `claude.login/v1`, and its API exposes the two calls as
`SettingsApi.claude.start` and `SettingsApi.claude.finish`. The provider page
of the `claude` kind draws a "Sign in with Claude" row that drives the
`useClaudeLogin` hook: it starts the sign-in, opens the URL in the system
browser, shows that URL while it waits, and settles the answered credential
into the `credentials` query cache before it publishes it, so the page's
auto-select effect commits a `token` value the configuration already accepts.
The hook's own cancel aborts the call without a failure toast.

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

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
