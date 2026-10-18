# OpenRouter provider bundle

`openrouter` lets Doric run its agents on the models OpenRouter serves. It
reads OpenRouter's live model catalog, so Doric knows each model's context
window, and it repairs rejected structured responses with corrected attempts.
You choose the stored API token and the model when you connect a model
provider in the desktop app.

It is a provider bundle that registers the `openrouter` kind as one
`models.provider/v1` record, which the core's `models/v1` lists and resolves.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Configuration

| Field                        | Required | Meaning                                                     |
| ---------------------------- | -------- | ----------------------------------------------------------- |
| `token`                      | Yes      | The stored `API_TOKEN` credential to authenticate with.     |
| `endpoint`                   | No       | The base URL; absent uses the OpenRouter default.           |
| `maxStructuredOutputRepairs` | No       | Corrected attempts a rejected structured response gets.     |
| `modelsUrl`                  | No       | Where the provider lists its models and their capabilities. |

`maxStructuredOutputRepairs` and `modelsUrl` are advanced fields.

## Behavior

The kind descriptor is the one the closed `llms` catalog declared, unchanged.

- `advertised()` and `catalogCapacity()` are true: usage reads context capacity
  from this kind's live catalog.
- `catalog({ configuration, secret })` reads `modelsUrl`, else
  `<endpoint>/models`, else the OpenRouter default. A non-empty `secret` is sent
  as a bearer token. A failed read is `failed`; the caller (`models/v1`) logs it.
- `create` checks the required fields and the numeric
  `maxStructuredOutputRepairs`, then builds the `llms` OpenRouter provider.

The `llms` logger is a pino logger whose records go to `log/v1`.

## Development

```console
npx nx build bundle-openrouter
npx nx typecheck bundle-openrouter
npx nx test bundle-openrouter
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
