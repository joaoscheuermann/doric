# Codex provider bundle

`codex` keeps the internal `codex` provider kind available to Doric's model
layer. It is not a user-facing option: the kind is not advertised, so it does
not appear in the list of provider kinds you can choose when you connect a
model. To connect a model, use the [`openai`](../openai/README.md) or
[`openrouter`](../openrouter/README.md) kinds instead.

It is a provider bundle that registers the kind as one `models.provider/v1`
record, which the core's `models/v1` resolves. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Behavior

The kind targets the ChatGPT Codex Responses backend, authenticated with a
Codex authorization value. Its descriptor is the one the closed `llms`
catalog declared, unchanged.

- `advertised()` is false, so `models/v1.kinds()` does not list it, while
  `models/v1.kind('codex')` still resolves it. `catalogCapacity()` is false.
- `catalog()` is always `absent`.
- `create` checks the required `token` (the stored `API_TOKEN` credential that
  carries the authorization value) and the `fedramp` flag, then builds the
  `llms` Codex provider. The optional fields are the endpoint and the ChatGPT
  account id.

The `llms` logger is a pino logger whose records go to `log/v1`.

## Development

```console
npx nx build bundle-codex
npx nx typecheck bundle-codex
npx nx test bundle-codex
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
