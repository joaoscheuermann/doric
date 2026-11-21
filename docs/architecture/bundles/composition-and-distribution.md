# Composition and distribution by the host

- Status: living document. It describes the composition and the distribution of bundles as implemented on 2026-11-20.

## Summary

`app/backend/doric-host` is the default agent host. It exposes long-lived, sandbox-backed Projects and independent chat Threads through REST and Socket.IO, and its bundles run the reusable agent loop of `packages/agent` ([`executor.ts`](../../../bundles/runtime/default/src/host/executor.ts)). The host is the source of truth for the installed bundles and for the **composition**: the JSON file that names one core bundle, the enabled bundles and the provider chosen for a contract. The host resolves a catalog from them for each generation and activates the foundation first, then the core, then the others ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).

The desktop keeps only a verified cache. During the splash, the Electron main reads the host's distribution through `doric.catalog/v1`, downloads the files it lacks, checks each one's SHA-256, resolves the `desktopMain` and `client` parts against its own platform version and activates them; its windows import the `client` parts from the single origin `doric://app` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The renderer never fetches code over HTTP.

## The composition file

The host reads the composition at `DORIC_COMPOSITION`, by default [`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json), and the installed bundles below `DORIC_BUNDLES_PATH`, by default the host's staged `dist/bundles` ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). The host reads the composition first at the `bootstrap` stage, for its alternatives and `required`, and the kernel reads it and the installed bundles in `bundle_load` ([`index.ts`](../../../app/backend/doric-host/src/index.ts)).

The file has this shape, checked with a strict schema; an unknown key makes it invalid ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)):

| Key            | Required | Shape                                                    | Meaning                                                                                             |
| -------------- | -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `core`         | yes      | bundle id                                                | The core bundle                                                                                     |
| `enabled`      | yes      | non-empty array of bundle ids                            | The bundles the catalog schedules; their order does not set the activation order                    |
| `providers`    | no       | contract id → bundle id; default `{}`                    | The provider chosen for a contract of cardinality `one`                                             |
| `resident`     | no       | array of bundle ids                                      | Installed bundles whose host part runs in the host's own process                                    |
| `required`     | no       | `{ "contracts": [contract id], "bundles": [bundle id] }` | What must be active before the host serves; each list defaults to `[]`; absent, nothing is required |
| `alternatives` | no       | name → `{ "env", "default", "options" }`                 | A choice between bundles that fill one role, made by an environment variable                        |

The shipped composition enables 32 bundles, every bundle under `bundles/` except `firecracker`:

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

The kernel reads `resident`, `required` and `alternatives` generically: the contract ids, bundle ids and variable names in them are data of the composition, not code of the platform.

## Providers and cardinality

Each contract declares its cardinality in the options of `defineService` ([Contracts](contracts.md)). A contract of cardinality `one`, the default, has one active provider in each environment. A contract of cardinality `many` accepts every enabled provider and needs no choice: `openai`, `openrouter`, `codex` and `claude` all provide `models.provider/v1` ([`provider.ts`](../../../bundles/providers/openai/src/host/provider.ts)), and the core's `models/v1` aggregates them ([core README](../../../bundles/foundation/core/README.md)).

The catalog picks the active provider of a `one` contract in an environment this way ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

1. The bundle named under `providers`, when it is enabled and provides the contract in that environment. If that bundle is quarantined, the contract has no active provider there: the catalog does not fall back to rules 2 and 3, and each bundle that requires the contract there is quarantined with `dependency_quarantined`. A quarantined chosen foundation provider puts the environment in recovery mode (below). A choice that names a bundle that is not enabled or does not provide the contract is ignored and recorded as a catalog issue.
2. Otherwise the core, when it provides the contract.
3. Otherwise the provider whose id sorts first.

Every other provider of the contract in that environment, except the core, is quarantined with the reason `unchosen_provider`. A choice applies only in the environments where the chosen bundle provides the contract; in the others the provider is picked by rules 2 and 3. A bundle that replaces a contract the core provides, such as `hooks/v1`, is therefore named under `providers`, for example `"providers": { "hooks/v1": "myhooks" }`; the core's own `services.use` then returns the chosen provider. Contracts with the prefix `doric.` belong to the platform and take no other provider ([Boundaries](boundaries.md)).

The shipped composition names one provider for each of the two contracts the core requires, `storage.backend/v1` and `secrets.backend/v1`, both from `postgres` ([`manifest.json`](../../../bundles/foundation/core/manifest.json), [postgres README](../../../bundles/foundation/postgres/README.md)). The other structural contracts have one enabled provider each: `runtime/v2` from `runtime` ([runtime README](../../../bundles/runtime/runtime/README.md)), `executor/v1` from `default` ([default README](../../../bundles/runtime/default/README.md)), `sandbox/v1` from `docker` ([docker README](../../../bundles/sandboxes/docker/README.md)) or `firecracker`, `models/v1` from `core` and `host-config/v1` from `host-config` (each bundle's `manifest.json`).

## Foundation and activation order

In each environment the catalog orders the scheduled bundles in three phases ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

1. **Foundation**: each bundle chosen under `providers` for a contract the core provides or requires in that environment. Within the foundation the providers of `storage.backend/v1` and `secrets.backend/v1` come first. A foundation bundle that lists a contract under `requires` is quarantined with `foundation_requires`, except a replacement of `events/v1`, `settings/v1` or `models/v1` that requires a storage or secrets backend.
2. **Core**: the core may require only contracts that an active foundation bundle provides, in a version that satisfies its range. Otherwise the environment is in recovery mode.
3. **Others**: the remaining bundles, in dependency order from the `requires` of their manifests, with a lexical tie-break. The members of a dependency cycle are quarantined.

A quarantined chosen foundation provider never falls back to the core: the environment is in recovery mode. A core that is not installed, not enabled or quarantined also puts the environment in recovery mode. The folders under `bundles/` (`foundation`, `runtime`, `providers`, `sandboxes`, `features`, `desktop`) organize the source and do not set the phase: `host-config` and `transport` sit in `bundles/foundation/` and activate with the others. The manifest fields the catalog reads are in [Manifest](manifest.md).

## `resident`

The host runs bundle code in two kinds of process: the kernel, which is the host's own process, and one generation process that the kernel forks ([Process isolation](process-isolation.md)). The foundation, the core, the embedded bundles and every bundle listed in `resident` run in the kernel; every other installed bundle runs in the generation process ([`partition.ts`](../../../packages/bundle/src/process/partition.ts)). The host's native network resources are reachable only by a bundle that runs in the kernel, through `doric.network/v1`: the foundation, the core, the embedded bundles and the `resident` ones ([`network.ts`](../../../packages/bundle/src/process/network.ts)). The shipped list names:

- `host-config`, which owns the configuration's `settings/v1` space, `host-config.configuration/v1`, and provides `host-config/v1` ([host-config README](../../../bundles/foundation/host-config/README.md));
- `transport`, which registers the REST routes and Socket.IO namespaces ([transport README](../../../bundles/foundation/transport/README.md));
- `screen-relay`, which serves the relay of the Projects' screens on the same listener ([screen-relay README](../../../bundles/features/screen-relay/README.md)).

## `required`

After the kernel activates the first generation, the host checks the catalog against `required`: each listed contract must have an active provider and each listed bundle must be active. A failure logs `Bundle recovery mode` with the reason `structural providers unavailable: <ids>`, stops the platform and ends the host's start with exit code 1 ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)). The host checks again each time a generation becomes active; when a structural provider is lost after boot, for example because its generation exhausted its respawns, the host logs `Bundle recovery mode` and exits with code 1, so that its supervisor restarts it. When the catalog itself resolves to recovery mode, for example because the core cannot activate, the host stops the platform and its start also fails with exit code 1, after the platform log records each bundle and its reasons.

## `alternatives`

An alternative names a variable (`env`), its `options` and a `default` that must be one of them. The option is the variable's value when that value is one of the options, and the default otherwise ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)). Without `DORIC_COMPOSITION`, the host boots the shipped composition with the chosen option enabled in place of the default bundle; with `DORIC_COMPOSITION`, it boots the operator's file as written, and the enabled options say which choice it uses ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). The host logs the choices as `alternatives` in its `Doric starting` and `Doric listening` lines ([`index.ts`](../../../app/backend/doric-host/src/index.ts)). The shipped alternative is `sandbox`: `docker` by default, `firecracker` with `DORIC_SANDBOX_PROVIDER=firecracker` ([docker README](../../../bundles/sandboxes/docker/README.md), [firecracker README](../../../bundles/sandboxes/firecracker/README.md)).

## Composition overrides

The splash's recovery actions "Disable" and "Return to default composition" change the composition without rewriting its file. They write or delete `composition.overrides.json` beside the active composition, never in the product database ([`overrides.ts`](../../../packages/bundle/src/loader/overrides.ts)):

```json
{ "disabled": ["notifications"] }
```

Every host catalog read leaves the disabled bundles out of `enabled`, so they appear in the catalog with the state `disabled`. An overrides file that cannot be read is recorded as a catalog issue and ignored ([`activate.ts`](../../../packages/bundle/src/loader/activate.ts)). The two actions are members of `doric.catalog/v1` (below). They run one at a time, and each publishes a new generation after it writes; a change that cannot be published (the kernel's partition changed, the new generation failed to start, or the host is stopping) stays in the file, applies at the next host start and fails the call with `unavailable` ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)). The core cannot be disabled.

`disable` accepts any enabled bundle but the core, including one that `required` names. Disabling such a bundle removes a structural provider: the host exits with code 1 once the new generation activates, or the change waits for the next start, and every start after it fails at `bundle_load` until `composition.overrides.json` is deleted by hand ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)).

## The contract `doric.catalog/v1`

The platform provides `doric.catalog/v1`; no bundle may provide it, because `doric.*` ids are reserved for the platform ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`define.ts`](../../../packages/bundle/src/contracts/define.ts)). Every member is callable from a desktop window (`expose: 'desktop'`), and every member but `get` is served by the host only.

| Member                  | Returns                | Behavior                                                                                                                                         |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get()`                 | `CatalogSnapshot`      | The calling environment's catalog                                                                                                                |
| `distribution()`        | `DistributionCatalog`  | What the desktop needs of the active host generation                                                                                             |
| `artifact({ sha256 })`  | `DistributionArtifact` | One file listed in a retained generation, by hash; `not_found` when no retained generation lists the hash, or the file on disk does not match it |
| `watch(listener)`       | `Disposable`           | One `CatalogChange` (`{ generation }`) per published generation                                                                                  |
| `disable({ bundleId })` | `void`                 | Adds the bundle to the overrides and publishes; `not_found` when it is not in the composition, `invalid_input` for the core                      |
| `resetComposition()`    | `void`                 | Deletes the overrides and publishes                                                                                                              |

The desktop reaches these members through the host bridge, the Socket.IO namespace `/doric/bridge` ([`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts), [`catalog.ts`](../../../app/backend/doric-host/src/lib/bridge/catalog.ts)).

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

The dispatcher checks every call against the method's schemas in `platform.ts`: an input that fails fails the call with `invalid_input`, and a result that fails fails it with `invalid_output` ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). Those schemas are strict, so an unknown key in an object makes it invalid, except in the three record fields: `providers` and `desktopScope` accept any string key, and `descriptor` accepts any object. The desktop checks `descriptor` against the contract descriptor's schema when it resolves the generation and records a failure as `invalid_descriptor` ([`distribution.ts`](../../../packages/bundle/src/runtime/distribution.ts), [`descriptor.ts`](../../../packages/bundle/src/runtime/descriptor.ts), [Contracts](contracts.md#the-contract-descriptor-and-schemas)). `artifact` takes a `sha256` of 64 lowercase hex characters and `disable` a non-empty `bundleId`. `QuarantineCode` is one of the codes listed in [Core](core.md#quarantine). `call` is the optional call argument described in [Contracts](contracts.md#the-call); `StreamListener` and the `Disposable` that `watch` returns are described in [Streams](services-and-channels.md#streams).

A bundle's `files` are `manifest.json`, `contracts.json` and every file under `desktop/`, `client/` and `schemas/`, every `.js` file under `contracts/`, and the modules outside `contracts/` that those contracts import. `parts` holds the fixed paths that are present: `desktopMain` is `desktop/index.js`, `client` is `client/index.js`, `clientStyles` is `client/styles.css` and `contracts` is `contracts/index.js` ([`distribution.ts`](../../../packages/bundle/src/loader/distribution.ts)). An embedded bundle has no directory: its files are its contract documents, served from memory ([`catalog.ts`](../../../app/backend/doric-host/src/lib/bridge/catalog.ts)).

## Building and staging

Each bundle builds its own `dist`. The host's `build-bundles` target depends on the `build` target of every project tagged `type:bundle` and then runs `stage app/backend/doric-host/dist/bundles --all bundles`, which copies the `dist` of every directory `bundles/<group>/<id>` that has a `manifest.json` to `app/backend/doric-host/dist/bundles/<id>` ([`project.json`](../../../app/backend/doric-host/project.json), [`cli.ts`](../../../packages/bundle/src/build/cli.ts)). No list of bundles exists in the build: every bundle is staged, and the composition decides which ones are enabled.

## The splash on the desktop

The Electron main opens the splash, connects to the host and loads one generation ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)):

1. It calls `doric.catalog/v1.distribution()`.
2. It keeps the bundles whose host state is not `disabled` and, for each listed file, looks in `userData/bundles/<id>@<version>/<path>`. A file that is missing or whose SHA-256 differs is fetched with `artifact`, staged in `userData/bundles/.tmp` and moved into place by an atomic rename only when its SHA-256 equals the catalog's, so no partial file is ever served ([`artifacts.ts`](../../../app/desktop/doric/src/platform/catalog/artifacts.ts), [`paths.ts`](../../../app/desktop/doric/src/platform/paths.ts)).
3. It resolves `desktopMain` and `client` from the same candidates: host quarantines carry over, a bundle with a file that failed verification is quarantined with `invalid_part`, and `engines.doric` is checked against the desktop's platform version ([`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts), [Versioning](versioning.md)). In connected mode, each quarantine the desktop adds to a bundle that has a desktop part and that the host did not quarantine is reported to the host with `doric.diagnostics/v1.report` as `desktop_quarantine`.
4. It runs the generation's `desktopMain` parts in one Electron `utilityProcess` and, once they are active and in connected mode, saves the distribution as `userData/doric/catalog-snapshot.json` ([`snapshot.ts`](../../../app/desktop/doric/src/platform/catalog/snapshot.ts)).
5. When the desktop quarantined bundles that the host did not, the splash shows the `bundle-failure` state, which offers "Continue without them" ([`view.ts`](../../../app/desktop/doric/src/splash-page/view.ts)). After at least 5 seconds of splash, it fires `onAppReadyHook`, in which the core sets the menu skeleton and opens the `workspace` window, marked `primary`, at the last path stored for that key, or `/` ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [Hooks](hooks.md)).
6. The window is sandboxed and context-isolated ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)). It loads the renderer shell from `doric://app/platform/shell@<version>/`, which only boots the generation's `client` parts, imported from `doric://app/bundles/<id>@<version>/` out of the verified cache, and puts the core's `<core-outlet>` in the body ([doric-renderer README](../../../app/desktop/doric-renderer/README.md), [`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [doric:// protocol](doric-protocol.md)).
7. The splash closes when the first window calls `ready()`. A window not ready within 30 seconds, a core failure or an unreachable host shows the recovery state on the same surface ([`timing.ts`](../../../app/desktop/doric/src/platform/splash/timing.ts), [Splash and recovery](splash-and-recovery.md)).

When the host is unreachable, the splash shows the connection state and retries. Once a snapshot exists, the action "Open last known composition" loads it in the `disconnected-copy` mode, without downloads. The other recovery states and actions are in [Splash and recovery](splash-and-recovery.md) ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

## A new generation while the app is open

The main subscribes to `doric.catalog/v1.watch()`. On each published generation it reads the distribution again and, when it names a different host generation (by `storage.hostId`, `hostBoot` and `generation`), loads it as a new desktop generation in the background and fires `onGenerationReadyHook` in it. Open windows stay pinned to their generation and nothing reloads ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [Process isolation](process-isolation.md)).

## Related documents

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
