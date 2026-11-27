# bundle

`bundle` is the platform package of Doric's bundles. Every feature of Doric —
agent tools, skills, model providers, sandboxes, storage, the agent runtime and
every part of the desktop UI — is a bundle that provides and consumes typed,
versioned service contracts. This package holds what makes that work:

- the contract API bundles are written against (`bundle/contracts`);
- the service runtime every environment shares: service directory, dispatcher,
  calls, catalog resolution, activation loop, the process envelope
  (`bundle/runtime`);
- the Node side of the host: discovery, the catalog and the build CLI
  (`bundle`);
- in-process test harnesses for bundles (`bundle/testing`);
- the import-map specifiers a client part leaves to its window
  (`bundle/externals`) and the generated JSON Schemas (`bundle/schemas/*`).

Part of [Doric](../../README.md). This README is the home of every fact of the
package: its exports and their signatures, their behavior, the data they read
and write, their side effects, configuration, limits and errors, and how the
package and a bundle are built and tested. The cross-unit mechanisms the
package implements are described in the architecture documents linked from
each section.

## Who uses it

| Kind     | Users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Entries                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Bundles  | Every bundle under [`/bundles`](../../bundles): its parts and its contracts module                                                                                                                                                                                                                                                                                                                                                                                                               | `bundle/contracts`                                                |
| Bundles  | Every bundle's tests, for example [`client/activation.test.ts`](../../bundles/runtime/runtime/tests/client/activation.test.ts) (`checkRecording`, `recordActivation`) and [`chat/tests/support/desktop.ts`](../../bundles/desktop/chat/tests/support/desktop.ts)                                                                                                                                                                                                                                 | `bundle/testing`, `bundle/runtime`, `bundle`, `bundle/contracts`  |
| Bundles  | Every bundle's Nx `build` target (see [Writing a bundle](#writing-a-bundle))                                                                                                                                                                                                                                                                                                                                                                                                                     | The build CLI                                                     |
| Bundles  | No bundle imports the type `EmbeddedBundle` any more: it is exported from `bundle` ([`catalog.ts`](src/loader/catalog.ts)) and used by this package's tests ([`tests/support/fixtures.ts`](tests/support/fixtures.ts)); `host-config` and `transport` stopped importing it with their kernel entries (slices S68a and S69)                                                                                                                                                                       | `bundle` (types)                                                  |
| Apps     | [`doric-host`](../../app/backend/doric-host/README.md) boots the platform with `startHostPlatform` and serves the public listener (`PLATFORM_VERSION`, exposure)                                                                                                                                                                                                                                                                                                                                 | `bundle`, `bundle/contracts`, `bundle/platform`, `bundle/runtime` |
| Apps     | The desktop app [`doric`](../../app/desktop/doric/README.md) runs `desktopMain` generations and the window bridge, and serves `/schemas/` from the copy of `dist/schemas` the platform build makes ([`handler.ts`](../../app/desktop/doric/src/platform/protocol/handler.ts))                                                                                                                                                                                                                    | `bundle/runtime`, `bundle/contracts`                              |
| Apps     | The desktop platform build `app/desktop/doric-platform` imports `PLATFORM_ASSETS_VERSION`, bundles `src/contracts/index.ts` as the window's `bundle/contracts` module, and copies `packages/bundle/dist/schemas` by path into the desktop assets as `<out>/schemas/` ([`build.mjs`](../../app/desktop/doric-platform/build.mjs), [`packages.config.mjs`](../../app/desktop/doric-platform/packages.config.mjs)). Moving or renaming `dist/schemas` or `src/contracts/index.ts` breaks that build | `bundle/runtime`, `src/contracts/index.ts`, `dist/schemas`        |
| Apps     | The renderer shell [`doric-renderer`](../../app/desktop/doric-renderer/README.md) imports `desktop/client`, which imports `bundle/contracts` and `bundle/runtime`; its webpack resolves with the `@org/source` condition, so the shell compiles this package's `src/`, not `dist/` ([`webpack.config.js`](../../app/desktop/doric-renderer/webpack.config.js), [`bootstrap.ts`](../../app/desktop/doric-renderer/src/bootstrap.ts))                                                              | `bundle/contracts`, `bundle/runtime` (through `desktop/client`)   |
| Apps     | The desktop end-to-end tests `app/desktop/doric-e2e` ([`bridge.test.ts`](../../app/desktop/doric-e2e/tests/bridge.test.ts), [`harness.ts`](../../app/desktop/doric-e2e/tests/support/harness.ts))                                                                                                                                                                                                                                                                                                | `bundle/contracts`, `bundle/runtime`                              |
| Apps     | The host end-to-end tests `app/backend/doric-host-e2e` declare `bundle` as a dependency and a TypeScript project reference, and import none of its entries ([`package.json`](../../app/backend/doric-host-e2e/package.json), [`tsconfig.json`](../../app/backend/doric-host-e2e/tsconfig.json))                                                                                                                                                                                                  | None                                                              |
| Packages | [`tool`](../tool/README.md) (`defineTool` over `tools/v1`), [`storage`](../storage/README.md) (in-memory foundation), [`desktop`](../desktop/README.md) (window bootstrap, elements)                                                                                                                                                                                                                                                                                                             | `bundle/contracts`, `bundle/runtime`, `bundle`                    |
| Tests    | The repository's boundary test [`boundaries.test.mjs`](../../tests/boundaries.test.mjs) reads the symbols of `packages/bundle/src/contracts/` by path and reports a bundle other than `core` that uses a `bundle/contracts` symbol without declaring its contract ([`boundaries.mjs`](../../tests/support/boundaries.mjs))                                                                                                                                                                       | `src/contracts/` (by path)                                        |

No code imports the `bundle/externals` specifier: the package's own build reads
[`externals.ts`](src/build/externals.ts) through a relative import
([`parts.ts`](src/build/parts.ts)).

## Entry points

`package.json` `exports` ([`package.json`](package.json)). Each code entry
resolves to `src/` under the `@org/source` condition and to `dist/` otherwise.
Two consumers set the condition: TypeScript, as `customConditions` in
[`tsconfig.base.json`](../../tsconfig.base.json), so type-checking reads the
sources, and the renderer shell's webpack, as `conditionNames`, so the shell
bundles the sources
([`webpack.config.js`](../../app/desktop/doric-renderer/webpack.config.js)).
Node, which runs the host and the compiled tests, loads the build output. The
desktop main process does not load it at run time: at build time nx-electron's
webpack bundles the `dist/` ESM entries into the main process script, and
`build-runner.mjs` imports `PLATFORM_ASSETS_VERSION` from `bundle/runtime` and
bundles the resolved `bundle/contracts` entry as `generation-contracts.mjs`,
the one `bundle/contracts` instance of a `desktopMain` generation
([`webpack.config.js`](../../app/desktop/doric/webpack.config.js),
[`build-runner.mjs`](../../app/desktop/doric/build-runner.mjs)).
`./package.json` is exported as itself.

| Entry                    | Source                                               | Runs in          | Audience                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle/contracts`       | [`src/contracts/index.ts`](src/contracts/index.ts)   | Node and browser | Bundle authors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `bundle/runtime`         | [`src/runtime/index.ts`](src/runtime/index.ts)       | Node and browser | Apps, `desktop`, embedded foundation host parts, bundle tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bundle`                 | [`src/index.ts`](src/index.ts)                       | Node             | The host, build tooling, embedded foundation host parts (types), bundle tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bundle/testing`         | [`src/testing/index.ts`](src/testing/index.ts)       | Node             | Bundle unit tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bundle/platform`        | [`src/platform/index.ts`](src/platform/index.ts)     | Node             | The host: `startPlatform`, the catalog index and the staged-bundle readers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bundle/host`            | [`src/sdk/host/index.ts`](src/sdk/host/index.ts)     | Node             | Host parts: `runBundle`, `HostContext`, `stampedCallerOf`, `contractErrorOf` (a `ConnectError` to a `ContractError`), `createToolHandlers`, `createHookHandlers`, `onHostStart`, `ajvValidators` (JSON Schema 2020-12 validators with ajv, formats not checked, [`ajv.ts`](src/sdk/host/ajv.ts)), `hostStartup` (the `doric.startup/v1` record, `stage(name)` and `log(level, message, fields)`, outside a start step; its client is made only when called, and `onHostStart` hands its step the same object), without the build tooling the root pulls in |
| `bundle/client`          | [`src/sdk/client/index.ts`](src/sdk/client/index.ts) | Browser          | Client parts: one Connect transport per client part over `fetch`, with the `doric-client-part` interceptor                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bundle/externals`       | [`src/build/externals.ts`](src/build/externals.ts)   | Node and browser | Build tooling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bundle/contracts/gen/*` | `src/contracts/gen/*`, written by `generate-proto`   | Node and browser | Bundles that use the platform's `.proto` contracts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bundle/schemas/*`       | `dist/schemas/*`, written by the build               | Data             | The desktop platform build, which copies the folder by path (see [Who uses it](#who-uses-it))                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`./contracts/gen/*` exports the protobuf-es code generated from
[`proto/`](proto), its 39 contract files (the platform contracts under
`doric/platform/<name>/v1`, the options and control files under
`doric/platform/v1`, the basic contracts under `doric/<name>/v1`, among
them `storage/v1`, `storage.backend/v1` and `secrets.backend/v1` in the shape
of the spec's "Storage until phase 4", and `models.provider/v1`, and the
conformance suite's `doric/conformance/v1/conformance.proto`), with `buf/validate` and `google/rpc`, as `bundle/contracts/gen/<path>_pb.js`, resolved like the
code entries. The `generate-proto` target writes it into `src/contracts/gen/`,
which Git ignores, and `build` and `typecheck` depend on it; another project's
generated code imports these files through this export (the `map_imports` of
[`buf.gen.yaml`](../../buf.gen.yaml)).

The proto check ([`proto-rules.ts`](src/build/proto-rules.ts)) checks the rules
for contract `.proto` files that `buf lint` does not. Its CLI,
`node packages/bundle/dist/build/proto-rules.js <file-descriptor-set>`, reads a
`FileDescriptorSet` of every contract (`buf build --as-file-descriptor-set`),
writes one line `<file>: <element>: <code>: <message>` per violation to stderr,
and exits 1 on a violation or a usage error. The root target
`npx nx run @org/source:proto-check` runs both steps.

`bundle/contracts`, `bundle/runtime` and `bundle/client` import only relative
modules, `zod`, `@connectrpc/connect` (with its `protocol` and
`protocol-connect` modules) and `@bufbuild/protobuf` (with `codegenv2` and
`wkt`): `tsconfig.browser.json` typechecks them with the DOM library and no
Node types, and a test walks their import graph
([`tsconfig.browser.json`](tsconfig.browser.json),
[`browser-safe.test.ts`](tests/browser-safe.test.ts)). `bundle/externals`
imports nothing, so a consumer reads it without loading esbuild.

Dependencies ([`package.json`](package.json)): `zod` (schemas), `ajv` (JSON
Schema validation in the host processes), `yaml` (skill frontmatter) and
`tslib` (the TypeScript helpers of the compiled output), with
`@bufbuild/protobuf` for the generated code and the proto check;
`@bufbuild/protovalidate`, which validates requests in
[`sdk/host/serve.ts`](src/sdk/host/serve.ts),
[`platform/router/platform-services.ts`](src/platform/router/platform-services.ts)
and [`testing/router.ts`](src/testing/router.ts), and which
`inventory-targets.test.ts` uses to compile every `buf.validate` rule (T1.5);
`@connectrpc/connect`, used by `src/contracts`, `src/runtime`, `src/platform`,
`src/sdk` and `src/testing`, and `@connectrpc/connect-node`, used by
`src/platform` (the router listener and the gateway), `src/sdk/host` and the
conformance suite (spec section 8, "Libraries",
[`grpc-processes.md`](../../docs/designs/grpc-processes.md#8-contracts-in-proto)).
`@connectrpc/connect` 2.3.0 is patched by
[`patches/@connectrpc+connect+2.3.0.patch`](../../patches/@connectrpc+connect+2.3.0.patch),
which the root `postinstall` applies with `patch-package`. The build CLI also
uses `esbuild`, `@tailwindcss/node` and `@tailwindcss/oxide`, which this
package does not declare: they come from the repository's root
[`package.json`](../../package.json). `cli.ts` imports
[`parts.ts`](src/build/parts.ts), and with it those three, on every `build`
command, a host-only bundle included, and never for `stage` or `copy-md`
([`cli.ts`](src/build/cli.ts)).

## Writing a bundle

A host part is a process that serves the generated services of its `.proto`
contracts. The contract is a `.proto` file under the bundle's `proto/`:

```proto
// proto/doric/greeter/v1/greeter.proto
syntax = "proto3";

package doric.greeter.v1;

import "buf/validate/validate.proto";
import "doric/platform/v1/options.proto";

option (doric.platform.v1.contract) = {
  id: "greeter/v1"
  cardinality: CARDINALITY_ONE
  environment: ENVIRONMENT_HOST
};

service GreeterService {
  rpc Greet(GreetRequest) returns (GreetResponse);
}

message GreetRequest {
  string name = 1 [(buf.validate.field).string.min_len = 1];
}

message GreetResponse {
  string text = 1;
}
```

The project's `generate-proto` target writes its protobuf-es code into
`src/contracts/gen/` (see [Package and project files](#package-and-project-files)),
and `src/host/main.ts`, the bundle's host part, serves it with `runBundle`:

```ts
import { runBundle } from 'bundle/host';

import { GreeterService } from '../contracts/gen/doric/greeter/v1/greeter_pb.js';

runBundle({
  services: [
    [GreeterService, { greet: ({ name }) => ({ text: `Hello, ${name}` }) }],
  ],
  activate: () => undefined,
});
```

The `services` list is static: the build reads it from the source, takes what
the host part provides from it, and bundles `main.ts` into `dist/host/main.mjs`
without importing it ([The rules the build checks](#the-rules-the-build-checks),
[`runBundle`](#runbundle)); a request that breaks the `.proto`'s protovalidate
rules is refused with `invalid_input` before the handler runs. The live bundles
follow this shape, for example
[`resources`](../../bundles/features/resources/src/host/main.ts) and
[`screen-relay`](../../bundles/features/screen-relay/src/host/main.ts), which
also passes `httpServer` for its manifest's `host.httpPrefix`.
`manifest.json`, at the bundle's root, declares the bundle's identity, the
platform range and the contracts it provides and requires:

```json
{
  "manifestVersion": 1,
  "id": "greeter",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": ["greeter/v1@1.0.0"],
  "requires": []
}
```

A desktop or client part is `src/desktop/index.ts` or `src/client/index.ts`,
which exports `activate` and receives a `DesktopContext` or `ClientContext`.
The manifest's fields and rules are described in [The bundle
manifest](../../docs/architecture/bundles/manifest.md), including its `host`
part (`httpPrefix`, `assets`); what `activate` receives in [Contexts and capabilities](../../docs/architecture/bundles/contexts.md);
the `define*` family as a whole in [Contracts and the `define*`
family](../../docs/architecture/bundles/contracts.md).

### The rules the build checks

The build CLI imports each built desktop and client part, calls its `activate`
with a recording context, reads the host part's static `services` list, and
compares what the part did with the manifest. A broken rule below
fails the build with a `BuildError` whose message is quoted with the rule; the
complete list of checks and outputs is in [Build tooling](#build-tooling).

- A bundle has up to three parts, each in one environment: the host part
  (`dist/host/main.mjs`, from `src/host/main.ts`) runs in `host` as its own
  process and is never imported by the build (since slice S69 a stale
  `dist/host/index.js` is ignored), `dist/desktop/index.js` runs in
  `desktopMain` and receives a `DesktopContext`, and `dist/client/index.js`
  runs in `client` and receives a `ClientContext`; each context carries
  `services` ([`cli.ts`](src/build/cli.ts),
  [`context.ts`](src/contracts/context.ts)). A missing part is skipped, which
  is not an error.
- Each part loads in Node. The client part is imported with a DOM shim: it may
  touch the DOM at import time only through `class … extends HTMLElement`. A
  part that throws while loading fails the build with
  `Loading <part> failed: <error>`; for the client part the message goes on to
  say that a client module may touch the DOM at import time only through
  `class … extends HTMLElement` and that heavier modules load with a dynamic
  `import()` inside a component ([`cli.ts`](src/build/cli.ts)).
- Each part exports a function named `activate`; otherwise the build fails with
  `<part> does not export an activate function.` ([`cli.ts`](src/build/cli.ts)).
- Every contract a part provides, defines or registers during `activate` is
  listed in `provides` (`… but not declared in provides.`), and every
  `provides` entry is provided, defined or registered by some part:
  `provides declares <contract>, but no part provides, defines or registers it during activate.`
  ([`record.ts`](src/build/record.ts)). Besides what it records, the host
  part provides the contract of every contract-role service of a `HOST` or
  `HOOKS` contract in its static `services` list, and every `provides` id
  whose `.proto` marks it a hooks, event, settings or storage-type contract
  and that no service serves; both satisfy the `provides` check
  ([`host-provides.ts`](src/build/host-provides.ts)). In any manifest
  version, a served contract missing from `provides` fails with
  `<source>: the host part serves <id>, which provides does not declare.`
- Every contract a part reaches with `services.use` or with `use` of the
  `hooks/v1` facade is listed in `requires` or `optional`, unless the bundle
  provides it or it is a platform `doric.*` contract, which is never declared.
  `services.whenAvailable` is not checked: during the dry activation it does
  nothing. A checked use of any other contract throws
  `Bundle "<id>" uses "<contract>" without listing it in requires.`, reported
  as `Dry activation of <part> failed: …` ([`record.ts`](src/build/record.ts),
  [`ids.ts`](src/contracts/ids.ts)).
- A `provides` entry is `<contract>/v<major>@<version>` with an exact version
  whose major equals the contract id's major (`greeter.api/v1@1.0.0`); a
  `requires` entry carries a range that admits only that major; an `optional`
  entry is a bare contract id with no version (`greeter.api/v1`); otherwise the
  build fails with `Invalid manifest "<path>": …` before any part is built
  ([`cli.ts`](src/build/cli.ts), [`manifest.ts`](src/runtime/manifest.ts),
  [`provides`, `requires` and
  `optional`](../../docs/architecture/bundles/manifest.md#provides-requires-and-optional)).

### Package and project files

Besides `manifest.json` and `src/`, a bundle directory holds the files that
make it a package and an Nx project, as in
[`core`](../../bundles/foundation/core) (the full layout is in [Package layout
and build
output](../../docs/architecture/bundles/manifest.md#package-layout-and-build-output)):

- `package.json`: `name` equal to the manifest `id`, `type: module`, and, when
  the bundle has a contracts module, an `exports` entry `./contracts` (with the
  `@org/source` condition on `src/contracts/index.ts`); that entry is what makes
  `<id>/contracts` resolve for other bundles
  ([`core/package.json`](../../bundles/foundation/core/package.json)). A
  bundle with `.proto` contracts also exports `./contracts/gen/*`, its generated
  code ([`files/package.json`](../../bundles/features/files/package.json)).
- `proto/`: a bundle's `.proto` contracts, under `proto/doric/<package path>/`.
  Such a bundle's `project.json` has the target `generate-proto`, which `build`
  and `typecheck` depend on: it runs `buf generate` into `src/contracts/gen/`,
  which Git ignores. This package's own `generate-proto` depends on
  `@org/source:proto-export` and also generates `buf/validate` and `google/rpc`
  from `dist/proto` ([`project.json`](project.json)).
- `project.json`: the Nx project `bundle-<id>`, with the targets `build`,
  `typecheck` and `test`. The `build` target runs
  `tsc --build bundles/<group>/<id>/tsconfig.json`, then, in most bundles with
  a client part, `tsc -p bundles/<group>/<id>/tsconfig.client.json` (a type
  check that writes nothing), and last
  `node packages/bundle/dist/build/cli.js build bundles/<group>/<id>`
  ([`core/project.json`](../../bundles/foundation/core/project.json),
  [`terminal/project.json`](../../bundles/features/terminal/project.json)).
- `tsconfig.json`: the `tsc` project that writes the host part and the
  contracts module to `dist/`. Most bundles include `src/**/*.ts` and exclude
  the folders the CLI bundles with esbuild, and the set varies: `core` excludes
  `src/desktop/**` and `src/client/**`, `terminal` only `src/client/**`,
  `history` only `src/desktop/**`, host-only bundles such as `postgres` and
  `web` nothing, and `chat` includes only `src/contracts/**/*.ts`
  ([`core/tsconfig.json`](../../bundles/foundation/core/tsconfig.json),
  [`chat/tsconfig.json`](../../bundles/desktop/chat/tsconfig.json),
  [`postgres/tsconfig.json`](../../bundles/foundation/postgres/tsconfig.json)).
  Output `tsc` writes into those folders is removed when the CLI clears them:
  it clears `dist/desktop/` when `src/desktop/index.ts` exists, `dist/client/` when
  `src/client/index.ts` or `src/client/styles.css` exists, and
  `dist/client/chunks/` and `dist/client/frames/` on every build, with or
  without a source ([`parts.ts`](src/build/parts.ts)).

### Sources and outputs

`tsc` writes the host part and the contracts module; the CLI then builds the
desktop and client parts and copies the rest ([`cli.ts`](src/build/cli.ts),
[`parts.ts`](src/build/parts.ts)). Workers, chunks and frames are the `.ts`
files directly in their folder, each an entry; subfolders hold their modules.
The CLI also writes `dist/manifest.json`, `dist/contracts.json`,
`dist/descriptors.binpb`,
`dist/schemas/<contract>.json` and `dist/package.json`, and the browser builds
emit the fonts they import under `assets/` beside each part; those outputs are
described in [Build tooling](#build-tooling).

| Source                         | Output (below `dist/`)               | Built when                                             | Notes                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/host/**/*.md`             | `host/**/*.md`                       | The file exists                                        | Copied; templates the host part reads                                                                                                                                                              |
| `src/desktop/index.ts`         | `desktop/index.js`                   | The file exists                                        | esbuild, Node 22, ESM                                                                                                                                                                              |
| `src/client/index.ts`          | `client/index.js`                    | The file exists                                        | esbuild, browser ES2022, ESM; window import-map specifiers stay external                                                                                                                           |
| `src/client/styles.css`        | `client/styles.css`                  | The source exists, or the client entry imports CSS     | Tailwind over the platform theme when the source exists, followed by the CSS esbuild extracted from the client's imports (Monaco, xterm); without the source the file holds only the extracted CSS |
| `src/client/workers/<name>.ts` | `client/workers/<name>.js`           | `src/client/index.ts` exists                           | No import-map specifier is external; a relative import that resolves into `src/contracts/` becomes the external `<id>/contracts`, as in the client entry                                           |
| `src/client/chunks/<name>.ts`  | `client/chunks/<name>.js` (+ `.css`) | `src/client/index.ts` exists                           | Window modules the client entry imports on demand, with the client's externals                                                                                                                     |
| `src/client/frames/<name>.ts`  | `client/frames/<name>.js`            | The file exists, with or without a client entry        | Modules for a document outside the window, with the frame import map; a frame bundles the contracts' sources it imports                                                                            |
| `src/contracts/index.ts`       | `contracts/index.js`                 | `tsconfig.json` includes it                            | Compiled by `tsc` in the `build` target; other bundles import it as `<id>/contracts` through the bundle's `package.json` `exports`                                                                 |
| `src/contracts/gen/**/*.ts`    | `contracts/gen/**/*.js`              | `generate-proto` wrote it                              | Compiled by `tsc`; other bundles import it as `<id>/contracts/gen/*`                                                                                                                               |
| `src/skills/<name>/SKILL.md`   | `skills/<name>/SKILL.md`             | A direct subdirectory of `src/skills` holds `SKILL.md` | Validated and copied; the other files of the folder are not copied ([`skills.ts`](src/loader/skills.ts))                                                                                           |

## `bundle/contracts`

The browser-safe API a bundle part, a contracts module or a test imports
([`src/contracts/index.ts`](src/contracts/index.ts)). Every export below is
listed with its signature, except the interfaces of the basic contracts
(`Storage`, `Secrets`, `Models`, …), which [Exports per source
file](#exports-per-source-file) lists by method name; the full signature of
each method is in the README of the bundle that provides it. A type a
signature uses but `index.ts` does not export is marked `// not exported`.

### Ids and environments

From [`ids.ts`](src/contracts/ids.ts):

```ts
type ContractId = `${string}/v${number}`;
type Environment = 'host' | 'desktopMain' | 'client';
const environments: readonly Environment[]; // ['host', 'desktopMain', 'client']
const contractIdPattern: RegExp; // /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\/v[1-9][0-9]*$/
function isContractId(value: unknown): value is ContractId;
function isPlatformContract(id: string): boolean; // id starts with "doric."
function majorOf(id: string): number; // "git.commands/v2" → 2
```

`majorOf` checks only the `/v<major>` suffix (`/\/v([1-9][0-9]*)$/`), so it
also answers for a string that fails `contractIdPattern`; without the suffix
it throws `TypeError` `Invalid contract ID "<id>".`
([`ids.ts`](src/contracts/ids.ts)).

A contract whose id starts with `doric.` belongs to the platform: it always
exists, no manifest lists it, and only the platform defines it. A bundle id
matches `/^[a-z][a-z0-9-]*$/` and is never `doric`
([`ids.ts`](src/contracts/ids.ts), [`manifest.ts`](src/runtime/manifest.ts)).

### The `define*` functions

Each `define*` function validates its argument when it runs and returns a
frozen object branded with its kind (`Symbol.for('doric.definition')`), which
the runtime and the build recognize even across copies of the module. Every
check failure is a `TypeError` thrown at definition time
([`define.ts`](src/contracts/define.ts)). `defineHooks`, `defineService`,
`defineEvent`, `defineCommand`, `defineSettings` and `defineStorageType` refuse
an id that does not match `contractIdPattern` (`Invalid <what> contract ID
"<id>".`) and an id that starts with `doric.` (`The <what> contract ID "<id>"
is reserved for the platform.`). `<what>` is `hooks`, `service`, `event`,
`command`, `settings` or `storage type`; the id of an event or a storage type
is its `type`. `ref` makes only the first check, with `<what>` = `ref`
(`Invalid ref contract ID "<id>".`). The id check runs first; the checks of
the members and options follow.

#### `defineHook` and `defineHooks`

```ts
type HookKind = 'observe' | 'transform' | 'decide' | 'sequence';
type HookOrder = 'activation' | 'reverse'; // not exported
type HookOwnerView<T> = (input: T, bundleId: string) => T | undefined; // not exported
type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };
const decisionSchema: z.ZodType<Decision>; // strict union of the two shapes

function defineHook<K extends HookKind, I extends z.ZodType>(definition: {
  readonly kind: K;
  readonly input: I;
  readonly order?: HookOrder; // sequence only; default 'activation'
  readonly forOwner?: HookOwnerView<z.output<I>>; // observe only
}): HookDefinition<K, I>;

interface HookDefinition<K, I> {
  readonly kind: K;
  readonly input: I;
  readonly order?: HookOrder;
  readonly forOwner?: HookOwnerView<z.output<I>>;
}

function defineHooks<
  const Id extends ContractId,
  H extends Record<string, HookDefinition>,
>(id: Id, hooks: H): HooksContract<Id, H>;

interface HooksContract<Id, H> {
  readonly type: 'hooks';
  readonly id: Id;
  readonly hooks: H; // frozen copy
}
function isHooksContract(value: unknown): value is HooksContract;
```

`defineHook` throws on an unknown kind (`Invalid hook kind "<kind>".`), on
`order` for a kind other than `sequence` (`Only a sequence hook takes an
order.`) and on `forOwner` for a kind other than `observe` (`Only an observe
hook takes forOwner.`). `defineHooks` throws when a member was not made with
`defineHook` (`Hook "<name>" of "<id>" must be created with defineHook.`). A
hook has no output schema: the kind fixes what a handler returns — nothing for
`observe` and `sequence`, a value of the input schema for `transform`, a
`Decision` for `decide`. `forOwner` gives
each handler's bundle its own view of an `observe` input, or skips that
handler when it returns `undefined`. How hooks are owned, registered and fired
is described in [Hooks](../../docs/architecture/bundles/hooks.md).

#### `defineMethod` and `defineService`

```ts
type MethodExposure = 'desktop';
const methodExposures: readonly ['desktop'];
function isMethodExposure(value: unknown): value is MethodExposure;

// not exported: accepts the readonly variant of a schema type
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function defineMethod<
  I extends z.ZodType,
  O extends z.ZodType,
  R extends DeepReadonly<z.input<O>> | Promise<DeepReadonly<z.input<O>>>,
>(method: {
  readonly input: I;
  readonly output: O;
  readonly expose?: MethodExposure; // absent: no window may call it
  readonly execute: (input: z.output<I>, call: Call, services: Services) => R;
}): MethodDefinition<I, O, R>;

interface MethodDefinition<I, O, R> {
  readonly input: I;
  readonly output: O;
  readonly expose?: MethodExposure;
  execute(input: z.output<I>, call: Call, services: Services): R;
}
type AnyMethodDefinition = MethodDefinition<z.ZodType, z.ZodType>;

type Cardinality = 'one' | 'many';
interface ServiceOptions {
  readonly cardinality: 'many';
}

function defineService<
  const Id extends ContractId,
  M extends Record<string, AnyMethodDefinition>,
>(id: Id, methods: M, options?: ServiceOptions): ServiceDefinition<Id, M>;
function defineService<
  R extends AnyServiceRef,
  M extends ImplementationOf<R> & Record<string, AnyMethodDefinition>,
>(
  contract: R,
  methods: M,
  options?: ServiceOptions,
): ServiceDefinition<RefId<R>, M>;

interface ServiceDefinition<Id, M> {
  readonly type: 'service';
  readonly id: Id;
  readonly cardinality: Cardinality; // 'one' unless options say 'many'
  readonly methods: M; // frozen copy
}
type AnyServiceDefinition = ServiceDefinition<
  ContractId,
  Record<string, AnyMethodDefinition>
>;
function isServiceDefinition(value: unknown): value is AnyServiceDefinition;
```

`defineMethod` throws when `execute` is not a function (`A method needs an
execute function.`) and when `expose` is not one of `methodExposures`
(`Invalid expose "<expose>": expected one of desktop.`). `defineService`
throws when a member was not made with `defineMethod` (`Method "<name>" of
"<id>" must be created with defineMethod.`) and when `options` is given and
its `cardinality` is not `'many'` (`The only service option is {
cardinality: "many" }.`). Passing a `ref` in place of the id makes the
compiler check the methods against the interface the ref carries
([`types.ts`](src/contracts/types.ts)). The `services` argument of `execute`
is the providing bundle's own `Services`, bound when it calls
`services.provide`. The two schemas are treated differently
([`dispatch.ts`](src/runtime/dispatch.ts)):

- `execute` receives the parsed input (`safeParse(input).data`), so the input
  schema's defaults, transforms and codecs apply: the `skills/v1.register`
  provider receives the skill decoded by `SkillSchema` (`indexText` set,
  duplicate tools removed), and the `windows/v1.open` provider receives an
  `appearance` without `titleBar` or `background` with `'integrated'` and
  `'window'` filled in ([`skill.ts`](src/contracts/skill.ts),
  [`windows.ts`](src/contracts/basic/windows.ts)). The runtime passes that
  parsed value to the provider, not the caller's raw argument.
- An output schema must be descriptive (no default, transform or pipe): the
  runtime validates a result and returns the original value, never the
  parsed copy.

The order of a stub call is in [`Services` and the part
contexts](#services-and-the-part-contexts).

#### `defineEvent`, `defineCommand`, `defineSettings`, `defineStorageType`

```ts
function defineEvent<
  const T extends ContractId,
  P extends z.ZodObject,
>(definition: { readonly type: T; readonly payload: P }): EventDefinition<T, P>;
interface EventDefinition<T, P> {
  readonly kind: 'event';
  readonly type: T;
  readonly payload: P;
}

function defineCommand<
  const Id extends ContractId,
  I extends z.ZodType,
>(definition: {
  readonly id: Id;
  readonly input: I;
  readonly execute: (
    input: z.output<I>,
    call: Call,
    services: Services,
  ) => void | Promise<void>;
}): CommandDefinition<Id, I>;
interface CommandDefinition<Id, I> extends Registrable<BoundCommand<Id, I>> {
  readonly kind: 'command';
  readonly id: Id;
  readonly input: I;
  execute(
    input: z.output<I>,
    call: Call,
    services: Services,
  ): void | Promise<void>;
}
interface BoundCommand<Id, I> {
  readonly id: Id;
  readonly input: I;
  execute(input: z.output<I>, call: Call): Promise<void>;
}

function defineSettings<
  const Id extends ContractId,
  S extends z.ZodType,
>(definition: {
  readonly id: Id;
  readonly schema: S;
}): SettingsDefinition<Id, S>;
interface SettingsDefinition<Id, S> {
  readonly kind: 'settings';
  readonly id: Id;
  readonly schema: S;
}

interface StorageIndex {
  readonly name: string;
  readonly fields: readonly string[]; // property paths of the schema
  readonly unique?: boolean;
}
function defineStorageType<
  const T extends ContractId,
  S extends z.ZodObject,
>(definition: {
  readonly type: T;
  readonly schema: S;
  readonly indexes: readonly StorageIndex[];
}): StorageTypeDefinition<T, S>;
interface StorageTypeDefinition<T, S> {
  readonly kind: 'storage-type';
  readonly type: T;
  readonly schema: S;
  readonly indexes: readonly StorageIndex[]; // frozen copies
}
```

A command is `Registrable`: when `commands/v1.register` receives it, the
runtime binds it to the registering bundle's services, so its `execute` later
receives `(input, call, services)` with that bundle's services
([`define.ts`](src/contracts/define.ts), [`registrable.ts`](src/contracts/registrable.ts)).
Events are registered with `events/v1`, settings with `settings/v1` and storage
types with `storage/v1.defineType`; see [Events and
nodes](../../docs/architecture/bundles/events-and-nodes.md) and
[Storage](../../docs/architecture/bundles/storage.md).

#### `ref`

```ts
function ref<T, Impl = ImplFrom<T>>(
  id: ContractId,
): ServiceRef<ApiFrom<T>, Impl>;
function isServiceRef(value: unknown): value is AnyServiceRef; // structural: any object { kind: 'ref', id: string }, no brand check

interface ServiceRef<
  Api = unknown,
  Impl = Api,
  Id extends ContractId = ContractId,
> {
  readonly kind: 'ref';
  readonly id: Id;
  // type-only: the API and the implementation the ref carries
}
```

A ref holds only the contract id at run time; its type parameters carry the
API. `ref` checks the id against `contractIdPattern` and accepts `doric.*`.
`T` is an interface (`ref<Git>('git.commands/v1')`) or a service definition,
whose methods become the stubs ([`define.ts`](src/contracts/define.ts),
[`types.ts`](src/contracts/types.ts)).

### Types of the stubs

From [`types.ts`](src/contracts/types.ts):

| Type                      | Meaning                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `AnyServiceRef`           | `ServiceRef<unknown, unknown, ContractId>`                                                                                               |
| `ApiOf<R>`                | The API a ref exposes: the type `services.use(R)` returns                                                                                |
| `ApiFrom<T>`              | The API derived from a definition (`StubsOf` its methods), a `CommandApi` for a command, or `T` itself for an interface                  |
| `ImplementationOf<R>`     | What `defineService(ref, methods)` must provide: one `MethodDefinition` per method (rules below the table)                               |
| `RefId<R>`                | The id of a ref                                                                                                                          |
| `StubOf<D>`, `StubsOf<M>` | A method's consumer stub: `(input, call?) => output` — `(...items, call?)` for a tuple input — returning a `Promise` when `execute` does |
| `CommandApi<Id, I>`       | The dispatch handle `commands/v1.execute` takes for a command ref: `{ id?, input? }`                                                     |
| `JsonValue`, `JsonObject` | Readonly JSON values                                                                                                                     |

`ImplementationOf<R>` derives each method's `execute` input from the
interface method's parameters ([`types.ts`](src/contracts/types.ts),
`MethodInputOf`):

- a trailing optional `CallArg` parameter is dropped;
- one remaining parameter becomes the input type itself, several become a
  tuple of them, and none becomes `[]` — the input a `noInput` method has;
- a `Registrable<B>` parameter arrives as `B`, the value the runtime bound
  for the provider.

For a ref made from a service definition (`ref<typeof Service>(id)`) it
demands only the definition's keys, each with any `MethodDefinition`.

### `Services` and the part contexts

From [`context.ts`](src/contracts/context.ts):

```ts
interface Disposable {
  dispose(): void;
} // idempotent
type Cleanup = () => void | Promise<void>;
interface ProviderInfo {
  readonly bundleId: string;
  readonly version: string;
}

interface Services {
  provide<D extends AnyServiceDefinition>(definition: D): Disposable;
  use<R extends AnyServiceRef>(contract: R, scope?: CallScope): ApiOf<R>;
  whenAvailable<R extends AnyServiceRef>(
    contract: R,
    callback: (api: ApiOf<R>, provider: ProviderInfo) => void | Cleanup,
  ): Disposable;
}

interface HostContext {
  readonly services: Services;
}
interface DesktopContext {
  readonly services: Services;
}
interface ClientContext {
  readonly services: Services;
}
type Activate<
  Ctx extends HostContext | DesktopContext | ClientContext = HostContext,
> = (ctx: Ctx) => void | Cleanup | Promise<void | Cleanup>;
```

A part's module exports `activate: Activate<…>`. The runtime implements
`Services` per bundle ([`services.ts`](src/runtime/services.ts)):

- `provide(definition)` registers a provider record in the environment's
  directory and tracks it in the current disposal scope. It checks, in this
  order, and throws:
  - `invalid_input` for a value not made with `defineService`;
  - `undeclared_provide` when the bundle's descriptor does not list the
    contract in this environment;
  - `cardinality_mismatch` when the definition's cardinality differs from the
    one the catalog publishes;
  - `contract_mismatch` when a basic contract's provider does not implement
    exactly the platform's method table (only the table's `optional` methods
    may be omitted), when a method's input or output JSON Schema differs from
    the platform's, or when it declares an exposure the platform does not
    give.

  When the composition chose another bundle as the provider of a `one`
  contract, `provide` then registers nothing and returns an inert
  `Disposable`. Otherwise the directory refuses a second provider of a `one`
  contract with `provider_conflict`
  ([`directory.ts`](src/runtime/directory.ts)).

- `use(contract, scope?)` returns a late-binding stub: each method call
  resolves the active provider at call time. It throws `invalid_input` for a
  value that is not a ref, `many_contract_use` for a contract of cardinality
  `many`, and `undeclared_requirement` for a contract the manifest lists in
  neither `requires`, `optional` nor `provides` (a `doric.*` contract always
  passes; the composition's core may use every basic contract). `scope` binds
  scope keys to every call the stub makes. `use(HooksV1)` returns the hooks
  facade, described below.
- `whenAvailable(contract, callback)` subscribes to the contract's providers:
  the callback runs synchronously, in registration order, for each provider
  registered now, and for each one that registers later, with a stub pinned
  to it, inside a child disposal scope
  ([`directory.ts`](src/runtime/directory.ts)). The cleanup it returns
  (directly or as a promise's value) and everything it registered are
  disposed when that provider goes away or when the returned `Disposable` is
  disposed. A throw or a rejection is reported as `when_available_failed`.
  It checks less than `use`: it throws `invalid_input` for a value that is not
  a ref, but it accepts a contract of cardinality `many` (it is how a
  consumer aggregates one) and makes no `requires` check.

The hooks facade `services.use(HooksV1)` returns has three methods; each
throws `invalid_input` (`Expected a hooks contract created with
defineHooks.`) for a value not made with `defineHooks`
([`facades.ts`](src/runtime/facades.ts)):

- `define(C)` declares the bundle as the owner of `C` through
  `hooks/v1.define` and returns a `HookHandle`: per hook,
  `execute(input, call?)`. The handle is cached per contract id for the
  bundle, so a second `define(C)` returns the same handle without a hop.
- `use(C)` applies the same `requires` rule as `services.use` and returns a
  `HookRegistrar`: per hook, `(handler) => Disposable`, which calls
  `hooks/v1.register`.
- `whenAvailable(C, callback)` calls `hooks/v1.whenDefined` and passes the
  callback a `HookRegistrar` once `C` is defined; it makes no `requires`
  check. When the provider calls it back is described in the [core
  README](../../bundles/foundation/core/README.md#hooksv1).

A stub method call runs these steps ([`dispatch.ts`](src/runtime/dispatch.ts);
the runtime side is in [Directory and principals](#directory-and-principals)):

1. **Resolve.** A stub of a deactivated bundle refuses with `unavailable`.
   The provider is the pinned one (from `whenAvailable`) or the contract's
   active provider. When there is none and the stub is not pinned, the call
   waits on the runtime's `awaitProvider` when it returns a promise, aborted
   by the call argument's signal, and then starts again; otherwise it fails with
   `unavailable`, as does a method the provider's record does not have.
2. **Split the arguments.** For a method whose input is not a tuple, the
   first argument is the input, and the second is the call argument only
   when it is a `Call` or a `CallOptions`; otherwise it is dropped, and so is
   every further argument. For a tuple input the arguments are the tuple's
   items; a trailing `Call` is always the call argument, while trailing
   `CallOptions` are the call argument only past the tuple's length or where
   the tuple item at that position rejects them.
3. **Bind.** Each `Registrable` argument (the input, or each tuple item)
   becomes `value[bindRegistrant](callerServices)`.
4. **Validate.** The bound input is parsed with the provider's input schema;
   a failure is `invalid_input`.
5. **Invoke.** The runtime creates the hop's `Call` and calls the provider
   with the parsed value (`parsed.data`), not the argument. A provider's throw
   or rejection reaches the caller as thrown (across a process, rebuilt as
   described in [Values, errors and calls](#values-errors-and-calls)).
6. **Settle.** The result (awaited when it is a promise) is validated with
   the output schema (`invalid_output`); a returned `Disposable` is tracked in
   the caller's current scope; the original value is returned.

A stub answers `undefined` for the property names `then`, `toJSON`,
`constructor`, `valueOf` and `toString` and for every symbol key, so a stub
is not thenable (it can be returned from an `async` function) and a contract
method with one of those names cannot be called through a stub. Any other
name is a method; a stub caches one function per name
([`dispatch.ts`](src/runtime/dispatch.ts)).

The errors of `Services` and of a stub carry these messages and `details`
([`services.ts`](src/runtime/services.ts),
[`dispatch.ts`](src/runtime/dispatch.ts),
[`directory.ts`](src/runtime/directory.ts)):

| Code                     | Message                                                                                                                                                             | `details`                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `invalid_input`          | `provide expects a definition created with defineService.`; `Expected a contract ref created with ref().` (`use`, `whenAvailable`)                                  | none                           |
| `invalid_input`          | `Invalid input for <id> <method>: <issues>` (stub)                                                                                                                  | `{ contract, method, issues }` |
| `invalid_output`         | `Invalid output from <id> <method> (bundle "<bundle>"): <issues>` (stub)                                                                                            | `{ contract, method, issues }` |
| `unavailable`            | `Bundle "<bundle>" is no longer active.`                                                                                                                            | none                           |
| `unavailable`            | `No active provider of "<id>".`                                                                                                                                     | `{ contract }`                 |
| `unavailable`            | `Contract "<id>" has no method "<method>".`                                                                                                                         | `{ contract, method }`         |
| `undeclared_requirement` | `Bundle "<bundle>" uses "<id>" without listing it in requires.`                                                                                                     | `{ contract, bundleId }`       |
| `many_contract_use`      | `"<id>" has many providers; aggregate them with whenAvailable.`                                                                                                     | `{ contract }`                 |
| `undeclared_provide`     | `Bundle "<bundle>" provides "<id>" in <environment> without declaring it.`                                                                                          | `{ contract, bundleId }`       |
| `cardinality_mismatch`   | `Provider "<bundle>" declares "<id>" as <cardinality>; the catalog publishes <cardinality>.`                                                                        | `{ contract, bundleId }`       |
| `contract_mismatch`      | `Provider of "<id>" must implement: <methods>; may implement: <methods or none>; got: <methods>.`                                                                   | `{ contract }`                 |
| `contract_mismatch`      | `Method "<name>" of "<id>" does not match the platform schema.`; `Method "<name>" of "<id>" may not be exposed to the desktop: the platform specification decides.` | `{ contract, method }`         |
| `provider_conflict`      | `Contract "<id>" already has an active provider: bundle "<bundle>".`                                                                                                | none                           |

`<issues>` is each zod issue as `<path>: <message>` (the path joined with
`.`, left out when empty), joined with `; `; `details.issues` holds
`{ code, path, message }` per issue, a symbol path segment as its string.
Method lists are sorted and joined with `, `.

A refused registration that escapes `activate` quarantines the bundle.
`provide` marks every
`ContractError` it throws except `invalid_input`; a stub call marks an error
whose code is one of `duplicate_tool`, `duplicate_skill`,
`registration_conflict`, `not_owner`,
`provider_conflict`, `undeclared_provide`, `cardinality_mismatch` or
`contract_mismatch`, which providers raise when they refuse a registration
(`isRegistrationConflict`). When a marked error escapes `activate`, the
bundle is quarantined as `cardinality_mismatch` for that code and as
`registration_failed` for the others, not as `activate_failed`
([`services.ts`](src/runtime/services.ts),
[`dispatch.ts`](src/runtime/dispatch.ts),
[`activation.ts`](src/runtime/activation.ts); see [Catalog resolution and
activation](#catalog-resolution-and-activation)). The rules are described
with examples in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md).

### `Call`

From [`call.ts`](src/contracts/call.ts):

```ts
type CallScope = Readonly<Record<string, string>>;
interface Caller {
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
}
interface TraceContext {
  readonly traceparent: string;
} // 00-<32 hex>-<16 hex>-01
interface Call {
  readonly caller: Caller;
  readonly scope?: CallScope;
  readonly signal: AbortSignal;
  readonly trace: TraceContext;
}
interface CallOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
} // epoch ms; 0 = none
type CallArg = Call | CallOptions;

const windowScopeKey = 'windowKey';
const scopeKeyPattern: RegExp; // /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SCOPE_MAX_KEYS = 16;
const SCOPE_MAX_VALUE = 512;
const callScopeSchema: z.ZodType<CallScope>; // keys match scopeKeyPattern, values ≤ SCOPE_MAX_VALUE characters, ≤ SCOPE_MAX_KEYS keys
const callGeneration: unique symbol; // Symbol.for('doric.call.generation')

function isCall(value: unknown): value is Call; // branded by the runtime
function isCallOptions(value: unknown): value is CallOptions;
function deadlineOf(call: Call): number; // 0 when none
function generationOf(call: Call): number; // 0 = kernel-originated, unpinned
```

Only the runtime creates a `Call`: it carries the non-enumerable brand
`Symbol.for('doric.call')`, its deadline under the non-enumerable
`Symbol.for('doric.call.deadline')` (epoch ms, 0 = none; neither symbol is
exported) and the generation it is pinned to under `callGeneration`.
`callScopeSchema` refuses more than 16 keys with `A call scope holds at most
16 keys.` ([`call.ts`](src/contracts/call.ts)).
`isCallOptions` accepts only a plain object whose own keys are a non-empty
subset of `signal` (an `AbortSignal`) and `deadline` (a finite number). How a
hop builds its call is in [`createHopCall`](#calls-traces-and-scopes); the
scope keys and their owners are in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md#scope-keys).

### Errors

From [`error.ts`](src/contracts/error.ts):

```ts
class ContractError extends Error {
  readonly name: 'ContractError';
  readonly code: string;
  readonly details?: unknown;
  constructor(code: ContractErrorCode | (string & {}), message: string, details?: unknown);
}
const contractErrorCodes: readonly [...]; // listed below
type ContractErrorCode = (typeof contractErrorCodes)[number];
function isContractError(value: unknown): value is ContractError; // by name, code and message, never instanceof
function toContractError(value: unknown): ContractError;          // anything else becomes 'internal'
```

`ContractError` sets `details` only when one is given. `toContractError`
returns a `ContractError` unchanged; anything else becomes code `internal`
with the message of an `Error`, a string as the message, or `Internal
error.` for any other value, and no `details`
([`error.ts`](src/contracts/error.ts)).

Across gRPC, [`status.ts`](src/contracts/status.ts) converts a
`ContractError` to and from the `google.rpc.Status` that ends a call:
`toStatus` and `toConnectError` write the gRPC code of the spec's error table
(`grpcCodeOf`), the message, a `google.rpc.ErrorInfo { reason: <code>, domain:
"doric" }` (`contractErrorDomain`) and, when `details` is defined, a
`doric.platform.v1.ErrorDetails`; `fromStatus` and `fromConnectError` rebuild
the `ContractError`, and a status without a `doric` `ErrorInfo` becomes
`internal` with the status's message. `retiredErrorCodes` (`local_only`,
`many_contract_use`, `cardinality_mismatch`) stay in `contractErrorCodes` but
are no longer raised, and `grpcCodeOf` maps them to `FAILED_PRECONDITION`.

Every contract boundary throws a `ContractError`. The codes the platform
raises are an open set; callers match on `code`. The table lists the codes
of `contractErrorCodes` by who raises them:

| Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Raised by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | When, and what next                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`, `invalid_output`, `unavailable`, `undeclared_requirement`, `undeclared_provide`, `many_contract_use`, `cardinality_mismatch`, `provider_conflict`, `contract_mismatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `Services` and the stubs of this package ([`services.ts`](src/runtime/services.ts), [`dispatch.ts`](src/runtime/dispatch.ts), [`directory.ts`](src/runtime/directory.ts)); providers also raise `invalid_input` and `unavailable` for their own refusals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Each case, its message and `details` are in [`Services` and the part contexts](#services-and-the-part-contexts). An `invalid_*`, `undeclared_*`, `*_mismatch` or `many_contract_use` code is a defect of the caller, its schema or its manifest; `unavailable` lasts until a provider registers, which `whenAvailable` waits for                                                                                        |
| `internal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `toContractError`, and the envelope for a thrown value that is not a `ContractError` ([`error.ts`](src/contracts/error.ts), [`errors.ts`](src/runtime/envelope/errors.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | An unexpected failure; the message is the thrown value's                                                                                                                                                                                                                                                                                                                                                                |
| `local_only`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The envelope ([`values.ts`](src/runtime/envelope/values.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A process-local value would cross a process, or a handle is used outside the process that made it; see [Basic contracts](#basic-contracts) and [Values, errors and calls](#values-errors-and-calls)                                                                                                                                                                                                                     |
| `generation_lost`, `protocol_error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The envelope link ([`link.ts`](src/runtime/envelope/link.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The generation process that served the call is gone, or a wire message is malformed; see [Generation processes and the envelope](#generation-processes-and-the-envelope)                                                                                                                                                                                                                                                |
| `not_owner`, `registration_conflict`, `duplicate_tool`, `duplicate_skill`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The `core` providers: `hooks/v1`, `storage/v1` and `events/v1` (`not_owner`); `hooks/v1`, `storage/v1`, `events/v1`, `settings/v1`, `commands/v1` and `regions/v1` (`registration_conflict`, which other bundles such as `layout`, `chat` and `workspace` also raise for their own registries); `tools/v1` (`duplicate_tool`); `skills/v1` (`duplicate_skill`, `unavailable_tool`) ([`tools/service.ts`](../../bundles/foundation/core/src/host/tools/service.ts), [`skills/service.ts`](../../bundles/foundation/core/src/host/skills/service.ts), [`storage/facade.ts`](../../bundles/foundation/core/src/host/storage/facade.ts), [`events/service.ts`](../../bundles/foundation/core/src/host/events/service.ts), [`hooks.ts`](../../bundles/foundation/core/src/shared/hooks.ts), [`client/commands.ts`](../../bundles/foundation/core/src/client/commands.ts), [`desktop/commands.ts`](../../bundles/foundation/core/src/desktop/commands.ts), [`regions.ts`](../../bundles/foundation/core/src/client/regions.ts)) | A registration or an owner-only operation is refused: another bundle owns the contract or type, the name is taken, or a skill allows a tool that `tools/v1.list` does not return for the call. When it escapes `activate`, it quarantines the bundle (see [`Services` and the part contexts](#services-and-the-part-contexts)). Each contract's rules are in the [core README](../../bundles/foundation/core/README.md) |
| `revision_conflict`, `sequence_conflict`, `unique_conflict`, `limit_exceeded`, `unknown_type`, `invalid_index_value`, `invalid_stream`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `storage/v1` in `core` (`unknown_type`) and the `storage.backend/v1` providers, through the helpers of the `storage` package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [Core README](../../bundles/foundation/core/README.md#storagev1), [`storage` README](../storage/README.md#conflict-and-limit-errors), [`postgres` README](../../bundles/foundation/postgres/README.md#errors-and-failure-behavior)                                                                                                                                                                                      |
| `unknown_settings`, `settings_missing`, `settings_conflict`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `settings/v1` in `core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [Core README](../../bundles/foundation/core/README.md#settingsv1)                                                                                                                                                                                                                                                                                                                                                       |
| `unknown_event`, `invalid_scope`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `events/v1` in `core`; other bundles raise `invalid_scope` for their own scope checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [Core README](../../bundles/foundation/core/README.md#eventsv1)                                                                                                                                                                                                                                                                                                                                                         |
| `credential_missing`, `credential_invalid`, `credential_name_taken`, `credential_kind_immutable`, `credential_ambiguous`, `credential_storage_unavailable`, `credential_key_required`, `credential_unreadable`, `unknown_kind`, `duplicate_credential_kind`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `secrets/v1` in `core` and the `secrets.backend/v1` providers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [Core README](../../bundles/foundation/core/README.md#secretsv1), [`postgres` README](../../bundles/foundation/postgres/README.md#secretsbackendv1-version-100)                                                                                                                                                                                                                                                         |
| `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The host's `doric.catalog/v1.disable` for a bundle outside the composition ([`composition-actions.ts`](src/platform/composition-actions.ts)); the desktop main process for a window that is not open, or before any core activated ([desktop README](../../app/desktop/doric/README.md)); other bundles for their own records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The named thing does not exist                                                                                                                                                                                                                                                                                                                                                                                          |
| `disconnected`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The desktop main process, when the host bridge closes ([desktop README](../../app/desktop/doric/README.md#the-host-connection-and-the-connection-status))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The host is unreachable from the desktop                                                                                                                                                                                                                                                                                                                                                                                |
| `unknown_command`, `route_conflict`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `commands/v1` and `navigation/v1` in `core` ([`desktop/commands.ts`](../../bundles/foundation/core/src/desktop/commands.ts), [`navigation.ts`](../../bundles/foundation/core/src/client/navigation.ts)); the desktop's window dispatcher also answers `unknown_command` ([`dispatcher.ts`](../../app/desktop/doric/src/platform/bridge/dispatcher.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Core README: `commands/v1`](../../bundles/foundation/core/README.md#commandsv1), [`navigation/v1`](../../bundles/foundation/core/README.md#navigationv1)                                                                                                                                                                                                                                                               |
| `unknown_contract`, `unknown_provider`, `invalid_instance_token`, `instance_revoked`, `not_connected`, `control_stream_open`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The router of the process model ([`src/platform/router/`](src/platform/router)), phase 2 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md#3-calls-between-bundles): an unknown service (`unknown_contract`, also answered by the gateway, the host SDK and `createTestRouter`), a `doric-provider` that names no live provider of a `many` contract (`unknown_provider`), a missing or unknown instance token (`invalid_instance_token`), the token of a stopped, lost or invalid instance (`instance_revoked`), a call other than `BundleHostService/Connect` with the token of an instance that is only spawned (`not_connected`), and a second control stream with the same token (`control_stream_open`)                                                                                                                                                                                                                                                                                                 |
| `unknown_lease`, `unsupported_operation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `sandbox/v1` by lease id in the [`docker`](../../bundles/sandboxes/docker/README.md) and [`firecracker`](../../bundles/sandboxes/firecracker/README.md) host processes (`src/host/service.ts`): an unknown, released or other instance's lease (`NOT_FOUND`), and an operation the sandbox does not offer, such as `Start` without live processes (`UNIMPLEMENTED`); phase 3, slice S44 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `provider_error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `models.provider/v1` calls served by `serveProviderKind` of `llms/rpc` in the provider bundles' host processes: an `LlmProviderError` thrown by the built provider crosses the router as `FAILED_PRECONDITION` with the full error in `details.providerError`; phase 3, slice S43 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tool_error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tools served by `createToolHandlers` in host parts: a tool error (an `Error` named `ToolErrorObject` with data `{ code, message, toolName?, callId?, diagnostic?, issues? }`) thrown by `execute` or `check` crosses the router as `FAILED_PRECONDITION` with every field of the data in `details.toolError`, without its cause chain, and `core` keeps it through `tools/v1` `Execute` and `Check`; plain errors stay `internal`; phase 3, slice S51a of [`grpc-processes.md`](../../docs/designs/grpc-processes.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unknown_session`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `runtime.workspace/v1` in [`runtime`](../../bundles/runtime/runtime/README.md) for a session id it does not hold (`NOT_FOUND`); phase 3, slice S47 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `invalid_config`, `invalid_credential`, `invalid_provider`, `invalid_project`, `invalid_project_color`, `invalid_thread`, `invalid_project_path`, `invalid_execution`, `invalid_branch`, `invalid_prompt`, `invalid_steer`, `invalid_resume`, `invalid_rewind`, `invalid_interrupt`, `invalid_terminal`, `invalid_cursor`, `invalid_size`, `invalid_credential_id`, `invalid_project_id`, `invalid_thread_id`, `invalid_page`, `invalid_cwd`, `invalid_event_cursor` (`INVALID_ARGUMENT`); `credential_not_found`, `vm_not_found`, `project_not_found`, `project_path_not_found`, `thread_not_found`, `prompt_not_found`, `unknown_prompt`, `missing`, `terminal_missing` (`NOT_FOUND`); `configuration_rejected`, `model_catalog_unreadable`, `compaction_failed` (`UNAVAILABLE`); `internal_error` (`INTERNAL`) | The public API `doric.api.*` of `transport` (phase 3, slice S60 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md)): its refusal reasons that have a row in the error table; its other reasons travel as `FAILED_PRECONDITION`, and `credential_name_taken` stays `ALREADY_EXISTS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Registration helpers

```ts
const bindRegistrant: unique symbol; // Symbol.for('doric.bind-registrant')
interface Registrable<B> {
  [bindRegistrant](services: Services): B;
}
function isRegistrable(value: unknown): value is Registrable<unknown>; // an object or a function with a [bindRegistrant] function
```

A registration that needs its registrant's services (a command, a tool of the
`tool` package) implements `[bindRegistrant]`
([`registrable.ts`](src/contracts/registrable.ts)). A stub call replaces each
`Registrable` argument by the value `[bindRegistrant]` returns for the
caller's services, before the input is validated, so the provider receives the
bound value ([`dispatch.ts`](src/runtime/dispatch.ts), step 3 of a stub call
in [`Services` and the part contexts](#services-and-the-part-contexts)).

### Skills

From [`skill.ts`](src/contracts/skill.ts):

```ts
interface SkillSchemaInput {
  readonly name: string; readonly description: string; readonly body: string;
  readonly allowedTools: readonly string[]; readonly indexText?: string;
}
interface SkillRecord { /* the same, with indexText: string */ }
const skillRecordSchema: z.ZodType<SkillRecord>; // strict; name, description, body and allowedTools items non-empty trimmed; indexText any string
const SkillSchema: z.ZodCodec<…>;                 // SkillSchemaInput → SkillRecord
```

Decoding with `SkillSchema` removes duplicate `allowedTools` and sets
`indexText` to `` `${name} | ${description} | ${allowedTools.join(',')} | ${body}` ``,
whatever `indexText` the input had.

A host part's own skills are registered by the host SDK
([`sdk/host/skills.ts`](src/sdk/host/skills.ts), `registerBundleSkills`, called
by `runBundle`): once `activate` resolves, and before `ActivateResult`, it
registers each `src/skills/<folder>/SKILL.md` of the bundle directory, folders
in lexical order, through `context.registrations.track(SkillsService, …)` as
the instance, so a new `skills/v1` provider gets them again. It reads each file
with `context.assets.read` (the manifest's `host.assets` must list
`src/skills/*/SKILL.md`) and parses it as the build does. A skill whose
discovery, read, parse or `Register` fails is skipped and logged with
`context.log.warn('skill not registered', { path, code?, error })`; the
activation never fails for it. A rejecting `activate` registers no skill.
`skills/v1` 1.3.0 stores `allowedTools` as given: Doric does not enforce it,
and `Register` no longer answers `unavailable_tool`, which slice S67 removed
from the shared error-code list. `bundle/testing`'s router registers no skills.

### Basic contracts

The platform declares each basic contract — id, cardinality, environments and
method table — and `bundle/contracts` exports its ref, its interface and its
method table (`<name>Methods`). A provider must implement exactly that table
([`basic/index.ts`](src/contracts/basic/index.ts),
[`services.ts`](src/runtime/services.ts)). The methods, data and errors of
each contract are described with its provider: the contracts `core` provides
in the [core README](../../bundles/foundation/core/README.md); the backends
with [`postgres`](../../bundles/foundation/postgres/README.md).
`models.provider/v1` has several providers and `core` consumes it, so its
full shape is here, in [The `models.provider/v1`
contract](#the-modelsproviderv1-contract); each model provider's README states
what it answers, and [Models and
providers](../../docs/features/models-and-providers.md) describes the feature.

```ts
interface BasicContractSpec {
  readonly cardinality: Cardinality;
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
  readonly optional: readonly string[]; // methods a provider may omit
}
const basicContracts: Readonly<Record<BasicContractId, BasicContractSpec>>;
type BasicContractId = keyof typeof basicContracts;
function isBasicContract(id: string): id is BasicContractId;
function basicContractSpec(id: string): BasicContractSpec | undefined;
```

| Contract             | Ref                | Environments            | Cardinality | Optional methods     | Source                                               |
| -------------------- | ------------------ | ----------------------- | ----------- | -------------------- | ---------------------------------------------------- |
| `hooks/v1`           | `HooksV1`          | all                     | one         |                      | [`hooks.ts`](src/contracts/basic/hooks.ts)           |
| `log/v1`             | `LogV1`            | all                     | one         |                      | [`log.ts`](src/contracts/basic/log.ts)               |
| `tools/v1`           | `ToolsV1`          | `host`                  | one         |                      | [`tools.ts`](src/contracts/basic/tools.ts)           |
| `skills/v1`          | `SkillsV1`         | `host`                  | one         |                      | [`skills.ts`](src/contracts/basic/skills.ts)         |
| `settings/v1`        | `SettingsV1`       | `host`, `desktopMain`   | one         |                      | [`settings.ts`](src/contracts/basic/settings.ts)     |
| `secrets/v1`         | `SecretsV1`        | `host`                  | one         |                      | [`secrets.ts`](src/contracts/basic/secrets.ts)       |
| `secrets.backend/v1` | `SecretsBackendV1` | `host`                  | one         |                      | [`secrets.ts`](src/contracts/basic/secrets.ts)       |
| `storage/v1`         | `StorageV1`        | `host`                  | one         |                      | [`storage.ts`](src/contracts/basic/storage.ts)       |
| `storage.backend/v1` | `StorageBackendV1` | `host`                  | one         |                      | [`storage.ts`](src/contracts/basic/storage.ts)       |
| `events/v1`          | `EventsV1`         | `host`                  | one         |                      | [`events.ts`](src/contracts/basic/events.ts)         |
| `models/v1`          | `ModelsV1`         | `host`                  | one         |                      | [`models.ts`](src/contracts/basic/models.ts)         |
| `models.provider/v1` | `ModelsProviderV1` | `host`                  | many        |                      | [`models.ts`](src/contracts/basic/models.ts)         |
| `commands/v1`        | `CommandsV1`       | `desktopMain`, `client` | one         |                      | [`commands.ts`](src/contracts/basic/commands.ts)     |
| `ui/v1`              | `UiV1`             | `client`                | one         |                      | [`ui.ts`](src/contracts/basic/ui.ts)                 |
| `navigation/v1`      | `NavigationV1`     | `client`                | one         | `forward`, `history` | [`navigation.ts`](src/contracts/basic/navigation.ts) |
| `regions/v1`         | `RegionsV1`        | `client`                | one         |                      | [`regions.ts`](src/contracts/basic/regions.ts)       |
| `windows/v1`         | `WindowsV1`        | `desktopMain`           | one         |                      | [`windows.ts`](src/contracts/basic/windows.ts)       |
| `menus/v1`           | `MenusV1`          | `desktopMain`           | one         |                      | [`menus.ts`](src/contracts/basic/menus.ts)           |

Each source file also exports the contract's types and zod schemas, listed in
[Exports per source file](#exports-per-source-file). The exported helpers
with behavior of their own are:

```ts
// common.ts — shared schemas of the method tables
interface MethodSpec {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly expose?: MethodExposure;
}
type MethodSpecs = Readonly<Record<string, MethodSpec>>;
const disposableSchema: z.ZodType<Disposable>; // meta { 'x-doric-local': 'disposable' }
function isDisposable(value: unknown): value is Disposable;
function isDisposableSchema(schema: z.ZodType): boolean; // also true for another copy of zod's registry entry
function functionSchema<T>(): z.ZodType<T>; // any function ('Expected a function.'); process-local without a codec: never crosses
const callSchema: z.ZodType; // a runtime Call inside a payload; process-local without a codec: never crosses
// each accepts only values made by the matching define*
const hooksContractSchema: z.ZodType<HooksContract>;
const eventDefinitionSchema: z.ZodType<EventDefinition>;
const settingsDefinitionSchema: z.ZodType<SettingsDefinition>;
const storageTypeDefinitionSchema: z.ZodType<StorageTypeDefinition>;
const commandDefinitionSchema: z.ZodType<CommandDefinition>;
const noInput: z.ZodTuple<[]>; // a method without input
interface StreamObserver<T> {
  next(item: T): void;
  end?(error?: ContractError): void;
}
type StreamListener<T> = ((item: T) => void) | StreamObserver<T>;
function streamListener<T extends z.ZodType>(
  item: T,
): z.ZodType<StreamListener<z.output<T>>>;
function streamItemOf(schema: z.ZodType): z.ZodType | undefined;
function toStreamObserver<T>(listener: StreamListener<T>): StreamObserver<T>; // a function becomes { next }

// commands.ts
function isBoundCommand(value: unknown): value is BoundCommand; // { id: string, execute: function }

// tools.ts
const orderKeySchema: z.ZodNumber; // integer 1 … Number.MAX_SAFE_INTEGER, the global order of tools and skills
function isContractTool(value: unknown): value is ContractTool; // an object with a non-empty trimmed name, an execute function, a definition object and a settings array

// secrets.ts
const credentialFieldNames: readonly ['username', 'email', 'secret'];
const builtinCredentialKinds: readonly CredentialKindDefinition[];
//   API_TOKEN: required ['secret']; USERNAME_PASSWORD: required ['username', 'secret']
function credentialFieldsSatisfied(
  kind: CredentialFieldSet,
  values: CredentialValues,
): boolean;
//   every required field present, and no field outside required ∪ optional
function credentialFieldsMessage(kind: CredentialKindDefinition): string;
//   "A <id> credential requires <required> and carries no other field." / "… and may also carry <optional>."
function isSecretsView(value: unknown): value is SecretsView; // has list, redactions, addRedaction

// models.ts
function toLanguageModel<T extends object>(value: T): T & LanguageModel;
//   a plain object gets a prototype of its own with the same own properties, so it crosses
//   the process envelope as a handle; an object with another prototype is returned as is
const MODEL_ICON_MAX_LENGTH = 16_384; // characters of one SVG icon
const MODEL_ICON_MAX_MODELS = 1000; // model names per icon request
const MODEL_ICON_MAX_NAME = 512; // characters of one model name
const MODEL_ICON_MAX_REQUESTS = 64; // requests per models/v1.icons call
```

A stream method's input has a `streamListener(item)` among its tuple items;
its JSON Schema records the item schema under `x-doric-stream`, so a boundary
recognizes the method and validates each item
([`common.ts`](src/contracts/basic/common.ts),
[`json-schema.ts`](src/runtime/json-schema.ts)).

A value local to its process (a function, a `Call`, an object with methods)
crosses the envelope only when its schema names a codec with
`.meta({ 'x-doric-local': 'callback' | 'disposable' | 'object' })`, as
`disposableSchema`, `streamListener` and `languageModelSchema` do; it then
crosses as a handle. Every other local schema — `functionSchema()`,
`callSchema`, any `z.custom` without that metadata — makes its member
`{ "x-doric-local": true }` in the JSON Schema, and a method of a bundle-defined
contract with such a member cannot cross a process: a call across one is
refused with `local_only`. A contract meant to cross processes marks each
function it carries with a codec ([`json-schema.ts`](src/runtime/json-schema.ts),
[`values.ts`](src/runtime/envelope/values.ts), [Process
isolation](../../docs/architecture/bundles/process-isolation.md#the-envelope)).

#### The `models.provider/v1` contract

`models.provider/v1` is how a model provider bundle offers one provider kind
to `models/v1`. It runs in `host` only, has cardinality `many` and no optional
methods (its `optional` list is `[]`), so a record implements all six methods
below
([`basic/index.ts`](src/contracts/basic/index.ts),
[`models.ts`](src/contracts/basic/models.ts)). Each provider bundle registers
its record with `{ cardinality: 'many' }`; the providers are
[`claude`](../../bundles/providers/claude/README.md),
[`codex`](../../bundles/providers/codex/README.md),
[`openai`](../../bundles/providers/openai/README.md) and
[`openrouter`](../../bundles/providers/openrouter/README.md), and each declares
`models.provider/v1@1.4.0` in its manifest. `core` watches every record and
builds `models/v1` over them
([core README](../../bundles/foundation/core/README.md#modelsv1)).

```ts
interface ModelsProvider {
  kind(call?: CallArg): Promise<ModelKindDescriptor>;
  advertised(call?: CallArg): Promise<boolean>;
  catalog(
    input: {
      readonly configuration: Readonly<Record<string, string>>;
      readonly secret?: string;
    },
    call?: CallArg,
  ): Promise<CatalogResult>;
  create(
    input: ModelsProviderCreateInput,
    call?: CallArg,
  ): LanguageModel | Promise<LanguageModel>;
  catalogCapacity(call?: CallArg): Promise<boolean>;
  icons(
    input: {
      readonly configuration: Readonly<Record<string, string>>;
      readonly models: readonly string[];
    },
    call?: CallArg,
  ): Promise<ModelIconChoice>;
}
interface ModelsProviderCreateInput {
  readonly providerId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly secret?: () => Promise<string>; // x-doric-local: 'callback'
}
const ModelsProviderV1 = ref<ModelsProvider>('models.provider/v1');
const modelsProviderMethods: MethodSpecs;
```

| Method              | Input (`modelsProviderMethods`)                                                                                     | Output                | Meaning                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `kind()`            | none                                                                                                                | `ModelKindDescriptor` | The kind this record offers                                                                                         |
| `advertised()`      | none                                                                                                                | `boolean`             | Whether `models/v1.kinds()` lists the kind; `models/v1.kind(id)` finds it either way                                |
| `catalog(input)`    | `{ configuration: Record<string, string>, secret?: string }`, strict                                                | `CatalogResult`       | The kind's live model catalog for these values; `secret` is the resolved secret, not a credential id                |
| `create(input)`     | `{ providerId: string, values: Record<string, string>, secret?: callback }`, strict                                 | `LanguageModel`       | Builds the provider; the answer is a handle made with `toLanguageModel`                                             |
| `catalogCapacity()` | none                                                                                                                | `boolean`             | Whether the built provider's `models()` reports context capacity, which `models/v1.contextWindow` reads             |
| `icons(input)`      | `{ configuration: Record<string, string>, models: string[] }`, strict; at most 1000 names of at most 512 characters | `ModelIconChoice`     | The icons this kind chooses for these values, by name: its own and, per listed model, that model's own; no fallback |

Data shapes ([`models.ts`](src/contracts/basic/models.ts)):

- `ModelKindDescriptor` (strict): `id`, `label`, `description` (strings);
  `fields: ModelField[]`, the values a provider of the kind carries; `lists`,
  an array of `'models'` and `'reasonings'`, the lists a provider keeps;
  optional `modelsFromCatalog` (boolean), set when the kind's model list is its
  live catalog, so the configuration fill writes every model the catalog
  lists; optional `site: { url, label }` (strict), the site a
  provider page links to: `url` must parse with the `https:` scheme, `label`
  is non-empty.
- `ModelField` (strict): `key`, `label` (strings), `kind` (`text`, `url`,
  `number`, `enum` or `secret`), `required` (boolean), optional
  `description`, `placeholder`, `options` (strings) and `advanced` (boolean).
- `CatalogResult`: `{ status: 'read', models: CatalogModel[] }` or
  `{ status: 'absent' | 'failed' }` (both strict): the models, or why there are
  none (no URL, or a failed read). `CatalogModel` (loose) has `id`,
  `reasonings` and `parameters` (string arrays), `mandatory` (boolean),
  optional `name` and `defaultEffort`, and may carry more keys.
- `LanguageModel`: an opaque object, marked `x-doric-local: 'object'`. It
  crosses the envelope as a handle: back in the process that built it, it is
  the object `create` answered; anywhere else any use is refused as
  `local_only` ([`values.ts`](src/runtime/envelope/values.ts)).
  `toLanguageModel` gives a plain object a prototype of its own, keeping its
  own properties (getters stay getters), so it crosses as a handle and not by
  copy; an object whose prototype is not `Object.prototype` or
  `null` is returned unchanged.
- `ModelsProviderCreateInput.secret` reads the provider's secret as stored
  now; a provider awaits it before each request, so a rotated credential
  reaches the next request. It is a local callback and crosses only as a
  handle.
- `ModelIconChoice` (strict): optional `provider` and `models`, an array with
  one entry per requested model, in order: an icon name (1 to 64 characters)
  or `null` for a model without an icon of its own.

The contract declares no error codes. An error a record throws reaches its
caller with its class rebuilt ([Values, errors and
calls](#values-errors-and-calls)); how `models/v1` treats a record whose
method fails or is late is described in the [core
README](../../bundles/foundation/core/README.md#modelsv1).

#### Exports per source file

Every file exports the contract's interface, its ref (see the table above)
and its method table `<name>Methods` (`MethodSpecs`: one `{ input, output,
expose? }` per method). A `<name>Schema` is a zod schema and the type of the
same name without `Schema` is its `z.output` (`z.input` where noted). Method
semantics are in the provider's README (see above).

[`commands.ts`](src/contracts/basic/commands.ts):

| Export           | Meaning                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Commands`       | `register(command: Registrable<BoundCommand>): Disposable`; `execute(command: AnyServiceRef \| ContractId, input?, call?): Promise<void>` |
| `isBoundCommand` | See the helpers above                                                                                                                     |
| `CommandExecute` | `(input: unknown, call: Call) => Promise<void>`                                                                                           |

[`events.ts`](src/contracts/basic/events.ts):

| Export                | Meaning                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Events`              | `register(definition)`, `sink(spec)`, `append(definition, payload, call?)`                                                                                                                   |
| `EventSinkSpec`       | `{ scopeKeys: readonly string[]; stream: string; scopeDescription?: string }`: where the rows of appended events go; `{key}` in `stream` is a scope key; `scopeDescription` 1–256 characters |
| `eventSinkSpecSchema` | 1–`SCOPE_MAX_KEYS` unique keys matching `scopeKeyPattern`, `stream` 1–256 characters, every `{placeholder}` among the keys                                                                   |

[`hooks.ts`](src/contracts/basic/hooks.ts):

| Export             | Meaning                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Hooks`            | What `services.use(HooksV1)` returns: `define(C)`, `use(C)`, `whenAvailable(C, callback: (registrar: HookRegistrar<C>) => void \| Cleanup)`; see [`Services` and the part contexts](#services-and-the-part-contexts) |
| `HooksProvider`    | What a `hooks/v1` provider implements: `define`, `register`, `whenDefined`, `execute`; `HooksV1` is `ref<Hooks, HooksProvider>`                                                                                      |
| `HookOutput<H>`    | What a handler returns: nothing for `observe`/`sequence`, the input's output type for `transform`, `Decision` for `decide`                                                                                           |
| `HookHandler<H>`   | `(input, call: Call) => HookOutput<H> \| Promise<HookOutput<H>>`                                                                                                                                                     |
| `AnyHookHandler`   | `(input: unknown, call: Call) => unknown`: a handler as the provider stores it                                                                                                                                       |
| `HookHandle<C>`    | What `define(C)` returns to the owner: per hook, `execute(input, call?): Promise<HookOutput>`                                                                                                                        |
| `HookRegistrar<C>` | What `use(C)` returns to a consumer: per hook, `(handler) => Disposable`                                                                                                                                             |

[`log.ts`](src/contracts/basic/log.ts):

| Export      | Meaning                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Log`       | `debug`, `info`, `warn`, `error(message, fields?, call?): void`; a provider's level never throws and is never awaited, but the stub throws `invalid_input` synchronously when `message` is not a string or `fields` is not a record ([`dispatch.ts`](src/runtime/dispatch.ts)) |
| `LogFields` | `Readonly<Record<string, unknown>>`                                                                                                                                                                                                                                            |

[`menus.ts`](src/contracts/basic/menus.ts):

| Export                           | Meaning                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Menus`                          | `addItem(item)`, `addKeybinding(binding)`, `setContext({ key: 'path' \| 'focus', value: string \| null })` |
| `MenuWhen`, `menuWhenSchema`     | `{ path?: string; focus?: string }`: the active route pattern and focus that enable an entry               |
| `MenuItem`, `menuItemSchema`     | `{ id, location ('app/<menu>' or 'dock'), command, label, when?, order? }`                                 |
| `Keybinding`, `keybindingSchema` | `{ command, key, when? }`                                                                                  |
| `menuContextSchema`              | The input of `setContext`                                                                                  |

[`models.ts`](src/contracts/basic/models.ts):

| Export                                             | Meaning                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Models`, `ModelsProvider`                         | The `models/v1` and `models.provider/v1` interfaces; see [The `models.provider/v1` contract](#the-modelsproviderv1-contract)                                                  |
| `ModelField`, `modelFieldSchema`                   | One configuration field of a model kind: `{ key, label, kind: 'text' \| 'url' \| 'number' \| 'enum' \| 'secret', required, description?, placeholder?, options?, advanced? }` |
| `ModelKindDescriptor`, `modelKindDescriptorSchema` | `{ id, label, description, fields: ModelField[], lists: ('models' \| 'reasonings')[], modelsFromCatalog?, site?: { url (https:), label } }`                                   |
| `CatalogModel`, `catalogModelSchema`               | One model of a kind's catalog (loose object)                                                                                                                                  |
| `CatalogResult`, `catalogResultSchema`             | `{ status: 'read'; models: CatalogModel[] } \| { status: 'absent' \| 'failed' }`                                                                                              |
| `LanguageModel`, `languageModelSchema`             | An opaque, process-local model handle (`x-doric-local: 'object'`)                                                                                                             |
| `toLanguageModel`                                  | See the helpers above                                                                                                                                                         |
| `ResolvedModel`                                    | `{ providerId, model, effort?, languageModel }`                                                                                                                               |
| `ModelRequest`                                     | `{ providerId, model, effort? }`                                                                                                                                              |
| `ModelsConfiguration`                              | `Readonly<Record<string, unknown>>`                                                                                                                                           |
| `ModelsProviderCreateInput`                        | `{ providerId: string; values: Readonly<Record<string, string>>; secret?: () => Promise<string> }`: what `models.provider/v1.create` receives                                 |
| `MODEL_ICON_*`                                     | See the helpers above                                                                                                                                                         |
| `modelIconSvgSchema`                               | One icon: a string of at most `MODEL_ICON_MAX_LENGTH` characters starting with `<svg`                                                                                         |
| `ModelIconChoice`, `modelIconChoiceSchema`         | `{ provider?: name; models: (name \| null)[] }`: the icons a provider chooses, per requested model in order                                                                   |
| `ModelIconRequest`, `modelIconRequestSchema`       | `{ providerId, models }` or `{ kind, configuration, models }`                                                                                                                 |
| `ModelIconAnswers`, `modelIconAnswersSchema`       | `{ svgs: Record<name, svg>; answers: ModelIconChoice[] }`, in request order                                                                                                   |

[`navigation.ts`](src/contracts/basic/navigation.ts):

| Export                           | Meaning                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Navigation`                     | `register`, `navigate(path, { replace? })`, `back`, `forward`, `history` (both optional in the table), `current`, `chain`, `subscribe` |
| `RouteMatch`, `routeMatchSchema` | `{ path, pattern, params: Record<string, string> }`                                                                                    |
| `RouteRegistration`              | `{ path; create(match: RouteMatch): object; parent?: string }`                                                                         |
| `RouteEntry`                     | `{ match; route }`: one route of the active chain                                                                                      |
| `NavigationHistory`              | `{ canGoBack: boolean; canGoForward: boolean }`                                                                                        |

[`regions.ts`](src/contracts/basic/regions.ts):

| Export                           | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `Regions`                        | `add(region, item): Disposable`, `items(region)`, `subscribe(region, listener)` |
| `RegionItem`, `regionItemSchema` | `{ id, tag, props?: Record<string, unknown>, order? }`                          |
| `RegionEntry`                    | A `RegionItem` with `owner`: the `bundleId` that added it                       |

[`secrets.ts`](src/contracts/basic/secrets.ts):

| Export                                                                                            | Meaning                                                                                                        |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Secrets`, `SecretsBackend`                                                                       | The `secrets/v1` and `secrets.backend/v1` interfaces; the backend stores plaintext across the contract         |
| `CredentialKind`, `credentialKindSchema`                                                          | A registered kind name: `/^[A-Z][A-Z0-9_]{1,31}$/`                                                             |
| `credentialFieldNames`, `CredentialField`                                                         | `'username' \| 'email' \| 'secret'`                                                                            |
| `CredentialValues`                                                                                | `{ username?, email?, secret? }`                                                                               |
| `CredentialFieldSet`                                                                              | `{ required: CredentialField[]; optional: CredentialField[] }`                                                 |
| `CredentialKindDefinition`, `credentialKindDefinitionSchema`                                      | `{ id: CredentialKind; required; optional; label?: string }`; no field both required and optional              |
| `builtinCredentialKinds`, `credentialFieldsSatisfied`, `credentialFieldsMessage`, `isSecretsView` | See the helpers above                                                                                          |
| `CredentialRef`, `credentialRefSchema`                                                            | `{ id: string }`                                                                                               |
| `Secret`, `secretSchema`                                                                          | `{ id, kind, name, username?, email?, secret? }`                                                               |
| `CredentialDescription`, `credentialDescriptionSchema`                                            | The public view: `{ id, kind, name, username?, email?, hasSecret }`; never the secret                          |
| `CredentialCreate`, `credentialCreateSchema`                                                      | `{ kind, name, username?, email?, secret? }`                                                                   |
| `CredentialUpdate`, `credentialUpdateSchema`                                                      | Every field optional; `username`, `email`, `secret` absent or `null` keep the stored value, any string sets it |
| `CredentialWrite`, `credentialWriteSchema`                                                        | The same as `CredentialDescription`                                                                            |
| `credentialDeleteResultSchema`                                                                    | `'deleted' \| 'missing' \| 'referenced'`                                                                       |
| `ResolveByKindOptions` (`z.input`), `resolveByKindOptionsSchema`                                  | `{ exclude?: string[] }`: ids removed before the one-match rule                                                |
| `SecretsView`                                                                                     | An in-process, synchronous view of the provider's cache; never crosses a boundary                              |
| `ReferenceSource`                                                                                 | `() => Iterable<string>`: the credential ids a holder references now                                           |
| `StoredSecret`, `storedSecretSchema`                                                              | `Secret` plus `createdAt?`, `updatedAt?`: what the backend stores                                              |

[`settings.ts`](src/contracts/basic/settings.ts):

| Export                                    | Meaning                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Settings`                                | `register`, `get`, `entry`, `set(definition, value, options?, call?)`, `subscribe`       |
| `SettingsEntry<T>`, `settingsEntrySchema` | `{ value: T; revision: number; version: string; updatedAt: string; generation: number }` |
| `SettingsSetOptions`                      | `{ expectedRevision?: number }`                                                          |

[`skills.ts`](src/contracts/basic/skills.ts):

| Export                                     | Meaning                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `Skills`                                   | `register(skill: SkillSchemaInput, options?): Disposable`, `list(call?)`                     |
| `RegisteredSkill`, `registeredSkillSchema` | `{ bundleId, alwaysAvailable, order?: orderKey, skill: SkillRecord }`                        |
| `SkillRegistrationOptions`                 | `{ alwaysAvailable?: boolean; order?: number }`, strict; `order` checked by `orderKeySchema` |

[`storage.ts`](src/contracts/basic/storage.ts):

| Export                                                       | Meaning                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Storage`, `StorageBackend`                                  | The `storage/v1` and `storage.backend/v1` interfaces                                                                                                                                                                                                                                                |
| `StoredDocument`, `storedDocumentSchema`                     | `{ type, id, revision: int, value }`                                                                                                                                                                                                                                                                |
| `StorageQuery`, `storageQuerySchema`                         | `{ type, index, equals: IndexValue[], range?: { gt?, gte?, lt?, lte? }, order?: 'asc' \| 'desc', limit: 1–1000, cursor? }`                                                                                                                                                                          |
| `StoragePage`, `storagePageSchema`                           | `{ items: StoredDocument[]; cursor? }`                                                                                                                                                                                                                                                              |
| `StreamRead`, `streamReadSchema`                             | `{ stream, afterSequence: int ≥ 0, limit: int > 0 }`                                                                                                                                                                                                                                                |
| `StreamEntry`, `streamEntrySchema`                           | `{ sequence: int > 0, value, createdAt }` (`createdAt` set by the backend at commit)                                                                                                                                                                                                                |
| `TruncationMark`, `truncationMarkSchema`                     | `{ afterSequence, atSequence }`: entries above `afterSequence` were removed when the stream stood at `atSequence`                                                                                                                                                                                   |
| `StreamPage`, `streamPageSchema`                             | `{ entries, lastSequence, truncations }`; `truncations` are the marks that removed entries the reader may hold                                                                                                                                                                                      |
| `expectedRevisionSchema`                                     | `{ type, id, revision: int ≥ 0 }`; revision 0 means "must not exist"                                                                                                                                                                                                                                |
| `CommitBatch`, `commitBatchSchema`                           | One atomic batch, applied in the order expect → delete → put → dropStreams → truncate → append, or not at all; the backend applies it (for `postgres`, [`commit.ts`](../../bundles/foundation/postgres/src/host/storage/commit.ts), [Commits](../../bundles/foundation/postgres/README.md#commits)) |
| `commitResultSchema`                                         | `{ position: int }`                                                                                                                                                                                                                                                                                 |
| `StorageHealth`, `storageHealthSchema`                       | `{ status: 'ok' \| 'unavailable', writable, reason?, disk?: { blocks, availableBlocks } }`                                                                                                                                                                                                          |
| `StorageIdentity`, `storageIdentitySchema`                   | `{ hostId: uuid, storageGeneration: int > 0 }`                                                                                                                                                                                                                                                      |
| `StorageCapabilities`, `storageCapabilitiesSchema`           | `{ maxBatch, maxDocumentBytes, maxAppendBytes }`, positive integers                                                                                                                                                                                                                                 |
| `feedRequestSchema`                                          | `{ after: int, limit: int > 0 }`                                                                                                                                                                                                                                                                    |
| `FeedPage`, `feedPageSchema`                                 | `{ commits: { position, documents: { type, id }[], streams, truncated, dropped }[] }`                                                                                                                                                                                                               |
| `StorageDeclaration` (`z.input`), `storageDeclarationSchema` | `{ type, indexes: { name, fields, unique? }[] }`                                                                                                                                                                                                                                                    |

[`tools.ts`](src/contracts/basic/tools.ts):

| Export                                       | Meaning                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tools`                                      | `register(tool: Registrable<ContractTool>, options): Disposable`, `list(call?)`, `catalog(call?)`                                              |
| `ContractToolDefinition`                     | `{ name, description?, inputSchema: JsonObject, outputSchema: JsonObject, strict? }`: what a model sees                                        |
| `ToolIssueView`                              | `{ path: string; message: string }`                                                                                                            |
| `ToolPayloadCheck`                           | `{ success: true; data } \| { success: false; issues: ToolIssueView[] }`                                                                       |
| `ContractTool`                               | `{ name, description?, input: ZodObject, output, definition, settings: object[], resultModalities?, check?(payload), execute(payload, call) }` |
| `RegisteredTool`                             | `{ bundleId, alwaysAvailable, order?, projectId?, tool: ContractTool }`                                                                        |
| `ToolCatalogEntry`, `toolCatalogEntrySchema` | `{ name, description?, settings: object[] }`: plain data, as `GET /tools` lists it                                                             |
| `ToolRegistrationOptions`                    | `{ alwaysAvailable: boolean; order?: number; projectId?: string }`, strict; `order` checked by `orderKeySchema`, `projectId` non-empty         |
| `orderKeySchema`, `isContractTool`           | See the helpers above                                                                                                                          |

[`ui.ts`](src/contracts/basic/ui.ts):

| Export               | Meaning                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `Ui`                 | `define(tag, element): Disposable`, `create(tag, props?): object`, `dispose(element)` |
| `ElementConstructor` | `abstract new (...args: never[]) => object`: a custom element class                   |

[`windows.ts`](src/contracts/basic/windows.ts) (types are `z.input`):

| Export                                         | Meaning                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Windows`                                      | `open(request: OpenWindowRequest, call?): Promise<void>`                                                                                                              |
| `WindowAppearance`, `windowAppearanceSchema`   | `{ size?: { width, height, minWidth?, minHeight? }, titleBar: 'native' \| 'integrated' \| 'none' (default 'integrated'), background: token name (default 'window') }` |
| `PathWindowRequest`, `pathWindowRequestSchema` | `{ key, path, appearance?, primary? }`: a window showing an app route                                                                                                 |
| `WindowView`, `windowViewSchema`               | `{ path: string` (host-relative, starts with `/`)`; partition: string` (the Electron session partition)`; title?: string }`                                           |
| `ViewWindowRequest`, `viewWindowRequestSchema` | `{ key, view: WindowView, appearance?, primary? }`: a window showing a page on the host                                                                               |
| `OpenWindowRequest`, `openWindowRequestSchema` | One of the two; each shape is strict, so a request names exactly one                                                                                                  |
| `openWindowResultSchema`                       | `z.void()`                                                                                                                                                            |

### Platform contracts

`bundle/contracts` exports the ref and the interface of each `doric.*`
contract, its types and its schemas
([`platform.ts`](src/contracts/platform.ts)). The platform provides them; a
bundle uses them without listing them. Their full shapes are in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts).

| Contract                 | Ref                    | Interface            | Environments            |
| ------------------------ | ---------------------- | -------------------- | ----------------------- |
| `doric.catalog/v1`       | `DoricCatalogV1`       | `DoricCatalog`       | all                     |
| `doric.diagnostics/v1`   | `DoricDiagnosticsV1`   | `DoricDiagnostics`   | all                     |
| `doric.bundle/v1`        | `DoricBundleV1`        | `DoricBundle`        | all                     |
| `doric.log/v1`           | `DoricLogV1`           | `DoricLog`           | all                     |
| `doric.generation/v1`    | `DoricGenerationV1`    | `DoricGeneration`    | `host`                  |
| `doric.startup/v1`       | `DoricStartupV1`       | `DoricStartup`       | `host`                  |
| `doric.windows/v1`       | `DoricWindowsV1`       | `DoricWindows`       | `desktopMain`           |
| `doric.menus/v1`         | `DoricMenusV1`         | `DoricMenus`         | `desktopMain`           |
| `doric.cache/v1`         | `DoricCacheV1`         | `DoricCache`         | `desktopMain`           |
| `doric.migrations/v1`    | `DoricMigrationsV1`    | `DoricMigrations`    | `desktopMain`           |
| `doric.notifications/v1` | `DoricNotificationsV1` | `DoricNotifications` | `desktopMain`           |
| `doric.tokens/v1`        | `DoricTokensV1`        | `DoricTokens`        | `client`, `desktopMain` |
| `doric.about/v1`         | `DoricAboutV1`         | `DoricAbout`         | `client`                |
| `doric.elements/v1`      | `DoricElementsV1`      | `DoricElements`      | `client`                |
| `doric.connection/v1`    | `DoricConnectionV1`    | `DoricConnection`    | `client`                |
| `doric.browser/v1`       | `DoricBrowserV1`       | `DoricBrowser`       | `client`                |
| `doric.appearance/v1`    | `DoricAppearanceV1`    | `DoricAppearance`    | `client`                |

It also exports two platform hooks contracts, which the platform defines
with `definePlatformHooks` ([`platform.ts`](src/contracts/platform.ts)):

| Contract                                  | Hook                      | Kind                    | Input                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppHooksV1` (`doric.app.hooks/v1`)       | `onActivateHook`          | observe                 | `{ bundleId, version, generation, environment }`                                                                                                                                                                                                                                                                                |
|                                           | `onDeactivateHook`        | observe                 | the same                                                                                                                                                                                                                                                                                                                        |
|                                           | `onHostStartHook`         | sequence                | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onHostStopHook`          | sequence, reverse order | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onHostReadyHook`         | observe                 | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onGenerationReadyHook`   | observe                 | `{ generation }`                                                                                                                                                                                                                                                                                                                |
|                                           | `onGenerationChangedHook` | observe, per owner      | `{ event: 'activated' \| 'draining' \| 'lost' \| 'stopped', generation, incarnation, self: { generation, incarnation }, live: { generation, incarnation, state }[], holds?: { bundleId, key, label? }[] }`; each handler sees only its own bundle's `holds` ([Hooks](../../docs/architecture/bundles/hooks.md#doricapphooksv1)) |
|                                           | `onPeerSignalHook`        | observe, per owner      | `{ topic (1–128), payload, from: { generation, incarnation, bundleId }, self, live }`; only handlers of the sending bundle receive it ([Hooks](../../docs/architecture/bundles/hooks.md#doricapphooksv1))                                                                                                                       |
|                                           | `onAppReadyHook`          | observe                 | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onAppActivateHook`       | observe                 | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onBeforeQuitHook`        | decide                  | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onConnectionChangedHook` | observe                 | `{ connected }`                                                                                                                                                                                                                                                                                                                 |
| `WindowHooksV1` (`doric.window.hooks/v1`) | `onCloseHook`             | decide                  | `{}`                                                                                                                                                                                                                                                                                                                            |
|                                           | `onFlushHook`             | observe                 | `{}`                                                                                                                                                                                                                                                                                                                            |

When each fires is in [Hooks](../../docs/architecture/bundles/hooks.md).

The catalog's quarantine codes are exported as `quarantineCodes`:
`invalid_manifest`, `invalid_descriptor`, `invalid_part`, `duplicate_id`,
`engines_unsatisfied`, `missing_dependency`, `incompatible_version`,
`dependency_quarantined`, `unchosen_provider`, `cardinality_mismatch`,
`foundation_requires`, `dependency_cycle`, `activate_failed`,
`registration_failed`, `skill_invalid`, `generation_failed`, and, from phase 2 of the process model,
`invalid_bundle`, `health_timeout`, `process_failed`, `duplicate_http_prefix`
and `unreachable_dependency`. Since slice S67 no code sets `skill_invalid`
or `generation_failed` as a quarantine code: the platform skips an invalid
skill and logs it, and the supervisor reports a generation that does not
become active as a `generation_failed` diagnostics entry, leaving the bundle
unquarantined ([`publish.ts`](src/platform/supervisor/publish.ts),
[`supervisor.ts`](src/platform/supervisor/supervisor.ts)). When each is set is described in [The core
bundle and quarantine](../../docs/architecture/bundles/core.md#quarantine).

The other exports of [`platform.ts`](src/contracts/platform.ts) are the data
of those contracts:

| Export                                                 | Type or value                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Phase`                                                | `'foundation' \| 'core' \| 'others'`                                                                                                                                                                                                               |
| `BundleState`                                          | `'active' \| 'quarantined' \| 'disabled' \| 'inactive'`                                                                                                                                                                                            |
| `QuarantineCode`, `QuarantineReason`                   | `(typeof quarantineCodes)[number]`; `{ code: QuarantineCode; message: string; contract?: string }`                                                                                                                                                 |
| `CatalogManifest`                                      | The validated v1 manifest the catalog publishes: `{ manifestVersion: 1; id; version; engines: { doric }; provides; requires; optional?; desktopScope?: Record<string, string[]>; description? }`                                                   |
| `CatalogComposition`                                   | `{ core: string; enabled: readonly string[]; providers: Readonly<Record<string, string>> }`                                                                                                                                                        |
| `ContractProvider`                                     | `{ bundleId: string; version: string` (the contract version in `provides`)`; bundleVersion: string }`                                                                                                                                              |
| `CatalogBundle`                                        | `{ id: string; version: string; description?: string; state: BundleState; phase?: Phase; manifest?: CatalogManifest; reasons: readonly QuarantineReason[] }`                                                                                       |
| `CatalogContract`                                      | `{ id: string; environment: Environment; cardinality: 'one' \| 'many'; providers: readonly ContractProvider[] }`                                                                                                                                   |
| `CatalogSnapshot`                                      | `{ generation: number; composition; bundles: readonly CatalogBundle[]; order: readonly string[]` (activation order)`; contracts: readonly CatalogContract[]; storage?: StorageIdentity }`                                                          |
| `CatalogChange`, `catalogChangeSchema`                 | `{ generation: int }`: an item of `doric.catalog/v1.watch()`                                                                                                                                                                                       |
| `DistributionFile`, `distributionFileSchema`           | `{ path: string` (non-empty, `/` separators)`; sha256: string` (64 lowercase hex)`; size: int ≥ 0 }`                                                                                                                                               |
| `DistributionParts`                                    | `{ desktopMain?: string; client?: string; clientStyles?: string; contracts?: string }`: paths of the built parts                                                                                                                                   |
| `DistributionBundle`                                   | `{ id; version; state: BundleState; reasons; manifest?: CatalogManifest; descriptor?: JsonObject; files: readonly DistributionFile[]; parts: DistributionParts }`                                                                                  |
| `DistributionCatalog`, `distributionCatalogSchema`     | `{ generation: int; hostBoot: string` (non-empty, random per host process)`; platformVersion: string; composition; storage?; host: CatalogSnapshot; bundles: readonly DistributionBundle[] }`                                                      |
| `DistributionArtifact`, `distributionArtifactSchema`   | `{ sha256: string; base64: string }`: one distributed file by hash                                                                                                                                                                                 |
| `DiagnosticError`                                      | `{ at: string; bundleId: string; kind: string; message: string; details?: unknown }`                                                                                                                                                               |
| `DiagnosticBundle`                                     | `{ id; version; state: BundleState; phase?: Phase; reasons: readonly QuarantineReason[]; activationMs?: number }`                                                                                                                                  |
| `Diagnostics`                                          | `{ generation: number; mode: 'normal' \| 'recovery'; recovery?: { reason: string }; issues: readonly string[]; bundles: readonly DiagnosticBundle[]; errors: readonly DiagnosticError[]; consumers: Readonly<Record<string, readonly string[]>> }` |
| `DiagnosticReport`                                     | `{ bundleId: string; kind: string; message: string; details?: unknown }`                                                                                                                                                                           |
| `BundleDescription`                                    | `{ bundleId: string; version: string; generation: number; environment: Environment }`                                                                                                                                                              |
| `LogRecord`                                            | `{ level: 'debug' \| 'info' \| 'warn' \| 'error'; message; fields?; bundleId; version; generation; environment; scope?: CallScope; traceId?: string }`                                                                                             |
| `MenuSkeleton`                                         | `readonly { id: string; label: string; role?: string; submenu?: MenuSkeleton }[]`                                                                                                                                                                  |
| `WINDOW_CAPTURE_MAX_SIDE`                              | `4096`                                                                                                                                                                                                                                             |
| `WindowCaptureRequest`, `windowCaptureRequestSchema`   | `{ key: string` (non-empty)`; rect: { x ≥ 0; y ≥ 0; width; height }` (sides positive, at most `WINDOW_CAPTURE_MAX_SIDE`)` }`                                                                                                                       |
| `WindowCapture`, `windowCaptureSchema`                 | `{ png: string` (base64)`; width: int > 0; height: int > 0` (device pixels)`; scale: number > 0 }`                                                                                                                                                 |
| `MigrationRequest`                                     | `{ key: string; marker: string }`                                                                                                                                                                                                                  |
| `MigrationResult`                                      | `'migrated' \| 'none' \| 'skipped' \| 'failed'`                                                                                                                                                                                                    |
| `migrationKeyPattern`                                  | `/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/`: a localStorage key a migration may copy                                                                                                                                                                      |
| `migrationMarkerPattern`                               | `/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/`: the name of the marker record                                                                                                                                                                                  |
| `NotificationRequest`, `notificationRequestSchema`     | `{ title: string; body: string }`                                                                                                                                                                                                                  |
| `ConnectionStatus`, `connectionStatusSchema`           | `'connected' \| 'disconnected'`                                                                                                                                                                                                                    |
| `browserUrlSchema`                                     | A string of at most 8192 characters that parses as an absolute `https:` URL                                                                                                                                                                        |
| `DoricTheme`, `doricThemeSchema`                       | `'dark' \| 'light' \| 'system'`                                                                                                                                                                                                                    |
| `WorkHold`, `workHoldSchema`                           | `{ key: string` (1–256)`; label?: string` (≤ 256)` }`                                                                                                                                                                                              |
| `GenerationState`                                      | `'starting' \| 'active' \| 'draining' \| 'stopped' \| 'failed'`                                                                                                                                                                                    |
| `GenerationDescription`, `generationDescriptionSchema` | `{ generation: int; incarnation: int; state: GenerationState }`                                                                                                                                                                                    |
| `PeerSignal`                                           | `{ topic: string` (1–128)`; payload?: unknown }`                                                                                                                                                                                                   |
| `startupLevelSchema`                                   | `'debug' \| 'info' \| 'warn' \| 'error'`                                                                                                                                                                                                           |

## `bundle/runtime`

The service runtime shared by the host's generation processes, the desktop
main process and every window (the host kernel that also ran it was deleted
in slice S67)
([`src/runtime/index.ts`](src/runtime/index.ts)). Apps, the `desktop`
package, embedded foundation host parts (`host-config` imports
`contractDocument`) and bundle tests import it; desktop parts may, client,
chunk, worker and frame parts may not ([Build tooling](#build-tooling)).
It re-exports from the contracts what only the platform uses
([`define.ts`](src/contracts/define.ts),
[`platform.ts`](src/contracts/platform.ts)):

```ts
function definePlatformService<M extends Record<string, AnyMethodDefinition>>(
  idOrRef: ContractId | AnyServiceRef,
  methods: M,
): ServiceDefinition<ContractId, M>; // always cardinality 'one'
interface PlatformContractSpec {
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
}
const platformContracts: Readonly<
  Record<PlatformContractId, PlatformContractSpec>
>; // frozen
type PlatformContractId = keyof typeof platformContracts; // the doric.* service ids
```

`definePlatformService` checks the id like `defineService`
(`Invalid service contract ID "<id>".`) and throws a `TypeError`
`"<id>" is not a platform contract ID.` for an id that does not start with
`doric.`. The rest of the entry is the modules below.

### Directory and principals

```ts
interface ProviderRecord {
  readonly contractId: string;
  readonly bundleId: string;
  readonly version: string; // the providing bundle's version
  readonly contractVersion: string; // as declared in provides
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly methods: Readonly<Record<string, MethodSpec>>;
  readonly origin?: 'local' | 'remote';
  invoke(method: string, input: unknown, call: Call): unknown;
}
interface ProviderListener {
  added(record: ProviderRecord): void;
  removed(record: ProviderRecord): void;
}
interface Directory {
  register(record: ProviderRecord): () => void;
  providers(contractId: string): readonly ProviderRecord[];
  active(contractId: string): ProviderRecord | undefined;
  isActive(record: ProviderRecord): boolean;
  subscribe(contractId: string, listener: ProviderListener): () => void;
}
class ServiceDirectory implements Directory {
  observe(listener: ProviderListener): () => void;
}
class LayeredDirectory implements Directory {
  constructor(base: Directory, overlay?: Directory);
  readonly base: Directory;
  get overlay(): Directory | undefined;
  setOverlay(
    next: Directory | undefined,
    options?: { readonly retain?: boolean },
  ): void;
  release(overlay: Directory): void;
}
```

`ServiceDirectory` keeps the providers of each contract in registration
order; `active` is the first. Registering a second provider of a `one`
contract throws `provider_conflict`. `subscribe` calls `added` at once for
every current provider, then for each change; `observe` hears every contract
([`directory.ts`](src/runtime/directory.ts)). `LayeredDirectory` registers in
its base and reads the base before the overlay. `setOverlay` tells subscribers
the old overlay's records were removed and the new ones added; with
`retain: true` the old overlay's records stay active for the subscribers that
hold them until `release(overlay)` — the kernel, deleted in slice S67, used
this for a draining generation, and no live code passes `retain` now ([`layered-directory.ts`](src/runtime/layered-directory.ts)).

```ts
interface ContractCatalogView {
  cardinality(contractId: string): Cardinality | undefined;
  activeProvider(contractId: string): string | undefined; // the chosen bundle of a 'one' contract
}
const emptyCatalogView: ContractCatalogView;
interface ServiceRuntime {
  readonly directory: Directory;
  readonly catalog: ContractCatalogView;
  readonly environment: Environment;
  readonly generation: number;
  readonly operationGeneration?: number; // pin of a call without parent: 0 in the kernel, N in generation N
  readonly generationSignal: AbortSignal; // the default call.signal
  readonly report: (entry: DiagnosticReport) => void;
  readonly now?: () => number;
  readonly awaitProvider?: (
    contractId: string,
    signal: AbortSignal | undefined,
  ) => Promise<void> | undefined;
}
interface DeclaredProvide {
  readonly version: string;
  readonly cardinality: Cardinality;
}
interface PrincipalOptions {
  readonly bundleId: string;
  readonly version: string;
  readonly provides: ReadonlyMap<string, DeclaredProvide> | 'any';
  readonly ownContracts?: ReadonlySet<string>;
  readonly requires: ReadonlySet<string> | 'any';
  readonly isCore?: boolean;
}
class Principal {
  readonly runtime: ServiceRuntime;
  readonly options: PrincipalOptions;
  readonly caller: Caller;
  readonly scope: DisposalScope;
  services: Services; // checked
  unchecked: Services; // without the requires check
  get bundleId(): string;
  get current(): DisposalScope;
  get closed(): boolean;
  runInScope<T>(scope: DisposalScope, fn: () => T): T;
  noteRegistrationError(error: unknown): void;
  isRegistrationError(error: unknown): boolean;
  close(): void; // every stub of this principal then refuses calls
}
function createPrincipal(
  runtime: ServiceRuntime,
  options: PrincipalOptions,
): Principal;
interface ElementScope {
  readonly services: Services;
  dispose(): Promise<void>;
}
function createElementScope(principal: Principal): ElementScope;
```

A principal is one bundle in one environment of one generation
([`principal.ts`](src/runtime/principal.ts),
[`services.ts`](src/runtime/services.ts)). When `awaitProvider` is given and a
call finds no active provider, the call waits for the promise it returns and
then dispatches again; its call signal aborts the wait
([`dispatch.ts`](src/runtime/dispatch.ts)). `createElementScope` gives one
custom element services in a child of its owner's activation scope; every
registration made through them, also later from a stub the element kept, ends
with `dispose` ([`services.ts`](src/runtime/services.ts)).

```ts
function createStub<Api>(principal: Principal, target: DispatchTarget): Api;
interface DispatchTarget {
  readonly contractId: string;
  readonly useScope?: CallScope;
  readonly pinned?: ProviderRecord;
}
function dispatch(
  principal: Principal,
  target: DispatchTarget,
  method: string,
  args: readonly unknown[],
): unknown;
function normalizeArguments(
  schema: z.ZodType,
  args: readonly unknown[],
): { input: unknown; callArg: CallArg | undefined; tuple: boolean };
function isTupleSchema(schema: z.ZodType): boolean;
function isRegistrationConflict(error: unknown): boolean;
function createHooksFacade(
  principal: Principal,
  provider: HooksProvider,
  assertUse?: (contractId: string) => void,
): Hooks;
```

`normalizeArguments` splits stub arguments: for a tuple input the items are
the arguments, and a trailing `Call` is always the call argument while
trailing call options are one only past the tuple's length or where the
item at that position rejects them. `isRegistrationConflict` is true for the
codes a registration refusal raises: `duplicate_tool`, `duplicate_skill`,
`registration_conflict`, `not_owner`,
`provider_conflict`, `undeclared_provide`, `cardinality_mismatch` and
`contract_mismatch` ([`dispatch.ts`](src/runtime/dispatch.ts)).
`createHooksFacade` turns the flat `hooks/v1` provider methods into the
consumer API, each call a real hop ([`facades.ts`](src/runtime/facades.ts)).

### Calls, traces and scopes

```ts
interface CallFactoryInput {
  readonly caller: Caller;
  readonly useScope?: CallScope; // wins over the parent's keys
  readonly arg?: CallArg; // parent call or { signal, deadline }
  readonly generationSignal: AbortSignal;
  readonly windowKey?: string; // client dispatcher only
  readonly generation?: number; // pin without parent
  readonly defaultGeneration?: number;
  readonly now?: () => number;
}
function createHopCall(input: CallFactoryInput): Call;
function anySignal(signals: readonly AbortSignal[]): AbortSignal;
function newTrace(): TraceContext;
function childTrace(parent: TraceContext): TraceContext; // same trace id, new span; new trace when malformed
function traceIdOf(trace: TraceContext): string | undefined;
```

`createHopCall` ([`call.ts`](src/runtime/call.ts)) sets `caller` to the
principal making the hop. With a parent call it keeps the parent's signal,
deadline and generation and makes a child span; without one it starts a new
trace, takes the given signal or `generationSignal`, aborts it at the deadline
with a `TimeoutError` when the deadline is positive (a timer that fires before
the deadline re-arms for the time left, `abortAtDeadline`; `restoreCall` in
[`call-meta.ts`](src/runtime/envelope/call-meta.ts) does the same), and pins the call to
`generation`, else `defaultGeneration`, else 0. The scope is the parent's,
then `useScope`, then `windowKey`; an empty scope is omitted
([`trace.ts`](src/runtime/trace.ts)).

```ts
type DisposalErrorHandler = (error: unknown) => void;
class DisposalScope {
  constructor(onError?: DisposalErrorHandler);
  get disposed(): boolean;
  track(disposable: Disposable): void;
  onDispose(cleanup: Cleanup): void;
  child(): DisposalScope;
  dispose(): Promise<void>; // reverse order, awaited one by one; idempotent; never throws
}
function toDisposable(dispose: () => void): Disposable; // idempotent
const inertDisposable: Disposable;
```

A scope disposed already disposes anything tracked afterwards at once;
every failure goes to `onError` ([`scope.ts`](src/runtime/scope.ts)).

### Manifest, composition and descriptor

```ts
// The interfaces below spell out the z.output type aliases of the schemas.
const semverString: z.ZodType<string>; // checked by isVersion
const semverRange: z.ZodType<string>; // checked by isRange
const manifestV1Schema: z.ZodType<ManifestV1, ManifestV1Input>; // strict
interface ManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string; // /^[a-z][a-z0-9-]*$/, not "doric"
  readonly version: string; // semverString
  readonly engines: { readonly doric: string }; // semverRange
  readonly provides: readonly string[]; // "<id>/v<major>@<version>"; input default []
  readonly requires: readonly string[]; // "<id>/v<major>@<range>"; input default []
  readonly optional?: readonly string[]; // contract ids
  readonly desktopScope?: Readonly<Record<string, readonly string[]>>; // contract id → ≤ SCOPE_MAX_KEYS keys
  readonly description?: string; // trimmed, non-empty
  readonly host?: {
    readonly httpPrefix?: string;
    readonly assets?: readonly string[];
  }; // strict; v2 has the same assets
} // ManifestV1Input: the same with provides and requires optional
interface ContractEntry {
  readonly id: string;
  readonly major: number;
  readonly spec: string;
}
function parseContractEntry(entry: string): ContractEntry | undefined; // "<id>/v<major>@<version-or-range>"
interface ReadManifest {
  readonly manifest: Manifest; // v1 or v2 as written
}
function parseManifest(document: unknown): ReadManifest;
```

`parseManifest` reads a document by its `manifestVersion`, `1` with
`manifestV1Schema` and `2` with `manifestV2Schema`, and refuses a document
without it: "a manifest without manifestVersion is not supported by Doric 2;
write manifest version 2" ([`manifest.ts`](src/runtime/manifest.ts)).
The fields and rules of version 1 are in [The bundle
manifest](../../docs/architecture/bundles/manifest.md).

```ts
const compositionSchema: z.ZodType<Composition>; // strict
const requiredSchema: z.ZodType<Composition['required']>; // strict
const alternativeSchema: z.ZodType<Alternative>; // strict; options contains default
interface Composition {
  core: string; // non-empty
  enabled: string[]; // ≥ 1 non-empty ids
  resident?: string[]; // bundle ids of installed host parts sharing the host process
  providers: Record<string, string>; // contract id → bundle id; input default {}
  required?: { contracts: string[]; bundles: string[] }; // each input default []
  alternatives?: Record<string, Alternative>; // names /^[a-z][a-z0-9-]*$/
}
interface Alternative {
  env: string; // non-empty
  default: string; // non-empty, one of options
  options: string[]; // ≥ 1 non-empty
}
type AlternativeChoices = Readonly<Record<string, string>>;
type Variables = Readonly<Record<string, string | undefined>>;
function parseComposition(document: unknown): Composition;
function selectAlternatives(
  composition: Composition,
  variables: Variables,
): AlternativeChoices;
function enableAlternatives(
  composition: Composition,
  choices: AlternativeChoices,
): Composition;
function enabledAlternatives(composition: Composition): AlternativeChoices;
```

`selectAlternatives` takes for each alternative the value of its `env`
variable when it is one of `options`, else `default`. `enableAlternatives`
replaces each alternative's default bundle in `enabled` by the chosen option,
without duplicates. `enabledAlternatives` answers, for each alternative, its
single enabled option, or the default when none or several are enabled
([`composition.ts`](src/runtime/composition.ts)). The composition file is
described in [Composition and
distribution](../../docs/architecture/bundles/composition-and-distribution.md).

```ts
const descriptorKinds: readonly [
  'service',
  'hooks',
  'event',
  'command',
  'settings',
  'storage-type',
];
type DescriptorKind = (typeof descriptorKinds)[number];
const descriptorEntrySchema: z.ZodType<DescriptorEntry>; // strict
interface DescriptorEntry {
  id: string; // contractIdPattern
  version: string; // semverString
  kind: DescriptorKind;
  environment: Environment;
  cardinality: Cardinality;
  local: boolean;
  schema: string; // path relative to the bundle's dist, e.g. "schemas/hooks/v1.json"
}
const descriptorSchema: z.ZodType<Descriptor>; // strict
interface Descriptor {
  descriptorVersion: 1;
  bundle: { id: string; version: string };
  contracts: DescriptorEntry[];
}
function parseDescriptor(document: unknown): Descriptor;
function emptyDescriptor(id: string, version: string): Descriptor;
```

The descriptor is `dist/contracts.json`, which the build writes
([`descriptor.ts`](src/runtime/descriptor.ts)); its format is in [Contracts
and the `define*` family](../../docs/architecture/bundles/contracts.md).

### Catalog resolution and activation

```ts
type CatalogSource =
  | { readonly kind: 'installed'; readonly dir: string }
  | { readonly kind: 'embedded' };
interface CatalogCandidate {
  readonly id: string; // manifest id, or the directory name when the manifest could not be read
  readonly source: CatalogSource;
  readonly manifest?: ManifestV1;
  readonly descriptor?: Descriptor;
  readonly errors: readonly QuarantineReason[]; // problems found while reading
}
type EntryState = 'scheduled' | 'quarantined' | 'disabled';
interface CatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly source: CatalogSource;
  readonly manifest?: ManifestV1;
  readonly descriptor?: Descriptor;
  readonly phase?: Phase;
  readonly state: EntryState;
  readonly reasons: readonly QuarantineReason[];
  readonly dependencies: readonly string[]; // bundles of this environment it waits for
}
interface ResolvedProvider {
  readonly bundleId: string;
  readonly version: string; // the contract version in provides
  readonly bundleVersion: string;
}
interface ResolvedContract {
  readonly id: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly providers: readonly ResolvedProvider[]; // active providers; at most one for 'one'
}
interface ResolvedEnvironment {
  readonly environment: Environment;
  readonly generation: number;
  readonly composition: Composition;
  readonly issues: readonly string[];
  readonly entries: readonly CatalogEntry[];
  readonly order: readonly string[]; // activation order: foundation, core, others
  readonly contracts: readonly ResolvedContract[];
  readonly recovery?: { readonly reason: string };
}
interface ResolveInput {
  readonly candidates: readonly CatalogCandidate[];
  readonly composition: Composition;
  readonly platformVersion: string;
  readonly generation: number;
  readonly issues?: readonly string[]; // problems found before resolution
  readonly recovery?: { readonly reason: string }; // forces recovery mode
}
function resolveEnvironment(
  input: ResolveInput,
  environment: Environment,
): ResolvedEnvironment;
```

`resolveEnvironment` resolves one environment without running bundle code:
it checks each candidate's manifest, descriptor and platform range, chooses
the provider of each contract, reads `requires` per environment (a `client`
part is served by `client`, `desktopMain` and `host` providers), quarantines
bundles with reasons and cascades the quarantine through `requires` until
nothing changes, orders activation as foundation, core, others, and sets
`recovery` when the core or a chosen foundation provider cannot run
([`catalog.ts`](src/runtime/catalog.ts)). The rules are in [The core bundle
and quarantine](../../docs/architecture/bundles/core.md) and [The bundle
manifest](../../docs/architecture/bundles/manifest.md).

```ts
interface PlatformLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
class ActivationFailure extends Error {
  readonly code: QuarantineCode;
  constructor(code: QuarantineCode, message: string, options?: ErrorOptions);
}
function catalogView(resolved: ResolvedEnvironment): ContractCatalogView;
function principalOptionsFor(
  entry: CatalogEntry,
  resolved: ResolvedEnvironment,
): PrincipalOptions;
interface ActivationOptions {
  readonly resolved: ResolvedEnvironment;
  readonly runtime: ServiceRuntime;
  readonly platform: Principal; // 'doric': defines AppHooksV1, fires lifecycle hooks
  readonly diagnostics: DiagnosticsStore;
  readonly loadPart: (entry: CatalogEntry) => Promise<Activate | undefined>;
  readonly afterActivate?: (
    entry: CatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  readonly afterPhase?: (
    entry: CatalogEntry,
    principal: Principal,
  ) => Promise<void>; // once the phase is active
  readonly onHooksProviderReady?: (platform: Principal) => void | Promise<void>;
  readonly preActive?: readonly string[]; // active in another process; default []
  readonly hooksProvider?: 'local' | 'remote'; // default 'local'
  readonly settle?: (
    entry: CatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  readonly onPrincipal?: (entry: CatalogEntry, principal: Principal) => void;
  readonly log?: PlatformLog;
  readonly now?: () => number;
}
interface ActivationResult {
  readonly mode: 'normal' | 'recovery';
  readonly active: readonly string[];
  readonly principals: ReadonlyMap<string, Principal>;
  readonly appHooks: () => HookHandle<typeof AppHooksV1> | undefined;
  stop(): Promise<void>; // reverse deactivation; idempotent
}
function activateEnvironment(
  options: ActivationOptions,
): Promise<ActivationResult>;
```

`activateEnvironment` activates the scheduled entries in order, each with its
own principal and disposal scope ([`activation.ts`](src/runtime/activation.ts)).
Once the `hooks/v1` provider is active (or before the first bundle when
`hooksProvider` is `remote`) the platform defines `AppHooksV1` and fires
`onActivateHook` and, on deactivation, `onDeactivateHook`. A bundle whose
dependency is not active is quarantined with `dependency_quarantined`; a
throwing `activate` disposes its registrations, runs its cleanup and
quarantines it with `activate_failed` (or `registration_failed` when a
registration was refused); a rejection of `afterActivate`, `afterPhase` or
`settle` quarantines it the same way and cascades to the bundles that depend
on it. A failure of the core or of a chosen foundation provider enters
recovery: no further bundle activates and each remaining one is recorded
`inactive`. Lifetimes and quarantine are described in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md#lifetimes) and [The
core bundle and quarantine](../../docs/architecture/bundles/core.md).

### Diagnostics and the platform providers

```ts
const DIAGNOSTIC_ERRORS_PER_BUNDLE = 50;
class DiagnosticsStore {
  constructor(options: {
    readonly generation: number;
    readonly now?: () => number;
  });
  load(resolved: ResolvedEnvironment): void; // scheduled bundles start 'inactive'
  get mode(): 'normal' | 'recovery';
  enterRecovery(reason: string): void; // the first reason is kept
  state(id: string): BundleState | undefined;
  setState(id: string, state: BundleState, activationMs?: number): void;
  quarantine(id: string, reason: QuarantineReason): void;
  reasons(id: string): readonly QuarantineReason[];
  report(entry: DiagnosticReport): void;
  snapshot(): Diagnostics;
}
```

`report` stamps an error with the current time and keeps the 50 newest of
each bundle ([`diagnostics.ts`](src/runtime/diagnostics.ts)).

```ts
interface LogSink {
  write(record: LogRecord): void;
}
interface BundleStates {
  snapshot(): Diagnostics;
  state(id: string): BundleState | undefined;
}
interface CatalogDistributionProvider {
  distribution(call: Call): Promise<DistributionCatalog>;
  artifact(
    request: { readonly sha256: string },
    call: Call,
  ): Promise<DistributionArtifact>;
  watch(listener: StreamListener<CatalogChange>, call: Call): Disposable;
}
interface CatalogCompositionProvider {
  disable(request: { readonly bundleId: string }, call: Call): Promise<void>;
  resetComposition(call: Call): Promise<void>;
}
function statesOf(diagnostics: Diagnostics): BundleStates;
function catalogSnapshot(
  resolved: ResolvedEnvironment,
  diagnostics: BundleStates,
  storage?: StorageIdentity,
): CatalogSnapshot;
function providePlatformServices(
  platform: Principal,
  options: {
    readonly snapshot: (call: Call) => CatalogSnapshot;
    readonly diagnostics: DiagnosticsStore;
    readonly diagnosticsFor?: (call: Call) => Diagnostics;
    readonly sink: LogSink;
    readonly distribution?: CatalogDistributionProvider;
    readonly composition?: CatalogCompositionProvider;
    readonly generation?: {
      describe(call: Call): GenerationDescription;
      hold(work: WorkHold, call): Disposable;
      signal(signal: PeerSignal, call): void | Promise<void>;
    };
  },
): void;
```

`providePlatformServices` provides, as the principal `doric`,
`doric.catalog/v1` (`get`, plus `distribution`, `artifact` and `watch` when
`distribution` is given, and `disable` and `resetComposition` when
`composition` is given), `doric.diagnostics/v1` (`get`, `report`),
`doric.bundle/v1` (`describe`: the caller's `bundleId`, `version`,
`generation` and the runtime's environment), `doric.log/v1` (`write` to the
sink), and `doric.generation/v1` when that option is given ([`platform-providers.ts`](src/runtime/platform-providers.ts)). Their
contracts are described in [The core bundle and
quarantine](../../docs/architecture/bundles/core.md#doriccatalogv1-and-doricdiagnosticsv1),
[Observability](../../docs/architecture/bundles/observability.md) and
[Process isolation](../../docs/architecture/bundles/process-isolation.md).

### Distribution

```ts
function distributedSource(bundle: {
  id: string;
  version: string;
}): CatalogSource;
function candidatesFromDistribution(
  catalog: DistributionCatalog,
): CatalogCandidate[];
function compositionFromDistribution(catalog: DistributionCatalog): Composition;
// re-exported from the contracts (see Platform contracts)
const distributionArtifactSchema: z.ZodType<DistributionArtifact>;
const distributionCatalogSchema: z.ZodType<DistributionCatalog>;
const distributionFileSchema: z.ZodType<DistributionFile>;
```

The desktop resolves its `desktopMain` and `client` environments from the
host's distribution catalog: each distributed bundle becomes a candidate in
the host's order, the host's quarantine reasons become its errors, and a
bundle the host disabled leaves `enabled`
([`distribution.ts`](src/runtime/distribution.ts),
[Composition and distribution](../../docs/architecture/bundles/composition-and-distribution.md)).

### Contract documents and exposure

```ts
type SchemaDirection = 'input' | 'output';
interface MemberSchema {
  readonly schema: JsonObject;
  readonly local: boolean;
}
function memberSchema(schema: z.ZodType, io: SchemaDirection): MemberSchema;
const LOCAL_KEY = 'x-doric-local';
const localCodecKinds: readonly ['callback', 'disposable', 'object'];
type LocalCodecKind = (typeof localCodecKinds)[number];
const localMarker: JsonObject; // { 'x-doric-local': true }
const STREAM_KEY = 'x-doric-stream';
function streamItemSchema(input: unknown): JsonObject | undefined;
type RecordedContract = {
  readonly id: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
} & (
  | {
      readonly kind: 'service';
      readonly methods: Readonly<Record<string, MethodSpec>>;
    }
  | {
      readonly kind: 'hooks';
      readonly hooks: Readonly<Record<string, HookDefinition>>;
    }
  | { readonly kind: 'event'; readonly payload: z.ZodType }
  | { readonly kind: 'command'; readonly input: z.ZodType }
  | { readonly kind: 'settings'; readonly value: z.ZodType }
  | {
      readonly kind: 'storage-type';
      readonly value: z.ZodType;
      readonly indexes: readonly StorageIndex[];
    }
);
interface ContractDocument {
  readonly document: JsonObject;
  readonly local: boolean;
}
function contractDocument(contract: RecordedContract): ContractDocument;
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
function schemaPath(contractId: string): string; // `schemas/${contractId}.json`
function canonicalJson(value: unknown): string; // JSON with sorted keys
function jsonEqual(left: unknown, right: unknown): boolean;
function compilableSchema(schema: JsonValue): JsonValue; // drops an empty prefixItems so ajv compiles it

const documentExposureKey = 'x-doric-expose';
function exposureOf(
  contractId: string,
  method: string,
  declared?: { expose?: MethodExposure },
): MethodExposure | undefined;
function isDesktopExposed(
  contractId: string,
  method: string,
  spec: { expose?: MethodExposure } | undefined,
): boolean;
function misdeclaredExposure(
  contractId: string,
  methods: Record<string, { expose?: MethodExposure }>,
): string | undefined;
function documentExposure(
  document: JsonObject,
): Readonly<Record<string, MethodExposure>>;
```

`memberSchema` writes the JSON Schema 2020-12 of one member (zod's `input` or
`output` view): a process-local value with a codec becomes
`{ "x-doric-local": "<kind>" }` in place, and a member with a local value
without a codec is `{ "x-doric-local": true }`; tuples carry `minItems` and,
without a rest, `maxItems`. `contractDocument` builds a contract's document,
`$id` `doric:contract/<id>`, with each member under `$defs`
([`json-schema.ts`](src/runtime/json-schema.ts)); the document format is in
[Contracts and the `define*`
family](../../docs/architecture/bundles/contracts.md). For a contract the
platform publishes (a basic or `doric.*` contract), the exposure of a method
comes from the platform's table, otherwise from the provider's
`defineMethod`; `misdeclaredExposure` names the first method that declares an
exposure the table does not give ([`exposure.ts`](src/runtime/exposure.ts)).

### Semantic versions

```ts
interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}
function parseVersion(value: string): SemVer | undefined;
function isVersion(value: string): boolean;
function compareVersions(left: SemVer, right: SemVer): number;
function compare(left: string, right: string): number; // throws on an invalid version
function isRange(range: string): boolean;
function satisfies(candidate: string, range: string): boolean;
function rangeMajor(range: string): number | undefined; // the single major a range admits
function formatVersion(value: SemVer): string;
type ChangeLevel = 'none' | 'patch' | 'minor' | 'major';
function bump(base: string, level: ChangeLevel): string; // throws TypeError on an invalid base
```

Versions are `MAJOR.MINOR.PATCH` with an optional prerelease (no build
metadata); ranges are `*`, exact versions, `^`, `~` and `=`, `>`, `>=`, `<`,
`<=` comparators, joined by spaces (and) and `||` (or). A prerelease satisfies
a range only when a comparator of the same set names a prerelease of the same
release, as npm does ([`semver.ts`](src/runtime/semver.ts)).

### Platform version

```ts
const PLATFORM_VERSION = '1.11.0'; // what engines.doric ranges are checked against; every doric.* provider's version
const PLATFORM_ASSETS_VERSION = '1.0.0'; // the version segment of the platform folders and URLs
```

From [`version.ts`](src/runtime/version.ts).

### Generation processes and the envelope

```ts
type SerializedCatalogEntry = CatalogEntry;
interface GenerationInit {
  readonly environment: 'host' | 'desktopMain';
  readonly generation: number;
  readonly incarnation: number;
  readonly platformVersion: string;
  readonly composition: Composition;
  readonly entries: readonly SerializedCatalogEntry[]; // this process's entries, already resolved
  readonly order: readonly string[]; // this process's activation order
  readonly contracts: readonly ResolvedContract[];
  readonly preActive: readonly string[]; // bundles already active elsewhere in the environment
  readonly kernelProviders: readonly RemoteProviderDescriptor[]; // the kernel's providers at start
  readonly hooksProvider: 'remote' | 'local'; // 'remote': hooks/v1 lives in the kernel
  readonly catalog: CatalogSnapshot;
}
const generationInitSchema: z.ZodType<GenerationInit>; // generation and incarnation positive integers
interface RunnerOptions {
  readonly transport: Transport;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  readonly loadPart: (
    entry: SerializedCatalogEntry,
  ) => Promise<Activate | undefined>;
  readonly afterActivate?: (
    entry: SerializedCatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  readonly afterPhase?: (
    entry: SerializedCatalogEntry,
    principal: Principal,
  ) => Promise<void>; // once the whole phase activated
  readonly now?: () => number;
}
function runGeneration(options: RunnerOptions): Promise<void>;
class AnnouncingDirectory implements Directory {
  constructor(inner: Directory, announce: (message: ControlMessage) => void);
}
```

`runGeneration` waits for `init`, activates the process's bundles against the
kernel's providers, announces `ready`, serves until `stop`, deactivates in
reverse order and answers `stopped`. Its `AnnouncingDirectory` announces every
local, non-`doric.*` provider a bundle registers to the kernel (`provide`,
then `unprovide`) ([`runner.ts`](src/runtime/runner.ts)).

The envelope between processes is exported from
[`envelope/index.ts`](src/runtime/envelope/index.ts):

| Module                                                | Exports                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`link.ts`](src/runtime/envelope/link.ts)             | `ProcessLink`, `ProcessLinkOptions`, `ResolveTarget`, `Transport` (`send`, `onMessage`, `onClose`, `close`), `LinkCloseReason`: request correlation, cancellation, deadlines, exported handles and the close of the channel                                         |
| [`messages.ts`](src/runtime/envelope/messages.ts)     | The wire message types (`CallMessage`, `InvokeMessage`, `ResultMessage`, `CancelMessage`, `ReleaseMessage`, `ControlMessage`, …), `wireMessageSchema`, `wireErrorSchema`, `remoteProviderDescriptorSchema`, `controlKinds`, `isControlMessage`, `appLifecycleHooks` |
| [`call-meta.ts`](src/runtime/envelope/call-meta.ts)   | `toWireCall`, `restoreCall`, `RestoreOptions`: a `Call` as wire metadata and back                                                                                                                                                                                   |
| [`errors.ts`](src/runtime/envelope/errors.ts)         | `createErrorClassRegistry`, `ErrorClassRegistry`, `encodeError`, `decodeError`: errors cross with their class rebuilt from the registry                                                                                                                             |
| [`values.ts`](src/runtime/envelope/values.ts)         | `encodeValue`, `decodeValue`, `planFor`, `documentPlan`, `fixedPlan`, `MethodPlan`, `RemoteTool`, `WIRE_KEY`, codec types: process-local values cross as handles, a local value the schema does not allow is `local_only`                                           |
| [`remote.ts`](src/runtime/envelope/remote.ts)         | `describeRecord`, `remoteRecord`, `registerRemote`, `recordKey`, `announcedKey`, `matchesTarget`: a provider record as a descriptor and back                                                                                                                        |
| [`validators.ts`](src/runtime/envelope/validators.ts) | `SchemaValidators`, `SchemaCheck`, `SchemaIssue`, `documentMethodSpecs`, `memberSpec`, `validatorSchema`: checks of JSON Schema members at a boundary                                                                                                               |
| [`memory.ts`](src/runtime/envelope/memory.ts)         | `createTransportPair`, `TransportPair`: two connected in-memory transports                                                                                                                                                                                          |

Why the envelope works as it does is described in [Process
isolation](../../docs/architecture/bundles/process-isolation.md#the-envelope);
its exports follow.

#### Wire messages

From [`messages.ts`](src/runtime/envelope/messages.ts). Every message is
validated with `wireMessageSchema` on receipt.

```ts
interface WireCall {
  readonly caller: Caller; // filled by the sending dispatcher
  readonly scope?: CallScope; // on receipt, entries with a bad key or a non-string value are dropped
  readonly trace: TraceContext; // the hop span the sender created
  readonly deadline: number; // epoch ms; 0 = none
  readonly generation: number; // the pinned operation generation; 0 = unpinned
}

// Envelope messages
interface CallMessage extends WireCall {
  readonly kind: 'call';
  readonly id: string; // `${side}:${counter}`, unique per sending side
  readonly contract: string;
  readonly method: string;
  readonly input: unknown; // encoded
  readonly provider?: string; // the bundle of the record the sender resolved
  readonly record?: string; // that record's key, for a bundle with several records
  readonly oneway?: true; // no result is sent back
}
interface InvokeMessage extends WireCall {
  readonly kind: 'invoke';
  readonly id: string;
  readonly handle: string; // a handle the receiver exported
  readonly method?: string; // 'execute' or 'check' for a tool, 'run' for a scoped callback
  readonly args: readonly unknown[]; // encoded
}
type ResultMessage =
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    };
interface CancelMessage {
  readonly kind: 'cancel';
  readonly id: string;
}
interface ReleaseMessage {
  readonly kind: 'release';
  readonly handle: string;
}
// Streams across the desktop bridge and the main <-> window IPC; the process
// link between the kernel and a generation does not serve them.
interface SubscribeMessage extends WireCall {
  readonly kind: 'subscribe';
  readonly id: string;
  readonly contract: string;
  readonly method: string;
  readonly input: unknown; // without the listener
}
interface EventMessage {
  readonly kind: 'event';
  readonly id: string;
  readonly values: readonly unknown[];
} // [item]
interface UnsubscribeMessage {
  readonly kind: 'unsubscribe';
  readonly id: string;
}
interface EndMessage {
  readonly kind: 'end';
  readonly id: string;
  readonly error?: WireError;
}
type EnvelopeMessage =
  | CallMessage
  | InvokeMessage
  | ResultMessage
  | CancelMessage
  | ReleaseMessage
  | SubscribeMessage
  | EventMessage
  | UnsubscribeMessage
  | EndMessage;

// Errors
interface WireError {
  readonly code: string; // ContractError.code, else 'internal'
  readonly message: string;
  readonly details?: unknown;
  readonly thrown?: WireThrown;
}
type WireThrown =
  | { readonly kind: 'value'; readonly value: unknown }
  | WireThrownError;
interface WireThrownError {
  readonly kind: 'error';
  readonly name: string; // Reflect.get(error, 'name')
  readonly prototype: string; // constructor name, looked up in the receiver's registry
  readonly own: readonly WireOwnProperty[]; // getOwnPropertyNames order
}
type WireOwnProperty =
  | {
      readonly key: string;
      readonly enumerable: boolean;
      readonly value: unknown;
    }
  | {
      readonly key: string;
      readonly enumerable: boolean;
      readonly error: WireThrownError;
    };

// Control plane (kernel <-> runner); never routed to bundles
interface RemoteProviderDescriptor {
  readonly contractId: string;
  readonly bundleId: string;
  readonly key?: string; // the record's identity, for several records of a many contract
  readonly version: string; // the providing bundle's version
  readonly contractVersion: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly schema:
    | { readonly kind: 'basic' }
    | { readonly kind: 'platform' }
    | { readonly kind: 'document'; readonly document: JsonObject };
}
type ControlMessage =
  | { readonly kind: 'init'; readonly init: unknown } // a GenerationInit, validated by the runner
  | { readonly kind: 'ready'; readonly order: readonly string[] }
  | { readonly kind: 'provide'; readonly descriptor: RemoteProviderDescriptor }
  | {
      readonly kind: 'unprovide';
      readonly contractId: string;
      readonly bundleId: string;
      readonly key?: string;
    }
  | { readonly kind: 'diagnostics'; readonly snapshot: Diagnostics }
  | { readonly kind: 'catalog'; readonly snapshot: CatalogSnapshot }
  | {
      readonly kind: 'platform-log';
      readonly level: 'info' | 'warn' | 'error';
      readonly fields: Readonly<Record<string, unknown>>;
      readonly message: string;
    }
  | {
      readonly kind: 'lifecycle';
      readonly id: string;
      readonly hook: AppLifecycleHook;
      readonly input: unknown;
    }
  | {
      readonly kind: 'lifecycle-result';
      readonly id: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly kind: 'lifecycle-result';
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    }
  | { readonly kind: 'stop' }
  | { readonly kind: 'stopped' };
type AppLifecycleHook =
  | 'onAppReadyHook'
  | 'onAppActivateHook'
  | 'onBeforeQuitHook'
  | 'onGenerationReadyHook'
  | 'onConnectionChangedHook';
const appLifecycleHooks: readonly AppLifecycleHook[]; // frozen, in that order

type WireMessage = EnvelopeMessage | ControlMessage;
const wireMessageSchema: z.ZodType<WireMessage>;
const wireErrorSchema: z.ZodType<WireError>;
const remoteProviderDescriptorSchema: z.ZodType<RemoteProviderDescriptor>;
const controlKinds: ReadonlySet<string>; // the eleven ControlMessage kinds
function isControlMessage(message: WireMessage): message is ControlMessage;
```

`lifecycle` and `lifecycle-result` are declared and accepted by
`wireMessageSchema`, but no code sends them; `appLifecycleHooks` is read by
no code outside the module.

The control plane runs between a generation process's runner and its parent:
the desktop main process for a `desktopMain` generation (the kernel's
generation manager, which ran `host` generations, is deleted)
([`process.ts`](../../app/desktop/doric/src/platform/generation/process.ts)).
The runner's side is [`runner.ts`](src/runtime/runner.ts).

| Kind           | Sent by                                                                                                                                     | The receiver                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`         | The parent, once, after it spawns the process; the desktop main process sets `hooksProvider: 'local'` (`'remote'` was the deleted kernel's) | The runner ignores every other message until `init`, validates it with `generationInitSchema` and fails with `Invalid generation init: …`; a channel closed before it fails with `The kernel closed the channel before init.`        |
| `ready`        | The runner, once its bundles are activated, with the activation order                                                                       | The parent counts the generation as started                                                                                                                                                                                          |
| `provide`      | The runner, for each local, non-`doric.*` provider a bundle registers (`AnnouncingDirectory`)                                               | Registers a remote record for the descriptor, replacing one with the same key; a refused one is reported as `registration_failed` by the runner, and logged as a warning (`Generation provider refused`) by the desktop main process |
| `unprovide`    | The runner, when such a provider goes away                                                                                                  | Withdraws the remote record                                                                                                                                                                                                          |
| `diagnostics`  | The runner, after each bundle's principal is created, after each reported failure (once per microtask), after activation and after it stops | The parent keeps the snapshot as the generation's diagnostics                                                                                                                                                                        |
| `catalog`      | No live sender: the deleted kernel sent it when a generation became the active one                                                          | The runner replaces its catalog snapshot                                                                                                                                                                                             |
| `platform-log` | The runner, for each line its platform log writes                                                                                           | The parent logs the line at its level                                                                                                                                                                                                |
| `stop`         | The parent, to stop the generation                                                                                                          | The runner deactivates its bundles in reverse order, disposes the platform scope, pushes `diagnostics` and answers `stopped`                                                                                                         |
| `stopped`      | The runner, after it stops                                                                                                                  | The desktop main process does not read it: it waits for the process to exit and kills it after its stop timeout                                                                                                                      |

The desktop main process sends only `init` and `stop`: a `desktopMain`
generation keeps the providers and the catalog of its `init`.

#### `ProcessLink` and `Transport`

From [`link.ts`](src/runtime/envelope/link.ts) and
[`memory.ts`](src/runtime/envelope/memory.ts):

```ts
interface Transport {
  send(message: WireMessage): void; // throws once the channel is closed
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (reason: LinkCloseReason) => void): () => void;
  close(): void;
}
type LinkCloseReason =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly signal: string | null;
    }
  | { readonly kind: 'disconnected' };
interface ResolveTarget {
  readonly contract: string;
  readonly method: string;
  readonly provider?: string;
  readonly record?: string;
}
interface ProcessLinkOptions {
  readonly transport: Transport;
  readonly side: 'kernel' | 'generation'; // the kernel overwrites caller.generation
  readonly generation: number; // of the process on the generation side
  readonly incarnation?: number;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  resolve(target: ResolveTarget): ProviderRecord | undefined; // a local provider only
  principalOf?(bundleId: string): Principal | undefined; // for scoped callbacks
  report?(entry: DiagnosticReport): void;
  readonly generationSignal?: AbortSignal; // aborts the calls this side serves
  readonly now?: () => number;
}
interface CallTarget {
  readonly contract: string;
  readonly method: string;
  readonly input: unknown; // encoded
  readonly provider?: string;
  readonly record?: string;
} // the inline type of the three methods below; not exported

class ProcessLink implements CodecHost {
  constructor(options: ProcessLinkOptions);
  readonly side: 'kernel' | 'generation';
  readonly generation: number;
  readonly incarnation: number;
  readonly validators: SchemaValidators;
  readonly mirrors: Map<string, unknown>;
  get closeReason(): LinkCloseReason | undefined;
  get closeSignal(): AbortSignal; // aborted when the channel closes
  get inFlight(): number; // outbound calls awaiting a result + inbound calls not answered
  get openStreams(): number;
  onClose(listener: (reason: LinkCloseReason) => void): () => void; // called at once when already closed
  onIdle(listener: () => void): () => void; // each time inFlight drops to 0
  onControl(listener: (message: ControlMessage) => void): () => void;
  sendControl(message: ControlMessage): void;
  close(): void; // closes the transport; reason { kind: 'stopped' }
  forgetStream(end: (error: ContractError) => void): void;
  request(target: CallTarget, call: Call): Promise<unknown>; // resolves with the encoded output
  oneway(target: CallTarget, call: Call): void; // never throws
  optimistic(
    bundleId: string,
    target: CallTarget,
    call: Call,
    exported: readonly string[],
    end?: (error: ContractError) => void,
  ): Disposable; // a local Disposable now; the acknowledgement later
  activating(bundleId: string): () => void; // keep refusals for settle; returns the end mark
  settle(bundleId: string): Promise<void>; // rejects with the first refusal
  // CodecHost
  exportHandle(target: ExportTarget): string;
  exported(handle: string): ExportTarget | undefined;
  invoke(
    handle: string,
    method: string | undefined,
    args: readonly unknown[],
    call: Call,
  ): Promise<unknown>;
  run(handle: string, call: Call): string; // one run of a scoped callback; returns the run handle
  release(handle: string): void;
  detachedCall(): Call; // caller doric, a new trace
  principalOf(bundleId: string): Principal | undefined;
  report(bundleId: string, kind: string, error: unknown): void;
}

interface TransportPair {
  readonly left: Transport;
  readonly right: Transport;
  sever(reason?: LinkCloseReason): void; // ends both sides; default an exit by SIGKILL
}
function createTransportPair(): TransportPair; // structured-clones on send, delivers on a microtask, in order
```

When the call's signal aborts, `request` sends `cancel`; the serving side
aborts the provider's call, with a `TimeoutError` when the deadline has
elapsed. Once the channel closes, every pending and later request rejects with
`generation_lost` (`Generation <n> exited.`, details `{ generation,
incarnation }`), and each open stream registration ends with it. A message that
fails `wireMessageSchema` is reported to `report` as `protocol_error`; when it
is a `call`, `invoke` or `subscribe` with an `id`, the sender receives a
`protocol_error` result.

#### Values, errors and calls

From [`values.ts`](src/runtime/envelope/values.ts),
[`errors.ts`](src/runtime/envelope/errors.ts) and
[`call-meta.ts`](src/runtime/envelope/call-meta.ts):

```ts
const WIRE_KEY = '$doric';
type CallbackMode = 'async' | 'listener' | 'scoped';
type LocalKind =
  | 'callback'
  | 'disposable'
  | 'object'
  | 'call'
  | 'hooks'
  | 'definition'
  | 'tool';
type WireValue = // the wire form of a local value, keyed by WIRE_KEY
  | { readonly $doric: 'call' }
  | {
      readonly $doric: 'callback';
      readonly handle: string;
      readonly mode: CallbackMode;
    }
  | { readonly $doric: 'disposable'; readonly handle: string }
  | { readonly $doric: 'object'; readonly handle: string }
  | {
      readonly $doric: 'hooks';
      readonly id: string;
      readonly hooks: Readonly<
        Record<string, { kind: HookKind; input: JsonObject; order?: HookOrder }>
      >;
    }
  | {
      readonly $doric: 'definition';
      readonly kind: 'event' | 'settings' | 'storage-type';
      readonly id: string;
      readonly schema: JsonObject;
      readonly indexes?: readonly StorageIndex[];
    }
  | {
      readonly $doric: 'tool';
      readonly handle: string;
      readonly name: string;
      readonly description?: string;
      readonly definition: ContractToolDefinition;
      readonly settings: readonly object[];
      readonly resultModalities?: readonly string[];
    };
type ExportTarget =
  | {
      readonly kind: 'callback';
      readonly fn: (...args: unknown[]) => unknown;
      readonly mode: CallbackMode;
      readonly principal?: Principal;
      readonly parentScope?: DisposalScope;
    }
  | { readonly kind: 'disposable'; readonly value: Disposable }
  | { readonly kind: 'object'; readonly value: object }
  | { readonly kind: 'tool'; readonly tool: ContractTool };
interface CodecHost {
  /* the CodecHost members of ProcessLink above */
}
interface CodecContext {
  readonly host: CodecHost;
  readonly call: Call; // the call the value travels with
  readonly exports?: string[]; // handles exported while encoding
}
function encodeValue(
  value: unknown,
  kinds: ReadonlySet<LocalKind>,
  context: CodecContext,
): unknown;
function decodeValue(value: unknown, context: CodecContext): unknown;

interface MethodPlan {
  readonly refused?: string; // why the method cannot cross (local_only)
  readonly oneway?: boolean;
  readonly optimistic?: boolean;
  readonly listener?: number; // index of a stream method's listener among the input's items
  readonly input?: ReadonlySet<LocalKind>; // undefined = plain data
  readonly output?: ReadonlySet<LocalKind>;
  prepare?(input: unknown): unknown;
  finish?(output: unknown, input: unknown): unknown;
}
function fixedPlan(contractId: string, method: string): MethodPlan | undefined; // basic and doric.* methods
function documentPlan(
  label: string,
  input: unknown,
  output: unknown,
): MethodPlan; // from member JSON Schemas
function planFor(
  contractId: string,
  method: string,
  members: { readonly input: z.ZodType; readonly output: z.ZodType },
): MethodPlan; // fixedPlan, else documentPlan of the members

interface RemoteToolCallView {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  readonly definition: ContractToolDefinition;
  execute(payload: unknown): Promise<unknown>;
  check(payload: unknown): Promise<ToolPayloadCheck>;
}
class RemoteTool implements ContractTool {
  constructor(wire: Extract<WireValue, { $doric: 'tool' }>, host: CodecHost);
} // check and execute run in the registering process

interface ErrorClassRegistry {
  register(errorClass: abstract new (...args: never[]) => Error): void;
  lookup(name: string): (abstract new (...args: never[]) => Error) | undefined;
}
function createErrorClassRegistry(): ErrorClassRegistry; // always knows ContractError
function encodeError(value: unknown): WireError;
function decodeError(wire: WireError, classes: ErrorClassRegistry): unknown;

function toWireCall(call: Call): WireCall;
interface RestoreOptions {
  readonly signals: readonly AbortSignal[]; // cancel, link close, receiving runtime
  readonly callerGeneration?: number; // the kernel overwrites caller.generation
  readonly now?: () => number;
}
function restoreCall(meta: WireCall, options: RestoreOptions): Call;
```

`encodeValue` replaces each local value by its `WireValue` and exports a
handle for it; a local value of a kind outside `kinds` throws `local_only`
(`<what> is local to its process and cannot cross the envelope.`).
`decodeValue` rebuilds the local values and keeps plain data as sent; one wire
form always yields one mirror per link. `encodeError` keeps a
`ContractError`'s code (else `internal`) and the thrown value; `decodeError`
returns a `ContractError` when nothing was thrown along, the thrown value as
is, or an error rebuilt on the prototype of its constructor name: the
registered class, else the standard error class of that name, else `Error`
(a `DOMException` is constructed anew); own properties are restored with
their enumerability, nested errors such as `cause` included.
`restoreCall` rebuilds the branded `Call`; its signal aborts with the given
signals and, at the deadline, with a `TimeoutError`.

## `bundle` (Node)

The Node entry for the host, the build, embedded foundation host parts
(`EmbeddedBundle`, as a type) and bundle tests
([`src/index.ts`](src/index.ts)); desktop, client, chunk, worker and frame
parts may not import it ([Build tooling](#build-tooling)). It re-exports, from `bundle/runtime`,
the manifest, composition and descriptor schemas and types,
`resolveEnvironment`, the alternatives helpers, `PLATFORM_VERSION`,
`PLATFORM_ASSETS_VERSION`, `runGeneration` and its types; from the contracts'
[`skill.ts`](src/contracts/skill.ts), `SkillRecord` (also as `Skill`),
`SkillSchemaInput` and `SkillSchema`; from `bundle/testing`,
`createTestServices`; and the host SDK of the process model
([`src/sdk/host/`](src/sdk/host)): `runBundle`, `startBundle`,
`RegistrationTable`, `stampedCallerOf`, `reopenResumable`,
`resumableDelays`, `HostGoneError`, `EXIT_HOST_GONE`, `EXIT_STOPPED` and their
types.

### `runBundle`

Phase 2 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md#10-the-typescript-sdk)
adds the program of a host part that runs as its own process. Every bundle's
host part runs through it from its `src/host/main.ts`, the only host entry
since slices S67–S69; the fixture bundles of the platform tests and the
conformance suite do too.

```ts
function runBundle<const T extends readonly DescService[] = []>(
  definition: BundleDefinition<T>,
): void;
function startBundle<const T extends readonly DescService[] = []>(
  definition: BundleDefinition<T>,
  options: StartBundleOptions, // { env, exit, helloTimeoutMs?, bundleDir?, logTimings?, logOutput? }
): Promise<RunningBundle>; // { instance, exited }

interface BundleDefinition<
  T extends readonly DescService[] = readonly DescService[],
> {
  readonly services?: ServiceEntries<T>; // [service, implementation] pairs; default []
  readonly httpServer?: Server; // node:http, not yet listening; for a part with host.httpPrefix
  activate(context: HostContext): Promise<void> | void; // resolved: the bundle's own skills registered, then ActivateResult
  deactivate?(context: HostContext): Promise<void> | void;
  readonly logSink?: (context: HostContext) => LogSink; // in-process sink, for core
  readonly invalidInput?: InvalidInputAnswer; // the error for a request protovalidate rejects; default invalid_input
}

type InvalidInputAnswer = (
  method: DescMethod,
  violations: readonly InputViolation[], // at least one, in protovalidate's order
) => ContractError | undefined; // undefined keeps invalid_input

interface InputViolation {
  readonly field: readonly string[]; // proto field names; list and map subscripts dropped; [] for a message rule
  readonly ruleId: string; // string.uuid, update_thread_request.change
  readonly message: string;
}

interface HostContext {
  readonly instance: BundleInstance; // { bundleId, generation, incarnation }
  readonly services: HostServices; // use(ref, options?: UseOptions): Client<S>
  readonly registrations: HostRegistrations; // track(...): replayed to new provider instances
  readonly instances: HostInstances; // onGone: InstanceGone
  readonly generations: HostGenerations; // onChanged, onSignal
  readonly log: Log;
  readonly signal: AbortSignal; // aborted on Stop
  readonly assets: HostAssets; // read(path), extract(prefix?), require(specifier)
}

interface UseOptions<S extends DescService = DescService> {
  readonly provider?: string; // doric-provider, for a many contract
  readonly target?: string; // doric-target, <bundleId>/<generation>/<incarnation>
  readonly resume?: ResumeRequests<S>; // per server-streaming method: the request that reopens it after the last item
  readonly scope?: CallScope; // sent as doric-scope-bin on every call, in place of the parent call's scope
}
```

`invalidInput` answers a request that decoded but broke a protovalidate rule
of its method's input ([`serve.ts`](src/sdk/host/serve.ts)): a unary request,
a server stream's request, and each message of a client or bidi stream. It is
called synchronously, before the handler, with the method and every violation;
a returned `ContractError` ends the call, while `undefined`, a throw or no hook
keep `ContractError('invalid_input', <protovalidate message>)`. A request that
does not decode, and a rule that fails to evaluate, never reach it.
`InputViolation` and `InvalidInputAnswer` are exported from the host SDK.

`runBundle` is `startBundle` with `process.env` and `process.exit`
([`run.ts`](src/sdk/host/run.ts)). It reads the spawn environment
(`DORIC_ROUTER_URL`, `DORIC_INSTANCE_TOKEN`, `DORIC_BUNDLE_ID`,
`DORIC_GENERATION`, `DORIC_INCARNATION`), opens
`BundleHostService/Connect` with the token, and sends `Hello` with the full
names of `services` in list order and `httpPort`. It then answers
`Activate`, `HealthCheck`, `GenerationChanged` (a `GenerationAck` once the
`onChanged` handlers settled, or after 10 s), `PeerSignal` and `Stop`
(`deactivate`, `StopResult`, exit code 0, `EXIT_STOPPED`); a host that is gone
exits with code 70 (`EXIT_HOST_GONE`). A service listed twice, or an
`httpServer` already listening, rejects with a `TypeError` before the stream
opens.

`httpServer` is bound to `127.0.0.1:0` before the stream opens and its port is
the Hello's `httpPort`; the gateway forwards the requests under the manifest's
`host.httpPrefix` to it. A part whose manifest sets no `host.httpPrefix` may
pass one, but its `httpPort` is ignored. The SDK closes it after `deactivate`.

`context.services.use(ref, options)` answers a Connect client of `ref` over the
router transport; a call made inside a handler inherits that call's deadline,
scope, trace and signal. `options.scope` replaces the parent call's scope
(deadline, cancellation and trace still come from the parent call), so a
client created outside any handler call, in detached work, can send one, for
example `{ projectId, threadId, promptId }`; a scope outside
`callScopeSchema`'s bounds makes `use` throw `ContractError` `invalid_scope`
and no call is made. Under `track(…, { scope })` the first call carries the
scope and replays send none. A server-streaming method marked resumable that ends
with `generation_lost` is opened again (`reopenResumable`, after
`resumableDelays`: 100 ms, doubling up to 5 s while it answers `unavailable`),
with `options.resume`'s request for the method built from the last item, or
the original request. While the SDK replays the registrations of `ref`'s
contract to a new provider instance, new calls to it wait.

`context.assets` ([`assets.ts`](src/sdk/host/assets.ts)) answers the files the
manifest's `host.assets` globs match. The globs are relative to the bundle
directory (`StartBundleOptions.bundleDir`; `runBundle` takes the directory two
above `process.argv[1]`) and are read from `<bundle dir>/manifest.json` once;
a glob that is empty, absolute, has a `.`, `..` or empty segment, or a `\` is
refused by the manifest schema, and `hostAssetsOf(manifest)` answers them in
order. `read(path)` answers the bytes (`Uint8Array`) of a listed file; a path
no glob lists, or one that is not normal, rejects with "not listed", also in
development, and a listed file that is missing rejects with "missing" (both
name the path and the bundle). `extract(prefix?)` answers the bundle directory
in development. `require(specifier)` loads a package, such as one with native
code, with `createRequire` from the bundle directory. Phase 3 copies no asset
into `dist/`; the single executable application comes in phase 7.

`context.log` ([`log.ts`](src/sdk/host/log.ts)) is a queue that sends records
to `log/v1.WriteBatch` in batches of 100 or every 200 ms, with a 5 s deadline
per batch, one batch in flight; a batch is split where the trace or scope
changes. A failed batch is written to stdout without retry; a router refusal
(`undeclared_requirement` or `unknown_contract`) sends every later record to
stdout for the rest of the process. At 10,000 queued records the oldest is
written to stdout, so nothing is dropped. Stdout lines are redacted with the
list of `secrets/v1.WatchRedactions`. On `Stop` what is left is sent with a
2 s deadline per batch within the stop budget, and every exit flushes the
queue synchronously. `runBundle` installs handlers for `exit`,
`uncaughtException`, `unhandledRejection`, `SIGTERM` and `SIGINT`; a signal
flushes and is raised again. `BundleDefinition.logSink` replaces the router
sink (core writes its own records in process); `StartBundleOptions.logTimings`
and `logOutput` let tests shorten the timings and capture the stdout lines. A
bundle that does not declare `log/v1` or `secrets/v1` logs to stdout until S62
adds both as optional requirements of every host part.

`RegistrationTable<V>` ([`registrations.ts`](src/sdk/host/registrations.ts))
applies the spec's key rule for registrations (A66): `new
RegistrationTable({ conflictCode })`, `conflictCode` one of `duplicate_tool`,
`duplicate_skill` and `registration_conflict`; `register(caller, key, value)`
answers `{ registrationId }`, the same instance and key replacing the value and
keeping the id, another instance of the same bundle adding a registration of
which the newest instance's serves, and a key whose newest registration
belongs to another bundle throwing `ContractError(conflictCode)`;
`remove(registrationId)`, `dropInstance(instance)` (for `InstanceGone`),
`get(key)` and `entries()`.

### Loader

```ts
interface InstalledBundle {
  readonly dir: string;
  readonly read?: ReadManifest;
  readonly descriptor?: Descriptor;
  readonly errors: readonly QuarantineReason[];
}
function discoverBundles(root: string): Promise<readonly InstalledBundle[]>;
function readInstalledBundle(dir: string): Promise<InstalledBundle>;
function readManifest(bundleDir: string): Promise<ReadManifest>;
function readDescriptor(bundleDir: string): Promise<Descriptor | undefined>;
class CompositionError extends Error {
  readonly path: string;
}
function readComposition(path: string): Promise<Composition>;

interface EmbeddedBundle {
  readonly manifest: ManifestV1Input;
  readonly descriptor: Descriptor;
  readonly documents?: Readonly<Record<string, JsonObject>>; // contract documents by schema path
  readonly host?: { readonly activate: Activate<HostContext> };
}
interface BuildCatalogInput {
  readonly installed: readonly InstalledBundle[];
  readonly embedded: readonly EmbeddedBundle[];
  readonly composition: Composition;
  readonly platformVersion: string;
  readonly generation: number;
  readonly issues?: readonly string[];
  readonly recovery?: { readonly reason: string };
}
function buildCatalog(input: BuildCatalogInput): ResolvedEnvironment; // the host environment
```

`discoverBundles` reads every immediate subdirectory of `root`, sorted by
path, without running bundle code, and throws (`Unable to discover bundles in
root "<root>".`) when `root` cannot be read ([`discover.ts`](src/loader/discover.ts)).
`readInstalledBundle` records an unreadable or invalid manifest as
`invalid_manifest` (a manifest without `manifestVersion` included) and an
invalid `contracts.json` as `invalid_descriptor`; a missing `contracts.json` leaves the
descriptor absent. `readManifest`, `readDescriptor` and `readComposition` wrap
JSON and schema failures with the file in the message; `readComposition`
throws `CompositionError` ([`read.ts`](src/loader/read.ts)). An embedded
bundle is passed in code; an invalid manifest or descriptor quarantines it
([`catalog.ts`](src/loader/catalog.ts)).

```ts
const compositionOverridesSchema: z.ZodType<CompositionOverrides>; // strict
type CompositionOverrides = { disabled: string[] }; // non-empty ids
function compositionOverridesPath(compositionPath: string): string; // composition.overrides.json beside it
function readCompositionOverrides(
  path: string,
): Promise<CompositionOverrides | undefined>; // undefined when missing
function writeCompositionOverrides(
  path: string,
  overrides: CompositionOverrides,
): Promise<void>;
function clearCompositionOverrides(path: string): Promise<void>;
function applyCompositionOverrides(
  composition: Composition,
  overrides: CompositionOverrides | undefined,
): Composition;
```

The overrides file persists the recovery actions: `applyCompositionOverrides`
leaves each disabled bundle out of `enabled`; the composition file itself is
never rewritten. `writeCompositionOverrides` writes a temporary file and
renames it over the target; `clearCompositionOverrides` deletes the file
([`overrides.ts`](src/loader/overrides.ts)). With an overrides path, the
platform's `doric.catalog/v1.disable({ bundleId })` adds the bundle to
`disabled` (`not_found` when it is not in the composition, `invalid_input` for
the core; an unreadable file is replaced) and `resetComposition()` clears the
file; each then publishes, and a result other than `published` logs
`Composition change applies at the next host start` and throws `unavailable`.
The changes run one at a time ([`composition-actions.ts`](src/platform/composition-actions.ts)).

```ts
interface ParsedSkill {
  readonly skill: SkillSchemaInput;
  readonly alwaysAvailable?: boolean;
  readonly order?: number;
}
function parseSkillDocument(
  source: string,
  context: string,
  options?: { frontmatterAvailability: boolean },
): ParsedSkill;
function readSkill(
  bundlePath: string,
  relativePath: string,
  options?: { frontmatterAvailability: boolean },
): Promise<ParsedSkill>;
function discoverSkills(bundlePath: string): Promise<readonly string[]>;
```

A `SKILL.md` is YAML frontmatter between `---` lines, then the Markdown body.
The frontmatter holds `name`, `description`, `allowed-tools` (a
space-separated string or a list), optional `indexText`, and, for a version 1
manifest (`frontmatterAvailability: true`), optional `alwaysAvailable` and
`order` (an `orderKeySchema` integer); any other key is refused.
`discoverSkills` lists `skills/<dir>/SKILL.md` in lexical directory order and
skips a directory without `SKILL.md`. A resource path that is absolute,
contains `\` or escapes the bundle directory is refused
([`skills.ts`](src/loader/skills.ts)).

```ts
interface DistributionInput {
  resolved: ResolvedEnvironment;
  states: BundleStates;
  hostBoot: string;
  platformVersion: string;
  storage?: StorageIdentity;
}
function distributionFor(
  input: DistributionInput,
): Promise<DistributionCatalog>;
function distributionFiles(bundleDir: string): Promise<DistributionFile[]>;
function distributionParts(
  files: readonly DistributionFile[],
): DistributionParts;
```

`distributionFiles` lists, with SHA-256 and size and sorted by path, the files
of a staged bundle the desktop may need: `manifest.json`, `contracts.json`,
`descriptors.binpb` (Electron main's exposure index, slice S64),
`desktop/**`, `client/**`, `schemas/**`, `contracts/**/*.js`, and the modules
outside `contracts/` that those import relatively. `distributionFor` builds
one generation's distribution catalog from the host's catalog snapshot; an
embedded bundle has no files ([`distribution.ts`](src/loader/distribution.ts)).

## `bundle/platform`

The host side of the platform ([`src/platform/index.ts`](src/platform/index.ts)):

```ts
function startPlatform(options: PlatformOptions): Promise<Platform>;
interface PlatformOptions {
  // ... routerAddress, publicAddress, index, resolved, commandOf, ...
  readonly startup?: StartupSink; // sink of doric.startup/v1; also hears stage('database_client')
  readonly composition?: PlatformCompositionOptions; // { overridesPath, read, resolve }; undefined: Disable and ResetComposition answer UNIMPLEMENTED
  readonly hostPart?: (bundleId: string) => boolean; // undefined: every bundle has one
  readonly beforeListen?: (doric: DoricCaller) => Promise<void>;
  readonly beforeStop?: (
    doric: DoricCaller,
    signal: AbortSignal,
  ) => Promise<void>;
}
interface DoricCaller {
  client<S extends DescService>(service: S): Client<S>; // calls served in process as caller `doric`
}
interface Platform extends DoricCaller {
  readonly structuralFault?: string; // "structural providers unavailable: <ids>"
  readonly routerPort: number;
  readonly publicPort?: number;
  publish(next: ResolvedEnvironment): Promise<PublishResult>;
  shutdown(): Promise<void>; // never rejects
}
type HostHook = 'onHostStartHook' | 'onHostReadyHook' | 'onHostStopHook';
function runHostHook(
  doric: DoricCaller,
  hook: HostHook,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void>;
function stagedHostPart(bundlesDir: string): (bundleId: string) => boolean;
```

- The router always serves `doric.startup/v1` (`createStartupService(sink)`,
  in `router/platform-services.ts`): a request is checked against its proto
  rules first; an invalid one answers `invalid_input` and the sink hears
  nothing.
- Boot: `startPlatform` waits until every scheduled bundle is active. If a
  required bundle, or the provider of a required contract, is not active, it
  resolves with `structuralFault` set: no identity read, no `beforeListen`,
  no public listener. Otherwise it tells the sink `stage('database_client')`,
  reads the storage identity, awaits `beforeListen`, then binds the public
  listener. A rejecting `beforeListen` shuts everything down (no
  `beforeStop`) and `startPlatform` rejects with the same value.
- `shutdown` fixes one deadline (`timings.shutdownDeadlineMs`), closes the
  public listener, runs `beforeStop` until that deadline (its failure is
  ignored), then stops the instances with what is left
  (`Supervisor.shutdown(deadlineAt?)`) and closes the router.
- `runHostHook` defines `doric.app.hooks/v1` before every `Run` (core keeps the
  definition in memory only) and runs the hook as caller `doric`.
- `hostPart`: a bundle it rejects is hostless: recorded `active`, never
  spawned, never sent `Stop`. `stagedHostPart(bundlesDir)` accepts a bundle
  whose `<bundlesDir>/<id>/host/` holds `command.json`, `doric-<id>` or
  `main.mjs`.
- The gateway serves, each path once, the public methods whose contract has a
  provider, then the methods exposed to `DESKTOP`. `CatalogIndex.publicMethods()`
  lists the public methods: every method of a contract-role service of a `HOST`
  contract whose id starts with `api.`, whatever its `expose`, in file then
  declaration order, the same array on every call. So `doric.api.*` reaches its
  provider over Connect and gRPC as caller `doric`; once a publish removes the
  provider it answers `UNIMPLEMENTED`, `unknown_contract`. After those it
  serves the platform's own `DESKTOP` methods (`doric.catalog/v1`'s members,
  `doric.diagnostics/v1.Report`); the platform's other methods answer
  `UNIMPLEMENTED`, and a path it does not serve a plain 404.
- `doric.catalog/v1` is served in full: `Distribution` (with a `hostBoot`
  drawn at random per start), `ReadArtifact` (chunks of at most 1 MiB, the file
  hashed again before answering, else `not_found` with `{ sha256 }`), `Watch`
  (a first item, then one per adopted publish), and `Disable` and
  `ResetComposition` through `composition`, which log to the console. Both
  are unauthenticated on the public listener.
- A publish runs one at a time and adopts in order: the supervisor, the
  current resolution and the gateway, the diagnostics
  (`DiagnosticsStore.adopt`), the distribution, the open `Watch` calls.
- `withBasicContracts(index)` answers `index` with the 12 basic `HOST`
  contracts of `basicHostContractFiles` as a fallback (`index`'s files win
  where both hold one), since a staged `descriptors.binpb` holds only its
  bundle's own protos ([`basic-contracts.ts`](src/platform/basic-contracts.ts)).
  The generated files are imported through `bundle/contracts/gen`, as they
  import one another, so no second copy of a file loads. The host's boot uses
  it.
- Other exports: `createCatalogIndex`, `catalogIndexFromDescriptors`,
  `CatalogIndex`, `readStagedCatalogIndex`, `stagedCommandOf`,
  `defaultPublicAddress`, `PublicListenerBindingError`, `StartupSink`,
  `PublishResult`, `SpawnCommand`.

## `bundle/client`

The client SDK of the process model
([`src/sdk/client/index.ts`](src/sdk/client/index.ts), browser-safe), phase 2
of [`grpc-processes.md`](../../docs/designs/grpc-processes.md#10-the-typescript-sdk).
A window reaches it through `services.use`/`whenAvailable` of a generated
service descriptor (slice S64): the runtime answers through
`ServiceRuntime.hostClients`, which the desktop window fills with one
`createClientPart` per bundle over `window.doric.connect`; `use` answers
`unavailable` without it and `whenAvailable` never calls back; a `ref<T>()`
keeps the envelope. `ClientContext.services` stays typed `Services`, so a
client part narrows it with `as ClientServices`. The runtime, chat, papercraft,
openui, settings, git, mcp and claude-login client modules call host contracts
this way (S65a–S65c); S65d's still use the envelope.

Outside this package, `bundle/client` is imported by
[`packages/desktop/src/client/connect.ts`](../desktop/src/client/connect.ts)
(`createClientPart`, the window's `hostClients`) and by each of those eight
bundles' test support (`{ type ClientPart, reopenResumable }`) in
`bundles/runtime/runtime/tests/client/support/connect.ts`,
`bundles/desktop/{chat,settings}/tests/support/connect.ts`,
`bundles/features/{git,mcp}/tests/…/support/connect.ts` and
`bundles/features/claude-login/tests/client/support/connect.ts`; each keeps
its own copy, since `bundles/AGENTS.md` forbids cross-bundle imports outside
`<other>/contracts`. A fake `HostClients` there answers the window's calls
from a `createRouterTransport` router, and `reopenResumable` (defined in
[`src/runtime/resumable.ts`](src/runtime/resumable.ts)) reopens a resumable
stream after `generation_lost` as the real SDK does.

```ts
function createClientPart(options: ClientPartTransportOptions): ClientPart;
interface ClientPart {
  readonly bundleId: string; // sent as doric-client-part
  readonly transport: Transport; // one per client part
  use<S extends DescService>(ref: S, options?: ClientUseOptions<S>): Client<S>; // { resume?, scope? }
}
function createClientPartTransport(options: ClientPartTransportOptions): Transport;
interface ClientPartTransportOptions {
  readonly bundleId: string;
  readonly baseUrl: string; // the public listener, http://<host>:<port>
  readonly fetch?: typeof globalThis.fetch; // default globalThis.fetch
}
type ResumeRequests<S extends DescService>; // per server-streaming method: (last) => the request that reopens it
function reopenResumable<Req, Item>(…): AsyncIterable<Item>;
const resumableDelays: { firstMs: 100; maxMs: 5_000 };
const maxMessageBytes: number; // 4 MiB, from contracts/metadata.ts
function fromConnectError(e: ConnectError): ContractError;
```

`createClientPartTransport` ([`transport.ts`](src/sdk/client/transport.ts)) is
a Connect-protocol transport with binary bodies over `fetch` to the public
listener: unary and server-streaming calls. Every call carries
`doric-client-part: <bundleId>` and no `doric-caller*` header; a request whose
binary form is over `maxMessageBytes` fails with `RESOURCE_EXHAUSTED`, Doric
code `limit_exceeded`, before it is sent, and a network failure is
`UNAVAILABLE`. The Electron IPC transport to Electron main comes in a later
phase. It throws a `TypeError` for an empty `bundleId` or a `baseUrl` that is
not an absolute `http:` or `https:` URL.

`createClientPart` ([`client.ts`](src/sdk/client/client.ts)) shares one
transport across the clients its `use` answers; a resumable server-streaming
method reopens as the host SDK's `services.use` does ([`runBundle`](#runbundle)).
`ClientUseOptions.scope` is sent on every call of that client as
`doric-scope-bin`; a scope outside `callScopeSchema`'s bounds is refused with
`ContractError('invalid_scope')` when `use` is called.
`fromConnectError` reads a call's Doric code ([Errors](#errors)).

## `bundle/testing`

```ts
interface TestServicesOptions {
  readonly bundle: { readonly id: string; readonly version?: string }; // version default '0.0.0'
  readonly provide?: readonly AnyServiceDefinition[]; // provided by a fake 'test-provider'
  readonly providers?: readonly {
    readonly bundleId: string;
    readonly provide: readonly AnyServiceDefinition[];
  }[];
}
interface TestServices {
  readonly services: Services; // the bundle under test; neither requires nor provides enforced
  call(scope?: CallScope, signal?: AbortSignal): Call; // caller 'test', version 0.0.0, generation 1
  readonly reports: readonly DiagnosticReport[]; // failures the runtime reported
  dispose(): Promise<void>;
}
function createTestServices(options: TestServicesOptions): TestServices;
```

`createTestServices` runs a bundle's services in process, with no catalog and
no loader, in the `host` environment of generation 1. Every principal is
created with `provides: 'any'` and `requires: 'any'`, which skips only the
manifest declaration checks (`undeclared_provide`, `undeclared_requirement`);
`use` of a `many` contract still throws `many_contract_use`, and `provide`
of a basic contract off the platform's method table or exposure still throws
`contract_mismatch`. The catalog view is empty (`emptyCatalogView`): `provide` checks
cardinality only against a basic contract's own table and never yields to a
chosen provider. Each `providers` entry
is a fake bundle of its own, so several providers of a `many` contract reach
`whenAvailable` with their own ids, in the order given. `dispose` disposes the
bundle under test, then the providers, and aborts the generation signal
([`testing/index.ts`](src/testing/index.ts)).

```ts
import { createTestServices } from 'bundle/testing';

const harness = createTestServices({
  bundle: { id: 'greeter' },
  provide: [fakeDependency],
});

try {
  harness.services.provide(greeter);
  // exercise the services, passing harness.call() as the parent call
} finally {
  await harness.dispose();
}
```

```ts
interface MinimalHooksOptions {
  readonly hookDeadlineMs?: number;   // default 10_000
  readonly calls?: { method: string; caller: string; contract: string }[]; // records every call
}
function createMinimalHooks(options?: MinimalHooksOptions): ServiceDefinition<'hooks/v1', …>;

interface MinimalUiCore {
  readonly manifest: ManifestV1Input;
  readonly descriptor: Descriptor;
  readonly client: { readonly activate: Activate<ClientContext> };
}
const MINIMAL_CORE_TEXT = 'Minimal core';
function minimalUiCore(options?: { readonly id?: string }): MinimalUiCore; // id default 'mincore'
```

`createMinimalHooks` is a complete `hooks/v1` provider written only against
`bundle/contracts` and `doric.*` ([`minimal-hooks.ts`](src/testing/minimal-hooks.ts)):
`define` accepts a `doric.*` contract only from `doric` and any other only
from a bundle whose catalog manifest provides it (`not_owner`), and refuses a
second owner (`registration_conflict`); `execute` runs the handlers of
generation 0 (unpinned calls; the deleted kernel's partition) and of the call's generation in catalog order (`doric` first), then
registration order. A `sequence` hook awaits each handler with no deadline and
rejects on a failure (`order: 'reverse'` reverses the order); every other
kind gives each handler `hookDeadlineMs`, reports a timeout as
`hook_handler_timeout` and a failure, an invalid transform output or an
invalid decision as `hook_handler_failed` through `doric.diagnostics/v1`,
returns the last valid value for `transform`, and stops at the first refusal
for `decide`.

`minimalUiCore` is a core for window tests ([`minimal-ui-core.ts`](src/testing/minimal-ui-core.ts)):
its client part provides `hooks/v1`, `ui/v1`, `navigation/v1` and
`regions/v1` (navigation matches static paths and `:param` segments only),
and defines `<id>-outlet`, which renders `<p>Minimal core</p>`. Its `ui/v1`
refuses a tag that does not start with the caller's bundle id
(`invalid_input`).

For the process model (phase 2 of
[`grpc-processes.md`](../../docs/designs/grpc-processes.md)) the entry adds an
in-memory router and the protocol conformance suite. Both load Node modules
(`router.ts` runs the host SDK's call handling, and `runConformance` loads a
suite that imports `node:` built-ins), so `bundle/testing` runs in Node only.

```ts
function createTestRouter(options?: TestRouterOptions): TestRouter;
interface TestRouterOptions {
  readonly fakes?: readonly ServiceEntry[]; // the dependencies, served in process
  readonly requires?: readonly string[]; // declared service names; absent: no enforcement
  readonly caller?: Caller; // default { bundleId: 'test', version: '0.0.0', generation: 1 }
  readonly scope?: CallScope;
  readonly instance?: Partial<BundleInstance>; // default test-bundle/1/1
  readonly bundleDir?: string; // where context.assets reads
}
interface TestRouter {
  activate(definition: BundleDefinition): Promise<HostContext>; // as runBundle would, in process
  client<S extends DescService>(ref: S, options?: TestClientOptions): Client<S>;
  readonly control: TestRouterControl; // generationChanged, peerSignal, stop
  readonly logs: readonly TestLogRecord[];
}

function runConformance(options: ConformanceOptions): Promise<void>;
interface ConformanceOptions {
  readonly command: SpawnCommand; // the fixture's executable
  readonly env?: NodeJS.ProcessEnv;
}
```

`createTestRouter` ([`router.ts`](src/testing/router.ts)) activates a
`BundleDefinition` in the test's process and routes its calls, and the
clients' calls to it, over `createRouterTransport` of `@connectrpc/connect`,
so each message passes Connect's binary serialization. A request is validated
with protovalidate first, through the same internal `validRequest` as the host
SDK (`invalid_input`, or the answer of the definition's `invalidInput`); a call to a service that is not
declared in `requires` fails with `undeclared_requirement` (platform
contracts, whose id starts with `doric.`, are exempt, as in the real router);
a declared service
nobody serves fails with `unavailable`; a call before `activate` or after
`control.stop()` fails with `unavailable`. A cancelled streaming handler is
ended with `return()`, so its `finally` runs, as the real transport ends the
stream. It sends no `ProviderChanged` and
no `InstanceGone`. Its `use` takes `options.scope` as the host SDK's does.

`runConformance` ([`conformance/index.ts`](src/testing/conformance/index.ts))
registers the protocol conformance cases as `node:test` tests against a
fixture serving `doric.conformance.v1.ConformanceService`: the Hello, health,
activation, flow control, the error table, cancellation and deadlines, drain,
`Stop`, an unknown method and the 4 MiB limit. The target
`bundle:conformance` runs it on the TypeScript SDK's fixture.

## `bundle/externals`

```ts
const clientExternals: readonly string[];
//   react, react/*, react-dom, react-dom/*, @base-ui/react, @base-ui/react/*, lexical, @lexical/*,
//   desktop/ui, desktop/ui/*, zod, zod/*, bundle/contracts, */contracts
const frameExternals: readonly string[];
//   react, react/jsx-runtime, react/jsx-dev-runtime, react-dom, react-dom/client, @base-ui/react, @base-ui/react/*
function matchesExternal(
  external: readonly string[],
  specifier: string,
): boolean;
```

`clientExternals` are the window import-map specifiers a client part leaves
external, so one instance of each exists per window; `frameExternals` are
those of a frame's import map. A pattern with `*` matches any specifier with
its prefix and suffix ([`externals.ts`](src/build/externals.ts)).
`clientExternals` includes `@bufbuild/protobuf` and `@bufbuild/protobuf/*`,
`@connectrpc/connect` and `bundle/client`, which the window import map serves
once;
`<package>/contracts/gen/<path>` stays external through the client build's
plugin, not the list. The import
map is described in [Platform
packages](../../docs/architecture/bundles/platform-packages.md#the-import-map-of-a-window).

## `bundle/schemas/*`

The package build writes the platform's JSON Schema 2020-12 documents below
`dist/schemas/` ([`platform-schemas.ts`](src/build/platform-schemas.ts)):

| Path                           | `$id` / contents                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `bundle-manifest/v1.json`      | `doric://app/schemas/bundle-manifest/v1.json`, from `manifestV1Schema`                                              |
| `composition/v1.json`          | `doric://app/schemas/composition/v1.json`, from `compositionSchema`                                                 |
| `contracts-descriptor/v1.json` | `doric://app/schemas/contracts-descriptor/v1.json`, from `descriptorSchema`                                         |
| `contracts/<id>.json`          | The contract document of every basic and `doric.*` service, and of `doric.app.hooks/v1` and `doric.window.hooks/v1` |

```ts
function platformSchemaDocuments(): ReadonlyMap<string, JsonObject>; // by path below schemas/
function writePlatformSchemas(outDir: string): Promise<void>;
```

## Build tooling

The build CLI runs from the package's build output:

```console
node packages/bundle/dist/build/cli.js build [--development] <bundleDir>
node packages/bundle/dist/build/cli.js stage [--dev] <dest> <bundleDir...>
node packages/bundle/dist/build/cli.js stage [--dev] <dest> --all <root>
node packages/bundle/dist/build/cli.js copy-md <from> <to>
```

```ts
class BuildError extends Error {}
interface BuildOptions {
  readonly mode?: 'production' | 'development';
} // default production
interface BuildResult {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly documents: ReadonlyMap<string, JsonObject>;
}
function buildBundle(
  bundleDir: string,
  options?: BuildOptions,
): Promise<BuildResult>;
function bundleDirectories(root: string): Promise<readonly string[]>;
interface StageOptions {
  readonly dev?: boolean;
} // default false
function stageBundles(
  destination: string,
  bundleDirs: readonly string[],
  options?: StageOptions,
): Promise<void>;
function runCli(args: readonly string[]): Promise<void>;
```

Any other arguments reject with a `BuildError` carrying the usage line; run
from the command line, a failure prints its message and sets exit code 1
([`cli.ts`](src/build/cli.ts)).

**`build`** runs after `tsc` has compiled the bundle ([`cli.ts`](src/build/cli.ts)):

1. It validates `manifest.json` with `manifestV1Schema` (`Invalid manifest
"<path>": …`), removes `dist/skills`, `dist/schemas`,
   `dist/contracts.json`, `dist/descriptors.binpb` and `dist/manifest.json`,
   and copies the manifest.
2. It validates each `src/skills/<dir>/SKILL.md` with `SkillSchema`
   (`Invalid skill "<path>": …`) and copies it to `dist/skills/`.
3. It mirrors the Markdown below `src/host` into `dist/host`, as `copy-md`
   does.
4. It builds the desktop and client parts (below).
5. It imports each built part (`desktop/index.js` and `client/index.js`;
   never a frame, worker or chunk) and dry-activates it
   against recording services. A client part is imported with a DOM shim
   ([`dom-shim.ts`](src/build/dom-shim.ts)): it may touch the DOM at import
   time only through `class … extends HTMLElement`. A part that fails to load
   or exports no `activate` fails the build. The host part is never imported
   or dry-activated (slice S69): a stale `dist/host/index.js` is ignored, and
   what the host part provides comes from its static `services` list
   ([`host-provides.ts`](src/build/host-provides.ts)), recorded in
   `contracts.json` as a host-provides entry (`local: false`, no schema
   document).
6. It checks the recording against the manifest (below), then writes each
   contract's document to `dist/schemas/<id>.json`, `dist/contracts.json` and
   `dist/package.json` (`{ "type": "module" }`). A contract recorded in two
   environments with different schemas fails the build.
7. After the manifest-version-2 environment check, it deletes a stale
   `dist/host/main.mjs` and, when `src/host/main.ts` exists, bundles it with
   esbuild into `dist/host/main.mjs` ([`host.ts`](src/build/host.ts)): ESM
   for Node 26, `node:*` external, with a `createRequire` banner. A
   non-literal dynamic `import()` anywhere, `node_modules` included, fails the
   build listing each as `<path>:<line>`, and so does a `.node` addon.
8. It writes `dist/descriptors.binpb`, the binary
   `google.protobuf.FileDescriptorSet` of the bundle's own generated files
   (the `file_*` exports of each `*_pb.js` below `dist/contracts/gen`) and
   their transitive imports, imports first, each once; a bundle without
   generated contracts gets zero bytes. `dist/contracts.json` is still
   written until phase 6.

```ts
class RecordingError extends Error {}
function recordActivation(options: {
  manifest: ManifestV1;
  environment: Environment;
  activate: Activate;
}): Promise<readonly RecordedContract[]>;
function checkRecording(
  manifest: Manifest,
  recorded: readonly RecordedContract[],
  served?: readonly HostProvide[], // default []
): readonly string[];
interface HostProvide {
  readonly id: string;
  readonly kind: Exclude<DescriptorKind, 'command'>;
  readonly cardinality: DescriptorEntry['cardinality'];
  readonly source: string; // `src/host/main.ts:12` or the .proto file name
  readonly declared: string | undefined; // the version provides lists
}
function hostProvides(input: {
  manifest: Manifest;
  recorded: readonly RecordedContract[];
  services: readonly StaticServiceEntry[];
  index: CatalogIndex;
}): readonly HostProvide[];
function contractDocument(contract: RecordedContract): ContractDocument;
function schemaPath(contractId: string): string;
```

`recordActivation` records each `provide` (a `many` contract once), each
`hooks/v1.define` of a non-`doric.*` contract, and each `events/v1.register`,
`settings/v1.register`, `storage/v1.defineType` and `commands/v1.register` of
a `defineCommand` value; every other call is an inert no-op and
`whenAvailable` never fires. `use` of a contract outside `requires`,
`optional` and `provides` (and not `doric.*`) throws a `RecordingError`
([`record.ts`](src/build/record.ts)). `checkRecording` lists every problem: a
contract recorded twice in one environment, a contract not declared in
`provides`, a basic contract with another cardinality than the platform's, a
method exposed against the platform's table, a `served` contract `provides`
does not declare (in any manifest version), and a `provides` entry that
nothing recorded and no `served` contract has.

`hostProvides` ([`host-provides.ts`](src/build/host-provides.ts)) answers,
for a manifest of any version and without duplicates, the contracts the host
part provides beyond its recording: first, in `services` order, the contract
of each contract-role service of a `HOST` or `HOOKS` contract; then, in
`provides` order, each id whose `.proto` marks it `hooks`, `event`,
`settings` or `storage-type` and declares no contract-role service. It skips
ids the recording holds in `host` or `desktopMain` (so `chat.composer/v1`
stays with the desktop composer), and never throws. `buildBundle` reads the
static `services` and the build index before `checkRecording`, passes the
result as `served`, and appends to `contracts.json` a `host` entry for each
served contract `provides` lists: the declared version, kind and cardinality
from the `.proto`, `local: false` and the path `schemas/<id>.json`, for which
no schema file is written. The build's dry activation of the parts still
runs ([`cli.ts`](src/build/cli.ts)).

**Parts** ([`parts.ts`](src/build/parts.ts)). Each part with a source entry is
rebuilt into a cleared output folder with esbuild, bundled as ESM; inline
source maps in development mode, none in production.

| Part           | Platform       | External                                                      | Refused imports                                                                                                                                       |
| -------------- | -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop        | Node 22        | `bundle/contracts`, `zod`, `zod/*`, `*/contracts`, `electron` | `bundle`; `react`, `react-dom`, `@base-ui/react`, `lexical`, `@lexical/*`, `desktop` and every subpath of them (`react/jsx-runtime`, `desktop/ui`, …) |
| client, chunks | browser ES2022 | `clientExternals`                                             | `bundle`, `bundle/runtime`, `desktop`, `desktop/client`, `desktop/client/*`                                                                           |
| workers        | browser ES2022 | none                                                          | as the client                                                                                                                                         |
| frames         | browser ES2022 | `frameExternals`                                              | as the client, plus `bundle/*`, `desktop/*` and every client external that is not a frame external, except `zod` and `zod/*`                          |

- A relative import that resolves into the bundle's own `src/contracts/`
  becomes the external `<id>/contracts`, except in a frame, which bundles the
  contracts' sources it imports.
- A client part (entry and chunks) also keeps every
  `<package>/contracts/gen/<path>` external (a plugin decides, since the
  pattern needs two `*`); a relative import into its own `src/contracts/gen/`
  becomes `<id>/contracts/gen/<path>`. Desktop parts and workers bundle
  generated code; a frame refuses `@bufbuild/protobuf`.
- A bundled CommonJS module that `require`s an external gets a module that
  re-exports the external's ESM namespace, so the external stays one instance
  from the import map.
- Every browser build defines `process.env.NODE_ENV` as `"production"` and
  minifies syntax, in either mode, so libraries' development branches neither
  run nor ship in a window; fonts (`.woff2`, `.woff`, `.ttf`) are emitted as
  files under `assets/`.
- `src/client/styles.css` is compiled with Tailwind; a stylesheet that
  extends `@theme` fails the build. The CSS esbuild extracts from the client's
  imports is appended, and `client/styles.css` is written when either exists.
  A chunk's extracted CSS stays beside it as `client/chunks/<name>.css`.
- A failure is reported as `Building the <part> part failed:` with each
  esbuild error and its location.

**`stage`** replaces `<dest>/<id>` with each bundle's `dist`, leaving out
`*.tsbuildinfo` files; it fails naming the bundle directory when
`dist/manifest.json` is missing, and reads the manifest by its
`manifestVersion` (`parseManifest`), so version 2 manifests stage. With `--all <root>` it stages every
`<root>/<group>/<id>` that holds a `manifest.json`, in code-unit path order
(`bundleDirectories`). It replaces only the directories of the bundles it
stages: any other directory below `<dest>` stays
([`cli.ts`](src/build/cli.ts)). `doric-host` stages every bundle into
`app/backend/doric-host/dist/bundles`. With `--dev`, each bundle with a built
`dist/host/main.mjs` also gets `<dest>/<id>/host/command.json`, `["node",
"<abs bundleDir>/dist/host/main.mjs"]`.

**`copy-md`** removes every `.md` below `<to>`, then copies each `.md` below
`<from>` to the same relative path; other files are kept, a missing `<from>`
copies nothing. A bundle's `test` target runs it after `tsc` so the compiled
tests find the templates ([`cli.ts`](src/build/cli.ts)).

Each bundle's Nx `build` target runs `tsc --build` of its `tsconfig.json`,
then `build`; how a bundle's project is set up is described in [The bundle
manifest](../../docs/architecture/bundles/manifest.md) and
[Boundaries](../../docs/architecture/bundles/boundaries.md).

## Build and test this package

| Target                  | Runs                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle:generate-proto` | `buf generate` of `proto/doric` and of `dist/proto`'s `buf/validate` and `google/rpc` into `src/contracts/gen/`, after `@org/source:proto-export`; cached                                                                                                            |
| `bundle:build`          | After `generate-proto`: `tsc --build packages/bundle/tsconfig.lib.json` into `dist/`, then `node packages/bundle/dist/build/platform-schemas.js`, which writes `dist/schemas/`                                                                                       |
| `bundle:typecheck`      | After `generate-proto` and `build`: `tsc --build packages/bundle/tsconfig.json --emitDeclarationOnly`, then `tsc -p packages/bundle/tsconfig.browser.json` (the browser-safe entries)                                                                                |
| `bundle:test`           | After `build` and `^build`: `tsc -p tsconfig.browser.json` (type check only, `noEmit`), `tsc -p tsconfig.spec.json` (writes `dist-tests/`), then `node --test 'packages/bundle/dist-tests/tests/*.test.js' 'packages/bundle/dist-tests/tests/platform/**/*.test.js'` |
| `bundle:conformance`    | After `build` and `^build`: `tsc -p tsconfig.spec.json`, then `node --test 'packages/bundle/dist-tests/tests/conformance/*.test.js'`, the protocol conformance suite on the TypeScript SDK's fixture                                                                 |
| `bundle:bench-rk4`      | After `build` and `^build`, not cached: `tsc -p tsconfig.spec.json`, then `node packages/bundle/dist-tests/tests/bench/rk4.js`, RK4's benchmark; it exits 1 when RK4's rule fails, unless `RK4_NO_FAIL=1`                                                            |

```console
npx nx run bundle:build
npx nx run bundle:typecheck
npx nx run bundle:test
npx nx run bundle:conformance
RK4_NO_FAIL=1 npx nx run bundle:bench-rk4
```

The targets are declared in [`project.json`](project.json); the tests are in
[`tests/`](tests), with fixtures under `tests/support/` and `tests/fixtures/`;
the platform tests are under `tests/platform/`.

## Related documents

- [Contracts and the `define*` family](../../docs/architecture/bundles/contracts.md)
- [The bundle manifest](../../docs/architecture/bundles/manifest.md)
- [Contexts and capabilities](../../docs/architecture/bundles/contexts.md)
- [Hooks](../../docs/architecture/bundles/hooks.md)
- [The core bundle and quarantine](../../docs/architecture/bundles/core.md)
- [Composition and distribution](../../docs/architecture/bundles/composition-and-distribution.md)
- [Process isolation](../../docs/architecture/bundles/process-isolation.md)
- [Observability](../../docs/architecture/bundles/observability.md)
- [Platform packages](../../docs/architecture/bundles/platform-packages.md)
- [Boundaries](../../docs/architecture/bundles/boundaries.md)
- [core README](../../bundles/foundation/core/README.md): the basic contracts' methods, data and errors
- Feature docs: [Skills](../../docs/features/skills.md), [Credentials](../../docs/features/credentials.md), [Models and providers](../../docs/features/models-and-providers.md), [Error messages](../../docs/features/error-messages.md)
