# Codex provider bundle

`codex` provides the internal `codex` provider kind as one
`models.provider/v1` record. The kind descriptor is the one the closed `llms`
catalog declared, unchanged.

- `advertised()` is false, so `models/v1.kinds()` does not list it, while
  `models/v1.kind('codex')` still resolves it. `catalogCapacity()` is false.
- `catalog()` is always `absent`.
- `create` checks the required `token` and the `fedramp` flag, then builds the
  `llms` Codex provider.

The `llms` logger is a pino logger whose records go to `log/v1`.
