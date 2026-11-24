# Feature: bundle processes

- Status: `accepted` (phases 0–2 built; phase 3 in progress; phases 4–8 to come)

## Problem

Today the host runs every bundle's host part in one generation process, a
child it forks and talks to with `v8.serialize` messages. A bundle that blocks
the event loop, leaks memory or crashes takes every other bundle with it, a
bundle can only be written in TypeScript, and the contracts between bundles are
TypeScript types that carry functions and live objects, so nothing but the
same process can serve them.

The bundle process model of
[`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) gives each
bundle its own process, supervised by the host, and makes every call between
bundles a gRPC call through the host's router on `127.0.0.1`, with contracts
written in `.proto`.

## Decisions

- **One process per bundle.** The host runs the platform (catalog, supervisor,
  router, gateway, public listener) and supervises one process per bundle;
  bundles talk to each other only through the router (`AGENTS.md`, "Product
  Direction" and HC-003, approved by the owner on 2026-11-21).
- **One executable per bundle.** A TypeScript host part ships as a single
  executable application (SEA) built with esbuild and `node --build-sea` on
  Node 26; the `sqlite` bundle ships a native Rust executable at the same
  staged path.
- **Contracts in `.proto`.** One root `buf.yaml` (format `v2`, `STANDARD` lint
  with no exception, `FILE` breaking rules) lists every `proto` directory;
  TypeScript is generated with `protoc-gen-es` into each owner's
  `src/contracts/gen/`, and contract methods take and answer plain data
  (`docs/designs/grpc-processes/contract-inventory.md`, section A).
- **Rust.** A root Cargo workspace with the toolchain `rust-toolchain.toml`
  pins (1.100.0), built, linted and tested through Nx with `@monodon/rust`.
- **Generated code on the contract surface (coordinator decision, spec v6.4).**
  `<other>/contracts/gen/*` is part of a package's contract surface, like
  `<other>/contracts`, and the `imports` check allows it.
- **`buf breaking` skipped while the base has no `.proto` (coordinator
  decision, spec v6.4).** CI skips `buf breaking` when the pull request base has
  no `buf.yaml` or `.proto` files.

## Phase 0: measurements

Phase 0 builds the groundwork and measures what the design rests on. The
numbers below are from one arm64 Linux machine (Node v26.13.1, `aarch64`). The
x64 numbers come from the CI job `sea-spike` (matrix `ubuntu-latest`,
`ubuntu-24.04-arm`), which uploads `dist/sea-spike/results-<arch>.json`; they
are not recorded here yet.

### The SEA spike (AC0.3, T0.1)

`npx nx run bundle:build`, then `node scripts/sea-spike.mjs`, bundles each host part with esbuild (the options
of the spec's implementation notes, plus a `require` banner for the CommonJS
dependencies esbuild inlines), builds the SEA, starts it against a stub router
that serves `doric.platform.v1.BundleHostService/Connect`, and records the time
from spawn to the router's receipt of the `Hello`. Each SEA loads its bundle's
whole host module graph; `papercraft` then extracts `esbuild` with its
platform binary and `tailwindcss` with its oxide addon from its SEA assets,
loads them with `require`, and runs one esbuild build and one Tailwind compile.
RSS is `VmRSS` after the activation and one idle minute.

| Executable                                        | Spawn to Hello |      Size |  Idle RSS | Activation                                                            |
| ------------------------------------------------- | -------------: | --------: | --------: | --------------------------------------------------------------------- |
| `sqlite-node` (stand-in: `node:sqlite` in memory) |         134 ms | 144.0 MiB |  63.4 MiB | one key written and read                                              |
| `papercraft`                                      |         185 ms | 167.6 MiB | 141.1 MiB | esbuild build (157 B) and Tailwind compile (4,726 B, `.flex` present) |
| `runtime`                                         |         139 ms | 144.8 MiB |  98.0 MiB | host module loaded                                                    |
| `mcp`                                             |         130 ms | 145.1 MiB | 112.8 MiB | host module loaded                                                    |
| `docker`                                          |         112 ms | 144.8 MiB | 100.5 MiB | host module loaded                                                    |
| `sqlite` (native stub, `doric-spike-stub`)        |           4 ms |   1.6 MiB |   3.1 MiB | Hello only                                                            |

Findings for phase 3:

- `papercraft` reads `./skills/papercraft.md` relative to `import.meta.url`
  when its host module loads (`bundles/features/papercraft/src/host/index.ts`).
  Bundled, the read resolves against the executable's directory; the spike
  copies the file there, phase 3 moves it to `context.assets.read`.
- None of the five module graphs reaches a dynamic `import()` whose argument is
  not a string literal.
- The SEAs do not run their bundle's `activate`, which needs the platform's
  services; their RSS is that of the loaded code plus the SDK's control stream,
  a lower bound of an active bundle.

### Today's host

Today's host (`app/backend/doric-host/dist/src/index.js`) with the shipped
composition, PostgreSQL 18.4, idle one minute after `Doric listening` (1.6 s
after start): 368.5 MiB over two processes, the host (210.1 MiB) and the
generation process (158.4 MiB).

### RK1

| Measure           |     Value |
| ----------------- | --------: |
| Mean SEA RSS      | 103.2 MiB |
| Mean SEA RSS × 26 | 2,682 MiB |
| Ceiling: 2.75 GiB | 2,816 MiB |

The projected 26 processes take 2,682 MiB idle, 7.3 times today's two. The
owner set RK1's ceiling at 2.75 GiB idle, measured as mean SEA RSS × 26 (spec
A55), replacing the earlier bounds of 2 GiB and 3 × today's; the measurement
passes it.

### The codec benchmark (AC0.4)

`npx nx run proto-codec:bench` (`benchmarks/proto-codec`) runs each case with
`node:perf_hooks` on drafts of the three messages
(`benchmarks/proto-codec/proto/doric/benchmarks/proto_codec/v1/`) and writes
`dist/proto-codec/results-<arch>.json`. Sizes (binary / protobuf JSON / v8):
Thread snapshot (500 events) 220,157 / 246,605 / 236,746 B; storage commit
(100 events) 60,814 / 83,096 / 47,274 B; tool payload (64 KiB JSON) 74,368 /
65,753 / 63,523 B. The run of 2026-11-22 on arm64 (Node v26.13.1):

| Case                         | Operation                          |     ops/s |      p50 |      p99 |
| ---------------------------- | ---------------------------------- | --------: | -------: | -------: |
| Thread snapshot (ratio 2.14) | protobuf-es toBinary               |     1,456 | 0.637 ms | 1.636 ms |
| Thread snapshot (ratio 2.14) | protobuf-es fromBinary             |       964 | 0.723 ms | 3.444 ms |
| Thread snapshot (ratio 2.14) | protobuf-es toJson (string)        |     3,452 | 0.278 ms | 0.518 ms |
| Thread snapshot (ratio 2.14) | protobuf-es fromJson (string)      |       760 | 1.172 ms | 2.702 ms |
| Thread snapshot (ratio 2.14) | v8.serialize                       |     6,880 | 0.124 ms | 0.458 ms |
| Thread snapshot (ratio 2.14) | v8.deserialize                     |     3,572 | 0.223 ms | 1.001 ms |
| Thread snapshot (ratio 2.14) | protovalidate validate             |   576,699 | 0.001 ms | 0.006 ms |
| Thread snapshot (ratio 2.14) | zod parse                          |    23,600 | 0.041 ms | 0.080 ms |
| Thread snapshot (ratio 2.14) | decode: fromBinary + protovalidate |     1,096 | 0.716 ms | 2.723 ms |
| Thread snapshot (ratio 2.14) | decode: v8.deserialize + zod       |     2,347 | 0.301 ms | 1.909 ms |
| Storage commit (ratio 1.31)  | protobuf-es toBinary               |     4,463 | 0.199 ms | 0.600 ms |
| Storage commit (ratio 1.31)  | protobuf-es fromBinary             |    21,936 | 0.029 ms | 0.143 ms |
| Storage commit (ratio 1.31)  | protobuf-es toJson (string)        |    15,108 | 0.064 ms | 0.143 ms |
| Storage commit (ratio 1.31)  | protobuf-es fromJson (string)      |     2,955 | 0.241 ms | 1.428 ms |
| Storage commit (ratio 1.31)  | v8.serialize                       |    16,731 | 0.042 ms | 0.400 ms |
| Storage commit (ratio 1.31)  | v8.deserialize                     |    19,553 | 0.044 ms | 0.551 ms |
| Storage commit (ratio 1.31)  | protovalidate validate             |    27,150 | 0.033 ms | 0.126 ms |
| Storage commit (ratio 1.31)  | zod parse                          |   341,550 | 0.002 ms | 0.011 ms |
| Storage commit (ratio 1.31)  | decode: fromBinary + protovalidate |    13,815 | 0.058 ms | 0.457 ms |
| Storage commit (ratio 1.31)  | decode: v8.deserialize + zod       |    18,164 | 0.047 ms | 0.552 ms |
| Tool payload (ratio 4.41)    | protobuf-es toBinary               |     2,639 | 0.297 ms | 1.509 ms |
| Tool payload (ratio 4.41)    | protobuf-es fromBinary             |     2,136 | 0.315 ms | 2.286 ms |
| Tool payload (ratio 4.41)    | protobuf-es toJson (string)        |    11,378 | 0.084 ms | 0.234 ms |
| Tool payload (ratio 4.41)    | protobuf-es fromJson (string)      |     2,753 | 0.288 ms | 1.629 ms |
| Tool payload (ratio 4.41)    | v8.serialize                       |    17,100 | 0.047 ms | 0.127 ms |
| Tool payload (ratio 4.41)    | v8.deserialize                     |    12,709 | 0.065 ms | 0.777 ms |
| Tool payload (ratio 4.41)    | protovalidate validate             | 1,303,259 | 0.001 ms | 0.001 ms |
| Tool payload (ratio 4.41)    | zod parse                          | 1,863,994 | 0.000 ms | 0.001 ms |
| Tool payload (ratio 4.41)    | decode: fromBinary + protovalidate |     2,637 | 0.275 ms | 1.785 ms |
| Tool payload (ratio 4.41)    | decode: v8.deserialize + zod       |    11,620 | 0.066 ms | 0.867 ms |

The ratio is the mean of `fromBinary` + protovalidate over the mean of
`v8.deserialize` + zod. Section 8's rule (spec v6.4, A56, raised from three) is
that the median of three runs on an idle machine of the Thread snapshot's decode
is at most four times slower. The recorded Thread snapshot ratios: four earlier
runs, 3.03, 3.07, 3.00 and 3.51; four isolated runs, 2.14 (the table above),
2.84, 2.88 and 3.11; and 4.63 under concurrent load, which the rule excludes.
The median of the three latest isolated runs is 2.88, which passes. Most of the cost is `fromBinary` of the events'
`google.protobuf.Value` payloads; protovalidate itself is cheaper than zod. The
tool payload's ratio was 4.41 this run and the storage commit's 1.31; no rule
bounds those two.

The gates, RK1's ceiling and the codec rule, are met on arm64 only. The x64
numbers come from the CI job `sea-spike` and are not recorded yet.

## Current behavior and contracts

Phase 0 changes three runtime behaviors:

- A call's deadline timer that fires early re-arms for the remaining time
  instead of aborting: `abortAtDeadline` (`packages/bundle/src/runtime/call.ts`)
  aborts with a `TimeoutError` only once the clock has reached the deadline. It
  serves `deadlineSignal` and `restoreCall`
  (`packages/bundle/src/runtime/envelope/call-meta.ts`).
- The DOM shim (`packages/bundle/src/build/dom-shim.ts`) counts a global whose
  value is `undefined` as missing and installs it, such as Node 26's
  `localStorage` without `--localstorage-file`.
- The host image runs Node 26.

It adds:

- `buf.yaml`, `buf.lock` and `buf.gen.yaml`, and
  `packages/bundle/proto/doric/platform/v1/{options,control}.proto`; the root
  target `proto-export` (`npx nx run @org/source:proto-export`) writes
  `dist/proto`.
- The Rust workspace (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`) with
  one member, the spike stub `scripts/sea-spike/stub-rs`, tagged `type:rust`.
- `scripts/sea-spike.mjs` and `scripts/sea-spike/`, the CI job `sea-spike` and
  the stub crate, deleted in phase 7; `benchmarks/proto-codec`, deleted in
  phase 8.
- `tests/contract-inventory.test.mjs`, run by `npm run lint:test`: every
  contract method that is not plain data has a row in section A of the
  inventory, and every row names one. A member typed `any` fails unless
  `tests/contract-inventory-allow.json` (`[{contract, method, reason}]`) lists
  it. Phase 3 deletes the check.
- Node 26 in CI and in the image (`app/backend/doric-host/.Dockerfile`).

Phase 1 adds:

- Generated code across packages: `generate-proto` in `bundle` and in every
  bundle with `.proto` contracts (cached by Nx) writes protobuf-es code into `src/contracts/gen/` (ignored by
  Git), exported as `./contracts/gen/*`; `buf.gen.yaml`'s `map_imports` make a
  generated file import another owner's through that export, and `buf/validate`
  and `google/rpc` are generated in `bundle` only.
- Hand-written code may import another bundle's generated code as
  `<other>/contracts/gen/*`. Through phase 2 a client or desktopMain part could
  not: its build externalized only `bundle/contracts` and `*/contracts`. Phase 3
  (S35) lifts this restriction (`packages/bundle/src/build/parts.ts`).
- Through phase 6 the zod `define*` contracts stay the runtime truth and the
  `.proto` files describe the target shape; no runtime code uses the generated
  code yet. A change to a zod contract on this branch also updates its `.proto`
  and its inventory row; `inventory-targets.test.ts` checks only ids and rows,
  not that the two shapes agree.
- Every contract as a `.proto`, except the nine ids the inventory's section C
  removes that never cross gRPC (A59, `REMOVED_WITHOUT_PROTO`):
  `chat.hooks/v2`, `workspace.hooks/v1`, `core.hooks/v1`, `core.commands/v1`,
  `notifications.observations/v1`, `papercraft.cache/v1`,
  `doric.window.hooks/v1`, `doric.network/v1` and `doric.elements/v1`.
  `storage/v1`, `storage.backend/v1`, `secrets.backend/v1` and
  `core.event-hooks/v1` take the temporary shape of the spec's "Storage until
  phase 4". The platform's in `packages/bundle/proto/doric/`,
  each bundle's in its `proto/doric/`, including
  `bundles/features/files/proto/doric/files/v1/files.proto` (`FilesService`)
  and the eight public `api.<resource>/v1` in
  `bundles/foundation/transport/proto/doric/api/*/v1/` (A60).
- `packages/bundle/tests/inventory-targets.test.ts`: every contract id that
  crosses gRPC has one `.proto` in its package, every row of the inventory's
  sections A and B names an RPC of the image, no generated file imports a
  relative path outside its `gen/`, and every `buf.validate` rule compiles
  with `@bufbuild/protovalidate` (AC1.1, AC1.4, T1.2, T1.4, T1.5). It runs
  `node_modules/.bin/buf` from the repository root and reads
  `docs/designs/grpc-processes/contract-inventory.md`.
- `packages/bundle/tests/proto-rules.test.ts` with the fixtures under
  `packages/bundle/tests/fixtures/buf-lint` (T1.1), and
  `bundles/features/files/tests/generated-imports.test.ts` and
  `bundles/features/git/tests/generated-imports.test.ts` (T1.3).
- The proto check (`packages/bundle/src/build/proto-rules.ts`, A54), run by the
  root target `proto-check` over one `FileDescriptorSet` of every contract.
- Phase 1 decisions: a platform id `doric.<name>/v<major>` maps to the package
  `doric.platform.<name>.v<major>` (A51); the platform contracts' `.proto`
  files state no environment (A52); a `.proto` lives in the project that
  declares its contract, so `files.decorations/v1` is in `files` though `git`
  provides it (A57); a lease outcome is `{ string status; optional <T> value }`
  in the answering contract's package (A58); the nine ids above get no `.proto`
  (A59); the public API is eight contracts `api.<resource>/v1` that
  `transport` provides only from phase 3 (A60). The `dependencies` check counts
  `@bufbuild/protobuf` as used by a package that exports `./contracts/gen/*`,
  whose ignored generated code imports it (spec v6.6).
- CI: `proto-check` after `buf lint`, and `buf breaking` against the pull
  request base, skipped when the base has no `buf.yaml` or `.proto` files; the
  `sea-spike` job builds `bundle` first.

### Phase 2: the process model

Phase 2 of the spec (slices S12–S28) builds the process model in
`packages/bundle`. No shipped bundle runs on it yet: the host still runs
today's kernel and generation process, and the platform below runs in the
platform tests, the conformance suite and RK4's benchmark, with fixture
bundles. Its code is built and it is finished: RK4's numbers fail its rule, and the owner accepted them (AC2.2, A68; see [RK4](#rk4-provisional)).

Contracts, manifests and the build (slices S12–S17):

- **Manifest version 2** (`src/runtime/manifest.ts`, `manifestV2Schema`):
  `requires` and `optional` move under `host` and `client`; `host` also holds
  `httpPrefix` (one segment between slashes, `^/[a-z][a-z0-9-]*/$`). A version
  1 manifest gains an optional strict `host: { httpPrefix? }` (G7).
  `parseManifest`, `catalogManifestSchema` and `platform-providers.ts` accept
  version 2, and the build writes `bundle-manifest/v2.json`.
- **The environment check (A62, A63).** `bundle/build` fails with the code
  `contract_environment` when a part provides a contract of the other
  environment or a host part registers a handler service of a `CLIENT`
  contract, and with `services_not_static` when it cannot read a host part's
  `services` list without running it (`src/build/cli.ts`, `BuildError.code`).
  In phases 2 to 4 it runs on version 2 manifests only, so today's parts stay
  as they are; a client part's handler services are checked from phase 6.
- **Quarantine codes** (`src/contracts/platform.ts`): `invalid_bundle`,
  `health_timeout`, `process_failed`, `duplicate_http_prefix` and
  `unreachable_dependency` join `quarantineCodes`
  ([The core bundle and quarantine](../architecture/bundles/core.md#quarantine)).
  The catalog quarantines a version 2 bundle whose `host.requires` or
  `host.optional` names a contract only client parts provide
  (`unreachable_dependency`), and the second bundle with the same `httpPrefix`
  (`duplicate_http_prefix`).
- **Error codes** (`src/contracts/error.ts`): `unknown_contract`,
  `unknown_provider`, `invalid_instance_token`, `instance_revoked`,
  `not_connected` and `control_stream_open` join `contractErrorCodes`.
  `src/contracts/status.ts` converts between `ContractError`,
  `google.rpc.Status` and `ConnectError`, the Doric code travelling as a
  `google.rpc.ErrorInfo` reason in the domain `doric`; a status without one
  becomes `internal`. `proto-export` also exports
  `google/rpc/error_details.proto`, at the googleapis commit `buf.lock` pins,
  so `ErrorInfo` is generated (G4, T2.20). `bundle/contracts` stays
  browser-safe and may import `@connectrpc/connect`, `@bufbuild/protobuf` and
  `@bufbuild/protobuf/wkt` at run time.
- **`RegistrationTable` (A66)**, exported from `bundle`
  (`src/sdk/host/registrations.ts`): D4's key rule for registrations. The same
  instance and key replace the value and keep the `registrationId`; another
  instance of the same bundle adds one, and the newest instance's serves; a key
  whose newest registration belongs to another bundle throws the table's
  `conflictCode` (`duplicate_tool`, `duplicate_skill` or
  `registration_conflict`).

The platform, the SDK and CI (slices S18–S28):

- **Router** (`src/platform/router/`): routes gRPC calls between bundle
  processes by instance token; the gateway calls it in process through
  `Router.serveGateway` as caller `doric/0/0`. `RouteRequest.declaredBy` names
  the declaring part. In phase 2 the host serves in process only
  `doric.generation/v1` and `doric.log/v1` (A65,
  `src/platform/router/platform-services.ts`); its other platform contracts
  join in phase 3.
- **Supervisor** (`src/platform/supervisor/`): spawns `commandOf(bundleId)`'s
  command (A64), one process per bundle, and tracks per-bundle generations. A
  lost generation's `generation_lost` report is written after the process
  exits.
- **Generations, drain and publish** (`src/platform/supervisor/publish.ts`):
  publish adopts the new routes globally before it replaces processes; a
  failed generation N+1 leaves N active; a bundle quarantined at runtime is
  restarted by publish with the next generation number; `changedBundles` also
  lists running bundles that are unscheduled or removed
  (`PublishTarget.runningBundles`); a core change answers
  `kernel_restart_required`. A resumable stream cut at draining ends with
  `CallCancel` reason `drained`; `PeerSignalEvent.live` before any frame means
  the peer is itself active.
- **Replay** (`src/platform/router/replay.ts`, `src/sdk/host/replay.ts`):
  `ReplayDone` carries no status; a replay fails when its replay call ends
  non-OK. Every replay call carries `doric-target` naming the new provider
  instance from `ProviderChanged`; during the hold the router
  (`src/platform/router/reach.ts`) lets a pending consumer's call through only
  when its `doric-target` equals the held provider, and every other call waits
  for the release. Resumable streams reopen
  through `src/runtime/resumable.ts`.
- **Gateway** (`src/platform/gateway/`): a request under an `httpPrefix`
  answers 503 when the bundle has no active instance or no `httpPort`, and 502
  when the connection to it fails (`prefix.ts`); a method the gateway does not
  serve answers `UNIMPLEMENTED`, `unknown_contract`, and any other path 404
  (`handler.ts`). A
  `doric-client-part` naming a bundle that is not scheduled answers
  `undeclared_requirement`. A failed bind of the public listener fails the boot
  at the stage `public_binding`. The catalog index is fixed for the platform's
  life (phase 3 revisits it): a publish changes the served methods only among
  those the index holds.
- **SDK:** `bundle` exports `runBundle` (`src/sdk/host/`) with its static
  `services` (A61), where `services.use` reopens resumable streams with
  `UseOptions.resume`, and `BundleDefinition.httpServer`; an `httpPort`
  without an `httpPrefix` is ignored. `bundle/client` (`src/sdk/client/`)
  gives one transport per client part over `fetch` (Electron IPC later) with
  the `doric-client-part` interceptor; `maxMessageBytes` lives in
  `contracts/metadata.ts`. `bundle/testing` gains the router harness
  `src/testing/router.ts` and the conformance suite `runConformance`, and so
  runs in Node only.
- **Connect patch:** `patches/@connectrpc+connect+2.3.0.patch`, applied by a
  `patch-package` `postinstall`, fixes a leak RK4 measured. 2.3.0 is the latest published release (`npm view`); the patch is removed on the bump to a release that contains connect-es #1873. `app/backend/doric-host/.Dockerfile` copies `patches/` and runs `npx patch-package --error-on-fail` too (approved by the owner, A69).
- **CI:** the job `conformance` runs `bundle:conformance` on x64 and arm64;
  on x64 it also runs RK4 (`bundle:bench-rk4`, `tests/bench/rk4.ts`, which
  hosts its own fixtures) report-only (`RK4_NO_FAIL=1`).

#### RK4 (provisional)

Sandbox numbers: arm64, a shared 4-CPU sandbox, medians of 3 runs after the
Connect leak patch. The runs used Node 22.23.4, while the repository, CI and
the image use Node 26. They are provisional.

| Measurement                                  | Result                                                                          | Before the patch                            |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| (a) unary latency                            | one hop p50 0.534 ms\*, p99 2.258 ms; two hops p99 4.651 ms                     | one hop p99 3.056 ms; two hops p99 7.135 ms |
| (b) `hooks/v1.Run`, five handlers            | p50 3.235 ms, p99 12.447 ms (stand-in provider; the host has no `hooks/v1` yet) | —                                           |
| (c) 1,000-item stream, two hops              | p50 44.7 ms, p99 92.2 ms                                                        | —                                           |
| (d) throughput, 64 callers                   | one hop 5,608 calls/s, p99 29.186 ms\*; two hops 2,605 calls/s, p99 98.074 ms\* | one hop 2,856 calls/s                       |
| (e) 100 KiB Connect JSON through the gateway | p50 2.184 ms, p99 10.134 ms (about 0.81 ms of transcoding)                      | —                                           |

\* Not recorded in the three runs; from one later run on the same sandbox and
Node 22.23.4 (2026-11-22), whose other numbers were: (a) one hop p99 2.538 ms,
two hops p50 1.254 ms and p99 5.671 ms; (d) one hop 5,463 calls/s, two hops
2,715 calls/s.

Verdict on these numbers: RK4's rule fails. (a) exceeds both p99 limits,
2.258 ms against 2 ms for one hop and 4.651 ms against 4 ms for two; (d)
passes, 5,608 calls per second against 5,000. Under the rule the owner decides: on 2026-11-22 the owner accepted these numbers and let phase 3 start (A68); latency is optimized later, by moving bundles to Rust, and the CI step stays report-only. AC2.2 is met by this decision, and phase 2 is finished.

### Phase 3

Phase 3 is built in slices S29–S71. S29 adds the host build and `stage
--dev`: `bundle build` bundles `src/host/main.ts` into `dist/host/main.mjs`
(ESM, Node 26, `node:*` external), failing on a non-literal dynamic `import()`
or a `.node` addon, and `stage --dev` writes each bundle's
`host/command.json` to run it with `node`
([`packages/bundle/README.md`](../../packages/bundle/README.md), "Build
tooling").

S30 has `bundle build` write `dist/descriptors.binpb` (the
`FileDescriptorSet` of the bundle's generated contracts and their transitive
imports; zero bytes without them), lets `stage` read version 2 manifests, and
adds the `bundle/platform` entry: `startPlatform`,
`catalogIndexFromDescriptors`, `createCatalogIndex`, `stagedCommandOf` (the
argv of `<dir>/<id>/host/command.json`, else `<dir>/<id>/host/doric-<id>`;
re-read per spawn; a malformed file quarantines the bundle as
`invalid_bundle`) and `readStagedCatalogIndex` (a missing `descriptors.binpb`
is an error).

S31 has `startPlatform` serve, in process and beside `doric.generation/v1`
and `doric.log/v1`, `doric.catalog/v1` (`Get` only: the present resolution's
snapshot, bundle states and reasons from the diagnostics by id, quarantined
providers left out, and the storage identity; `Watch`, `Distribution`,
`ReadArtifact`, `Disable` and `ResetComposition` answer `UNIMPLEMENTED`
`unknown_contract` until later slices), `doric.diagnostics/v1` (`Get`,
`Report`) and `doric.bundle/v1` (`Describe`: the caller as the router stamped
it, environment `host`). After boot, when an active bundle provides
`storage.backend/v1`, `startPlatform` reads its `Identity` once as caller
`doric`; a failing `Identity` rejects `startPlatform`, and a publish does not
read it again. The `DiagnosticsStore` is still not reloaded on publish, so a
bundle a publish adds shows inactive in `catalog.Get` (revisited at S62); the
gateway does not yet expose these methods to the desktop (S63–S66).

S32 adds `host.assets` to manifests v1 and v2: globs relative to the bundle
directory (refused: empty, absolute, a `.`, `..` or empty segment, a `\`),
answered by `hostAssetsOf`. The host SDK's `context.assets` reads them:
`read(path)` answers a listed file's bytes, refuses an unlisted or non-normal
path ("not listed", also in development) and rejects a listed missing file
("missing"); `extract(prefix?)` answers the bundle directory in development;
`require(specifier)` loads a package with native code through `createRequire`
from the bundle directory. `runBundle` takes the bundle directory two above
`process.argv[1]`; `StartBundleOptions.bundleDir` and
`TestRouterOptions.bundleDir` set it. Phase 3 copies no asset into `dist/`;
the SEA mode comes in phase 7.

S33 deletes the manifest without `manifestVersion` (v0): `parseManifest`
refuses it with "a manifest without manifestVersion is not supported by Doric
2; write manifest version 2", and discovery and activation quarantine such a
bundle with `invalid_manifest` and that message (A44, AC3.12). `convertV0`,
`manifestV0Schema`, `ManifestV0`, `LegacyResource`, `v0BundleId`,
`ReadManifest.legacy` and `registerInstalledTools` are removed.

S34 adds `AgentOptions.maxRecordOutputChars` to `packages/agent`: it caps the
output a stored tool record keeps, with `capOutput`'s marker (unset: the whole
output); `maxToolResultChars` still caps what the model sees.

S35 loads generated code in the window (T3.14, AC3.15). A client part (entry
and chunks) keeps `@bufbuild/protobuf`, `@bufbuild/protobuf/*` and every
`<package>/contracts/gen/<path>` external; a relative import into the bundle's
own generated code becomes `<id>/contracts/gen/<path>`. Desktop parts and
workers bundle generated code; a frame refuses `@bufbuild/protobuf`. The window
import map adds `<id>/contracts/gen/` for each bundle with generated code,
including bundles without `contracts/index.js` (such as `transport`).
`doric-platform` serves `@bufbuild/protobuf` by its npm version and
`bundle/contracts/gen/<path>_pb.js`, built with `contracts.js` so each generated
module loads once; its build fails when `packages/bundle`'s generated files are
missing.

S36 adds the entry `storage/rpc` to `packages/storage` (T3.9, AC3.11):
`serveStorageBackend`/`storageBackendClient` for `storage.backend/v1` and
`serveSecretsBackend`/`secretsBackendClient` for `secrets.backend/v1`, with values
as JSON chunks of at most 1 MiB after their item. Backend errors cross with code
and details; the client refuses values JSON cannot hold with `invalid_input`; a
malformed answer stream is `invalid_output`; transport cancel, deadline and
unavailability map to `cancelled`, `deadline_exceeded` and `unavailable`. The
conformance kit passes over the router with the memory backend. Phase 4 deletes
the entry with `storage.backend/v1`.

S37 adds `serveStorage(facade, { validators, instances? })` and
`storageClient(client, { registrations? })` to `storage/rpc` for `storage/v1`.
`DefineType` carries the type's JSON Schema as a `Struct` and answers a fresh
`registrationId`; `Undefine` (only from the defining bundle; unknown or other ids
are no-ops) or `InstanceGone` of the defining instance disposes it. The client's
`defineType` returns a `Disposable` at once, orders later calls after pending
`DefineType`/`Undefine`, replays definitions to a new core instance when
`registrations` are given, and `settled()` reports refusals. Values cross in
1 MiB chunks; the facade receives the caller's full call. Phase 4 deletes it with
`storage/v1`.

S38 adds the Node-only entry `bundle/host` (`runBundle`, `HostContext`,
`stampedCallerOf`): importing `bundle`'s root pulls the build tooling, which
S29's host build refuses, so host parts and `storage/rpc` import from
`bundle/host` instead (the root keeps its exports). `postgres` gains
`src/host/main.ts`, a host part serving `storage.backend/v1` and
`secrets.backend/v1` through `storage/rpc`, bundled into `dist/host/main.mjs`;
it validates arguments before the database, reads `DORIC_DATABASE_URL` at the
first call needing it, never fails activation and records no startup stage.
Its manifest is unchanged until S62.

S39a adds `createCoreServices({ types, validators, now? })`
(`bundles/foundation/core/src/host/services.ts`), answering
`{ services, activate(context) }`: `storage/v1` and `settings/v1` served over
the router beside the kernel entry (secrets and events follow in S39b, core's
`main.ts` in S41). Calls before `activate` fail `unavailable`. Storage keeps
ownership by namespace and provides, partitions views by the router-stamped
caller generation, releases types on `InstanceGone` (data kept), and core calls
its own facade as its own instance. Settings values are protobuf messages
(`Any`) validated with protovalidate; stored JSON includes default-valued
fields and reads ignore fields the message lacks, so 1.x rows stay readable. A
never-written space answers the message's empty value, or `settings_missing`
when the empty message is invalid. Decision: this differs from today's zod
defaults, so each registrant applies its own defaults on a never-written space
(revision 0) when it is ported. `bundle/host` also exports `ajvValidators`, and
`StorageFacade.defineType` may return a `Promise`.

S39b adds `secrets/v1` and `events/v1` to `createCoreServices`. Secrets: the
credentials load on the first call (shared, retried after a failure); kinds and
reference sources register per instance and are released on `InstanceGone`;
`Delete` asks every live reference source first and fails with a source's
error, removing nothing; `WatchRedactions` yields the list, then each change,
queued on every open stream before a write answers; `AddRedaction` refuses an
empty secret (proto `min_len`). Events: `Register` refuses a payload message
with a field named `type`; `Sink` binds an events stream; `Append` stores
`{ type, ...payload JSON }` (zero values omitted), redacted, committed through
the storage facade as core, then calls the `onEventAppended` option
(fire-and-forget) until `hooks/v1` is served (S40).

S40a adds `tools/v1` and `skills/v1` to `createCoreServices`. Tools are keyed by
name and Project: one name may be registered in different Projects, and a
registration in an overlapping Project by another bundle fails `duplicate_tool`
(T3.10, AC3.13); the newest instance of a bundle serves its keys, and an older
instance never refuses a newer one. `List` and `Catalog` answer the unscoped
tools plus the call's Project's, by order then registration order. `Execute`
relays to the registering instance's `ToolHandlerService` (router target bundle,
generation and incarnation), inheriting the caller's deadline; a tool the call
does not see is `not_found`, an unreachable instance `unavailable`.
`InstanceGone` drops the instance's tools and skills. Skills fail
`duplicate_skill` across bundles and `unavailable_tool` for an `allowedTools`
entry the caller does not see. Since S51a, `tools/v1` 1.6.0 has
`ToolsService.Check`, relayed to the registering instance's
`ToolHandlerService.Check`.

S40b adds `hooks/v1` and `log/v1` (eight services in all), and the
`hookDeadlineMs` option (default 10,000) replaces `onEventAppended`. `Define` is
accepted from the contract's provider only (`doric.*` only from doric; a second
provider fails `registration_conflict`); `Register` adds handlers; `Run` only
from the bundle serving the definition (`not_owner`), input checked by type.
Handlers with an `order` run first, then catalog order with doric first; a
reverse hook reverses the catalog part. Observe, transform and decide handlers
are bounded by the hook deadline; failures and timeouts go to
`doric.diagnostics/v1` as `hook_handler_failed` / `hook_handler_timeout` and the
run goes on (an empty decide answer is a failed handler, not a refusal).
Sequence handlers have no deadline and the first failure fails `Run`.
`WatchAvailability` streams the state, then each change. `core.event-hooks/v1`
is defined by core at `activate` and run after each committed append, detached
from the `Append` call. Log `Write` and `WriteBatch` stamp the caller, host
environment, scope and trace, redact secrets and write to `doric.log/v1`; a
failed write fails the call, so the SDK falls back to stdout.

S41a adds the platform RPC `doric.catalog/v1.Descriptors` (platform 2.1.0,
additive; a coordinator decision). It streams the serialized
`FileDescriptorSet` of the platform's catalog index — staged files, the
platform's own files and `doric.app.hooks/v1`, imports first — in chunks of at
most 1 MiB, with equal bytes on every call. A host process (core) reads it at
`activate` to build its message registry. The descriptor-set helper is shared
with the build; `descriptors.binpb` is unchanged.

S41b makes core serve `models/v1` over the router. The six operations are
relayed to the provider bundle whose `models.provider/v1` reports the
configured provider's kind; the target is the provider id, the configuration
without secret fields, and the secret read per request. `Complete` and `Stream`
check the header first, then pass items through as they arrive; cancelling
aborts the provider call. `Resolve` answers only `{ providerId, model, effort }`.
`Prepare` only checks and activates a configuration and no longer builds
providers, so a bad configuration fails at first use. Each call uses the
configuration active at call time: a prompt spanning a configuration change no
longer keeps its first provider (a release-notes item). An unknown provider or
kind fails `unavailable`, a malformed configuration `invalid_input`.

S41c gives core its process entry `src/host/main.ts`, which calls `runBundle`
(`bundle/host`) with its nine services listed statically as `[Service,
implementation]` pairs from `CoreServices.implementations`; it is built to
`dist/host/main.mjs` (about 2 MB) beside the kernel entry.
`CoreServicesOptions.types` may be a function: `main.ts` loads the registry at
`activate` with `loadCatalogTypes` from `doric.catalog/v1.Descriptors`. A
`Descriptors` failure fails `activate` with its code; a malformed set or a
missing import fails `invalid_output`. At `activate` core registers its own
`onHostStartHook` handler on `doric.app.hooks/v1` (always known to `hooks/v1`):
it connects the storage backend, sets the stage `credential_activation`, logs
`Activating stored credentials` and loads the credentials; `Stage` and `Log`
are required. The platform running the host-start hook and serving
`doric.startup/v1` comes with the boot slice S61; the manifest is unchanged
until S62.

S42 makes the host SDK's `context.log` a queue
([`log.ts`](../../packages/bundle/src/sdk/host/log.ts)) that sends records to
`log/v1.WriteBatch` in batches of 100 or every 200 ms (5 s deadline per batch,
one batch in flight, split where trace or scope change). A failed batch goes to
stdout without retry; a router refusal (`undeclared_requirement`,
`unknown_contract`) switches to stdout for the rest of the process; at 10,000
queued records the oldest goes to stdout, so nothing is dropped. Stdout lines
are redacted with `secrets/v1.WatchRedactions`' list. `Stop` sends what is left
(2 s per batch within the stop budget) and every exit flushes synchronously;
`runBundle` installs `exit`, `uncaughtException`, `unhandledRejection`,
`SIGTERM` and `SIGINT` handlers (signals flush and re-raise).
`BundleDefinition.logSink` lets core write in process (`core.logSink`);
`StartBundleOptions.logTimings` and `logOutput` serve tests. Bundles that do not
declare `log/v1` or `secrets/v1` log to stdout until S62 adds both as optional
to every host part.

From S43 the host parts serve their contracts beside their kernel entries (see
[Evolution](#evolution) for each slice); the parts the executor path uses
work as follows. A thrown llms provider error crosses the router as
`provider_error` and a thrown tool error as `tool_error`, both
`FAILED_PRECONDITION` with every field of the error's data in
`details.providerError` or `details.toolError`, and the caller rebuilds them.
`tools/v1` 1.6.0 adds `ToolsService.Check`, which `core` relays to the
registering instance's `ToolHandlerService.Check`. `runtime` exports
`serveExecutor`, `remotePromptSession` and `historyPatchItems` from
`runtime/contracts` (`src/contracts/executor-serving.ts`, since S62b1) for
executor bundles, and `default` imports them from there. `default`'s process
entry (`src/host/main.ts`) serves `executor/v1` and `default.agents/v1` and defines `default.hooks/v1`;
its model calls go through `llms/rpc`'s `modelsLanguageModel` and its tool
calls make one `Check` before each `Execute`. A cancelled `Run` or `Compact`
is not aborted: `runtime` signals it through
`executor.session/v1.WatchCancel`, waits for the call, and cancels it only
after a 5 s grace; a failure after the cancel answers `run_cancelled` or
`compaction_cancelled`. The kernel entries stay in use until S62.

Since S62a the build also counts what a host part serves without recording it
(`hostProvides`, `packages/bundle/src/build/host-provides.ts`): the `HOST` or
`HOOKS` contract of each contract-role service in the part's static `services`
list, and each `provides` id whose `.proto` marks a hooks, event, settings or
storage-type contract that no service serves; ids recorded on `host` or
`desktopMain` are left out. `checkRecording(manifest, recorded, served?)`
counts them for "provides declares …", and, in every manifest version since
S62c1, refuses a served contract `provides` does not list with "`<source>`: the
host part serves `<id>`, which provides does not declare." Each served contract
`provides` lists gets a `host` entry in `contracts.json` with `local: false` and
`schema: schemas/<id>.json`, but no schema document is written for it: a reader
treats the missing document as a contract with no JSON Schema and no exposure,
so the desktop leaves it unrouted; its exposure is its `.proto`'s, in
`descriptors.binpb`.

Since S62c1 the manifests (still version 1) list what their host parts serve
and call: `transport` provides the eight `api.*/v1@1.0.0`, `runtime` provides
`executor.session/v1@1.0.0` and `runtime.threads/v1@1.10.0` and lists
`executor/v1` under `optional`, `core` lists `models.provider/v1` under
`optional`, every bundle with a host part lists `log/v1` and `secrets/v1`, and
`terminal` requires `runtime.lease/v1`. Every `provides` entry of a host
contract carries its `.proto` header's version, which the repository test
`tests/provide-versions.test.mjs` (in `npm run lint:test`) checks; client
contracts and headers that say "until phase 4" are not checked. The host still
boots the kernel.

`runtime.threads/v1.ThreadEvents` (proto 1.10.0, since S62b3) answers the
longest prefix of the events after the cursor whose answer encodes below
`THREAD_EVENTS_MAX_BYTES` (3 MiB), at least one event when any follows, and
`lastSequence` unchanged: the larger of the record's last sequence and the
last event's. The wire does not change; a caller continues from the last
event's sequence while it is below `lastSequence`, and when the record runs
ahead of its events that extra call answers an empty page.
`readThreadEventLog` (`runtime/contracts`, `src/contracts/thread-events.ts`)
reads the whole log that way and joins the pages; it answers `undefined` when
a page answers no log (no Thread, also one deleted between pages) and fails
`invalid_output` when a page's last sequence is not after its cursor. The
routed hosts of `comments`, `openui` and `papercraft` read through it.
`transport`'s `ListEvents` sets `nextAfterSequence` whenever its page ends
before `lastSequence`, cut by transport or by `runtime`.

Stored `comments.added/v1` and `comments.resolved/v1` rows are read in either
encoding, today's payload or the message's JSON, through `commentsAddedOf` and
`commentsResolvedOf` (`comments/contracts`, `src/contracts/rows.ts`, since
S62b2); `chat` and `papercraft` use them and fall back to the row as stored,
and `papercraft` depends on `comments`.

## Evolution

- 2026-11-22: phase 0 of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.2): the
  groundwork above and its measurements; RK1's ceiling set at 2.75 GiB idle
  (A55) and section 8's codec rule at four times (A56), both met on arm64; x64
  awaits the CI job `sea-spike`. Deadline timers re-arm when they fire early,
  the DOM shim fills globals Node declares without a value, and the image runs
  Node 26.
- 2026-11-22: phase 1, slices S1 and S2, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.4):
  generated code per owner with the `./contracts/gen/*` export, the `files`
  proto, the proto check and the guarded `buf breaking` in CI.
- 2026-11-22: phase 1 completed, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.7):
  every contract is a `.proto` generated per owning bundle, the eight public
  `api.<resource>/v1` protos in `transport`, and the inventory coverage test.
- 2026-11-22: phase 2, slices S12–S28, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.9):
  manifest version 2, the environment check, the new quarantine and error
  codes, `status.ts` and `RegistrationTable`; router, supervisor, gateway,
  generations and publish, replay, `runBundle`, `bundle/client`, the router
  test harness and the conformance suite; the Connect leak patch; RK4 measured
  in the sandbox, where its rule fails on (a), and its decision waits for the
  owner after the CI x64 re-measure. Phase 2 is not finished until then.
- 2026-11-22: the owner's decisions A68 and A69 of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.10):
  RK4's numbers are accepted and phase 3 may start, so phase 2 is finished;
  the image's `patch-package` step is approved.
- 2026-11-22: [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md)
  (v6.11): the S24 replay-hold gap is fixed with `doric-target` on replay
  calls, no proto change; the doric-host image builds again (`ca-certificates`
  and the buf files in `agent-builder`; the build needs buf.build).
- 2026-11-22: phase 3, slice S29, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.11):
  the host part build into `dist/host/main.mjs` and `stage --dev` with
  `host/command.json`.
- 2026-11-22: phase 3, slice S30, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `dist/descriptors.binpb`, version 2 manifests in `stage`, and the
  `bundle/platform` entry with the staged catalog index and command.
- 2026-11-22: phase 3, slice S31, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `startPlatform` serves `doric.catalog/v1` (`Get`), `doric.diagnostics/v1`
  and `doric.bundle/v1` in process, and reads the storage `Identity` once
  after boot.
- 2026-11-22: phase 3, slice S32, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  manifests gain `host.assets`; the host SDK's `context.assets` reads them in
  development.
- 2026-11-22: phase 3, slice S33, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  the v0 manifest path is deleted; a manifest without `manifestVersion` is
  quarantined with `invalid_manifest`.
- 2026-11-22: phase 3, slice S34, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `AgentOptions.maxRecordOutputChars` caps a stored tool record's output.
- 2026-11-22: phase 3, slice S35, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  client parts load generated code and `@bufbuild/protobuf` from the window
  import map; the phase-1 restriction on `<other>/contracts/gen/*` is lifted.
- 2026-11-22: phase 3, slice S36, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `storage/rpc` carries `storage.backend/v1` and `secrets.backend/v1` over the
  router until phase 4.
- 2026-11-22: phase 3, slice S37, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `storage/rpc` carries `storage/v1` (`serveStorage`, `storageClient`) until
  phase 4.
- 2026-11-22: phase 3, slice S38, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  the entry `bundle/host`, and `postgres`'s host process part
  `src/host/main.ts`.
- 2026-11-22: phase 3, slice S39a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `createCoreServices` serving `storage/v1` and `settings/v1`; settings values
  as protobuf messages, with registrants applying their own defaults at
  revision 0.
- 2026-11-22: phase 3, slice S39b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `createCoreServices` also serving `secrets/v1` and `events/v1`, with the
  `onEventAppended` option standing in for `hooks/v1` until S40.
- 2026-11-22: phase 3, slice S40a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `createCoreServices` also serving `tools/v1` and `skills/v1`, tools keyed by
  name and Project.
- 2026-11-23: phase 3, slice S40b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  `createCoreServices` also serving `hooks/v1` and `log/v1`, with the
  `hookDeadlineMs` option replacing `onEventAppended`.
- 2026-11-23: phase 3, slice S41a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  the platform RPC `doric.catalog/v1.Descriptors` (platform 2.1.0), read by
  core at `activate` for its message registry.
- 2026-11-23: phase 3, slice S41b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  core serves `models/v1` by relaying to provider bundles; `Prepare` only
  checks and activates a configuration, and each call uses the configuration
  active at call time.
- 2026-11-23: phase 3, slice S41c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12):
  core's process entry `src/host/main.ts` (`dist/host/main.mjs`), its registry
  loaded at `activate` from `Descriptors`, and its own host-start handler.
- 2026-11-23: phase 3, slice S42, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (v6.12, A7):
  the host SDK's batched `context.log` queue with stdout fallback, redaction,
  exit flushing and process handlers; `BundleDefinition.logSink`.
- 2026-11-23: phase 3, slice S44, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the
  `docker` and `firecracker` host processes (`src/host/main.ts`) serve
  `SandboxService` by lease id; leases are per calling instance
  (`unknown_lease`, `NOT_FOUND`), a sandbox without live processes answers
  `unsupported_operation` (`UNIMPLEMENTED`), `onGone` releases the instance's
  leases and `deactivate` releases all.
- 2026-11-23: phase 3, slice S43, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `serveProviderKind` of `llms/rpc` serves `ProviderService` for one provider
  kind; the `claude`, `codex`, `openai` and `openrouter` host processes
  (`src/host/main.ts`) serve it through `runBundle`. One built provider per
  `providerId`, rebuilt when values or secret change; build failures are
  `invalid_input`, provider errors `provider_error` (`FAILED_PRECONDITION`,
  full error in `details.providerError`), and images are read through
  `runtime.attachments/v1.Read` into a `data:` URL.
- 2026-11-23: phase 3, slice S45a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the host
  SDK (`bundle/host`) exports `createToolHandlers` (serves
  `ToolHandlerService`; `register` registers per Project with `tools/v1`
  through `registrations.track`, so it is re-registered after core restarts,
  and returns an unregister handle; `Check` falls back to the tool's zod
  input; results are JSON), `createHookHandlers` (serves
  `HookHandlerService`; `register` reads contract, hook and kind from the
  proto options and answers by kind: observe, transform, decide, sequence)
  and `onHostStart` (an `onHostStartHook` handler with `stage()` and `log()`
  over `doric.startup/v1`; it runs for real only from S61/S62).
  `createTestRouter` exempts platform contracts (`doric.*`) from `requires`,
  as the real router does.
- 2026-11-23: phase 3, slice S45b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `host-config` gets a process entry, `src/host/main.ts` (built to
  `dist/host/main.mjs`), running `runBundle` with `HostConfigService`
  (`host-config/v1`), `ReferenceSourceService` and `HookHandlerService`
  listed statically. Its settings space is registered with `settings/v1` at
  activate, read through `Entry` and written through `Set`; its reference
  source answers the stored configuration's credential ids plus those of any
  `Replace` in flight (a direct `settings/v1.Set` by another bundle is not
  checked, accepted); `Replace` calls are serialized and check tools under the
  caller's scope; every RPC answers `unavailable` before activate; the start
  step runs for real only from S61/S62. The kernel entry and manifest are
  unchanged until S62; new dependency `@connectrpc/connect`.
- 2026-11-23: phase 3, slice S46a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the
  runtime host's domain wiring moves into `createRuntimeCore` (kernel entry
  unchanged); `createRuntimeServices` serves `runtime/v2`,
  `runtime.attachments/v1` and `runtime.usage/v1` over the router
  (`runtime.threads/v1` in S46b, `main.ts` in S48). Every RPC answers
  `unavailable` before activate; activate registers storage types, defines
  `runtime.hooks/v1`, folds events and runs the start step; stop answers
  `shutting_down`. Ports (`storage/v1`, `host-config`, secrets, models
  catalog) go through the router. The codec drops undeclared keys and answers
  `invalid_output` for an unknown oneof discriminator; requests are re-parsed
  with the zod schemas so `invalid_input` issues match 1.x (`CreateProject`
  still accepts an empty name). `runtime.attachments/v1.Read` answers a head
  then chunks of at most 1 MiB. New runtime-only codes `shutting_down` and
  `thread_control_inactive` travel as `FAILED_PRECONDITION`. Domain work runs
  detached from the incoming call, so its port calls carry no request trace,
  deadline or scope (kernel parity). Accepted risks: uncapped stream buffers;
  no 3 MiB split for `WatchProject` snapshots or single Watch events. New
  dependencies `@connectrpc/connect` and `core`; `storage` moves to
  dependencies.
- 2026-11-23: phase 3, slice S46b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `createRuntimeServices` also serves `runtime.threads/v1` (all 43 RPCs,
  `src/host/rpc/threads.ts`). Prompt controls (spawn, list, get, events, send,
  restart, interrupt, terminate) find their prompt through the call's scope; a
  control without a prompt scope fails `thread_control_inactive`. `Instruct`
  takes the bundle id from the caller. `Spawn` with a refused execution fails
  `invalid_execution` (detail `issue`); `SetThreadExecution` answers
  `{ status: 'invalid', reason }`. `WatchThread` splits an oversized snapshot:
  the snapshot item stays under 3 MiB and the remaining events go out as
  `event` items before any live item; `ViewThread` holds a `viewing` item until
  cancelled. Generation handover (`src/host/rpc/handover.ts`) is installed at
  activate as step 7 and removed at deactivate; it is driven by
  `context.generations` `onChanged`/`onSignal`, and the drain takes a
  `doric.generation/v1` Hold, sends its signals, then releases.
  `replay_failed` now travels as `INTERNAL`.
- 2026-11-23: phase 3, slice S47a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the
  runtime's sandbox port goes through the router (`routedSandbox`,
  `src/host/routed-sandbox.ts`, calls `sandbox/v1` by lease id; domain
  unchanged; `ExternalPorts` keeps only the executor, routed in S48).
  `createRuntimeServices` also serves `runtime.lease/v1` (11 RPCs,
  `src/host/rpc/lease.ts`). Lease operations run in the caller's call, so
  deadline, cancellation and trace reach `sandbox/v1`; cancelling `Start`
  kills the process. Lease callers never see lease ids. A Thread scope naming
  an unknown Thread answers `unavailable` with `leaseStatus` `missing` (no
  fallback to the first active Project); a sandbox `unknown_lease`
  mid-operation answers `unavailable` with `leaseStatus` `unavailable`; a
  sandbox without live processes answers `UNIMPLEMENTED`. Lease RPCs rely on
  protovalidate (no zod re-parse). Terminating a Project finishes in the
  background with a real `sandbox/v1` `Release`; callers wait for `cancelled`
  before deleting. `unknown_session` joins `contractErrorCodes` (`NOT_FOUND`);
  a session registry (`src/host/sessions.ts`) exists and sessions open in
  S47b. Open findings: over HTTP/2 an `unsupported_operation` from sandbox
  `Start` arrives on the result rather than rejecting the start; an `Exec`
  result can exceed 4 MiB; `PutFile` buffers the whole file uncapped.
- 2026-11-23: phase 3, slice S47b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `createRuntimeServices` also serves `runtime.workspace/v1`
  (`src/host/rpc/workspace.ts`). `Cwd`, `SetCwd` and `Location` act on the
  bound prompt's workspace (zod re-parse kept) and answer
  `thread_control_inactive` after the prompt ends. `OpenThread` opens a Thread
  session for the calling instance, answers `ready` (or one refusal item for
  `missing`, `inactive` or `pending`) and holds it until the stream is
  cancelled; `withThread` runs detached so a resume outlives the call.
  `ThreadState` reads the caller's session (unknown: `NOT_FOUND`
  `unknown_session`). Sessions end when the opening instance is gone
  (`onGone`, step 8) and on stop, deactivate and drain, before dispose and
  drain take the Project lock; open session streams then fail
  `FAILED_PRECONDITION` `shutting_down`. Deleting or terminating a Project with
  an exclusive session open waits for it through the Project lock. No
  `withThreadSession` client helper yet (S54). Open finding: a hint-refresh
  failure after a session ends is not logged yet (S48 adds a logger).
- 2026-11-23: phase 3, slice S48a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the host
  SDK's `context.services.use(ref, options)` takes `options.scope`, so a client
  created outside any handler call (detached work, such as `runtime`'s executor
  calls carrying `{projectId, threadId, promptId}`) can send a scope. The router
  transport sends it as `doric-scope-bin` in place of the parent call's scope;
  deadline, cancellation and trace still come from the parent call. An
  out-of-bounds scope makes `use` throw `ContractError` `invalid_scope` and no
  call is made. Under `track(…, { scope })` the first call carries the scope;
  replays send none. `createTestRouter`'s `use` behaves the same.
- 2026-11-23: phase 3, slice S48b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `runtime`
  calls `executor/v1` through the router (`routed-executor.ts`) and provides
  `executor.session/v1` (`session.ts`); the in-process executor port is gone.
  Each executor call sends the prompt's scope via `UseOptions.scope` and opens
  a session (random UUID) bound to the executor's provider bundle, read once
  from `doric.catalog/v1` `Get` and cached (failures not cached; no provider:
  `unavailable` before any call); the session ends when the call settles and
  is refused to other bundles and, once an instance has called back, to other
  instances. `Record` reads the whole stream first (malformed:
  `invalid_input`), then runs detached; a storage failure answers
  `unavailable`; `Record` on a checkpoint or rewind session answers
  `unsupported_operation`. `ReadHistory`, `TakeSteers` and
  `DescribeAttachment` stay tied to the call; the history format arrives only
  in `ReadHistory`'s first item. `Formats` is cached per executor instance via
  a tracked registration (a replay refreshes it). The workspace service logs a
  hint-refresh failure after a session ends at `warn`, closing the S47b open
  finding. Cycle rule: `executor/v1` must be optional for `runtime` (S62
  manifest); `default` (S51) may call `executor.session/v1` only from its
  `executor/v1` handlers, never at activate. Open finding:
  `DescribeAttachment` reads the whole blob.
- 2026-11-23: phase 3, slice S48c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `runtime`
  has its process entry, `src/host/main.ts` (built to `dist/host/main.mjs`,
  about 2.1 MB), calling `runBundle` with eight services listed statically:
  `RuntimeService` (`runtime/v2`), `ThreadsService`, `AttachmentsService`,
  `UsageService`, `LeaseService`, `WorkspaceService`, `SessionService`
  (`executor.session/v1`) and `HookHandlerService` (`createHookHandlers`).
  Activate calls `runtime.activate(context, hooks)`, which registers `onGone`;
  deactivate calls `runtime.deactivate()`. This completes runtime's host part
  (S46a–S48c). The kernel entry and manifest are unchanged until S62, which
  adds `executor.session/v1@1.0.0` to runtime's provides and makes
  `executor/v1` optional for `runtime`.
- 2026-11-23: phase 3, slice S49a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `screen-relay` has its process entry, `src/host/main.ts` (built to
  `dist/host/main.mjs`), calling `runBundle` with `RelayService`
  (`screen.relay/v1`) listed statically and `BundleDefinition.httpServer`: its
  own loopback listener (`127.0.0.1:0`, port reported to the platform), to
  which the gateway forwards `/screen/<token>/…` unchanged.
  `ScreenRelayServer.serve` makes the relay that listener's only handler
  (unknown paths and upgrades answer 404). A replayed `Expose` of the same
  token and upstream is idempotent, so `screen`'s re-published tokens (S49b)
  restore a restarted relay. Open: an old `screen` generation's shutdown can
  forget tokens the new one re-exposed. The kernel entry and manifest are
  unchanged until S62, which adds `host.httpPrefix: "/screen/"`.
- 2026-11-23: phase 3, slice S49b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `screen`
  has its process entry, `src/host/main.ts` (built to `dist/host/main.mjs`),
  calling `runBundle` with `SessionsService` (`screen.sessions/v2`) listed
  statically. `Attach` fails `unavailable` until activation, which builds the
  session manager with `context.log`, `trackedRelay` and `routedScreenLease`
  (over `runtime.lease/v1`). The routed lease describes once and pins every
  `Exec` to that sandbox id in the caller's scope; a `leaseStatus` failure ends
  the run as `pending` or `unavailable` (reason `sandbox`) even when swallowed,
  and later execs reject without a call. `trackedRelay` tracks each exposed
  token with `registrations.track` for replay to a restarted relay; `forget`
  untracks and calls `Forget`. Open: a swallowed lease failure in the
  `xpra list` wait loop runs to the loop's deadline; the S49a handover race.
  The kernel entry is unchanged until S62, which adds `host.requires`
  `runtime.lease/v1@^1.4.0`, `screen.relay/v1@^1.1.0`, `log/v1` and provides
  `screen.sessions/v2@2.1.0`.
- 2026-11-23: phase 3, slice S50a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `defineTool<Input, Output, Deps = Services>` passes `bind(deps)` to
  `execute`; a definition is registrable with the kernel only when `Deps`
  accepts `Services` (new `UnboundTool`), with no run-time change. Host-part
  tools take a port object (or `unknown`) and are bound before
  `createToolHandlers().register`, which is how tool slices rebind kernel tools
  to router clients. `bundle/host` exports `contractErrorOf`. `web` has its
  process entry, `src/host/main.ts` (built to `dist/host/main.mjs`), calling
  `runBundle` with `ToolHandlerService` listed statically; at activation it
  registers the `web` tool with `tools/v1` (`alwaysAvailable`, order 700),
  passing provider rejections through. The kernel entry is unchanged until
  S62, which requires `tools/v1@^1.5.0`.
- 2026-11-23: phase 3, slice S50c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `usage` has
  its process entry, `src/host/main.ts` (built to `dist/host/main.mjs`),
  calling `runBundle` with `UsageService` (`usage/v1`) listed statically, over
  `runtime.usage/v1`, `runtime.threads/v1`, `host-config/v1` and `models/v1`.
  Every method fails `unavailable` before activation; routed failures keep
  their codes. `SetCompactionTarget` changes only
  `execution.contextCompaction.pressurePercent`, and a `host-config/v1` answer
  without a configuration fails `invalid_output`. The `usage/v1` proto header
  says 1.1.0; the kernel entry and the manifest are unchanged until S62, which
  provides `usage/v1@1.1.0`.
- 2026-11-23: phase 3, slice S50b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `claude-login` and `resources` have process entries, `src/host/main.ts`
  (built to `dist/host/main.mjs`), each calling `runBundle` with its service
  listed statically and failing `unavailable` before activation.
  `LoginService` (`claude.login/v1`) delegates to `createLoginSessions`, as the
  kernel `loginService` now does; deactivation cancels a waiting sign-in;
  `Finish` stores through `secrets/v1` (`Create`, or on `credential_name_taken`
  `List` and `Update` of the `API_TOKEN` credential named `Claude`) and may wait
  up to 10 minutes, which the S60 transport must not shorten.
  `ResourcesService` (`resources/v1`) answers `Project` from one
  `runtime.lease/v1` `Stats`; a lease status is answered as `{ status }`, and
  any other failure rejects with its code so a down runtime is not hidden. The
  kernel entries and manifests are unchanged until S62, which provides
  `claude.login/v1@1.1.0` and requires `runtime.lease/v1@^1.4.0`.
- 2026-11-23: phase 3, slice S51a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the error
  code `tool_error` is new. A tool error (an `Error` named `ToolErrorObject`
  with data `{ code, message, toolName?, callId?, diagnostic?, issues? }`)
  thrown by a host-part tool's `execute` or `check` crosses the router as
  `tool_error` (`FAILED_PRECONDITION`) with every field of the data in
  `details.toolError`, without its
  cause chain; plain errors stay `internal` and `ContractError`s pass through;
  `default` rebuilds the tool error in S51d. `tools/v1` is 1.6.0 with
  `ToolsService.Check`, which `core` relays to the owner's
  `ToolHandlerService.Check` (newest instance, `projectId` only for scoped
  tools): an unknown tool fails `not_found`, an unreachable instance
  `unavailable`, and the owner's `tool_error` is kept. `createToolHandlers`
  answers `Check` with the tool's `check` or the zod fallback. Manifests move
  to `tools/v1@1.6.0` in S62.
- 2026-11-23: phase 3, slice S51c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): in
  `runtime/default`, the kernel `Services` give way to a port object
  (`DefaultPorts`, `kernelPorts`, `kernelBeforeModelRequest` in
  `src/host/ports.ts`), and `load_skill` is bound to the ports. Prompt
  templates and built-in agent files are read on first use through one
  process-wide asset source (`src/host/assets.ts`: `defaultAssetPaths`,
  `useAssetTexts`, `assetText`, `loadAssetTexts`; `lazyTemplate`), so no
  module reads a file at import. `thread_execution_unavailable` is now a
  `ContractError` with the same code and message. Agent files are now read in
  `activate` (a missing or invalid one quarantines the kernel entry with
  `activate_failed`, and makes the process entry's `activate` reject), and a
  template at its first render, so a missing or invalid template fails the run
  that renders it; errors name an agent file by its bundle-relative path.
- 2026-11-23: phase 3, slice S51b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `llms/rpc`
  adds `modelsLanguageModel`, an `LlmProvider` over `models/v1` that rebuilds
  `ProviderErrorObject` from `provider_error` details (malformed details and
  other codes stay `ContractError`; `unavailable` and `generation_lost` become
  a retryable `network_error`) and sends `https:` images as URLs and
  `attachmentImageUrl` images as attachments. `runtime` exports
  `runtime/executor` (`remotePromptSession`, `historyPatchItems`,
  `serveExecutor`) for executor bundles, and `routedExecutor` rebuilds a
  ProviderError-shaped error from `provider_error`.
- 2026-11-23: phase 3, slice S51d, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `default`
  runs on its own host process (`createDefaultHost`, `src/host/main.ts`) with
  routed ports (`routedPorts`, `routedBeforeModelRequest`) and routed tools,
  which rebuild the tool error from `tool_error`; it calls
  `executor.session/v1` only inside its executor handlers and sends images as
  `doric-attachment:` URLs.
- 2026-11-23: phase 3, slice S51e, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `executor.session/v1` gains `WatchCancel({ sessionId })` (version stays
  1.0.0). `routedExecutor` no longer aborts `Run`/`Compact` on cancel: it
  marks the session cancelled, waits, and after 5 s (`executorCancelGraceMs`)
  aborts and logs `executor_cancel_timeout`. `serveExecutor` aborts the
  implementation's signal on `WatchCancel`; any failure after the cancel
  answers the free codes `run_cancelled` / `compaction_cancelled`.
  `default`'s routed tools carry the call signal and make one `tools/v1.Check`
  per tool call; `Checkpoint`/`Rewind` still cancel by abort. Known gap: no
  runtime caller aborts a compaction yet (`runner.ts:1231-1238`).
- 2026-11-23: phase 3, slice S52a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `comments`
  runs on its own host process (`createCommentsHost`, `src/host/main.ts`) with
  routed ports over `events/v1`, `runtime.threads/v1` and `tools/v1`; it
  serves `comments/v1` and the `comment_reply` tool and registers the loose
  events `comments.added/v1` and `comments.resolved/v1` with no sink. The
  registry and the tool share `CommentsPorts` with the kernel. The fold reads
  both stored encodings (today's JSON and the message JSON routed appends
  write, `rows.ts`), which coexist from S62 until phase 4. `core`'s
  `events/v1` append stores bodies with implicit fields kept
  (`alwaysEmitImplicit: true`).
- 2026-11-23: phase 3, slice S52b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `threads`
  runs on its own host process (`src/host/main.ts`) and registers its eight
  tools over `runtime.threads/v1` and optional `default.agents/v1`; any
  `unavailable` from the agent lookup answers "Agent types are unavailable in
  this runtime."
- 2026-11-23: phase 3, slice S53a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `files`
  runs on its own host process (`src/host/main.ts`, `createFilesHost`); its
  seven tools run over `FilesToolPorts`, shared with the kernel, and the routed
  ports call `runtime.workspace/v1` and `runtime.lease/v1` (one `Describe`, then
  steps with `expectSandboxId`); `view-image` streams `ReadFileBytes` into
  `runtime.attachments/v1.Attach`.
- 2026-11-23: phase 3, slice S53b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the `files`
  process serves `files/v1` 1.4.0 over `runtime.lease/v1` with the lease scope
  `{projectId}` only; each former `withLease` task is one `Describe` then steps
  naming that sandbox, the first not-ready step answering `{status}` (A58);
  `ReadBytes` streams the head, then chunks of at most 1 MiB (truncated at
  `BYTES_LIMIT`, `binary` on a NUL byte); before activation its methods fail
  `unavailable`. Known differences until S62: the over-size attachment message
  and `runtime`'s whole-file `ReadFileBytes`; RK36 is deferred to S62.
- 2026-11-23: phase 3, slice S54a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `runtime.lease/v1` 1.5.0 answers a `started` item first on `Start` once the
  process started (output produced before it is held and sent right after; a
  refused head sends none); `runtime/contracts` exports `withThreadSession`,
  which opens `runtime.workspace/v1.OpenThread`, runs a task on `ready`,
  answers `missing`, `inactive` or `pending` without running it, and ends the
  session in a `finally`.
- 2026-11-23: phase 3, slice S54b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `terminal`
  runs as its own process (`src/host/main.ts`, `createTerminalProcessHost`)
  serving `terminal/v1` 1.3.0 (shape unchanged), its tool and its
  `runtime.hooks/v1` handler. A terminal opens a Thread session with
  `withThreadSession`, calls `runtime.lease/v1.Start` with its
  `threadSessionId`, ends the session on `started`, and keeps the `Start`
  stream, opened `detached`, for the terminal's life; terminals end with the
  instance. Redactions come from `secrets/v1.WatchRedactions`, not reopened on
  failure. `Run` on an inactive Thread fails `internal` "Thread is inactive.";
  without live terminals it fails `unsupported_operation` "Live terminals are
  unavailable.". `createTestRouter` now ends a cancelled streaming handler with
  `return()`, so its `finally` runs, as the real transport does.
- 2026-11-23: phase 3, slice S55a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md):
  `runtime/contracts` exports the routed-lease steps `leaseStatusOf`,
  `execRequestOf`, `execResultOf` and `runOnProjectLease` (one `Describe`,
  `expectSandboxId` on every step, the first `leaseStatus` failure is the
  `{ status }` answer, other failures keep code, message and details). `files`
  uses them; `screen` and `resources` keep their own.
- 2026-11-23: phase 3, slice S55b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `git`'s
  host part builds as a process (`src/host/main.ts`, `createGitProcessHost`).
  `activate` tracks `secrets/v1.RegisterKind` for `GIT` through
  `context.registrations.track`, then registers the tool `git`
  (`alwaysAvailable: false`, `order: 900`); after a kind refusal no tool is
  registered. The tool's routed ports run on `runOnProjectLease`, with a
  `Describe` wrapper that keeps the provider's error.
- 2026-11-23: phase 3, slice S55c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): the
  process also serves `git.commands/v1`; `main.ts` serves `CommandsService`
  and `ToolHandlerService`. `createGitCommands` holds the operations for the
  kernel and the process; routed Thread methods use `withThreadSession`
  (`exclusive`) and `ThreadState` for busy working directories, Project
  methods `runOnProjectLease` scoped to `{projectId}`; a `terminal/v1` `List`
  answering `unavailable` counts as no sessions. Methods fail `unavailable`
  "git is not activated." before activation. The kernel entry stays until
  S62.
- 2026-11-23: phase 3, slice S56, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md): `openui`
  runs as its own process (`src/host/main.ts`, `createOpenuiHost`) serving
  `openui.programs/v1` and `openui.questions/v1`, registering
  `openui.answered/v1`, its `runtime.hooks/v1` handler and its skill; its
  services answer `unavailable` until activation. Routed requests are parsed
  again with today's zod schemas, so the questions digest matches the
  kernel's; stored `openui.answered/v1` rows read the same in both encodings.
  The skill is never read at import: the kernel reads it in `activate` beside
  the compiled module, the process through `context.assets.read` (needs
  `host.assets`, slice S62). The 200 ms validation timer's instruct runs
  detached.
- 2026-11-23: phase 3, slice S57a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.18): `papercraft`'s kernel runs on ports and gains no process. The cores
  `projectReaders`, `jobRunnerOver`, `createProgramOperations` and
  `createLibraryOperations` take `PapercraftPorts`, built by
  `kernelPapercraftPorts`; the existing functions wrap them. `esbuild`,
  `tailwindcss` and `@tailwindcss/oxide` load lazily through
  `nativeOf`/`moduleNative` (`createRequire`), never a value `import()` under
  `src/host/`. The skill is read in `activate` (`readSkillBesideModule`), the
  runner lazily (`readRunnerBesideModule`, failure remembered). The process
  comes in S57b.
- 2026-11-23: phase 3, slice S57b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.18): `papercraft` runs as its own process (`src/host/main.ts`,
  `runBundle`; `src/host/service.ts`, `createPapercraftHost` over the S57a
  cores). Requests are parsed again with zod (`src/host/codec.ts`), a refusal
  answering `invalid_input`; `Read` streams files in chunks of at most 1 MiB.
  The sandbox goes through `routedPapercraftLease` (`src/host/lease.ts`, over
  `runOnProjectLease`, chunked `PutFile`/`GetFile`), Project files through
  `routedPapercraftPorts` (`src/host/routed.ts`; `files/v1` with the scope
  `{projectId}` only, bytes through `ReadBytes`). `activate` reads the skill,
  registers the cwd event (`registerCwdEvent`), the two hooks, then the skill
  (`registerSkill`: a refusal is skipped without retry); the services answer
  `unavailable` until then. Native packages load through
  `context.assets.require`, the skill and runner through `context.assets.read`
  (needs `host.assets`, slice S62). Library jobs and lease runs are detached;
  export reads and hook work stay inside the request. Concurrent `cwdAt`
  lookups for one (project, thread, turn) share one promise, so two Library
  calls join one job. The kernel entry stays until S62.
- 2026-11-23: phase 3, slice S58a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.19): `chat`'s `composer-state.ts` and `message-flush.ts` move to
  `bundles/desktop/chat/src/shared/`, shared by the desktop part and the host
  part of S58b. Each draft has a `revision` (0, then +1 per change), passed to
  watch listeners and carried by the snapshot. `createComposerState` takes
  `flushOf(kind)`, read at flush time (`registerFlush` wins; `undefined` keeps
  the item). One flush per draft runs at a time, queued in call order; each
  removes only the ids it flushed from the stack as it then stands, announcing
  `removed` only for those still there; a rejecting flush changes nothing.
- 2026-11-23: phase 3, slice S58b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.20): `chat`'s host process (`bundles/desktop/chat/src/host/`,
  `createChatHost`) serves `ComposerService` (`chat.composer/v1`, one shared
  `createComposerState` per (projectId, threadId)) and
  `ComposerFlushHandlerService` for kind `message`, run in process (other kinds
  answer `invalid_input`). Remote kinds flush through the newest registrant's
  handler with the caller's deadline and scope; registrations go through
  `RegistrationTable` (`message` is held by chat, a conflict answers
  `registration_conflict`), and `Unregister` removes only the caller's own. An
  anchor the wire cannot hold leaves the item on the stack; a remote answer
  without target or anchor case, or with an unknown pseudo, is
  `invalid_output`. Everything answers `unavailable` "chat is not active."
  until activation; Watch ends on `callOf(context).signal`. The host part
  requires nothing. The window keeps its local composer until phase 5 and
  nothing calls the host's Flush before then; `chat`'s manifest stays at
  version 1 until phase 5 (S62). New dependencies: `@connectrpc/connect`, dev
  `@bufbuild/protovalidate`.
- 2026-11-23: phase 3, slice S59a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.20): `mcp`'s host part moves onto ports, with no new process yet.
  `src/host/ports.ts` defines `McpPorts` (`storage`, `secrets`, `tools`,
  `lease`, `log`) and `kernelMcpPorts` (storage and secrets forward exactly the
  caller's arguments); `src/host/operations.ts` (`createMcpOperations`,
  `projectOf`) holds the method bodies, and `src/host/index.ts` only wires the
  kernel, including the project-ready hook moved from `manager.ts`.
  `createManager({ ports, store, vault })` exposes `sandboxReady`; tool
  registration is asynchronous, and one landing while its connection closes is
  unregistered at once. `executeMcpTool` is shared by `toDoricTool` and
  `mcpToolDefinition`; `openStdio` runs over an `McpLease`, and a sandbox
  without `start` or answering `unsupported_operation` keeps today's "cannot
  keep a process running" message. The process follows in S59b and S59c.
- 2026-11-24: phase 3, slice S59b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.21): `mcp`'s routed adapters, still with no process (S59c).
  `src/host/codec.ts` (`serverInputOf`, which checks a routed input again with
  today's zod schema and answers `invalid_input` "Invalid input for mcp/v1
  <Method>." with the issues; `serverViewMessageOf`,
  `skillSourceEntryMessageOf`); `src/host/lease.ts` `routedMcpLease`
  (`runOnProjectLease` with scope `{projectId}` only; `stdio` started through
  `LeaseService.Start`, detached, resolving at `started`;
  `unsupported_operation` keeps today's text); `src/host/routed.ts`
  (`detached`, `routedSecrets`, `routedTools`, `routedAttach` in chunks of at
  most 1 MiB, `routedMcpPorts`, `watchProjectDeletions`). Only Create's and
  Update's credential check and a tool call's image attach run in the
  caller's call; the rest is detached. `watchProjectDeletions` opens
  `runtime/v2.Watch` again 5 s after it ends, cleanly or with an error
  (a `warn` only for an error), and nothing after `dispose()`.
  `src/host/stream.ts` is `mcp`'s own copy of `chat`'s `streamOf`. The package
  gains `@connectrpc/connect`, and `storage` moves to `dependencies`.
- 2026-11-24: phase 3, slice S59c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.21): `mcp` runs as its own process. `src/host/main.ts` (`runBundle`)
  serves `McpService`, `SkillSourcesService`, `ToolHandlerService` and
  `HookHandlerService`; `src/host/service.ts` `createMcpHost` builds them over
  S59a's cores and S59b's adapters. Every method answers `unavailable` "mcp is
  not active." before `activate` resolves, if it rejects, and after
  `deactivate`. `activate`, in order: the routed ports; defines
  `mcp.server/v1` and waits for storage; registers the `MCP_TOKEN` credential
  kind; registers the prompt-started, project-closing and project-ready hooks
  in one hook table; starts `watchProjectDeletions`; opens the services.
  `deactivate` closes the services, stops the deletion watch and stops the
  operations, and never rejects (a failure is logged at `warn`). `Watch` ends
  on the caller's signal; server connections stay open. The kernel entry
  stays until S62, which owns the switch: S60 must not give `FinishSignIn` a
  short deadline (it waits up to 10 minutes); `storage/v1` stays required
  until phase 4; during a drain two generations may run a `stdio` server
  twice (RK31).
- 2026-11-24: phase 3, slice S60a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.22): what `transport`'s public API needs from the SDK and `runtime`.
  `BundleDefinition.invalidInput(method, violations)` (`run.ts` passes it to
  the call server) answers a request that decoded but broke a protovalidate
  rule: a unary request, a server stream's request, and each message of a
  client stream. It gets the method and every `InputViolation { field, ruleId,
  message }` in protovalidate's order, `field` holding proto field names only
  (list and map subscripts dropped). A returned `ContractError` ends the call;
  `undefined`, a throwing hook or no hook keep `invalid_input`; an undecodable
  request or a rule error never reaches it. `serve.ts` and `createTestRouter`
  validate through the same internal `validRequest`. `contractErrorCodes` and
  the error table gain 36 reasons of `doric.api.*`: 23 `invalid_*`
  (`INVALID_ARGUMENT`), 9 (`NOT_FOUND`), `configuration_rejected`,
  `model_catalog_unreadable`, `compaction_failed` (`UNAVAILABLE`) and
  `internal_error` (`INTERNAL`); `credential_name_taken` stays
  `ALREADY_EXISTS` (decision Q2; S62 amends the protos and inventory B).
  `runtime`'s JSON⇄message codec moves to `runtime/contracts`
  (`json-codec.ts`: `encode`, `decode`, `runtimeOneofs`);
  `src/host/rpc/codec.ts` re-exports it.
- 2026-11-24: phase 3, slice S60b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.22): `transport`'s Express route bodies move, unchanged, into operations
  (`src/host/api/operations/`) over `TransportPorts`, a narrowed
  `TransportServices`; each handler is `sendAnswer(response, await
  operations.x(routeInput(request)))` (`src/host/api/answer.ts`: `ApiAnswer`,
  `apiError`, `apiFailure`, `answerValue`, `routeInputOf`). Kernel only:
  mount points, order, statuses and Socket.IO are unchanged, except that an
  unknown lease status on a files read answers `409
  project_files_unavailable`. `DeleteThread` keeps `204` (decision Q8). The
  `doric.api.*` services follow in S60c/S60d.
- 2026-11-24: phase 3, slice S60c, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.23): `transport`'s process part, not yet run (`src/host/process/`).
  `createTransportHost` serves `config`, `credentials`, `providers`, `host`,
  `terminals` and `status` over `routedTransportPorts` (routed calls through
  `runtime/contracts` `encode`/`decode`; missing provider → `unavailable`;
  unset always-present answer fields → `invalid_output`), answering
  `unavailable` "transport is not active." outside activation; the start step
  logs "Network interfaces configured" with the eight `apiServices`.
  `invalidApiInput` (`src/host/api/violations.ts`, table `apiViolations`)
  answers protovalidate refusals with today's reasons: a violation on the
  path field first, else the method's other refusal. Projects, threads,
  the `Watch` streams and `main.ts` follow in S60d.
- 2026-11-24: phase 3, slice S60d, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.24): `transport`'s `src/host/main.ts` runs `runBundle` with all eight
  `doric.api.*` services; `createTransportHost` adds `projects` and
  `threads` (workspace reads answer `pending` or `value`; `ReadFile` streams
  `head` then chunks of at most 1,048,576 code units; `ListThreads` and
  `ListEvents` cut pages under 3 MiB with a cursor only when cut, Q7;
  `DeleteThread` keeps `204`, Q8). `src/host/process/watch.ts`:
  `threadWatch` relays `runtime.threads/v1.WatchThread`, `projectWatch`
  merges `runtime/v2` and `terminal/v1` project watches (`project_snapshot`,
  `terminal_snapshot`, then held notices; `replay_failed` before both
  snapshots; `unavailable` on a second snapshot, Q4), `statusWatch`; all end
  on the call's signal or with `unavailable` on `deactivate`. Invalid `Watch`
  requests keep today's messages (Q6). Group C is complete; the Express
  routes and Socket.IO stay until group F, and `api.*` enter `provides` in
  S62.
- 2026-11-24: phase 3, slice S61a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.25, A70–A72): `bundle/platform`. The router serves `doric.startup/v1`
  (`createStartupService(sink)`; requests checked against the proto rules
  first, an invalid one answers `invalid_input` and the sink hears nothing);
  `StartupSink` moves to `src/platform/router/platform-services.ts` and the
  kernel re-exports it. `Platform extends DoricCaller`: `doric.client(service)`
  calls are served as caller `doric`. `startPlatform` takes `startup`,
  `hostPart`, `beforeListen(doric)` and `beforeStop(doric, signal)`. Boot: all
  scheduled bundles active; a required bundle or contract provider not active
  resolves with `structuralFault` (no identity read, no `beforeListen`, no
  public listener); else `stage('database_client')`, the identity read,
  `beforeListen`, then the public listener (a rejecting `beforeListen` shuts
  everything down and rejects). Shutdown fixes one deadline, closes the
  listener, runs `beforeStop` until it, then stops the supervisor
  (`Supervisor.shutdown(deadlineAt?)`). `runHostHook(doric, hook)` defines
  `doric.app.hooks/v1` before every `Run` (core keeps it in memory only).
  `stagedHostPart(bundlesDir)` finds `host/command.json`, `host/doric-<id>`
  or `host/main.mjs`; bundles without a host part are active, never spawned
  and never stopped. The kernel still boots the running host until S62.
- 2026-11-24: phase 3, slice S61b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.25): `bundle/host` exports `hostStartup(context)`, a `doric.startup/v1`
  record (`stage`, `log`) whose client is made only when called;
  `onHostStart` hands its step this object. `postgres`:
  `PostgresBackendsOptions.startup` replaces `log`; `Connect` records
  `database_client`, logs `Initializing PostgreSQL client`, connects (with the
  legacy-row check), then logs `PostgreSQL client initialized`; `main.ts`
  passes `startup`, a no-op before `activate`. `docker` and `firecracker`:
  `registerSandboxPoolStep(hooks, context, environment)` registers on
  `onHostStartHook` a step that stages `sandbox_pool` and logs `Configuring
  sandbox pool` then `Sandbox pool configured` with the `logSandboxPool`
  fields (`dockerSocketShared` for docker); a failing startup call fails
  `Handle` with its code; `main.ts` serves `HookHandlerService` and registers
  the step in `activate`. The kernel still boots the running host until S62c.
- 2026-11-24: phase 3, slice S62b1, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.26): `runtime`'s `src/executor.ts` moves to
  `src/contracts/executor-serving.ts`, exported from `runtime/contracts`
  (`serveExecutor`, `remotePromptSession`, `historyPatchItems`); `routed`,
  `routedError`, `parseInput`, `SHUTTING_DOWN` and `THREAD_CONTROL_INACTIVE`
  move to `src/contracts/routed-errors.ts` (not re-exported from the entry;
  `src/host/rpc/errors.ts` re-exports them and keeps `detached`). The export
  `runtime/executor` is removed; `packages/storage` adds `storage/rpc/chunks`;
  `default` imports from `runtime/contracts`; the `imports` boundary exception
  is removed (the `declared` one stays until S62c). Decision: window safety is
  proven by `tests/contracts-window.test.ts`, which bundles `runtime/contracts`
  for the browser with esbuild, not by `tsconfig.client.json`, which Node types
  reach through `pino-std-serializers` and `undici-types`.
- 2026-11-24: phase 3, slice S62a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.28, A61, A63, A70): `packages/bundle/src/build/host-provides.ts` adds
  `HostProvide` and `hostProvides({manifest, recorded, services, index})`:
  the `HOST`/`HOOKS` contracts of contract-role services in the host part's
  static `services` list, plus `provides` ids whose `.proto` marks them
  hooks, event, settings or storage-type and that no service serves; ids
  recorded on `host` or `desktopMain` are skipped (`chat.composer/v1` stays
  with the desktop composer). `checkRecording(manifest, recorded, served?)`
  counts served contracts for "provides declares …"; for version 2 manifests
  only, a served contract missing from `provides` fails with
  "<source>: the host part serves <id>, which provides does not declare."
  (S62c applies it to every version). `buildBundle` reads the static
  services and build index before `checkRecording` and appends a `host`
  entry per served contract `provides` lists (`local: false`,
  `schemas/<id>.json`, no schema file written); the kernel's dry activation
  stays. No real bundle's `contracts.json` changes until S62c lists
  `api.*/v1` and `executor.session/v1`. S62c must settle the schema document
  of served entries: the desktop's `client-routing.ts` leaves a contract
  without one unrouted (default deny), and the host's
  `tests/bridge-exposure.test.ts` reads it for every host service entry.
- 2026-11-24: phase 3, slice S62b2, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.26): `comments`' `src/host/rows.ts` moves to `src/contracts/rows.ts` and
  is exported from `comments/contracts`, names and signatures unchanged, with
  no shim (`codec.ts`, `comments.ts` and `ports.ts` import it from
  `../contracts/index.js`). `chat` (`turnCommentFrom`, `resolvedFrom`) and
  `papercraft` (`commentsOfEvents`) read stored comment rows through
  `commentsAddedOf` and `commentsResolvedOf` and fall back to the row as
  stored, so rows in the message's JSON encoding read correctly;
  `papercraft` now depends on `comments`.
- 2026-11-24: phase 3, slice S62b3, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.27): `runtime.threads/v1.ThreadEvents` answers the longest prefix of the
  events that encodes below `THREAD_EVENTS_MAX_BYTES` (3 MiB), at least one
  event, with `lastSequence` unchanged (proto header 1.10.0; the manifest
  stays `runtime.threads/v1@1.8.0` until S62c). `readThreadEventLog`
  (`runtime/contracts`) reads the whole log, each next cursor the last
  event's sequence, answering `undefined` when the Thread is gone and
  `invalid_output` when a page does not advance; the routed hosts of
  `comments`, `openui` and `papercraft` read through it. `transport`'s
  `ListEvents` sets `nextAfterSequence` whenever its page ends before
  `lastSequence`. Proto comments only: `api.credentials/v1` lists
  `credential_name_taken` under `ALREADY_EXISTS`, `api.threads/v1` the
  queued edit's `invalid_prompt` under `INVALID_ARGUMENT` (both 1.0.0), and
  `git.commands/v1`'s header says 1.2.0.
- 2026-11-24: phase 3, slice S62c1, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.29): `checkRecording` refuses a served contract `provides` does not declare
  in every manifest version. 27 manifests change in version 1: `transport`'s
  eight `api.*/v1`, `runtime`'s `executor.session/v1@1.0.0`,
  `runtime.threads/v1@1.10.0` and optional `executor/v1`, `core`'s optional
  `models.provider/v1`, the optional `log/v1` and `secrets/v1` of every host
  part, `terminal`'s `runtime.lease/v1`, host contracts' `provides` versions
  raised to their `.proto` headers with the `requires` ranges, and
  `chat.composer/v1@1.1.0`; `host.assets` and `host.httpPrefix` are objects.
  `declaredContracts` maps `models.provider/v1`, `storage.backend/v1` and
  `secrets.backend/v1` to `core`, and `tests/boundary-exceptions.json` is
  empty. New `tests/provide-versions.test.mjs` (`protoHeaders`,
  `findProvideVersionDrift` in `tests/support/provide-versions.mjs`) fails
  when a host contract's `provides` version differs from its `.proto` header.
  `bridge-exposure.test.ts` skips a host entry with no staged document.
  Decisions: S62c is split into S62c1 (lists), S62c2 (the public API on the
  gateway) and S62c3 (the boot); served entries get no schema document;
  client contract versions stay until phases 5–6; bundle `version` fields do
  not change. The host still boots the kernel.
