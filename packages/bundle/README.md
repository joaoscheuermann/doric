# bundle

Everything in Doric is a bundle. Agent tools, skills, model providers,
sandboxes, storage, the agent runtime and every part of the desktop UI are
plugged in as bundles that provide and consume typed, versioned service
contracts. `bundle` is the platform that makes this work: the contract API
bundles are written against, the service runtime shared by every environment,
and the Node loader and build tooling of the host. If you want to extend or
replace any part of Doric, start here.

Part of [Doric](../../README.md).

## Why bundles

- **Typed contracts.** A service is a set of methods with Zod input and output
  schemas; calls are validated at the boundary, and the build publishes each
  contract as JSON Schema.
- **One model for every environment.** The same contracts run in the host,
  the desktop main process and the renderer (`host`, `desktopMain`,
  `client`).
- **Replaceable pieces.** A composition chooses which bundles are enabled and
  which one provides a contract, so a provider, sandbox or UI part can be
  swapped without touching the rest.
- **Safe startup.** Bundles that cannot activate are quarantined with a
  reason instead of taking the host down, and the host reports a recovery
  mode when its core cannot start.
- **Testable in isolation.** `createTestServices` runs a bundle's services in
  process, without a catalog or loader.

Doric's own bundles live under [`/bundles`](../../bundles): `foundation`
(core, storage on PostgreSQL, transport, host configuration), `runtime`,
`providers` (`openai`, `openrouter`, `codex`), `sandboxes` (`docker`,
`firecracker`), `features` (files, Git, terminal, web, threads and more) and
`desktop` (layout, chat, settings, history, notifications).

## Entry points

| Entry              | Audience                      | Contents                                                                                                                 |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bundle/contracts` | Bundle authors (browser-safe) | `define*`, `ref`, `Call`, `ContractError`, `Services`, the basic contract refs (`HooksV1`, `ToolsV1`, ...) and `doric.*` |
| `bundle/runtime`   | Platform only (browser-safe)  | Service directory, dispatcher, call propagation, manifest/composition/descriptor schemas, resolver, activation loop      |
| `bundle`           | Host (Node)                   | `startHost`, discovery, catalog, build CLI and testing helpers                                                           |
| `bundle/testing`   | Bundle unit tests             | `createTestServices`                                                                                                     |
| `bundle/externals` | Build tooling                 | `clientExternals`: the import-map specifiers a client part leaves to the window                                          |
| `bundle/schemas/*` | Anyone                        | Generated JSON Schemas of the manifest, composition, descriptor and platform contracts                                   |

`bundle/contracts` and `bundle/runtime` import only relative modules and
`zod`; `tsconfig.browser.json` typechecks them without Node types.

## Writing a bundle

```ts
import {
  defineMethod,
  defineService,
  type HostContext,
} from 'bundle/contracts';
import { z } from 'zod';

export const greeter = defineService('greeter.api/v1', {
  greet: defineMethod({
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ text: z.string() }).strict(),
    execute: ({ name }, call) => ({
      text: `${name} from ${call.caller.bundleId}`,
    }),
  }),
});

export const activate = ({ services }: HostContext) => {
  services.provide(greeter);
};
```

`manifest.json` (v1) declares identity, platform range and contracts:

```json
{
  "manifestVersion": 1,
  "id": "greeter",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": ["greeter.api/v1@1.0.0"],
  "requires": ["tools/v1@^1.0.0"]
}
```

### Bundle layout

- Parts live at `host/index.js`, `desktop/index.js` and `client/index.js`.
- A client may also have frames: each `src/client/frames/<name>.ts` builds to
  `client/frames/<name>.js`, a module for a document outside the window (a
  Papercraft preview's sandboxed iframe loads one through
  `doric://app/frame/index.html?entry=`). Only the frame import map's
  specifiers stay external (`react`, `react/jsx-runtime`,
  `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`, `@base-ui/react`
  and its subpaths); `zod` and what it imports by relative path (its own
  contracts' sources included) are bundled in, and the window's other
  import-map specifiers (`desktop/*`, `bundle/*`, any `<id>/contracts`) fail
  the build. Frames
  ship with the client's files and are served with
  `Access-Control-Allow-Origin: *`.
- Skills live at `skills/*/SKILL.md`, discovered in lexical directory order,
  with an optional `alwaysAvailable` frontmatter flag.
- A manifest without `manifestVersion` is read as v0 and converted in memory:
  its `name` becomes the ID, its version `0.0.0`, any platform version is
  accepted, it provides nothing, and it requires `tools/v1` when it lists
  tools.

### Testing a bundle

```ts
import { createTestServices } from 'bundle/testing';

const harness = createTestServices({
  bundle: { id: 'greeter' },
  provide: [fakeDependency],
});

try {
  harness.services.provide(greeter);
  // Exercise the services with a hop Call: harness.call()
} finally {
  await harness.dispose();
}
```

`provide` registers service definitions from a fake `test-provider` bundle,
and `reports` collects the failures the runtime reported.

## Booting the host

```ts
import { startHost } from 'bundle';

const platform = await startHost({
  bundlesPath: 'app/backend/doric-host/dist/bundles',
  composition: { path: 'app/backend/doric-host/composition.json' },
  log: platformLog,
  sink: logSink,
});

await platform.ready();
```

`startHost`:

- resolves the catalog (foundation, core, others; per-environment `requires`;
  quarantine with reasons);
- activates each bundle with its own services and disposal scope;
- reports `mode: 'recovery'` when the core or a chosen foundation provider
  cannot activate.

`catalog()`, `diagnostics()` and the `doric.catalog/v1`,
`doric.diagnostics/v1`, `doric.bundle/v1` and `doric.log/v1` services expose
the result.

`platform.storageIdentity()` asks the active `storage.backend/v1` provider for
the host's `{ hostId, storageGeneration }` (or answers `undefined` without
one). A resolved identity is kept and published as `catalog().storage`; a
failure is not kept, so the next call asks again. The host calls it once the
database is reachable.

## Basic contracts

`bundle/contracts` defines each basic contract's interface, its `ref`
(`StorageV1`, `SecretsV1`, ...) and its method table (`storageMethods`,
`secretsMethods`, ...). A provider must implement exactly that table with the
same schemas, or `provide` fails with `contract_mismatch`. The tables are also
published under `bundle/schemas/contracts/`.

| Contract                                        | Environments            | Providers |
| ----------------------------------------------- | ----------------------- | --------- |
| `hooks/v1`, `log/v1`                            | all                     | one       |
| `tools/v1`, `skills/v1`, `models/v1`            | `host`                  | one       |
| `models.provider/v1`                            | `host`                  | many      |
| `storage/v1`, `storage.backend/v1`              | `host`                  | one       |
| `secrets/v1`, `secrets.backend/v1`, `events/v1` | `host`                  | one       |
| `settings/v1`                                   | `host`, `desktopMain`   | one       |
| `commands/v1`                                   | `desktopMain`, `client` | one       |
| `windows/v1`, `menus/v1`                        | `desktopMain`           | one       |
| `ui/v1`, `navigation/v1`, `regions/v1`          | `client`                | one       |

Notes on the data contracts:

| Contract                           | Notes                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/v1`, `storage.backend/v1` | Documents with revisions (`expect` revision 0 = must not exist), indexed queries (at most 1000 per page), streams with protocol `createdAt` and truncation marks, atomic commits (expect → delete → put → dropStreams → truncate → append), a commit feed, blobs, `health()` measurements and the backend's `identity()`                        |
| `secrets/v1`, `secrets.backend/v1` | Credentials by kind with the one field rule (`credentialFieldsSatisfied`, `credentialFieldsMessage`), `resolveByKind(kind, { exclude }?)`, `redactions()`, and the local `view()` and `registerReferences(source)`; the backend stores plaintext across the contract                                                                            |
| `settings/v1`                      | Spaces with `get`, `entry` (`value`, `revision`, `version`, `updatedAt`, `generation`), `set` with `expectedRevision`, and `subscribe`                                                                                                                                                                                                          |
| `events/v1`                        | `register`, `sink` and `append`; the owner's `sink` names the scope keys and the stream of each row (`{key}` placeholders), so the platform knows no Thread log: the runtime's sink is `runtime.thread.events/{threadId}` with `{ projectId, threadId, promptId }`, and its stored envelope is `runtime/contracts`' `threadEventEnvelopeSchema` |

Every contract documents its error codes beside it; they are listed in
`contractErrorCodes`.

## Build tooling

```console
node packages/bundle/dist/build/cli.js build [--development] <bundleDir>
node packages/bundle/dist/build/cli.js stage <dest> <bundleDir...>
node packages/bundle/dist/build/cli.js copy-md <from> <to>
```

`build` runs after `tsc`. It validates the manifest, copies skills and the
host part's Markdown templates (every `.md` below `src/host`, copied to the
same path below `dist/host` before the dry activation, because the host part
reads them when it is imported; stale `.md` files there are removed), builds
the desktop and client parts and the client's frames (production mode unless
`--development`), dry-activates the parts (never a frame) to compute each contract's environment and
cardinality, and writes `dist/contracts.json` and
`dist/schemas/<contract>.json` (JSON Schema 2020-12). There is no semver check
against a published baseline yet: `contracts.published.json` files and the
`baseline` command were removed until publishing exists (stage 11), and a
leftover file is ignored.

`stage` copies each `dist` into `<dest>/<id>`.

`copy-md` mirrors the `.md` files below `<from>` into `<to>` the same way
`build` does: it removes every `.md` below `<to>`, then copies each one from
`<from>` to the same relative path, and keeps every other file. A bundle's
`test` target runs it after `tsc` so the compiled tests find the templates
(`default` copies `src/host` into `dist-tests/src/host`).

## Development

```console
npx nx run bundle:build
npx nx run bundle:typecheck
npx nx run bundle:test
```
