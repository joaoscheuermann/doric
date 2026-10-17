# config

`config` validates agent configuration carried in message metadata. It owns the
GitHub repository, provider, model, and task shape used by that message-based
surface; the Direct host's persisted REST configuration is documented in
`app/backend/doric-host` instead.

## Use

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

Use `parseInitialMessageConfig(message)` when the first message must contain
`message.metadata.configuration`. Use `parseMessageConfigUpdate(message)` for
later messages; it returns `undefined` when no update is present.

Invalid input throws `ConfigParseError`, whose `code` distinguishes an invalid
message, missing configuration, or invalid field and whose `path` identifies
the failing value. Reasoning effort accepts `none`, `minimal`, `low`, `medium`,
`high`, or `xhigh`.

## Development

```console
npx nx build config
npx nx test config
```
