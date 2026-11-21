# claude-login

Apply these rules to `bundles/features/claude-login/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to signing in to a Claude Code subscription through the
browser and storing the result as the `API_TOKEN` credential named `Claude`.
Add to it no provider kind, model, request to Claude or other use of the
stored credential: using the credential belongs to the provider bundle of the
`claude` kind. Draw nothing but the sign-in row of the `claude` kind's
`token` field: the provider page and its other fields belong to the bundle
that draws the settings window.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Never open a browser from `src/host/`: the host may run where no browser
  runs. Answer the authorization URL from `start`, and open it only from
  `src/client/` through `doric.browser/v1`.
- Pass the authorization value only to `secrets/v1`: never log it, never
  answer it through `claude.login/v1` (`finish` answers only the
  `CredentialDescription`), and never write it to a file, a setting or a
  token store that outlives the sign-in.
- Never read or reuse an existing Claude Code login: nothing in this bundle
  refreshes a stored token, so every sign-in runs a fresh authorization.
- Keep the waiting sign-in inside the `loginService` closure of
  `src/host/login.ts`, one per activation. End a sign-in that has not
  finished only through `cancel`, which aborts its authorization. Once the
  wait in `finish` ends, clear the waiting sign-in and its timer in `finish`.
  Store nothing after the call's signal aborts.
- Close the callback server on every way a sign-in ends. `begin` leaves it
  open when creating the transport or the OAuth client throws: when you
  change `begin`, close the server on that path too.
- Never leave the authorization's promise without a rejection handler: an
  unhandled rejection ends the host process.
- Take the OAuth client id, endpoints, scope, callback host, ports and path
  from the `oauth` package, and change them there, never in this bundle.
- Reach every outside piece the host part uses (callback server, OAuth
  client, transport, timeout) through a member of `ClaudeLoginDeps` with the
  real piece as its default, so that tests inject a fake.
- Refuse in the host part only with a `ContractError` whose code starts with
  `claude_login_`, except that a `ContractError` of the authorization or of
  `secrets/v1` passes through unchanged; list each code in the doc comment of
  the method that raises it in `src/contracts/index.ts` and in the README's
  error table.
- Make every call of the client part through `createClaudeLoginApi` in
  `src/client/api.ts`, and keep its mapping of every rejection of `start` and
  `finish` to a `ClientError`.
- Answer the page only with the DOM event `settings-provider-field`, bubbling
  and composed, with `detail: { value: <credential id> }`, and only while the
  element is mounted; never write the settings window's state or caches.
- Import only types from `settings/contracts`: the manifest lists no contract
  of `settings`, so the bundle loads in a composition without it.
- Keep the toast ids `claude-login` (success), `claude-login-failed`
  (failure) and `claude-login-finished` (a sign-in that finished after its
  element was gone), and show no toast for a failure caused by the hook's own
  Cancel.
- Add to `claudeLoginErrorCatalog` in `src/client/error-catalog.ts` an entry
  for each error code the sign-in toast gives its own title, and keep
  `sign_in_failed` as its fallback code.
- Style the row only with components of `desktop/ui` and utility classes, and
  add no `src/client/styles.css`.
- Put a new step of the sign-in on the host in `src/host/login.ts`, and a new
  method of `claude.login/v1` in the `ClaudeLogin` interface and in
  `claudeLoginMethods` of `src/contracts/index.ts` and in the `defineService`
  of `src/host/login.ts`, with `expose: 'desktop'` when a window calls it.
- Put a change to the row in `src/client/claude-login-field.tsx`, a change to
  how a sign-in runs in `src/client/use-claude-login.ts`, and a new call in
  `src/client/api.ts`.
- Test a change to the host part in [`tests/login.test.ts`](tests/login.test.ts)
  through `createActivate` with the fakes of
  [`tests/support/world.ts`](tests/support/world.ts), never with a real port
  or network; a change to the manifest in
  [`tests/manifest.test.ts`](tests/manifest.test.ts); a change to the
  activation, the adapter or the row in the matching file of
  [`tests/client/`](tests/client/), through its `support/` helpers.
- Update the feature doc
  [Provider sign-in](../../../docs/features/provider-sign-in.md) with any
  change to how the sign-in runs or what it stores,
  [Credentials](../../../docs/features/credentials.md) with any change to the
  credential it stores, and
  [Error messages](../../../docs/features/error-messages.md) with any change
  to the row's toasts or catalog, in the same change.

## Verify

- `npx nx run bundle-claude-login:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-claude-login:test`: run it after any change under `src/`
  or `tests/`, and run the tests only through this target.
- `npx nx run bundle-claude-login:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or
  `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
