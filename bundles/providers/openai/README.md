# OpenAI provider bundle

`openai` lets Doric run its agents on any endpoint that answers the OpenAI
Responses API: OpenAI itself or a compatible server you point it at. You
choose the endpoint, the stored API token and the model when you connect a
model provider in the desktop app.

It is a provider bundle that registers the `openai` kind as one
`models.provider/v1` record, which the core's `models/v1` lists and resolves.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Configuration

| Field      | Required | Meaning                                                         |
| ---------- | -------- | --------------------------------------------------------------- |
| `endpoint` | No       | The base URL; absent uses the `llms` default endpoint.          |
| `token`    | No       | The stored `API_TOKEN` credential; absent sends no auth header. |

## Behavior

The kind descriptor is the one the closed `llms` catalog declared, unchanged.

- `advertised()` is true and `catalogCapacity()` is false.
- `catalog()` is always `absent`: the kind has no `modelsUrl` field.
- `create({ providerId, values, secret })` checks the required fields, then
  builds the `llms` OpenAI Responses provider with the provider id as its
  identity. `secret` is the source of the `token` field, awaited before every
  request, so a rotated credential reaches the next request.

The `llms` logger is a pino logger whose records go to `log/v1`.

## Development

```console
npx nx build bundle-openai
npx nx typecheck bundle-openai
npx nx test bundle-openai
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
