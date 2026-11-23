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
