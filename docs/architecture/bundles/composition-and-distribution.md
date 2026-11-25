# Composition and distribution by the host

- Status: living document. It describes the composition and the distribution of bundles as implemented on 2026-11-20.

## Summary

`app/backend/doric-host` is the default agent host. It exposes long-lived, sandbox-backed Projects and independent chat Threads through REST and Socket.IO, and its bundles run the reusable agent loop of `packages/agent` ([`executor.ts`](../../../bundles/runtime/default/src/host/executor.ts)). The host is the source of truth for the installed bundles and for the **composition**: the JSON file that names one core bundle, the enabled bundles and the provider chosen for a contract. The host resolves a catalog from them for each generation and activates the foundation first, then the core, then the others ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). The mechanism spans three units: `packages/bundle` resolves the catalog and runs the kernel ([bundle README](../../../packages/bundle/README.md)), `app/backend/doric-host` boots it from its composition ([doric-host README](../../../app/backend/doric-host/README.md)), and `app/desktop/doric` downloads and activates the desktop parts ([doric desktop README](../../../app/desktop/doric/README.md)).

The desktop keeps only a verified cache. During the splash, the Electron main reads the host's distribution through `doric.catalog/v1`, downloads the files it lacks, checks each one's SHA-256, resolves the `desktopMain` and `client` parts against its own platform version and activates them; its windows import the `client` parts from the single origin `doric://app` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The renderer never fetches code over HTTP.

## The composition file

The host reads the composition at `DORIC_COMPOSITION`, by default [`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json), and the installed bundles below `DORIC_BUNDLES_PATH`, by default the host's staged `dist/bundles` ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). The host reads the composition once at the `bootstrap` stage, for its alternatives and `required`, and the kernel reads it and the installed bundles in `bundle_load` ([`index.ts`](../../../app/backend/doric-host/src/index.ts)).

The kernel reads the installed bundles, the composition and its overrides again at every catalog read: the first one in `bundle_load` and one for each new generation it publishes ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [Publishing a new generation](process-isolation.md#publishing-a-new-generation)). An edit to the composition file therefore takes effect at the next publication when the host booted the file by its path. When the host boots the shipped composition with an alternative's non-default option, it hands the kernel an in-memory composition built once at `bootstrap` instead of the path, and every later catalog read reuses that object, so edits to the file take effect only at the next host start ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). `required` and the alternatives are read only at `bootstrap`, whichever way the host boots.

The file has this shape, checked with a strict schema; an unknown key makes it invalid ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)):

| Key            | Required | Shape                                                    | Meaning                                                                                             |
| -------------- | -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `core`         | yes      | non-empty string                                         | The id of the core bundle                                                                           |
| `enabled`      | yes      | non-empty array of non-empty strings                     | The ids of the bundles the catalog schedules; their order does not set the activation order         |
| `providers`    | no       | contract id → non-empty string; default `{}`             | The id of the provider chosen for a contract of cardinality `one`                                   |
| `resident`     | no       | array of bundle ids                                      | Installed bundles whose host part runs in the host's own process                                    |
| `required`     | no       | `{ "contracts": [contract id], "bundles": [bundle id] }` | What must be active before the host serves; each list defaults to `[]`; absent, nothing is required |
| `alternatives` | no       | name → `{ "env", "default", "options" }`                 | A choice between bundles that fill one role, made by an environment variable                        |

A contract id, as a `providers` key and in `required.contracts`, matches `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\/v[1-9][0-9]*$`. A bundle id, in `resident` and `required.bundles`, matches `^[a-z][a-z0-9-]*$` ([`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). `core`, `enabled` and the values of `providers` are only checked to be non-empty strings: an id there that names no installed bundle is caught by the catalog, not by the schema. An alternative's name matches `^[a-z][a-z0-9-]*$`; its `env` and `default` are non-empty strings, and `options` is a non-empty array of non-empty strings that contains `default` ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)).

The shipped composition, [`composition.json`](../../../app/backend/doric-host/composition.json), enables 32 bundles, every bundle under `bundles/` except `firecracker`:

```json
{
  "core": "core",
  "enabled": [
    "transport",
    "postgres",
    "core",
    "host-config",
    "files",
    "web",
    "git",
    "threads",
    "terminal",
    "usage",
    "resources",
    "screen",
    "screen-relay",
    "runtime",
    "default",
    "openai",
    "openrouter",
    "codex",
    "claude",
    "claude-login",
    "docker",
    "notifications",
    "layout",
    "account",
    "workspace",
    "settings",
    "chat",
    "history",
    "comments",
    "openui",
    "papercraft",
    "mcp"
  ],
  "providers": {
    "storage.backend/v1": "postgres",
    "secrets.backend/v1": "postgres"
  },
  "resident": ["host-config", "transport", "screen-relay"],
  "required": {
    "contracts": [
      "runtime/v2",
      "executor/v1",
      "sandbox/v1",
      "models/v1",
      "host-config/v1"
    ],
    "bundles": ["transport"]
  },
  "alternatives": {
    "sandbox": {
      "env": "DORIC_SANDBOX_PROVIDER",
      "default": "docker",
      "options": ["docker", "firecracker"]
    }
  }
}
```

A file that cannot be read, is not JSON or fails the schema (an unknown key, or an alternative whose `default` is not among its `options`) puts the host catalog in recovery mode with the reason `invalid composition: <error>`, and the host's start fails with exit code 1 ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)).

The kernel reads `resident`, `required` and `alternatives` generically: the contract ids, bundle ids and variable names in them are data of the composition, not code of the platform ([`partition.ts`](../../../packages/bundle/src/process/partition.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)).

## How installed bundles are found

At each catalog read, every immediate subdirectory of `DORIC_BUNDLES_PATH` is a candidate, read in the order of its full path; the read executes none of the bundle's code ([`discover.ts`](../../../packages/bundle/src/loader/discover.ts)). A candidate takes its id from its manifest ([Manifest](manifest.md)). A directory whose manifest cannot be read takes the directory's name for display and is quarantined with `invalid_manifest`; that name never collides with a real bundle id. When two candidates share an id, the first by path keeps it and each later one is quarantined with `duplicate_id` ([`loader/catalog.ts`](../../../packages/bundle/src/loader/catalog.ts), [`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A bundles root that cannot be read leaves the catalog with no installed bundle and records a catalog issue ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts)).

An **embedded bundle** is a bundle handed to the kernel in memory instead of a directory: its manifest, its contract descriptor, the contract documents an installed bundle would ship as files, and optionally its host `activate` ([`loader/catalog.ts`](../../../packages/bundle/src/loader/catalog.ts)). Embedded bundles follow the installed ones among the candidates, are always enabled whatever `enabled` says, and run in the kernel ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`partition.ts`](../../../packages/bundle/src/process/partition.ts)). They serve isolated hosts and tests; the shipped host passes none ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)).

## Catalog issues

A catalog issue is a problem of the composition or of the bundles root that quarantines no bundle by itself. The catalog records each one as a message, and `doric.diagnostics/v1.get()` returns them in `issues` ([`diagnostics.ts`](../../../packages/bundle/src/runtime/diagnostics.ts), [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`doric.diagnostics/v1`](core.md#doricdiagnosticsv1)). The messages are ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`overrides.ts`](../../../packages/bundle/src/loader/overrides.ts), [`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

| Message                                                                      | When                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `Unable to discover bundles in root "<root>".: <cause>`                      | The bundles root cannot be read                                                 |
| `Invalid composition overrides "<path>".: <cause>`                           | The overrides file is not JSON or fails its schema                              |
| the error of the file read                                                   | The overrides file exists but cannot be read                                    |
| `missing bundle <id>`                                                        | An id in `enabled` names no installed bundle and no unreadable bundle directory |
| `provider choice <contract> -> <bundle> ignored: bundle not enabled`         | A `providers` entry names a bundle that is not installed or not enabled         |
| `provider choice <contract> -> <bundle> ignored: bundle does not provide it` | A `providers` entry names a bundle whose manifest does not provide the contract |

`<cause>` is the message of the underlying error and of each of its causes, joined by `: `.

## Providers and cardinality

Each contract declares its cardinality in the options of `defineService` ([Contracts](contracts.md)). The catalog publishes one cardinality per contract in each environment, taken as [Contract ids](contracts.md#contract-ids) describes, and quarantines each live provider that declares another with `cardinality_mismatch` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A contract of cardinality `one`, the default, has one active provider in each environment. A contract of cardinality `many` accepts every enabled provider and needs no choice: `openai`, `openrouter`, `codex` and `claude` all provide `models.provider/v1` ([`provider.ts`](../../../bundles/providers/openai/src/host/provider.ts)), and the core's `models/v1` aggregates them ([core README](../../../bundles/foundation/core/README.md)).

The catalog picks the active provider of a `one` contract in an environment this way ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

1. The bundle named under `providers`, when it is enabled and provides the contract in that environment. If that bundle is quarantined, the contract has no active provider there: the catalog does not fall back to rules 2 and 3, and each bundle that requires the contract there is quarantined with `dependency_quarantined`. A quarantined chosen foundation provider puts the environment in [recovery mode](core.md#recovery-mode). A choice that names a bundle that is not enabled or does not provide the contract is ignored and recorded as a [catalog issue](#catalog-issues).
2. Otherwise the core, when it provides the contract.
3. Otherwise the provider whose id sorts first.

Every other provider of the contract in that environment, except the core, is quarantined with the reason `unchosen_provider`. A choice applies only in the environments where the chosen bundle provides the contract; in the others the provider is picked by rules 2 and 3. A bundle that replaces a contract the core provides, such as `hooks/v1`, is therefore named under `providers`, for example `"providers": { "hooks/v1": "myhooks" }`; the core's own `services.use` then returns the chosen provider. Contracts with the prefix `doric.` belong to the platform and take no other provider ([Boundaries](boundaries.md)).

The shipped composition names one provider for each of the two contracts the core requires, `storage.backend/v1` and `secrets.backend/v1`, both from `postgres` ([`manifest.json`](../../../bundles/foundation/core/manifest.json), [postgres README](../../../bundles/foundation/postgres/README.md)). The other structural contracts have one enabled provider each: `runtime/v2` from `runtime` ([runtime README](../../../bundles/runtime/runtime/README.md)), `executor/v1` from `default` ([default README](../../../bundles/runtime/default/README.md)), `sandbox/v1` from `docker` ([docker README](../../../bundles/sandboxes/docker/README.md)) or `firecracker`, `models/v1` from `core` and `host-config/v1` from `host-config` (each bundle's `manifest.json`).

## Foundation and activation order

In each environment the catalog orders the scheduled bundles in three phases ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

1. **Foundation**: each bundle chosen under `providers` for a contract the core provides or requires in that environment. Within the foundation the providers of `storage.backend/v1` and `secrets.backend/v1` come first. A foundation bundle that lists a contract under `requires` is quarantined with `foundation_requires`, except a replacement of `events/v1`, `settings/v1` or `models/v1` that requires a storage or secrets backend.
2. **Core**: each contract the core requires that an enabled bundle provides in that environment must be provided by an active foundation bundle, in a version that satisfies the core's range; otherwise the environment is in recovery mode. A required contract that no enabled bundle provides in any environment also puts it in recovery mode; one that enabled bundles provide only in other environments does not.
3. **Others**: the remaining bundles, in dependency order from the `requires` of their manifests, with a lexical tie-break. The members of a dependency cycle are quarantined.

A quarantined chosen foundation provider never falls back to the core: the environment is in recovery mode. A core that is not installed, not enabled or quarantined also puts the environment in recovery mode. The conditions and reasons of recovery mode are in [Core](core.md#recovery-mode). The folders under `bundles/` (`foundation`, `runtime`, `providers`, `sandboxes`, `features`, `desktop`) organize the source and do not set the phase: `host-config` and `transport` sit in `bundles/foundation/` and are in the phase `others`; on the host they still activate before every generation bundle, because they are `resident` (below). The manifest fields the catalog reads are in [Manifest](manifest.md).

## `resident`

The host runs bundle code in two kinds of process: the kernel, which is the host's own process, and one generation process that the kernel forks ([Process isolation](process-isolation.md)). The foundation, the core, the embedded bundles and every bundle listed in `resident` run in the kernel; every other installed bundle runs in the generation process ([`partition.ts`](../../../packages/bundle/src/process/partition.ts)). The kernel splits the catalog's order into a kernel order and a generation order, each in the catalog's order, and publishes the kernel's bundles first, then the generation's, as the host's `order`; the kernel activates its bundles before the generation process activates its own, so a `resident` bundle activates before every generation bundle ([`partition.ts`](../../../packages/bundle/src/process/partition.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts), [What runs where](process-isolation.md#what-runs-where)). The host's native network resources are reachable only by a bundle that runs in the kernel, through [`doric.network/v1`](services-and-channels.md#native-handles-doricnetworkv1): the foundation, the core, the embedded bundles and the `resident` ones ([`network.ts`](../../../packages/bundle/src/process/network.ts)). The shipped list names:

- `host-config`, which owns the configuration's `settings/v1` space, `host-config.configuration/v1`, and provides `host-config/v1` ([host-config README](../../../bundles/foundation/host-config/README.md));
- `transport`, which registers the REST routes and Socket.IO namespaces ([transport README](../../../bundles/foundation/transport/README.md));
- `screen-relay`, which serves the relay of the Projects' screens on the same listener ([screen-relay README](../../../bundles/features/screen-relay/README.md)).

## `required`

After the kernel activates the first generation, the host checks the catalog against `required`: each listed contract must have an active provider and each listed bundle must be active. A failure logs `Bundle recovery mode` with the reason `structural providers unavailable: <ids>`, stops the platform and ends the host's start with exit code 1 ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)). The host checks again each time a generation becomes active; when a structural provider is lost after boot, for example because its generation exhausted its respawns, the host logs `Bundle recovery mode` and exits with code 1, so that its supervisor restarts it. When the catalog itself resolves to recovery mode, for example because the core cannot activate, the host stops the platform and its start also fails with exit code 1, after the platform log records each bundle and its reasons. A start that fails, for these or any other reason, ends with the fatal line `Doric failed to start`, whose only field is the `stage` it reached; the error itself is not logged there. A structural provider lost after boot exits without that line ([`index.ts`](../../../app/backend/doric-host/src/index.ts)).

## `alternatives`

An alternative names a variable (`env`), its `options` and a `default` that must be one of them. The option is the variable's value when that value is one of the options, and the default otherwise ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)). Without `DORIC_COMPOSITION`, the host boots the shipped composition with the chosen option enabled in place of the default bundle; with `DORIC_COMPOSITION`, it boots the operator's file as written, and the variable is not read: the choice the host reports for an alternative is its single enabled option, or its default when none or several of its options are enabled ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)). The host logs the choices as `alternatives` in its `Doric starting` and `Doric listening` lines ([`index.ts`](../../../app/backend/doric-host/src/index.ts)). The shipped alternative is `sandbox`: `docker` by default, `firecracker` with `DORIC_SANDBOX_PROVIDER=firecracker` ([docker README](../../../bundles/sandboxes/docker/README.md), [firecracker README](../../../bundles/sandboxes/firecracker/README.md)).

## Composition overrides

The splash's recovery actions "Disable" and "Return to default composition" change the composition without rewriting its file. They write or delete `composition.overrides.json` beside the active composition, never in the product database ([`overrides.ts`](../../../packages/bundle/src/loader/overrides.ts)):

```json
{ "disabled": ["notifications"] }
```

The file is checked with a strict schema: one key, `disabled`, an array of non-empty strings. A missing file means no overrides. The host writes it to a temporary file beside it, `composition.overrides.json.<uuid>.tmp`, and renames that over the file, so a reader never sees a partial file ([`overrides.ts`](../../../packages/bundle/src/loader/overrides.ts)).

Every host catalog read leaves the disabled bundles out of `enabled`, so they appear in the catalog with the state `disabled`; an embedded bundle stays enabled ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). An overrides file that cannot be read, is not JSON or fails the schema is recorded as a [catalog issue](#catalog-issues) and ignored ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts)); the next `disable` replaces it with a file that holds only its own bundle and logs `Composition overrides replaced` ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts)).

The two actions are members of `doric.catalog/v1` (below). They run one at a time, and each publishes a new generation after it writes, logging `Composition published` when that succeeds. A change that cannot be published stays in the file and applies at the next host start; the action logs `Composition change applies at the next host start` and fails the call with `unavailable`, whose `details.status` is `kernel_restart_required` or `failed` ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)). The answer is `failed` when the new generation's process fails to start or the host is stopping. It is `kernel_restart_required` whenever the new catalog changes the kernel partition: the ids, versions, phases, states and sources of the foundation, core, embedded and `resident` bundles, the providers they publish, or the recovery reason ([`partition.ts`](../../../packages/bundle/src/process/partition.ts), [Publishing a new generation](process-isolation.md#publishing-a-new-generation)). A disable therefore takes effect live only for a bundle that runs in the generation process and whose removal leaves the kernel partition as it was. In the shipped composition, disabling `postgres`, `host-config`, `transport` or `screen-relay` always waits for the next start.

`disable` accepts any bundle that the composition the kernel booted enables (the file, or the in-memory composition when the host chose a non-default alternative), except the core; it answers `not_found` for another id and `invalid_input` for the core ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). With `DORIC_SANDBOX_PROVIDER=firecracker`, for example, `disable({ bundleId: 'docker' })` answers `not_found`, although the file enables `docker`. It accepts a bundle that `required` names, and a bundle that provides a contract the core requires. Disabling a bundle `required` names removes a structural provider: the host exits with code 1 once the new generation activates, or the change waits for the next start, and every start after it fails at `bundle_load` ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). Disabling the only enabled provider of a contract the core requires, such as `postgres` for `storage.backend/v1`, puts every later start in recovery mode ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). Either way, the host starts again only once `composition.overrides.json` is deleted by hand.

## The contract `doric.catalog/v1`

The platform provides `doric.catalog/v1`; no bundle may provide it, because `doric.*` ids are reserved for the platform ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`define.ts`](../../../packages/bundle/src/contracts/define.ts)). Every member is callable from a desktop window (`expose: 'desktop'`). On the host, the kernel serves every member ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts)). Every generation process runs the same runner: a host generation process, and the `utilityProcess` in which the desktop runs a generation's `desktopMain` parts. That runner provides `doric.catalog/v1` with `get` alone, which returns the catalog snapshot its parent (the kernel, or the Electron main) last sent it. A call of another member from a bundle there, on the host or in `desktopMain`, fails with `unavailable` and the message `Contract "doric.catalog/v1" has no method "<method>".` ([`runner.ts`](../../../packages/bundle/src/runtime/runner.ts), [`runner-entry.ts`](../../../app/desktop/doric/src/platform/generation/runner-entry.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).

| Member                  | Returns                | Behavior                                                                                                                                         |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get()`                 | `CatalogSnapshot`      | The calling environment's catalog                                                                                                                |
| `distribution()`        | `DistributionCatalog`  | What the desktop needs of the host generation the call is pinned to, or of the active one                                                        |
| `artifact({ sha256 })`  | `DistributionArtifact` | One file listed in a retained generation, by hash; `not_found` when no retained generation lists the hash, or the file on disk does not match it |
| `watch(listener)`       | `Disposable`           | One `CatalogChange` (`{ generation }`) each time a different generation becomes active                                                           |
| `disable({ bundleId })` | `void`                 | Adds the bundle to the overrides and publishes; `not_found` when it is not in the composition, `invalid_input` for the core                      |
| `resetComposition()`    | `void`                 | Deletes the overrides and publishes                                                                                                              |

The desktop reaches these members through the host bridge, the Socket.IO namespace `/doric/bridge` ([`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts), [`catalog.ts`](../../../app/backend/doric-host/src/lib/bridge/catalog.ts)).

The host's distribution members behave this way ([`catalog.ts`](../../../app/backend/doric-host/src/lib/bridge/catalog.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)):

- `distribution()` answers for the generation the call is pinned to while that generation is not stopped, and for the active generation otherwise ([Which generation a call reaches](process-isolation.md#which-generation-a-call-reaches)). The list of files of a generation is computed once, the first time it is asked for; the bundles' states and reasons, the composition and `storage` are read live at each call.
- A **retained generation** is a host generation whose state is not `stopped`, together with the active one. `artifact` looks the hash up in each retained generation's file list and reads the file again from disk, so a file that changed on disk since its generation was listed is not served.
- `watch` remembers the generation the call reaches when it subscribes and sends a change each time another generation becomes active. A respawn re-activates the same generation and sends nothing.

### The `DoricCatalog` shape

`DoricCatalog` is the interface a caller of `doric.catalog/v1` receives. Its members and every shape they take and return, as declared in [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts) (`StorageIdentity` in [`storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts), `CallArg` in [`call.ts`](../../../packages/bundle/src/contracts/call.ts), `Environment` in [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts), `StreamListener` in [`common.ts`](../../../packages/bundle/src/contracts/basic/common.ts), `Disposable` in [`context.ts`](../../../packages/bundle/src/contracts/context.ts), `JsonObject` in [`types.ts`](../../../packages/bundle/src/contracts/types.ts)):

```ts
interface DoricCatalog {
  get(call?: CallArg): CatalogSnapshot;
  distribution(call?: CallArg): Promise<DistributionCatalog>;
  artifact(
    request: { readonly sha256: string },
    call?: CallArg,
  ): Promise<DistributionArtifact>;
  watch(listener: StreamListener<CatalogChange>, call?: CallArg): Disposable;
  disable(
    request: { readonly bundleId: string },
    call?: CallArg,
  ): Promise<void>;
  resetComposition(call?: CallArg): Promise<void>;
}

interface CatalogSnapshot {
  readonly generation: number; // integer
  readonly composition: CatalogComposition;
  readonly bundles: readonly CatalogBundle[];
  readonly order: readonly string[]; // the activation order of this environment
  readonly contracts: readonly CatalogContract[];
  readonly storage?: StorageIdentity; // once the host resolved its storage backend
}

interface CatalogComposition {
  readonly core: string;
  readonly enabled: readonly string[];
  readonly providers: Readonly<Record<string, string>>; // contract id → bundle id
}

interface CatalogBundle {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly state: 'active' | 'quarantined' | 'disabled' | 'inactive';
  readonly phase?: 'foundation' | 'core' | 'others';
  readonly manifest?: CatalogManifest;
  readonly reasons: readonly QuarantineReason[];
}

interface CatalogManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly optional?: readonly string[];
  readonly desktopScope?: Readonly<Record<string, readonly string[]>>; // contract id → scope keys a window may send
  readonly description?: string;
}

interface QuarantineReason {
  readonly code: QuarantineCode;
  readonly message: string;
  readonly contract?: string;
}

interface CatalogContract {
  readonly id: string;
  readonly environment: Environment; // 'host' | 'desktopMain' | 'client'
  readonly cardinality: 'one' | 'many';
  readonly providers: readonly ContractProvider[]; // the active providers
}

interface ContractProvider {
  readonly bundleId: string;
  readonly version: string; // the contract version the bundle declares in `provides`
  readonly bundleVersion: string;
}

// The output type of `storageIdentitySchema`
type StorageIdentity = {
  hostId: string; // a UUID
  storageGeneration: number; // a positive integer
};

interface DistributionCatalog {
  readonly generation: number; // integer; restarts at 1 with every host process
  readonly hostBoot: string; // non-empty, random per host process
  readonly platformVersion: string; // the host's platform version
  readonly composition: CatalogComposition;
  readonly storage?: StorageIdentity;
  readonly host: CatalogSnapshot; // what `get()` returns on the host
  readonly bundles: readonly DistributionBundle[];
}

interface DistributionBundle {
  readonly id: string;
  readonly version: string;
  readonly state: 'active' | 'quarantined' | 'disabled' | 'inactive'; // the host state
  readonly reasons: readonly QuarantineReason[]; // the host's quarantine reasons
  readonly manifest?: CatalogManifest;
  readonly descriptor?: JsonObject; // the bundle's contracts.json
  readonly files: readonly DistributionFile[];
  readonly parts: DistributionParts;
}

interface DistributionFile {
  readonly path: string; // non-empty, relative to the bundle's dist, `/` separators
  readonly sha256: string; // 64 lowercase hex characters
  readonly size: number; // a non-negative integer
}

interface DistributionParts {
  readonly desktopMain?: string;
  readonly client?: string;
  readonly clientStyles?: string;
  readonly contracts?: string;
}

interface DistributionArtifact {
  readonly sha256: string; // 64 lowercase hex characters
  readonly base64: string; // the file bytes
}

interface CatalogChange {
  readonly generation: number; // integer
}
```

The `state` of a `CatalogBundle`, and the host state of a `DistributionBundle`, is one of ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`diagnostics.ts`](../../../packages/bundle/src/runtime/diagnostics.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)):

- `active`: the bundle activated in this generation;
- `quarantined`: the bundle will not run; `reasons` says why;
- `disabled`: the bundle is installed with a readable manifest but is not in `enabled` once the overrides apply, such as `firecracker` in the shipped composition or a bundle the overrides disable;
- `inactive`: the bundle is scheduled and not yet active, was deactivated when its platform or generation stopped, or was left out or withdrawn because the environment is in recovery mode.

`phase` comes from the resolved catalog: it is set on each bundle the catalog scheduled, as `foundation`, `core` or `others`, and on each foundation bundle, even one quarantined while the catalog is resolved. A bundle quarantined later, during activation (for example with `activate_failed` or `dependency_quarantined`), changes only its state and keeps its `phase`. Only a bundle quarantined while the catalog is resolved, outside the foundation, and a disabled bundle have no `phase` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`diagnostics.ts`](../../../packages/bundle/src/runtime/diagnostics.ts), [`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).

The dispatcher checks every call against the method's schemas in `platform.ts`: an input that fails fails the call with `invalid_input`, and a result that fails fails it with `invalid_output` ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). Those schemas are strict, so an unknown key in an object makes it invalid, except in the three record fields: `providers` and `desktopScope` accept any string key, and `descriptor` accepts any object. The desktop checks `descriptor` against the contract descriptor's schema when it resolves the generation and records a failure as `invalid_descriptor` ([`distribution.ts`](../../../packages/bundle/src/runtime/distribution.ts), [`descriptor.ts`](../../../packages/bundle/src/runtime/descriptor.ts), [Contracts](contracts.md#the-contract-descriptor-and-schemas)). `artifact` takes a `sha256` of 64 lowercase hex characters and `disable` a non-empty `bundleId`. `QuarantineCode` is one of the codes listed in [Core](core.md#quarantine). `call` is the optional call argument described in [Contracts](contracts.md#the-call); `StreamListener` and the `Disposable` that `watch` returns are described in [Streams](services-and-channels.md#streams).

A bundle's `files` are `manifest.json`, `contracts.json`, `descriptors.binpb` and every file under `desktop/`, `client/` and `schemas/`, every `.js` file under `contracts/`, and the modules outside `contracts/` that those contracts import. The modules outside `contracts/` are found by following the relative imports of the `contracts/` modules transitively; an import that leaves the bundle's `dist` or names a missing file is not followed. The files are sorted by path. `parts` holds the fixed paths that are present: `desktopMain` is `desktop/index.js`, `client` is `client/index.js`, `clientStyles` is `client/styles.css` and `contracts` is `contracts/index.js` ([`distribution.ts`](../../../packages/bundle/src/loader/distribution.ts)). An embedded bundle has no directory: its files are its contract documents, served from memory ([`catalog.ts`](../../../app/backend/doric-host/src/lib/bridge/catalog.ts)).

## Building and staging

Each bundle builds its own `dist`. The host's `build-bundles` target depends on the `build` target of every project tagged `type:bundle` and then runs `stage app/backend/doric-host/dist/bundles --all bundles`, which copies the `dist` of every directory `bundles/<group>/<name>` that has a `manifest.json` to `app/backend/doric-host/dist/bundles/<id>`, where `<id>` is the id in that bundle's `dist/manifest.json`. Staging deletes the target directory first, so it replaces it, and skips `.tsbuildinfo` files. A bundle directory without `dist/manifest.json` stops the staging with `<dir>: dist/manifest.json is missing; build the bundle first`. The host's `build` target depends on `build-bundles`, so building the host stages every bundle ([`project.json`](../../../app/backend/doric-host/project.json), [`cli.ts`](../../../packages/bundle/src/build/cli.ts)). No list of bundles exists in the build: every bundle is staged, and the composition decides which ones are enabled.

## The splash on the desktop

The Electron main opens the splash, connects to the host and loads one generation ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)):

1. It calls `doric.catalog/v1.distribution()`.
2. It keeps the bundles whose host state is not `disabled` and, for each listed file, looks in `userData/bundles/<id>@<version>/<path>`. A file that is missing or whose SHA-256 differs is fetched with `artifact`, staged in `userData/bundles/.tmp` and moved into place by an atomic rename only when its SHA-256 equals the catalog's, so no partial file is ever served ([`artifacts.ts`](../../../app/desktop/doric/src/platform/catalog/artifacts.ts), [`paths.ts`](../../../app/desktop/doric/src/platform/paths.ts)). A file fails with `download_failed` when its path leaves the bundle's directory (`artifact path leaves the bundle directory: <path>`), when `artifact` fails (`artifact download failed: <path>: <error>`) or when writing it fails (`artifact write failed: <path>: <error>`), and with `hash_mismatch` (`artifact hash mismatch: <path>`) when the bytes received do not match the listed SHA-256.
3. It resolves `desktopMain` and `client` from the same candidates: host quarantines carry over, a bundle with a file that failed in step 2, for any of those reasons, is quarantined with `invalid_part` and the failure's message, and `engines.doric` is checked against the desktop's platform version ([`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts), [Versioning](versioning.md)). In connected mode, each quarantine the desktop adds to a bundle that has a desktop part and that the host did not quarantine is reported to the host with `doric.diagnostics/v1.report` as `desktop_quarantine`.
4. It runs the generation's `desktopMain` parts in one Electron `utilityProcess` and, once they are active and in connected mode, saves the distribution as `userData/doric/catalog-snapshot.json` ([`snapshot.ts`](../../../app/desktop/doric/src/platform/catalog/snapshot.ts)).
5. When the desktop quarantined bundles that the host did not, the splash shows the `bundle-failure` state, which offers "Continue without them" ([`view.ts`](../../../app/desktop/doric/src/splash-page/view.ts)). After at least 5 seconds of splash, it fires `onAppReadyHook`, in which the core sets the menu skeleton and opens the `workspace` window, marked `primary`, at the last path stored for that key, or `/` ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [Hooks](hooks.md)).
6. The window is sandboxed and context-isolated ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)). It loads the renderer shell from `doric://app/platform/shell@<version>/`, which only boots the generation's `client` parts, imported from `doric://app/bundles/<id>@<version>/` out of the verified cache, and puts the core's `<core-outlet>` in the body ([doric-renderer README](../../../app/desktop/doric-renderer/README.md), [`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [doric:// protocol](doric-protocol.md)).
7. The splash closes when the first window calls `ready()`. A window not ready within 30 seconds of `onAppReadyHook`, a core failure or an unreachable host shows the recovery state on the same surface ([`timing.ts`](../../../app/desktop/doric/src/platform/splash/timing.ts), [Splash and recovery](splash-and-recovery.md)).

When the host is unreachable, the splash shows the connection state and retries. Once a snapshot exists, the action "Open last known composition" loads it in the `disconnected-copy` mode, without downloads. The other recovery states and actions are in [Splash and recovery](splash-and-recovery.md) ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

## A new generation while the app is open

The main subscribes to `doric.catalog/v1.watch()`. On each change, and each time the bridge reconnects after `onAppReadyHook` has fired, it refreshes: it reads the distribution again and, when it names a different host generation than the newest connected desktop generation (by `storage.hostId`, `hostBoot` and `generation`), loads it as a new desktop generation in the background and fires `onGenerationReadyHook` in it. One refresh runs at a time; a refresh asked for while one runs joins it. A load that does not reach the ready state is only logged, as `A new generation did not activate`, and a failed refresh as `The catalog refresh failed`; the windows stay on their generation. Open windows stay pinned to their generation and nothing reloads ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [Desktop generations](process-isolation.md#desktop-generations)).

A desktop generation older than the newest stops once no window pins it. When its process has stopped, the main deletes from `userData/bundles` every `<id>@<version>` directory that neither a desktop generation not yet released nor the last good core references, and the staging directory `.tmp` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`artifacts.ts`](../../../app/desktop/doric/src/platform/catalog/artifacts.ts)).

## Related documents

- [bundle README](../../../packages/bundle/README.md): the package that resolves the catalog, runs the kernel and builds and stages bundles.
- [doric-host README](../../../app/backend/doric-host/README.md): the host that boots the composition.
- [doric desktop README](../../../app/desktop/doric/README.md): the Electron app that keeps the verified cache.
- [Boundaries](boundaries.md): which code may reach which, and the platform's `doric.*` contracts.
- [Contracts](contracts.md): `defineService` and the cardinality option.
- [Manifest](manifest.md): `provides`, `requires`, `engines.doric` and the parts the distribution lists.
- [Core](core.md): the core bundle and quarantine.
- [Contexts](contexts.md): the services a bundle reaches in each environment.
- [Hooks](hooks.md): `onAppReadyHook`, `onGenerationReadyHook` and replacing the provider of `hooks/v1`.
- [Storage](storage.md): `storage.backend/v1`, `secrets.backend/v1` and the core's facades.
- [Splash and recovery](splash-and-recovery.md): the surface where downloads, reconnection and recovery happen.
- [doric:// protocol](doric-protocol.md): the single origin the renderer imports from.
- [Process isolation](process-isolation.md): the kernel, the generation processes and the desktop's `utilityProcess` per generation.
- [Windows](windows.md): why the core, not the composition, decides which windows open.
- [Versioning](versioning.md): how `engines.doric` is checked.
