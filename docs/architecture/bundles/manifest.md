# The bundle manifest

- Status: living document. It describes the bundle manifest as implemented on 2026-11-20.

## Summary

A bundle's `manifest.json` holds what the platform must know about the bundle **before it runs any of its code**: who the bundle is, which platform versions it runs on, and which contracts it provides, requires and may use. Everything else is found by folder convention or registered by the bundle's code during `activate`, through the contracts written with the `define*` family (see [Contracts](contracts.md)).

The manifest is validated by one zod schema, `manifestV1Schema` ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). The bundle build CLI validates it before it builds the parts ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)), the loader validates it again when it reads the bundle ([`read.ts`](../../../packages/bundle/src/loader/read.ts)), and the catalog uses it, with the `contracts.json` descriptor the build writes beside it, to decide which bundles activate and in what order, without running any bundle code ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). The rules a bundle author follows when writing a manifest are listed in [`bundles/AGENTS.md`](../../../bundles/AGENTS.md); this document explains the mechanism behind them.

## An example

The manifest of the `git` bundle ([`manifest.json`](../../../bundles/features/git/manifest.json)):

```json
{
  "manifestVersion": 1,
  "id": "git",
  "version": "1.3.0",
  "engines": {
    "doric": "^1.0.0"
  },
  "description": "Git repository management capabilities for the Doric agent.",
  "provides": [
    "git.commands/v1@1.1.0",
    "git.changes/v1@1.0.0",
    "git.open-comparison/v1@1.0.0",
    "files.decorations/v1@1.0.0"
  ],
  "requires": [
    "tools/v1@^1.2.0",
    "runtime.workspace/v1@^1.1.0",
    "runtime.lease/v1@^1.1.0",
    "ui/v1@^1.0.0",
    "regions/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "workspace.selection/v1@^1.0.0",
    "runtime.records/v1@^1.0.0",
    "layout.tabs/v2@^2.0.0",
    "settings.config/v1@^1.0.0",
    "secrets/v1@^1.0.0",
    "hooks/v1@^1.0.0"
  ],
  "optional": [
    "files.sandbox/v1",
    "files.refresh/v1",
    "files.open-file/v1",
    "terminal/v1",
    "chat.hooks/v2"
  ],
  "desktopScope": {
    "git.commands/v1": ["projectId", "threadId", "promptId"]
  }
}
```

Basic contracts that the `core` bundle provides, such as `tools/v1`, `ui/v1` and `hooks/v1`, are listed under `requires` like any other contract. No `doric.*` contract appears: those belong to the platform.

## Fields

The schema is strict: a field it does not name is refused ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)).

| Field             | Required | Shape                                                     | What it is for                                                                                |
| ----------------- | -------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `manifestVersion` | Yes      | The literal `1`                                           | Marks the document as a version 1 manifest                                                    |
| `id`              | Yes      | One lowercase segment, `^[a-z][a-z0-9-]*$`, not `doric`   | The bundle's identity in the catalog; see [Bundle ids and Nx names](#bundle-ids-and-nx-names) |
| `version`         | Yes      | An exact semantic version, `MAJOR.MINOR.PATCH[-pre]`      | The bundle's version; the descriptor the build writes must carry the same one                 |
| `engines.doric`   | Yes      | A semantic version range; `engines` has no other key      | The platform versions the bundle runs on; outside the range the bundle is quarantined         |
| `provides`        | No       | List of `<contract>/v<major>@<version>`; empty by default | The contracts the bundle provides, defines or registers, each with its exact version          |
| `requires`        | No       | List of `<contract>/v<major>@<range>`; empty by default   | The contracts the bundle's activation depends on, each with the range of versions it accepts  |
| `optional`        | No       | List of bare contract ids, `<contract>/v<major>`          | The contracts the bundle uses when they are present, without an activation dependency         |
| `desktopScope`    | No       | Map from a provided contract id to a list of scope keys   | The scope keys a desktop window may send to that contract                                     |
| `description`     | No       | A non-empty string                                        | A short text for the catalog and for diagnostics                                              |

A contract id is lowercase segments separated by `.`, the first starting with a letter, then `/v` and a positive major: `contractIdPattern` in [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts). By convention it starts with the id of the bundle that owns it (`git.commands/v1`), and a bundle's main contract may be its bare id (`files/v1`, `runtime/v2`); the basic contracts are named by domain (`hooks/v1`, `storage.backend/v1`) ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)). The schema checks the shape, not the prefix: `git`, for example, provides `files.decorations/v1`, a contract `files` declares and lists under `optional` ([`git/manifest.json`](../../../bundles/features/git/manifest.json), [`files/manifest.json`](../../../bundles/features/files/manifest.json)).

## `provides`, `requires` and `optional`

### Versions and ranges

An entry of `provides` carries the exact version the bundle provides (`git.commands/v1@1.1.0`); its major must equal the `/v<major>` of the id. An entry of `requires` carries a range (`runtime.lease/v1@^1.1.0`) that must admit exactly one major, the one of the id. `^1.2.0`, `~1.2.0`, `>=1.2.0 <2.0.0` and `1.2.0` qualify for a `/v1` id; `>=1.0.0`, `*` and `^1.0.0 || ^2.0.0` do not, because they admit no major or several. The ranges accept the operators `^`, `~`, `>=`, `<=`, `>`, `<` and `=`, a bare version, `*`, `x` and `X`, joined by spaces and by `||` ([`semver.ts`](../../../packages/bundle/src/runtime/semver.ts), [`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). An entry of `optional` carries no version: it is the bare contract id. How a contract takes a patch, a minor or a major is in [Versioning](versioning.md).

### `provides` and the descriptor

`provides` must match what the bundle's code does. The build imports each part (`host/index.js`, `desktop/index.js`, `client/index.js`) and runs its `activate` against recording services. A contract the part provides with `services.provide`, defines with `hooks/v1.define`, or registers as an event, a settings group, a storage type or a command is recorded. The build fails when a recorded contract is missing from `provides`, when a `provides` entry is recorded by no part, when one contract is defined or registered twice in one environment (a `many` service may be provided several times, and is recorded once) ([`record.ts`](../../../packages/bundle/src/build/record.ts)), and when a contract's schemas differ between environments ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)). From the recording it writes `dist/contracts.json`, the descriptor: one entry per contract and environment, with the version from `provides`, the kind, the cardinality, whether the contract is `local`, and the path of the contract's JSON Schema ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`descriptor.ts`](../../../packages/bundle/src/runtime/descriptor.ts)).

The manifest does not say in which environment a contract is provided, nor its cardinality (`one` or `many`); the descriptor does. The catalog quarantines a bundle with `invalid_descriptor` when `contracts.json` is missing, when its bundle id or version differ from the manifest's, or when its contracts and versions differ from `provides` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). At run time, `services.provide` of a contract the descriptor does not list for the current environment throws `undeclared_provide` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).

When two enabled bundles provide a contract of cardinality `one`, the composition chooses one of them under `providers` (see [Services and channels](services-and-channels.md) and [Core](core.md)).

### `requires`: activation dependencies

The catalog reads `requires` per environment ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

- A part in `host` is served by providers in `host`, a part in `desktopMain` by providers in `desktopMain`, and a part in `client` by providers in `client`, `desktopMain` and `host`.
- The catalog checks the first reachable environment, in the order `client`, `desktopMain`, `host`, that has a provider of the contract: its active provider (for a `one` contract) or each live provider (for a `many` contract) must provide a version the range satisfies; otherwise the bundle is quarantined with `incompatible_version`. When every provider of the contract is quarantined, the bundle is quarantined with `dependency_quarantined`, so a quarantine cascades along `requires`.
- When no enabled bundle provides the contract in any environment, the bundle is quarantined with `missing_dependency`. A contract provided only in an environment the part does not reach constrains nothing there.
- A provider in the same environment becomes an activation dependency: it activates first. The members of a cycle of such dependencies are quarantined with `dependency_cycle`.

The `core` bundle is resolved apart: its `requires` may name only contracts that an active foundation bundle provides (`storage.backend/v1` and `secrets.backend/v1` in the shipped `core`), and a failure there sends the environment to recovery mode instead of quarantining `core` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`manifest.json`](../../../bundles/foundation/core/manifest.json)). The foundation and the order in which it activates are in [Core](core.md).

### `optional`: best-effort use

`optional` lists contracts a bundle may call when a provider is active, without depending on it for activation: the catalog does not read `optional`, so a missing, quarantined or incompatible provider neither quarantines the bundle nor orders its activation ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). An `optional` line is still a dependency between bundles for the repository: the `cycles` check of `npm run lint:test` draws an edge for each `requires` and `optional` line, from the bundle that lists the contract to each provider, or from the provider to it when the listing bundle declares the contract (`files` for `files.decorations/v1`), and fails on a cycle that the edges listed in `tests/boundary-exceptions.json` do not break ([`boundaries.mjs`](../../../tests/support/boundaries.mjs)). A contract under `optional` may be used with `services.use` like one under `requires` ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). A call through that stub with no active provider throws `unavailable`, and the caller falls back to its own unavailable behavior; while no generation is active yet, the call waits for one instead ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). The `transport` bundle, for example, lists `files/v1`, `git.commands/v1`, `usage/v1`, `resources/v1` and `terminal/v1` under `optional` and reaches them only when a request needs them ([`manifest.json`](../../../bundles/foundation/transport/manifest.json), [`kernel.ts`](../../../bundles/foundation/transport/src/kernel.ts)). `git` lists `chat.hooks/v2` there and observes it with `whenAvailable`, so it loads in a composition without `chat`.

### Every contract a bundle uses is listed

A bundle lists every contract it uses that it does not provide, under `requires` or `optional`. Three checks hold that rule:

- **At run time**, `services.use(Contract)` and `hooks/v1.use(Contract)` throw `undeclared_requirement` unless the contract is listed under `requires` or `optional`, is one the bundle provides, or is a `doric.*` contract. The bundle that the composition names as its core may also use any basic contract ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).
- **At build time**, the recording services apply the same rule to `use` during the dry activation of each part, and the build fails on an unlisted contract; the core receives no exception there ([`record.ts`](../../../packages/bundle/src/build/record.ts)).
- **In the repository**, the `declared` check of `npm run lint:test` reads each bundle's `src/`, with comment lines blanked: a contract id that some manifest provides, written as a whole string literal, or a value imported from `<other>/contracts` or `bundle/contracts` that stands for a contract id, must be provided or listed under `requires` or `optional`; an `import type` is not a use, and the core's uses of `bundle/contracts` symbols are skipped. The same check reports a `requires` or `optional` line whose id no manifest provides ([`boundaries.mjs`](../../../tests/support/boundaries.mjs)).

`services.whenAvailable` and `hooks/v1.whenAvailable` are not checked against the manifest at run time or at build time ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`record.ts`](../../../packages/bundle/src/build/record.ts)); a contract a bundle reaches only through them is held to the rule by the repository check, through the symbol the bundle imports.

### Platform contracts

A contract whose id starts with `doric.` belongs to the platform. The schema refuses it under `provides` and `requires`; a bundle uses it without listing it, and it always exists ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)).

## `desktopScope`

A call carries a scope, a record of string keys (see [Contexts](contexts.md)). `desktopScope` names, for each contract the bundle provides, the scope keys a desktop window may send to it. Sixteen shipped bundles use it, for the contracts a window calls with a Project, a Thread or a prompt in view; `openui` and `papercraft` accept `projectId` and `threadId` only:

| Bundle          | `desktopScope`                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `runtime`       | `runtime/v2`, `runtime.threads/v1`, `runtime.lease/v1`, `runtime.attachments/v1`: `projectId`, `threadId`, `promptId` |
| `chat`          | `chat.composer/v1`: `projectId`, `threadId`, `promptId`                                                               |
| `git`           | `git.commands/v1`: `projectId`, `threadId`, `promptId`                                                                |
| `history`       | `history.snapshots/v1`: `projectId`, `threadId`, `promptId`                                                           |
| `notifications` | `notifications.observations/v1`: `projectId`, `threadId`, `promptId`                                                  |
| `host-config`   | `host-config/v1`: `projectId`, `threadId`, `promptId`                                                                 |
| `claude-login`  | `claude.login/v1`: `projectId`, `threadId`, `promptId`                                                                |
| `comments`      | `comments/v1`: `projectId`, `threadId`, `promptId`                                                                    |
| `files`         | `files/v1`: `projectId`, `threadId`, `promptId`                                                                       |
| `mcp`           | `mcp/v1`: `projectId`, `threadId`, `promptId`                                                                         |
| `resources`     | `resources/v1`: `projectId`, `threadId`, `promptId`                                                                   |
| `screen`        | `screen.sessions/v2`: `projectId`, `threadId`, `promptId`                                                             |
| `terminal`      | `terminal/v1`: `projectId`, `threadId`, `promptId`                                                                    |
| `usage`         | `usage/v1`: `projectId`, `threadId`, `promptId`                                                                       |
| `openui`        | `openui.programs/v1`, `openui.questions/v1`: `projectId`, `threadId`                                                  |
| `papercraft`    | `papercraft.programs/v1`, `papercraft.cache/v1`: `projectId`, `threadId`                                              |

(From [`runtime`](../../../bundles/runtime/runtime/manifest.json), [`chat`](../../../bundles/desktop/chat/manifest.json), [`git`](../../../bundles/features/git/manifest.json), [`history`](../../../bundles/desktop/history/manifest.json), [`notifications`](../../../bundles/desktop/notifications/manifest.json), [`host-config`](../../../bundles/foundation/host-config/manifest.json), [`claude-login`](../../../bundles/features/claude-login/manifest.json), [`comments`](../../../bundles/features/comments/manifest.json), [`files`](../../../bundles/features/files/manifest.json), [`mcp`](../../../bundles/features/mcp/manifest.json), [`resources`](../../../bundles/features/resources/manifest.json), [`screen`](../../../bundles/features/screen/manifest.json), [`terminal`](../../../bundles/features/terminal/manifest.json), [`usage`](../../../bundles/features/usage/manifest.json), [`openui`](../../../bundles/features/openui/manifest.json) and [`papercraft`](../../../bundles/features/papercraft/manifest.json).)

The schema requires each key of `desktopScope` to be a contract listed under `provides`, and each list to hold distinct scope keys (`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`), at most 16 of them, never `windowKey` in any letter case: the platform alone sets `windowKey` ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`call.ts`](../../../packages/bundle/src/contracts/call.ts)). The desktop process routes a window's call to the provider of the contract and refuses, with `invalid_input`, a call whose scope holds a key that the provider's `desktopScope` does not list for that contract; a contract absent from `desktopScope` accepts no key ([`client-routing.ts`](../../../app/desktop/doric/src/platform/bridge/client-routing.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)). Which methods a window may call at all is decided by each method's exposure, not by the manifest (see [Services and channels](services-and-channels.md)). The repository's `core` check reports any `projectId`, `threadId` or `promptId` key in the `desktopScope` of `core`, which stays free of conversation keys ([`boundaries.mjs`](../../../tests/support/boundaries.mjs)).

## The rules the schema enforces

Beyond the shape of each field, `manifestV1Schema` refuses ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)):

| Rule                                                                                                | Field                                    |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A field the schema does not name, in the manifest or in `engines`                                   | any                                      |
| The id `doric`                                                                                      | `id`                                     |
| An entry not of the form `<contract>/v<major>@<version-or-range>`                                   | `provides`, `requires`                   |
| A `doric.*` contract                                                                                | `provides`, `requires`                   |
| The same contract id twice in one list                                                              | `provides`, `requires` (each on its own) |
| A version that is not exact, or whose major differs from the id's                                   | `provides`                               |
| A range that does not parse, or that admits a major other than the id's, or several majors          | `requires`                               |
| An entry that is not a contract id                                                                  | `optional`                               |
| A contract not listed under `provides`; a repeated, malformed or `windowKey` key; more than 16 keys | `desktopScope`                           |

The schema does not compare the lists with each other beyond `desktopScope`: one contract may appear under both `provides` and `requires`, and `optional` is not checked for `doric.*` ids, repeated ids or ids also under `requires`. Whether a listed contract is provided by some bundle is a question for the catalog and for the repository check, not for the schema.

The platform publishes the schema as a JSON Schema document, `doric://app/schemas/bundle-manifest/v1.json`, generated from `manifestV1Schema` by the build of `packages/bundle` and served under `/schemas/` of the [`doric://app` origin](doric-protocol.md) ([`platform-schemas.ts`](../../../packages/bundle/src/build/platform-schemas.ts), [`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)).

### A manifest without `manifestVersion`

The loader reads a `manifest.json` without `manifestVersion` with a second schema, of the fields `name`, `description`, `tools` and `skills` (the code calls it v0), and converts it in memory to a version 1 manifest: the id is `name`, the version `0.0.0`, `engines.doric` is `*`, the description is kept, `provides` is empty, and `requires` holds `tools/v1@^1.0.0` when `tools` is not empty. Such a bundle receives an empty descriptor, and the loader itself registers the listed tools and skills in its name ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`discover.ts`](../../../packages/bundle/src/loader/discover.ts), [`activate.ts`](../../../packages/bundle/src/loader/activate.ts)). Every shipped bundle has a version 1 manifest. The build also accepts a version 2 manifest (`manifestV2Schema`, with `requires` and `optional` under `host` and `client`; phase 2 of [`grpc-processes.md`](../../designs/grpc-processes.md)), on which it runs the check `contract_environment`; a version 1 manifest may set `host.httpPrefix`, and both versions may set `host.assets`, the globs, relative to the bundle directory, of the files the host part reads with `context.assets` (refused: empty, absolute, a `.`, `..` or empty segment, a `\`; phase 3) ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). This document describes version 2 in phase 8.

## Package layout and build output

A bundle is a folder `bundles/<group>/<id>/`, where `<group>` is one of `desktop`, `features`, `foundation`, `providers`, `runtime` and `sandboxes`. The folder holds, beside files only one bundle needs (such as `prisma/` in `postgres`):

| Path                      | What it is                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `manifest.json`           | The manifest                                                                                                 |
| `README.md`               | What the bundle does and how to use it                                                                       |
| `AGENTS.md`               | The bundle's rules for agents, in the bundles that have them                                                 |
| `package.json`            | The package metadata: `name` equal to the id, `type: module`, `exports`, and the packages the bundle imports |
| `project.json`            | The Nx project, named `bundle-<id>`, with at least the targets `build`, `typecheck` and `test`               |
| `tsconfig*.json`          | The TypeScript projects of the parts and of the tests                                                        |
| `src/host/index.ts`       | The `host` part                                                                                              |
| `src/desktop/index.ts`    | The `desktopMain` part                                                                                       |
| `src/client/index.ts`     | The `client` part, with `styles.css`, `workers/`, `chunks/` and `frames/` beside it when the bundle has them |
| `proto/`                  | The bundle's `.proto` contracts, under `proto/doric/<package path>/`, in the bundles that have them          |
| `src/contracts/`          | The public contracts module, exported from `src/contracts/index.ts`                                          |
| `src/contracts/gen/`      | The protobuf-es code `generate-proto` writes from `proto/`, ignored by Git                                   |
| `src/skills/*/SKILL.md`   | Skills                                                                                                       |
| `tests/`                  | The bundle's tests                                                                                           |
| `stories/`, `.storybook/` | Storybook stories of the client part                                                                         |

A bundle has only the parts it needs: a part without a source entry is not built ([`parts.ts`](../../../packages/bundle/src/build/parts.ts)). A bundle with a contracts module exports it as the package subpath `./contracts`, so other bundles import it as `<id>/contracts` (see [Contracts](contracts.md)); a bundle that publishes no contracts module has no such subpath (`threads`, `postgres`, `transport`, the model providers and the sandboxes). A bundle with `.proto` contracts, `transport` included, also exports `./contracts/gen/*`, its generated code, and has the Nx target `generate-proto`, which `build` and `typecheck` run first; and some bundles export further subpaths, such as `./testing`, `./host` or `./kernel` ([`terminal/package.json`](../../../bundles/features/terminal/package.json), [`runtime/package.json`](../../../bundles/runtime/runtime/package.json), [`host-config/package.json`](../../../bundles/foundation/host-config/package.json), [`transport/package.json`](../../../bundles/foundation/transport/package.json)).

The `build` target of a bundle's Nx project runs `tsc --build` of the bundle's `tsconfig.json`, which compiles the sources its `include` names, never `src/client/` (in `git`, all of `src/` but `src/client/`), to `bundles/<group>/<id>/dist`, then the bundle build CLI, `node packages/bundle/dist/build/cli.js build bundles/<group>/<id>` ([`git/project.json`](../../../bundles/features/git/project.json), [`git/tsconfig.json`](../../../bundles/features/git/tsconfig.json)). A bundle with a client part, except `core` and `notifications`, type-checks its client project (`tsc -p tsconfig.client.json`, which writes nothing) between the two; `papercraft` and `screen` also type-check `tsconfig.parts.json`, and `papercraft` bundles its sandbox runner to `dist/sandbox/runner.mjs` after the CLI ([`papercraft/project.json`](../../../bundles/features/papercraft/project.json), [`screen/project.json`](../../../bundles/features/screen/project.json)). The CLI then ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`parts.ts`](../../../packages/bundle/src/build/parts.ts)):

1. validates `manifest.json` and copies it to `dist/manifest.json`;
2. validates each skill and copies it to `dist/skills/`, and copies the Markdown files below `src/host` to `dist/host`;
3. bundles `src/desktop/index.ts` to `dist/desktop/index.js` and `src/client/index.ts` to `dist/client/index.js`, with the client's CSS at `dist/client/styles.css` and its workers, chunks and frames below `dist/client/`; an import of the bundle's own `src/contracts/` becomes the external `<id>/contracts` (a frame of the client bundles those sources instead), and imports a part may not contain fail the build;
4. imports each built part, runs its `activate` against the recording services, and checks the recording against the manifest (see [`provides` and the descriptor](#provides-and-the-descriptor));
5. writes one JSON Schema per recorded contract to `dist/schemas/<contract>.json`, the descriptor `dist/contracts.json`, and `dist/package.json` with `type: module`.

`dist/` then holds what the bundle ships: the output of `tsc` (`host/`, `contracts/`, and modules such as `kernel.js` in `transport`), `desktop/`, `client/`, `manifest.json`, `contracts.json`, `package.json`, `schemas/` and the skills. The CLI command `stage <dest> <bundleDir...>` (or `stage <dest> --all <root>`, for every `<root>/<group>/<id>` with a `manifest.json`) copies each bundle's `dist/`, without `.tsbuildinfo` files, to `<dest>/<id>`, where `<id>` is read from `dist/manifest.json` ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)). How the host then distributes the staged bundles is in [Composition and distribution](composition-and-distribution.md).

## Bundle ids and Nx names

A bundle id is one lowercase segment: a letter, then letters, digits and `-` (`bundleIdPattern` in [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). It has no `.` and no `/`: a contract id always ends in `/v<major>`, and the first `.`-segment of a bundle's contract id names the bundle that owns it; a basic contract such as `storage.backend/v1` has no owning bundle ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). It is never `doric`, the identity the platform uses as the caller and owner of `doric.*` contracts ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). Two installed bundles with the same id are refused: the second is quarantined with `duplicate_id` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).

Ids are short names of what a bundle does: `core`, `postgres`, `transport` and `host-config` in `foundation`; `runtime` and `default` in `runtime`; `chat`, `layout`, `settings`, `workspace`, `history`, `notifications` and `account` in `desktop`; `files`, `git`, `terminal`, `mcp` and the other features in `features`; `openai`, `openrouter`, `codex` and `claude` in `providers`; `docker` and `firecracker` in `sandboxes`. In every shipped bundle the same name is the folder name, the manifest `id` and the package `name`, and the Nx project is named `bundle-<id>` (`bundle-git`), so that `npx nx run bundle-git:test` runs one bundle's tests ([`bundles/`](../../../bundles), [`git/project.json`](../../../bundles/features/git/project.json)). The id also prefixes the bundle's contract ids by convention (`git.commands/v1`), and names the staged folder and the `<id>/contracts` import specifier.

## Related documents

- [Contracts](contracts.md): the `define*` family, contract ids and the `contracts` entry point.
- [Versioning](versioning.md): the semver rules for `version`, `engines.doric` and the versions and ranges of `provides` and `requires`.
- [Core](core.md): the foundation, the core's own `requires`, and quarantine.
- [Services and channels](services-and-channels.md): `services.provide`, `services.use` and `services.whenAvailable`, cardinality, `providers`, and exposure to a desktop window.
- [Hooks](hooks.md): how a hooks contract appears under `provides`, `requires` and `optional`.
- [Contexts](contexts.md): the call and its scope.
- [Composition and distribution](composition-and-distribution.md): how the host publishes the staged bundles.
- [The `doric://app` origin](doric-protocol.md): where the published JSON Schemas are served.
- [`bundles/AGENTS.md`](../../../bundles/AGENTS.md): the rules a bundle author follows for the manifest and the package.
