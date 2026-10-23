# Claude login bundle

`claude-login` signs the settings window in to a Claude Code subscription.
The provider page of the `claude` kind offers a sign-in no other kind draws:
one that reuses an existing Claude Code login when one is present and opens a
fresh browser authorization otherwise, and then names the credential it
stored as the provider's `token` field.

It is a feature bundle with a host part only, loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `claude.login/v1`, with `login`.

## Host

`claude.login/v1.login()` signs in to Claude, one at a time:

- **Reuse first.** A working Claude Code login — `~/.claude` (or
  `CLAUDE_CONFIG_DIR`), or `CLAUDE_AUTHORIZATION` — answers the call by itself
  through `resolveClaudeAuth`, and no browser opens. A resolve failure that is
  not an aborted call falls through to the fresh flow, because a broken
  `~/.claude` login must never block a fresh sign-in.
- **Fresh flow.** The loopback callback server binds Claude Code's own
  `localhost:54545/callback` (falling back to `:54546` when the port is busy),
  the browser opens the authorization URL, and the code is exchanged for
  tokens. The flow keeps its token record in an in-memory store — the durable
  copy is the credential this bundle writes after the flow answers — and the
  callback server is closed however the flow ends, in a `finally`.
- **Storage.** The authorization value — only its `authorization` header
  form, never a rendered token — is stored through `secrets/v1` as the
  `API_TOKEN` credential named `Claude`. A `credential_name_taken` refusal
  (another bundle stored one under that name) re-reads the store and replaces
  the secret of the same-name credential. The value is never logged, and
  `login()` answers the credential's public view, never the secret.
- **One at a time.** A second `login()` while one is running answers
  `claude_login_busy`. A cancelled call answers `claude_login_aborted` on
  every path (reuse, fresh flow, storage) and stores nothing.

## Settings integration

The `settings` bundle imports this package (`claude-login/contracts`), its
manifest requires `claude.login/v1`, and its API exposes the answer as
`SettingsApi.claude.login`. The provider page of the `claude` kind draws a
"Sign in with Claude" row that drives the `useClaudeLogin` hook: the hook
settles the answered credential into the `credentials` query cache before it
publishes it, so the page's auto-select effect commits a `token` value the
configuration already accepts, and the sign-in toast names the result. The
hook's own cancel aborts the call without a failure toast.

## Limits

The fresh flow opens the browser on the machine the host runs on; a remote
host needs a reachable browser, and the `npm run claude:oauth` CLI flow writes
the authorization value into the environment for such hosts instead.

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
