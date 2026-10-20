# config

A dependency-free validator for agent configuration carried in message
metadata. It turns untrusted input into a typed `AgentConfig` describing the
GitHub repository, providers, models, and tasks, and it reports the exact path
of the first invalid value. Use it on a message-based surface where the first
message carries the configuration and later messages may update it.

Part of [Doric](../../README.md). The Doric host's persisted REST
configuration is documented in `app/backend/doric-host` instead.

## Highlights

- **Typed result.** Returns a plain `AgentConfig` with optional fields omitted
  rather than set to `undefined`.
- **Precise errors.** `ConfigParseError` carries a `code` and a `path` such as
  `message.metadata.configuration.models[0].effort`.
- **Message-aware helpers.** Separate parsers for the required initial
  configuration and for optional later updates.
- **No dependencies** beyond `tslib`.

## Usage

```ts
import { parseConfig } from 'config';

const config = parseConfig({
  github: {
    repo: {
      url: 'https://github.com/acme/example.git',
      branch: 'main',
    },
    token: process.env['GITHUB_TOKEN'],
  },
  providers: [
    {
      id: 'codex',
      type: 'codex',
      token: process.env['CODEX_AUTHORIZATION'],
    },
  ],
  models: [
    {
      id: 'default',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    },
  ],
  tasks: [{ id: 'coding', model: 'default' }],
});
```

## API

| Function                             | Behavior                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `parseConfig(value, path?)`          | Validates a configuration object; `path` prefixes error paths (`config` default). |
| `parseInitialMessageConfig(message)` | Requires `message.metadata.configuration` and validates it.                       |
| `parseMessageConfigUpdate(message)`  | Validates `message.metadata.configuration` if present; otherwise `undefined`.     |

## Shape

| Field         | Required fields           | Optional fields                       |
| ------------- | ------------------------- | ------------------------------------- |
| `github`      | `repo.url`, `token`       | `repo.branch`                         |
| `providers[]` | `id`, `type`              | `token`, `baseUrl`                    |
| `models[]`    | `id`, `provider`, `model` | `effort`, `reasoning`, `internal_key` |
| `tasks[]`     | `id`, `model`             |                                       |

Reasoning effort accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
or `max`. `reasoning` is the legacy name for `effort`; when both are set they
must match. The parser checks shape and types only; it does not check that a
task's `model` or a model's `provider` names an entry that exists.

## Errors

Invalid input throws `ConfigParseError`, whose `code` distinguishes an invalid
message (`invalid_message`), missing configuration (`missing_configuration`),
or invalid field (`invalid_config_field`) and whose `path` identifies the
failing value.

## Development

```console
npx nx build config
npx nx typecheck config
npx nx test config
```
