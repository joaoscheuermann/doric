# Host config bundle

`host-config` holds the one Doric configuration: the model providers the host
can use, the model and reasoning effort prompts run with, the execution limits,
per-tool values, and the stored credentials all of these name. A new
configuration is checked end to end, down to building its providers, before it
is stored, so the host never saves one it cannot use.

It is a host-only bundle that the shipped
[`composition.json`](../../../app/backend/doric-host/composition.json) lists as
`resident`: it activates in the native host (kernel) process instead of in a
generation process, because the `secrets/v1` view and credential reference
source it relies on are local to that process. A resident bundle is part of the
kernel partition, so publishing a new generation does not replace it; changing
it needs a host restart. The composition's `required` block also names
`host-config/v1`, so the host refuses to boot without it. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Settings:** `host-config.configuration/v1`, the `settings/v1` space that
  holds the configuration as one `core.settings/v1` document.
- **Service:** `host-config/v1`, with `current()` (the active configuration,
  its revision and update time) and `replace(input)` (the `PUT /config`
  pipeline). Both methods are exposed to desktop windows, which may send the
  `projectId`, `threadId` and `promptId` scope keys.
- **Credential references:** every credential the stored configuration names
  is registered with `secrets/v1`, so deleting it is refused.
- **Startup:** an `onHostStartHook` that runs the `configuration_activation`
  stage.

It requires `hooks/v1`, `settings/v1`, `secrets/v1`, `models/v1` and
`tools/v1`. `runtime`, `default`, `usage`, `transport` and the desktop
`settings` bundle require `host-config/v1`; `transport` serves it as
`GET /config` and `PUT /config`.

## The configuration

| Field                          | Meaning                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `providers`                    | At least one provider: a unique `id`, a `kind` from the `llms` catalog, exactly that kind's values, and its model list. |
| `models.execution`             | The `providerId`, `model` and optional `effort` prompts run with; the provider must be one listed above.                |
| `execution.maxTurns`           | The turn limit of one prompt.                                                                                           |
| `execution.maxToolResultChars` | Optional cap on one tool result.                                                                                        |
| `execution.contextCompaction`  | Optional compaction policy; when absent, the consumer applies `defaultContextCompaction`.                               |
| `tools`                        | Per-tool values, keyed by tool name and then by the field keys the tool declares.                                       |
| `gitCredentialId`              | Optional `GIT` credential used as the Git identity.                                                                     |
| `githubCredentialId`           | Optional `API_TOKEN` credential used for GitHub.                                                                        |
| `profile.name`                 | Optional user's name: trimmed, 1–100 characters, one line.                                                              |
| `profile.timezone`             | Optional IANA time zone the host's `Intl` accepts, stored as chosen; when absent, the host's own applies.               |

The configuration holds no secret of its own. A provider field of kind
`secret` carries the UUID of a stored credential, so `GET /config` answers the
same shape `PUT /config` accepts. The schema is strict: an unknown key, a
value the provider kind does not declare, an empty optional value, a non-HTTP
URL, a repeated model, or an effort outside a model's list is refused, and so
is an unknown key inside `profile`, a `profile.name` that is empty or only
spaces, longer than 100 characters or broken across lines, or a
`profile.timezone` the host does not know. `profile` is optional and comes
last, so a configuration written without it reads and serializes as before.
The `default` bundle will use the profile as the prompt variables `user.name`
and `timezone`; it is never read from the host's operating system, because
the host can be remote. `host-config/v1` and `host-config.configuration/v1`
added `profile` in 1.1.0.

## Replacing a configuration

`replace` runs every replacement in one serialized lane, in request order:

1. The body is parsed against the schema; a body it refuses answers
   `invalid`.
2. Every credential reference must name a stored credential of the right kind:
   `API_TOKEN` for provider secrets and GitHub, `GIT` for the Git identity.
3. Each listed model is filled from its kind's live catalog through
   `models/v1.catalog` (reasoning efforts, default effort, whether reasoning is
   mandatory).
4. Every loaded tool's required fields must resolve from the stored values or
   the field's default.
5. The candidate providers are built with `models/v1.prepare`, so a
   configuration that cannot be activated is never stored.
6. The configuration is written as one `settings/v1` write, and the stored
   revision's providers are activated.

| Result     | When                                          | `PUT /config` answer         |
| ---------- | --------------------------------------------- | ---------------------------- |
| `replaced` | Every step succeeded.                         | 200 with the new snapshot    |
| `invalid`  | Schema, credential or tool-field rule failed. | 422 `invalid_config`         |
| `rejected` | Any later failure; the active one is kept.    | 503 `configuration_rejected` |

A failed replacement does not block the next one.

## Revisions and storage

- Each write gets the next `settings/v1` revision and an `updatedAt` time; the
  snapshot is `{ configuration, revision, updatedAt }`.
- Reads and writes both pass through one normalizer: providers sorted by ID,
  record keys in PostgreSQL jsonb order with a provider's credential last, and
  `tools` always present. This keeps the `GET /config` body identical to the
  one the former table-backed store answered.
- The generic-storage migration converted the former configuration tables into
  this settings document, keeping the revision and update time; see the
  [host README](../../../app/backend/doric-host/README.md#database).
- The configuration is loaded on first use and cached; a failed load is
  retried on the next call.

## Credential references

The references are the provider `secret` fields, `gitCredentialId` and
`githubCredentialId`. The settings schema refuses a configuration that names a
credential `secrets/v1` does not hold, and the registered reference source
makes `secrets/v1.delete` answer `referenced` for any of them. A credential
named only in `tools` is not registered as a reference and can still be
deleted.

## Startup

At `configuration_activation` the start hook reads the stored configuration,
builds its providers with `models/v1.prepare`, and logs the revision, provider
count, execution model and turn limit. It runs before the host listens, so no
prompt resolves a provider before the configuration is active. Activation
itself does no I/O.

## Entrypoints

- `host-config/contracts` — `ConfigurationV1`, the value types and Zod
  schemas, `configurationMethods` and `defaultContextCompaction`.
- `host-config/kernel` — `createHostConfig`, the bundle as an embedded
  definition for kernel and test compositions, plus `configurationSettingsId`,
  `referencedCredentialIds` and `boundTools`.
- `host-config/testing` — the configuration schema, `defaultConfig` (the
  baseline migration's OpenRouter provider), the store, the configuration
  service and the credential service, for the host's integration harness and
  this bundle's tests.

## Development

```console
npx nx build bundle-host-config
npx nx typecheck bundle-host-config
npx nx test bundle-host-config
```

The build writes `bundles/foundation/host-config/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/host-config`. To rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
