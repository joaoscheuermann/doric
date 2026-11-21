# config

A dependency-free validator for agent configuration carried in message metadata. It turns untrusted input into a typed `AgentConfig` that describes a GitHub repository, model providers, models and tasks, and it reports the path of the first invalid value it finds. It is meant for a message-based surface where the first message of a conversation carries the configuration in `metadata.configuration` and later messages may replace it.

Part of [Doric](../../README.md). No bundle, application or other package in the repository imports it; its only caller is its own test suite ([`config.test.ts`](tests/config.test.ts)). The Doric host's stored configuration of providers and models is a different mechanism, described in the host README's [Configuration and providers](../../app/backend/doric-host/README.md#configuration-and-providers). The feature doc [Models and providers](../../docs/features/models-and-providers.md#message-carried-configuration) states how these model fields relate to the host's providers and models.

The package has no side effects: it starts no process, opens no file or connection, sets no timer and emits no event. Every function is synchronous and pure, apart from the error it throws.

## Entry point

[`package.json`](package.json) declares one entry point, the package root `config`, as an ES module:

| Condition     | File                                    |
| ------------- | --------------------------------------- |
| `@org/source` | [`src/index.ts`](src/index.ts) (source) |
| `types`       | `dist/index.d.ts`                       |
| `import`      | `dist/index.js`                         |
| `default`     | `dist/index.js`                         |

`./package.json` is exported as well. [`src/index.ts`](src/index.ts) re-exports everything [`src/lib/config.ts`](src/lib/config.ts) exports, which is the whole public API below. The only runtime dependency is `tslib`.

## Public API

### Functions

All three are defined in [`config.ts`](src/lib/config.ts).

```ts
function parseConfig(value: unknown, path?: string): AgentConfig;
function parseInitialMessageConfig(message: unknown): AgentConfig;
function parseMessageConfigUpdate(message: unknown): AgentConfig | undefined;
```

- **`parseConfig(value, path = 'config')`** validates a configuration object and returns a new `AgentConfig`. `path` is the prefix of every error path, so an error inside `value` reads `config.models[0].effort` by default.
- **`parseInitialMessageConfig(message)`** reads the configuration of the first message of a conversation, which must carry one. `message` must be an object; its `metadata` must be present and an object, and `metadata.configuration` must be present. The configuration is then validated with `parseConfig` under the path prefix `message.metadata.configuration`.
- **`parseMessageConfigUpdate(message)`** reads the configuration of a later message, which may carry none. `message` must be an object. When `message.metadata` is absent it returns `undefined`. A present `metadata` must be an object; when its `configuration` is absent it returns `undefined`, and otherwise the configuration is validated as in `parseInitialMessageConfig`.

The other properties of a message (such as `parts`) are not read: a configuration placed anywhere but `metadata.configuration` is not found.

| Input to the message functions                        | `parseInitialMessageConfig`                                            | `parseMessageConfigUpdate`                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `message` is not an object (or is `null` or an array) | throws `invalid_message` at `message`                                  | throws `invalid_message` at `message`                                  |
| `metadata` is absent (`undefined`)                    | throws `missing_configuration` at `message.metadata.configuration`     | returns `undefined`                                                    |
| `metadata` is present but not an object               | throws `invalid_config_field` at `message.metadata`                    | throws `invalid_config_field` at `message.metadata`                    |
| `metadata.configuration` is absent (`undefined`)      | throws `missing_configuration` at `message.metadata.configuration`     | returns `undefined`                                                    |
| `metadata.configuration` is present                   | returns `parseConfig(configuration, 'message.metadata.configuration')` | returns `parseConfig(configuration, 'message.metadata.configuration')` |

### Types

Defined in [`types/config.ts`](src/lib/types/config.ts) and [`types/error.ts`](src/lib/types/error.ts); every property is `readonly`.

```ts
type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

interface AgentConfig {
  readonly github: GithubConfig;
  readonly providers: readonly ProviderConfig[];
  readonly models: readonly ModelConfig[];
  readonly tasks: readonly TaskConfig[];
}

interface GithubConfig {
  readonly repo: { readonly url: string; readonly branch?: string };
  readonly token: string;
}

interface ProviderConfig {
  readonly id: string;
  readonly type: string;
  readonly token?: string;
  readonly baseUrl?: string;
}

interface ModelConfig {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly reasoning?: ReasoningEffort;
  readonly internal_key?: string;
}

interface TaskConfig {
  readonly id: string;
  readonly model: string;
}

type ConfigParseErrorCode =
  | 'invalid_message'
  | 'missing_configuration'
  | 'invalid_config_field';

interface ConfigParseIssue {
  readonly code: ConfigParseErrorCode;
  readonly path: string;
  readonly message: string;
}
```

`ConfigParseIssue` describes the same three facts a `ConfigParseError` carries, as plain data; no function of the package returns or accepts it.

### `ConfigParseError`

Defined in [`parse-error.ts`](src/lib/classes/parse-error.ts):

```ts
class ConfigParseError extends TypeError {
  readonly code: ConfigParseErrorCode;
  readonly path: string;
  constructor(code: ConfigParseErrorCode, path: string, message: string);
}
```

Its `name` is `'ConfigParseError'`, its `message` is the third constructor argument, and its prototype is set explicitly so that `instanceof ConfigParseError` (and `instanceof TypeError`) holds. Every validation failure of the three functions throws one. The functions only read properties of their input, so another error can come only from the input itself, such as a getter that throws.

## Validation rules

`parseConfig` ([`config.ts`](src/lib/config.ts)) checks shape and types only, in this order, and throws at the first failure:

1. The value is an object. "Object" means a non-`null` value of type `object` that is not an array ([`object.ts`](src/lib/utils/object.ts)).
2. `github`: an object; then `github.repo`, an object; then `repo.branch` (optional string), `repo.url` (string) and `github.token` (string).
3. `providers`: an array; then each entry in index order: an object; `token` (optional string); `baseUrl` (optional string); `id` (string); `type` (string).
4. `models`: an array; then each entry in index order: an object; `effort` (optional `ReasoningEffort`); `reasoning` (optional `ReasoningEffort`); `internal_key` (optional string); `effort` and `reasoning` agree when both are set; `id`, `provider` and `model` (strings).
5. `tasks`: an array; then each entry in index order: an object; `id` and `model` (strings).

What the rules mean for callers:

- **Required and optional.** A required field must be a string (or, for the four top-level fields, the stated object or array). An optional field may be absent or `undefined`; any other value, `null` included, must be a string, and for `effort` and `reasoning` one of the seven `ReasoningEffort` values.
- **The result is a new object.** It holds only the fields listed in [Types](#types). Unknown properties, at any level, are dropped. An optional field that is absent or `undefined` is omitted from the result, not set to `undefined`. Fields are read by ordinary property access, so inherited properties are accepted.
- **`effort` and `reasoning`.** Both name a model's reasoning effort and accept the same values. Either may be set alone; when both are set they must be equal, else the error is reported at the model's `effort` path. Both are kept in the result as given; the package does not copy one into the other.
- **What is not checked.** Empty strings and empty arrays are accepted. URLs, tokens and branch names are not checked for form. Duplicate `id`s are accepted. A model's `provider` and a task's `model` are not checked against the `id`s of `providers` and `models`. A provider's `type` is any string. A hole in a sparse `providers`, `models` or `tasks` array is not validated and stays a hole in the result ([`config.ts`](src/lib/config.ts)); JSON input has no holes.

Example:

```ts
import { parseConfig } from 'config';

const config = parseConfig({
  github: {
    repo: { url: 'https://github.com/acme/example.git', branch: 'main' },
    token: process.env['GITHUB_TOKEN'],
  },
  providers: [
    { id: 'codex', type: 'codex', token: process.env['CODEX_AUTHORIZATION'] },
  ],
  models: [
    { id: 'default', provider: 'codex', model: 'gpt-5.5', effort: 'high' },
  ],
  tasks: [{ id: 'coding', model: 'default' }],
});
```

If `GITHUB_TOKEN` is unset, the call throws `ConfigParseError` with code `invalid_config_field`, path `config.github.token` and message `Expected a string`. The package itself reads no environment variable.

## Errors

Every error is a `ConfigParseError` built in [`config.ts`](src/lib/config.ts). Paths join keys with `.` and indexes with `[n]` ([`object.ts`](src/lib/utils/object.ts)), starting from the prefix: `config` by default for `parseConfig`, `message.metadata.configuration` for the message functions, so a path reads like `message.metadata.configuration.models[0].effort`.

| `code`                  | `path`                              | `message`                                                                   | When                                                                          |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `invalid_message`       | `message`                           | `Message must be an object`                                                 | A message function receives a non-object                                      |
| `missing_configuration` | `message.metadata.configuration`    | `Initial message metadata must include configuration`                       | `parseInitialMessageConfig` finds no `metadata` or no `configuration`         |
| `invalid_config_field`  | `message.metadata`                  | `Expected an object`                                                        | A message's `metadata` is present but not an object                           |
| `invalid_config_field`  | the failing value                   | `Expected an object`                                                        | The configuration, `github`, `github.repo` or an array entry is not an object |
| `invalid_config_field`  | the failing value                   | `Expected an array`                                                         | `providers`, `models` or `tasks` is not an array                              |
| `invalid_config_field`  | the failing value                   | `Expected a string`                                                         | A string field, or `effort` / `reasoning`, holds a value that is not a string |
| `invalid_config_field`  | the failing `effort` or `reasoning` | `Expected reasoning effort none, minimal, low, medium, high, xhigh, or max` | A string that is not a `ReasoningEffort`                                      |
| `invalid_config_field`  | the model's `effort`                | `Model effort must match legacy reasoning when both are provided`           | A model sets `effort` and `reasoning` to different values                     |

Callers should branch on `code` and `path`; the messages are fixed strings but are meant for people.

## Limits

The package validates one configuration at a time and keeps no state between calls. It reports only the first failure, never a list. It imposes no size limit on strings or arrays.

## Build and test

The `build` and `typecheck` targets (with `build-deps` and `watch-deps`) are inferred by the `@nx/js/typescript` plugin of [`nx.json`](../../nx.json): `build` compiles [`tsconfig.lib.json`](tsconfig.lib.json) (`src/**/*.ts`) into `dist/`. The `test` target of [`project.json`](project.json) compiles [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/` and runs `node --test` on `dist-tests/tests/*.test.js`; the tests are in [`tests/config.test.ts`](tests/config.test.ts).

```console
npx nx build config
npx nx typecheck config
npx nx test config
```
