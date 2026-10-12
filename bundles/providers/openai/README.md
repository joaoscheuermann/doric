# OpenAI provider bundle

`openai` provides the `openai` provider kind as one `models.provider/v1`
record. The kind descriptor is the one the closed `llms` catalog declared,
unchanged.

- `advertised()` is true and `catalogCapacity()` is false.
- `catalog()` is always `absent`: the kind has no `modelsUrl` field.
- `create({ providerId, values, secret })` checks the required fields, then
  builds the `llms` OpenAI Responses provider with the provider id as its
  identity. `secret` is the source of the `token` field, awaited before every
  request.

The `llms` logger is a pino logger whose records go to `log/v1`.
