# Claude provider bundle

`claude` registers the `claude` provider kind, a Claude Code subscription
login answered by Anthropic's Messages API. It is a user-facing option: the
kind is advertised, so it appears in the list of provider kinds you can choose
when you connect a model.

It is a provider bundle that registers the kind as one `models.provider/v1`
record, which the core's `models/v1` resolves. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Behavior

The kind sends Anthropic Messages requests with the Claude Code OAuth beta
headers, authenticated with a stored Claude authorization value. To log in,
run `npm run claude:oauth` once: it starts a Claude Code OAuth flow in your
browser and saves the resulting authorization header to the root `.env`
under `CLAUDE_AUTHORIZATION`. Create an `API_TOKEN` credential whose secret
is that value, and name that credential in the kind's `token` field.

- `advertised()` is true, so `models/v1.kinds()` lists it.
  `catalogCapacity()` is false.
- `catalog()` is always `absent`. The kind keeps no live catalog: model names
  are typed by hand, because Anthropic's models endpoint lists ids and
  display names but says nothing about a model's capabilities.
- `create` checks the required `token` (the stored `API_TOKEN` credential
  that carries the Claude authorization value), then builds the `llms`
  Claude provider. The optional field is the endpoint.

A login does not last forever: Claude Code's token endpoint may refuse the
long-login request the script asks for, so when requests start failing with
`auth_failed`, run `npm run claude:oauth` again and update the credential's
secret.

The `llms` logger is a pino logger whose records go to `log/v1`.

## Development

```console
npx nx build bundle-claude
npx nx typecheck bundle-claude
npx nx test bundle-claude
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
