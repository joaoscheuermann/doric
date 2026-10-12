# OpenRouter provider bundle

`openrouter` provides the `openrouter` provider kind as one
`models.provider/v1` record. The kind descriptor is the one the closed `llms`
catalog declared, unchanged.

- `advertised()` and `catalogCapacity()` are true: usage reads context capacity
  from this kind's live catalog.
- `catalog({ configuration, secret })` reads `modelsUrl`, else
  `<endpoint>/models`, else the OpenRouter default. A non-empty `secret` is sent
  as a bearer token. A failed read is `failed`; the caller (`models/v1`) logs it.
- `create` checks the required fields and the numeric
  `maxStructuredOutputRepairs`, then builds the `llms` OpenRouter provider.

The `llms` logger is a pino logger whose records go to `log/v1`.
