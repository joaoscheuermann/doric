# Models adapter bundle

`models-adapter` is a provisional installed bundle. Its host part provides one
`models.provider/v1` record for each `llms` provider kind, in the `llms` order:
`openai`, `openrouter` and `codex`. The core's `models/v1` builds and resolves
providers through these records. Stage 10 replaces this bundle with the
`openai`, `openrouter` and `codex` bundles.

Each record does the following:

- `kind()` returns the `llms` `ProviderKind` unchanged.
- `advertised()` is false only for `codex`.
- `catalog({ configuration, secret })` reads the kind's models URL. It returns
  `absent` for a kind without a `modelsUrl` field and `failed` when the read
  fails.
- `create({ providerId, values, secret })` builds the `llms` provider. It uses
  the provider id as the provider's identity and passes `secret` as the source
  of the kind's secret field. `llms` awaits that source before every request,
  so a rotated credential reaches the next request.

The `llms` logger is a pino logger whose records go to `log/v1`.
