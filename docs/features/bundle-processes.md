# Feature: bundle processes

- Status: `accepted` (phases 0–3 built; phase 3 closed by the owner's decision
  A75 with T8, AC3.6 and the host and desktop end-to-end tests on `postgres`
  not run, see "Phase 3: what was not run"; phase 4 in progress, S72–S77c2 built, see
  "Phase 4"; phases 5–8 to come)

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

Since slice S70 the spike builds only the `sqlite-node` stand-in and the
native stub. The entries of `papercraft`, `runtime`, `mcp` and `docker`
imported the kernel entries S68a, S68c and S68d deleted; S70 deleted them with
their rows, the helpers that packed `papercraft`'s native assets and its
esbuild and Tailwind check, so the spike exits 1 only when an executable fails
to build or says no Hello in time (`scripts/sea-spike.mjs`). The table above is
phase 0's record. A local run after S70, with `idleSeconds` 10 rather than the table's idle
minute (`dist/sea-spike/results-x64.json`), measured `sqlite-node` at 90 ms to
Hello, 144.0 MiB and 92.9 MiB idle RSS; the Rust stub was not built, since that
machine had no `cargo`.

### Today's host

Today's host (`app/backend/doric-host/dist/src/index.js`) with the shipped
composition, PostgreSQL 18.4, idle one minute after `Doric listening` (1.6 s
after start): 368.5 MiB over two processes, the host (210.1 MiB) and the
generation process (158.4 MiB).

### RK1

| Measure                          |     Value |
| -------------------------------- | --------: |
| Mean SEA RSS                     | 103.2 MiB |
| Mean SEA RSS × 26                | 2,682 MiB |
| Ceiling (A55, phase 0): 2.75 GiB | 2,816 MiB |

The projected 26 processes take 2,682 MiB idle, 7.3 times today's two. The
owner set RK1's ceiling at 2.75 GiB idle, measured as mean SEA RSS × 26 (spec
A55), replacing the earlier bounds of 2 GiB and 3 × today's; the measurement
passes it. Phase 3 measured the composition itself at 3,161 MiB, over that
ceiling, and the owner raised it to 4 GiB (4,096 MiB) idle for the shipped
composition, for phase 3 (AC3.16) and phase 7 (AC7.4) alike, with no bound
relative to today's (spec A74; "Phase 3: memory (AC3.16, RK1)" below).

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

## Phase 3: measurements

Slice S71 measured phase 3 on one x64 machine, not phase 0's arm64 machine: a
Debian 12 container on WSL2 (Linux 6.18.58.1), AMD Ryzen 9 3900X, 24 CPUs,
32 GiB, Node v26.13.1. It ran today's host (`4677b54c`) and the branch after
S70 (`cf60c521`) with the shipped composition idle (no Project, no window),
load average 0.6 to 0.9 before each run, five runs each, 5 s apart. The
database is PostgreSQL 18.4 in the sandbox's container
`doric-sandbox-postgres-1`, with the databases `doric_main` (today's host) and
`doric_grpc` (the branch), per spec A73; A73 names `127.0.0.1:5432`, but the
sandbox is itself a container, so the runs reached it at `172.18.0.2:5432`. The
branch's bundles are staged with `stage --dev`, so each bundle process is
`node <bundle>/dist/host/main.mjs`, not an SEA. The probes wrote their per-run
results to a scratch file outside the repository
(`/workspace/.tools/probes-s71/results.json`); its numbers are transcribed in
the tables below, which are the record.

### Phase 3: boot time (AC3.7, RK2)

Boot is the time from the host's spawn to its log record `Doric listening`.

| Host                    |   Median |          Range | Runs                              |
| ----------------------- | -------: | -------------: | --------------------------------- |
| Today's (`4677b54c`)    | 2,063 ms | 1,916–2,142 ms | 2,063, 1,916, 2,142, 2,132, 1,990 |
| The branch (`cf60c521`) | 2,100 ms | 2,087–2,178 ms | 2,165, 2,100, 2,087, 2,178, 2,095 |

The branch boots in 1.02 times today's time, under RK2's limit of twice
today's (4,126 ms), so RK2 passes. Per bundle (the table under "Phase 3:
memory"), spawn to Hello is the bundle process's time from its start to its
first `doric.platform.v1.BundleHostService/Connect` request, a lower bound of
its Hello, read by a `NODE_OPTIONS=--import` hook the bundle processes inherit
from the host (`packages/bundle/src/platform/supervisor/spawn.ts:33-51`); host
spawn to Hello counts from the host's spawn to the same request. `Activate` to
`ActivateResult` is each bundle's `activation_ms` from
`doric.diagnostics/v1.Get`, read over the router port, since the gateway does
not serve that service (`packages/bundle/src/platform/gateway/handler.ts:83-84`).
Over every bundle's five runs, spawn to Hello ran 246–714 ms (the slowest
`runtime`), host spawn to Hello 1,038–1,442 ms, and activation 2–232 ms (the
slowest `core`). The slowest Hello (714 ms) and activation (232 ms) stay far
under half of the 10 s and 60 s timeouts
(`packages/bundle/src/platform/supervisor/timings.ts:55,57`), so no timing
becomes configurable.

### Phase 3: memory (AC3.16, RK1)

RSS is `VmRSS` of the host and every descendant process 60 s after
`Doric listening`, the median of the five runs above.

| Process             | Today's (`4677b54c`) | The branch (`cf60c521`) |
| ------------------- | -------------------: | ----------------------: |
| Host                |            228.2 MiB |               191.5 MiB |
| Generation process  |            187.8 MiB |                       – |
| 26 bundle processes |                    – |               3,161 MiB |
| Total               |            416.0 MiB |               3,352 MiB |

The 26 bundle processes take 3,161 MiB (3,150.7–3,180.9 MiB over the five
runs), a mean of 121.6 MiB, and the whole branch 8.06 times today's two
processes. Against phase 0's projection (mean SEA RSS × 26, 2,682 MiB) the
bundle processes take 479 MiB more. The gap is not attributable to activation
alone: phase 0 measured SEAs on arm64 that did not run `activate`, phase 3
`node main.mjs` processes on x64 that did. RK1 failed A55's ceiling of
2,816 MiB by 345 MiB; the owner raised it to 4,096 MiB (A74), under which it
passes, 935 MiB under. One branch run without the hook (and without the
activation call) measured 3,164.5 MiB for the bundle processes, so the hook
does not move the memory; that run's boot, 2,323 ms, lies outside the hooked
runs' range (2,087–2,178 ms), and one run does not tell whether the hook moves
the boot.

| Bundle         |  Idle RSS |   RSS range | Spawn to Hello | Host spawn to Hello | Activate to ActivateResult |
| -------------- | --------: | ----------: | -------------: | ------------------: | -------------------------: |
| `chat`         | 102.8 MiB | 102.4–102.9 |         505 ms |            1,145 ms |                       3 ms |
| `claude`       | 110.6 MiB | 107.6–113.1 |         492 ms |            1,107 ms |                       8 ms |
| `claude-login` | 101.7 MiB | 101.6–102.4 |         448 ms |            1,065 ms |                       9 ms |
| `codex`        | 109.8 MiB | 108.1–112.5 |         482 ms |            1,124 ms |                       9 ms |
| `comments`     | 121.2 MiB | 119.6–121.5 |         587 ms |            1,227 ms |                      47 ms |
| `core`         | 158.6 MiB | 154.9–171.1 |         506 ms |            1,118 ms |                     136 ms |
| `default`      | 131.8 MiB | 131.6–136.3 |         589 ms |            1,235 ms |                      59 ms |
| `docker`       | 123.1 MiB | 120.2–124.0 |         591 ms |            1,220 ms |                      92 ms |
| `files`        | 127.4 MiB | 126.2–129.9 |         571 ms |            1,223 ms |                     146 ms |
| `git`          | 128.5 MiB | 126.6–129.1 |         587 ms |            1,241 ms |                      96 ms |
| `host-config`  | 109.0 MiB | 107.8–109.7 |         472 ms |            1,098 ms |                     106 ms |
| `mcp`          | 139.7 MiB | 139.1–142.8 |         662 ms |            1,320 ms |                      67 ms |
| `openai`       | 111.8 MiB | 111.7–112.3 |         487 ms |            1,119 ms |                       8 ms |
| `openrouter`   | 110.7 MiB | 108.5–113.3 |         512 ms |            1,144 ms |                       9 ms |
| `openui`       | 124.7 MiB | 123.5–124.7 |         577 ms |            1,244 ms |                      57 ms |
| `papercraft`   | 127.0 MiB | 124.2–127.7 |         562 ms |            1,229 ms |                      31 ms |
| `postgres`     | 172.4 MiB | 165.0–173.2 |         585 ms |            1,194 ms |                      15 ms |
| `resources`    | 107.1 MiB | 106.8–107.8 |         471 ms |            1,149 ms |                       5 ms |
| `runtime`      | 139.2 MiB | 138.7–139.5 |         662 ms |            1,299 ms |                     195 ms |
| `screen`       | 107.6 MiB | 107.1–108.3 |         495 ms |            1,220 ms |                       7 ms |
| `screen-relay` | 103.0 MiB | 102.2–103.6 |         576 ms |            1,257 ms |                      13 ms |
| `terminal`     | 122.1 MiB | 121.6–124.9 |         548 ms |            1,288 ms |                      42 ms |
| `threads`      | 123.4 MiB | 122.5–124.1 |         561 ms |            1,305 ms |                     109 ms |
| `transport`    | 133.7 MiB | 132.6–134.4 |         596 ms |            1,374 ms |                      20 ms |
| `usage`        | 109.6 MiB | 108.7–111.8 |         303 ms |            1,410 ms |                       6 ms |
| `web`          | 104.4 MiB | 103.0–104.9 |         262 ms |            1,419 ms |                     108 ms |

Each cell is the median of five runs (RSS ranges in MiB). Both Hello columns
run to the bundle process's first `BundleHostService/Connect` request, a lower
bound of its Hello.

### Phase 3: what was not run

Phase 3 ends when its "Ends with" in the spec's Phases table and AC3.1–AC3.16
hold. RK1's gate (AC3.16) and RK2's (AC3.7) pass. On 2026-11-27 the owner
declared phase 3 complete and let phase 4 start (spec A75), although three
checks, each a run for the owner, were not run. They stay unrun and are waived
by A75, not met:

- T8 (RK18, RK31), below.
- AC3.6 (RK6): a TCP connection from inside a Docker sandbox and from inside a
  Firecracker sandbox to the router port fails. No revision of the spec
  records it met and no test covers it; it needs the sandboxes.
- The host and desktop end-to-end tests, green on `postgres` (phase 3's end
  condition).

Phase 4 deletes the `postgres` bundle and PostgreSQL from the deployment (spec
A27, A45). After that, the end-to-end tests cannot run on `postgres`, so phase
3's end-to-end baseline on `postgres` cannot be proved anymore. T8's procedure
below stays for the owner; it is written for the branch on `postgres`, so a run
after phase 4 needs its database environment adapted.

### Phase 3: T8, for the owner to run (RK18, RK31)

T8 moved from slice S62d4 to S71. It needs the Docker sandbox with `nft` and
`CAP_NET_ADMIN`, a Docker-sandbox Project and a host that can reach the Docker
daemon, so the owner runs it. S71 wrote this procedure and ran only its
restage.

What it records:

- **RK18.** A terminal opened with `doric.terminal.v1.TerminalService/Create`
  (the branch has no `TerminalService.Start`), whose PTY runs over a
  `sandbox/v1.Start` stream through `runtime` to `docker`, while `runtime`
  drains. Record when `runtime`'s old generation stops and when the terminal's
  stream ends, against the time of the reset and the 10-minute drain deadline
  (`drainDeadlineMs`, `packages/bundle/src/platform/supervisor/timings.ts:66`).
  Expected per RK18: the stream ends, and the old generation stops, at the
  reset plus 10 minutes, unless the terminal ends first.
- **RK31.** An `mcp` stdio server connected while `mcp` changes generation.
  Record whether its tools stay listed, when the old `mcp` instance stops, and
  whether the new instance restarts the server (a new process in the sandbox).
  Phase 3 has no storage library, so this covers the stdio server only.

Prerequisites: the branch built and staged
(`app/backend/doric-host/dist/bundles`), Node 26.13.1 on `PATH`, the host's
database and credential environment as for the S71 runs (not written here),
and the Docker sandbox. All commands run from the repository root.

**The restage.** The host reads its staged bundles from `DORIC_BUNDLES_PATH`
(default `app/backend/doric-host/dist/bundles`,
`app/backend/doric-host/src/lib/bundles/boot.ts:50-62`), and every publish
reads them again. A bundle moves to a new generation when its signature
changes, and the signature includes its version
(`packages/bundle/src/platform/supervisor/publish.ts`, `signatureOf`). So the
restage works on a scratch copy and never touches the repository's staged
tree:

1. Copy the staged tree and start the host on the copy:

   ```sh
   T8=/tmp/t8; mkdir -p "$T8"
   cp -r app/backend/doric-host/dist/bundles "$T8/bundles"
   DORIC_HOST=127.0.0.1 DORIC_PORT=3071 DORIC_LOG_FILE="$T8/doric.log" \
     DORIC_STORAGE_PATH="$T8/storage" DORIC_STATE_DIR="$T8/state" \
     DORIC_BUNDLES_PATH="$T8/bundles" \
     node app/backend/doric-host/dist/src/index.js &
   ```

2. Raise the bundle's patch version in the copy: `version` in
   `$T8/bundles/<id>/manifest.json` and `bundle.version` in
   `$T8/bundles/<id>/contracts.json` (`runtime`: 3.0.0 → 3.0.1). The staged
   `host/command.json` still points to the built `main.mjs`, so the new
   generation runs the same code under a new version.
3. Call `doric.platform.catalog.v1.CatalogService/ResetComposition` on the
   public port (served without authentication, RK11); its publish reads the
   copy again and drains the bundle's old generation:

   ```sh
   call() {
     curl -sS -X POST "http://127.0.0.1:3071/$1" \
       -H 'content-type: application/json' -H 'connect-protocol-version: 1' \
       --data "$2"; echo
   }
   call doric.platform.catalog.v1.CatalogService/ResetComposition '{}'
   ```

To time the generations, read each bundle process's `DORIC_BUNDLE_ID` and
`DORIC_GENERATION` from `/proc/<pid>/environ` of the host's descendants, and
the host's log (`$T8/doric.log`); note the time of each step.

**RK18, a terminal through a draining `runtime`:**

1. Create a Docker-sandbox Project and a Thread
   (`doric.api.projects.v1.ProjectsService/CreateProject` with
   `{"name":"t8"}`, then `CreateThread` with
   `{"projectId":"<project id>","name":"t8"}`), or create them in the desktop
   against this host, and wait until the Project's sandbox is up
   (`GetProject`).
2. Open the terminal and keep output flowing:

   ```sh
   call doric.terminal.v1.TerminalService/Create '{"threadId":"<thread id>"}'
   call doric.terminal.v1.TerminalService/Input \
     '{"terminalId":"<terminal id>","data":"while :; do date; sleep 5; done\n"}'
   ```

   If the gateway answers `PERMISSION_DENIED` `undeclared_requirement`, repeat
   with the header `doric-client-part: terminal` (the desktop part that
   declares `terminal/v1`).

3. Raise `runtime`'s patch version in the copy and call `ResetComposition`;
   note the time.
4. Every 30 s, call `TerminalService/Snapshot` with
   `{"terminalId":"<terminal id>"}` until the output stops advancing or the
   session reports it exited, and at least 11 minutes after the reset.
5. Record the time of the reset, of the stop of `runtime`'s old generation and
   of the stream's end.

**RK31, an `mcp` stdio server across a generation change:**

1. In the same Project, add a stdio server that lives in the sandbox, for
   example the reference "everything" server if the sandbox image has `npx`:
   `doric.mcp.v1.McpService/Create` with
   `{"mcpServerInput":{"projectId":"<project id>","name":"t8-stdio","enabled":true,"transport":{"stdio":{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}}}}`.
   Watch the Project (`McpService/Watch`, or open it in the desktop) so the
   server connects; `McpService/List` shows it connected with its tools. Note
   the server's process in the sandbox
   (`docker exec <sandbox container> ps -ef`).
2. Raise `mcp`'s patch version in the copy and call `ResetComposition`; note
   the time.
3. Every 15 s for 11 minutes, call `McpService/List` with
   `{"projectId":"<project id>"}` (tools still listed? state?) and run the
   `ps` in the sandbox (the same pid, a new one, none?).
4. Record when `mcp`'s new generation started and its old one stopped,
   whether the tools stayed listed throughout, and whether and when the stdio
   process restarted (a new pid).

Cleanup: delete the Project (`ProjectsService/DeleteProject`) if its sandbox
container should go, then stop the host with `SIGTERM`; the database stays.

**The check already made.** On 2026-11-27 at 15:29 UTC, without a Project and
without Docker, S71 ran the restage of `runtime` on the branch:
`ResetComposition` answered `{}` in 0.42 s, `runtime`'s generation 2 (3.0.1)
was up by the answer, and generation 1 stopped 0.22 s later, with nothing in
flight to drain. The terminal and `mcp` steps were not run.

**Field names.** The terminal bodies' fields (`threadId`, `terminalId`,
`data`) match `terminal.proto`'s `CreateRequest`, `InputRequest` and
`SnapshotRequest`
(`bundles/features/terminal/proto/doric/terminal/v1/terminal.proto`). The
field names of the Projects and MCP bodies and the `doric-client-part` retry
are not verified: check them against `projects.proto` and `mcp.proto`
(`McpServerInput`) before the run.

T8's results go into this section, beside the S71 measurements above.

## Phase 4: measurements

### Phase 4: write stalls (AC4.25, RK27)

Slice S77c measured RK27's cases (a) and (b) with
`packages/storage/tests/bench/rk27.ts`, a script run by the target
`storage:bench-rk27` (`cache: false`: `npx nx run sqlite:compile:production`,
then `tsc`, then `node packages/storage/dist-tests/tests/bench/rk27.js`) and
by the report-only CI step "Run the RK27 measurements", after the heavy storage
tests, with a 30-minute timeout; it is report-only, not a test. It prints JSON
lines: `rk27.environment`; `rk27.b`, one line per run, three in all; `rk27.a`;
and `rk27.rule`, with `backfillWithin5s`, `rebuildLimit` (only when (a) takes
over 5,000 ms) and `commitOver5s`. It exits 1 only on an error; without the release binary it
says to run `npx nx run sqlite:compile:production`.

- Machine: AMD Ryzen 9 3900X, 24 logical CPUs, 31 GiB RAM, Linux
  6.18.58.1-microsoft-standard-WSL2 (Debian 12), Node 22.23.5.
- Commit: measured from the working tree after `2fd8cbb7` (S77c and S77c2
  uncommitted).
- Binary profile: release, over `openTestEngineAt(testEngineBinary('release'))`,
  built in the `rust` 1.100.0 image in about 76 s. The debug build of
  `openTestEngine()` and `sqlite:compile` compiles SQLite at -O0, so it is not
  measured (S77c's plan finding PF1); Nx cannot name a configuration in
  `dependsOn`, so the target runs `sqlite:compile:production` as its first
  command. The image ships the debug build until phase 7.
- Runs: (b) three, judged by the maximum; (a) one (the owner's decisions).
  S77c's run backfilled 200,000 documents and set the limit; since S77c2 (a)
  backfills exactly the limit, 100,000 documents in 10 commits of 10,000
  (`backfillDocuments` in `rk27.ts`), and the confirming run measured it.

| Case                | What                                                                                             | Runs                      | Result                              |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------- | ----------------------------------- |
| (b), S77c           | one `Commit` of 10,000 `Note` puts, 67,108,864 value bytes                                       | 2,634, 2,398 and 2,335 ms | max 2,634 ms, under 5,000           |
| (a), S77c           | 200,000 `Note`s of 1,024 bytes, then a `Register` adding the non-unique `byTagTitle[tag, title]` | 9,876 ms                  | 20,251 documents/s, over 5,000 ms   |
| (b), confirming run | the same                                                                                         | 2,445, 2,294 and 2,239 ms | max 2,445 ms, under 5,000           |
| (a), confirming run | 100,000 `Note`s of 1,024 bytes, then the same `Register`                                         | 4,122 ms                  | 24,260 documents/s, within 5,000 ms |

Both values are upper bounds: (a) is the `Register` call's wall time at the
client, which includes the `COMMIT` that the engine's `Rebuilt.elapsed` leaves
out (PF2), and (b)'s includes moving 64 MiB through the test transport (PF3).

Verdict: (b) passes in both runs. In S77c's run (a) passes 5,000 ms, so the
rule sets `rebuildLimit` to 100,000: limit = floor(documents/s × 5 / 10,000) ×
10,000. Slice S77c2 lowered `REBUILD_DOCUMENTS` to 100,000. The confirming run
at the limit answers `backfillWithin5s: true` and `commitOver5s: false`, with no
`rebuildLimit`, so the limit is confirmed by measurement.
The owner made these sandbox release numbers binding, since the sandbox cannot
produce the CI's numbers (PF5), and AC4.25 closes on them for (a) and (b), the
confirming run closing (a); (c) comes with S87. No T4 row names S77c: it is AC4.25's measurement (PF4).

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
  the stub crate, deleted in phase 7; since S70 the spike builds the
  `sqlite-node` stand-in and the stub only; `benchmarks/proto-codec`, deleted in
  phase 8.
- The inventory check, run by `npm run lint:test` through phase 2: every
  contract method that is not plain data had a row in section A of the
  inventory, and every row named one; a member typed `any` failed unless its
  allowlist listed it. Slice S70 of phase 3 deleted the check with its
  allowlist, support and fixtures; `inventory-targets.test.ts` still checks
  the inventory's ids and rows.
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
`packages/bundle`. In phase 2 no shipped bundle ran on it: the host still ran
the kernel and generation process, and the platform below ran in the
platform tests, the conformance suite and RK4's benchmark, with fixture
bundles; the host boots it since S62c3 (below). Its code is built and it is finished: RK4's numbers fail its rule, and the owner accepted them (AC2.2, A68; see [RK4](#rk4-provisional)).

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
  the peer is itself active. A resumable server stream the instance opened as
  caller (every bundle's `secrets/v1.WatchRedactions`) does not hold its
  drain; a unary call it made still does (S63b,
  `src/platform/router/flights.ts`).
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
  `undeclared_requirement`. A failed bind of the public listener rejects with
  `PublicListenerBindingError` (`stage: 'public_binding'`); since S62c3 the
  host enters `network_binding` before the bind and logs that stage on
  failure (Q13). The catalog index is fixed for the platform's
  life (phase 3 revisits it): a publish changes the served methods only among
  those the index holds.
  Since S62c2 the gateway serves, each path once, the public methods
  (`CatalogIndex.publicMethods()`: every method of a contract-role service of
  a `HOST` contract whose id starts with `api.`, whatever its `expose`) whose
  contract has a provider, then the methods exposed to `DESKTOP`; so
  `doric.api.*` reaches its provider over Connect and gRPC as caller `doric`,
  and answers `UNIMPLEMENTED`, `unknown_contract`, once a publish removes the
  provider.
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
gateway does not yet expose these methods to the desktop (S63–S66;
superseded by S63a, below).

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
`duplicate_skill` across bundles; since S62d3 (`skills/v1` 1.3.0)
`allowedTools` is stored as given, and each host part's own
`src/skills/*/SKILL.md` are registered by the host SDK after its `activate`.
Since S51a, `tools/v1` 1.6.0 has
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

S63a has `startPlatform` serve every member of `doric.catalog/v1`:
`Distribution` and `ReadArtifact` (`src/platform/distribution.ts`; chunks of
at most 1 MiB, the file hashed again on disk before answering, else
`not_found` with `{ sha256 }`), `Watch`, and `Disable` and `ResetComposition`
(`src/platform/composition-actions.ts`, given by the optional
`PlatformOptions.composition`, logging to the console). Each member answers
`UNIMPLEMENTED` when its option is absent. The distribution's `hostBoot` is
random per platform start. A publish adopts in this order: the supervisor,
the current resolution and the gateway, then the diagnostics
(`DiagnosticsStore.adopt`, one record per id unlike `load`, `requires` indexed
only for new ids), then the distribution, then the open `Watch` calls. A
`Watch` without `onAdopt` sends its first item and stays open. The gateway
serves the platform's `DESKTOP` methods; its other platform methods answer
`UNIMPLEMENTED` instead of 404, and an unserved path still answers a plain
404 without `unknown_contract`. Known risk accepted by the owner: `Disable`
and `ResetComposition` are unauthenticated on the public listener (see the
2026-11-25 group E entry). Open: `platform/distribution.ts` repeats the
per-bundle body of `loader/distribution.ts`'s `distributionFor`; two `Watch`
tests depend on timing.

S41c gives core its process entry `src/host/main.ts`, which calls `runBundle`
(`bundle/host`) with its nine services listed statically as `[Service,
implementation]` pairs from `CoreServices.implementations`; it is built to
`dist/host/main.mjs` (about 2 MB); its kernel entry `src/host/index.ts` is
deleted in S67.
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
declare `log/v1` or `secrets/v1` log to stdout; since S62c1 every host part
lists both as optional.

From S43 the host parts serve their contracts beside their kernel entries (see
[Evolution](#evolution) for each slice); since S67 `core` and `postgres` have
no kernel entry and serve only through their process entries, and since S68a
`claude`, `codex`, `openai`, `openrouter`, `docker`, `firecracker`,
`host-config`, `claude-login`, `resources`, `usage`, `web`, `screen`,
`comments` and `threads` have none either, since S68b neither have
`files`, `git` and `terminal`, since S68c neither have `mcp`, `openui`
and `papercraft`, since S68d neither have `runtime` and `default`, and since
S69 neither have `transport` and `screen-relay`, so no bundle has one. The
parts the executor path uses work as follows. A thrown llms provider error crosses the router as
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
`compaction_cancelled`. The kernel entries stayed in use until S62; S67 deletes
the kernel, the in-process host and the kernel entries of `core` and `postgres`,
S68a those of the fourteen bundles above, S68b those of `files`, `git` and
`terminal`, S68c those of `mcp`, `openui` and `papercraft`, S68d those of
`runtime` and `default`, and S69 those of `transport` and `screen-relay`, with
`doric.network/v1`. `default`'s `assetText` answers only the texts its
host part installed at `activate` and reads no file. Since S70 no package
exports a kernel entry: `transport` and `host-config` no longer export
`./kernel`, nor `claude`, `codex`, `openai`, `openrouter` and `terminal`
`./host`.

Since S69 the build never imports or dry-activates the host part: it
dry-activates only the desktopMain and client parts, a stale
`dist/host/index.js` is ignored, and `checkContractEnvironment` accepts a
recorded provide of a `.proto` contract only from a client part providing a
`CLIENT` contract. Since S62a the build also counts what a host part serves without recording it
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
contracts and headers that say "until phase 4" are not checked. In S62c1 the
host still booted the kernel; S62c3 switched it to the platform (below).

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

Since S62c3 the host boots the platform
([`app/backend/doric-host/README.md`](../../app/backend/doric-host/README.md),
"Startup and failures"). `src/index.ts` creates no Express app, Socket.IO
server or bridge; it calls `startHostPlatform` and `hostReady`
(`src/lib/bundles/boot.ts`). `startHostPlatform` reads the composition with
`composition.overrides.json` applied, resolves generation 1, loads a
`DiagnosticsStore` (from `bundle/runtime`), indexes the staged
`descriptors.binpb` (`readStagedCatalogIndex`) and calls `startPlatform` with
`stagedCommandOf`, `stagedHostPart` and, since S63b,
`composition: { overridesPath, read, resolve }`, so `Disable` writes
`composition.overrides.json` (a later boot starts that bundle disabled) and
`ResetComposition` clears it; `readHostResolution` takes a generation, and a
private `readBootComposition` serves both readers. S63b deleted the host's
Socket.IO bridge (`src/lib/bridge/`) and `src/lib/socket-buffer.ts`; S70
removed the host's `express`, `socket.io`, `cors`, `@grpc/grpc-js` and
`@bufbuild/protobuf` dependencies. With these, every host part runs as its own
process in activation order and client-only bundles are never spawned. Each
bundle's `descriptors.binpb` holds only its own protos, so `withBasicContracts`
merges the generated files of the 12 basic host contracts from
`bundle/contracts/gen` into the index, the staged files winning. The
platform's `beforeListen` logs `Bundles loaded`
`{bundleCount, skillCount, toolCount}`, runs `onHostStartHook`, and at its end
sets the `network_binding` stage and logs `Binding HTTP listener`
`{address}`; `beforeStop` runs `onHostStopHook`. `hostReady` runs
`onHostReadyHook` and logs a failure at `warn`; the host then logs
`Doric listening` with `port: platform.publicPort`. SIGINT and SIGTERM run
`platform.shutdown()`, then exit 0. A composition that cannot be read, or a
resolution in recovery (the catalog's core or chosen foundation provider
unavailable), logs `Bundle recovery mode` and throws `BundleRecoveryError`
before the platform starts. The `required` contracts and bundles, a missing
runtime among them, are checked only once the bundle processes started: a
missing one is the platform's `structuralFault`, and the host does the same
after `platform.shutdown()`, failing at the stage last set. Only when nothing
is missing does the platform enter `database_client` and read the storage
identity, before `beforeListen`. A bundle process's lines reach the host log through
`log/v1` (component `bundles`) and are not ordered against the host's own
lines. `project.json` stages with `stage --dev <dir> --all bundles`,
`composition.json` has no `resident` list, and `compose.yaml` gives
`firecracker` and `docker` `restart: on-failure` and `stop_grace_period: 30s`.
`core`'s `models/v1` `Catalog` writes `Model catalog could not be read`
whenever its result is `failed`.

The window reaches a host contract over Connect (slice S64): a client part's
`services.use`/`whenAvailable` of a generated service descriptor answer a
Connect client through the runtime's `hostClients` (else `unavailable`; a
`ref<T>()` keeps the envelope), which the desktop window builds with
`windowHostClients` over `windowFetch` on `window.doric.connect`
(`doric:connect`). `createClientPart(...).use(ref, { scope })` sends
`doric-scope-bin` and refuses an out-of-bounds scope with `invalid_scope`.
Electron main's `createConnectRelay` checks the sender, the request, the
`doric-client-part`, that the client part is active and that the method is a
`DESKTOP` method of a `HOST`, non-platform contract of the window's generation,
indexed from the distributed `descriptors.binpb` (none or unreadable: a warning
and `unknown_contract`), then decodes the scope (it relays the scope without
checking it against the contract's declared scope kinds, RK37 of the spec); it
replaces `windowKey`, drops `doric-caller*` and forwards over HTTP/2 to the
host. `bundle/client` and `@connectrpc/connect` are client externals served
once by the window import map. Since S66 Electron main's own calls, the catalog
and the status included, go over Connect too, on one `connectHost` connection
(`src/platform/host/connect.ts`) whose `api.status/v1` watch is the connection
status and whose forward carries a window's Connect request;
`src/platform/bridge/host-bridge.ts` and
`src/connection/{manager,status,relay}.ts` are deleted.

Since S65a, `runtime`'s and `chat`'s client parts call the host this way.
`runtime` builds `RuntimeService` and `ThreadsService` clients lazily through
`services.use`; `api/host.ts` adapts them to `RuntimeHost` and `ThreadsHost` for
`records`, `project-watch` and `workspace-api`, which are not ported yet, and
`thread-views` opens `ViewThread` over Connect. `chat` uses `ThreadsService`
(watch, threads API, `setThreadExecution`, fence watches), `AttachmentsService`
(default binding) and `whenAvailable(ModelsService)` for icons, where an
`UNIMPLEMENTED` `Icons` reads as no icons, and reads errors through
`fromConnectError`; `composer.ts` stays on the envelope until phase 5. Since
S65b, `papercraft` watches Threads over `ThreadsService` (dropping events at or
below its cursor after a `generation_lost` reopen), reads programs over
`PapercraftProgramsService` (Read as a stream of chunks of at most 1 MiB,
re-encoded as base64 for `papercraft.cache/v1.ensure`, which stays on the
envelope), lists and resolves comments over `CommentsService` and reports errors
through `openui`'s `ProgramsService.ReportErrors`; `openui` calls
`QuestionsService` for Status and Answer and `ProgramsService.ReportErrors`.
Since S65c, `settings` calls `HostConfigService`, `ModelsService`, `ToolsService`
and `SecretsService` over Connect, each answer read back as today's shape
through `runtime/contracts`' `decode` (and each request written with `encode`
where the wire shape differs), since the wire has no `null`; it recognises a
Connect failure by shape, because it declares no `@connectrpc/connect`, and
imports `host-config/contracts/gen/...` directly, `host-config` being a
devDependency. `git` calls `CommandsService` and `SecretsService.List`; `mcp`
calls `McpService` and `SecretsService`, its `Watch` following `for await` with
an `AbortController` and resubscribing only after `disconnected` or
`unavailable`, because the SDK reopens a resumable stream after
`generation_lost`, and converts its views in `src/client/codec.ts`;
`claude-login` calls `LoginService`, a `Finish` answer outside
`credentialDescriptionSchema` reading as `invalid_output` and a `ConnectError`
without a Doric error detail as `internal`, "The request could not be
completed." `doric.browser/v1` and `workspace.dashboard/v1` stay on the
envelope. Since S65d, `files` calls `FilesService` (`Tree`, `Directories`,
`Content`, `CreateFile`, `CreateDirectory`) scoped to the Project and reads each
answer back as today's lease outcome, a lease state staying data (`pending` with
`Retry-After: 1`) and a refusal reading as not found for `not_found` and as
`invalid_path` otherwise; `terminal` calls `TerminalService` (`List`, `Create`,
`Snapshot`, `Input`, `Resize`, `Stop`, `Rename`), scoping only `list`, `create`
and the `WatchProject` stream it opens, and reads that stream's items as today's
`TerminalWatchItem`s, resubscribing only after `disconnected` or `unavailable`,
since the SDK reopens it after `generation_lost`; `screen` calls
`SessionsService.attach` scoped to the Project, its answer decoded with
`AttachResponseSchema`; `usage` calls `UsageService` (`Thread`, `Compact`,
`CompactionTarget`, `SetCompactionTarget`), turning the caller's deadline into a
relative `timeoutMs`; and `resources` calls `ResourcesService` (`Host`,
`Project`), `host()` unscoped. `files`, `terminal`, `usage` and `resources` read
their failures through `fromConnectError`; `screen` answers no answer for any
failure. The fault sentences the old path showed stay the same. A catalog
manifest accepts `host.assets`, and the build's dry activation answers
`use(<DescService>)` of a host contract with an inert stub after checking the
descriptor against the part's lists (a descriptor without the contract option
is refused).

### Phase 4

The owner's decisions A76–A78 settle phase 4: `sqlite` in Rust is the only
storage engine, with no TypeScript backend. Slice S72 (spec version 6.56,
[Phases](../designs/grpc-processes.md#phases), "Phase 4's slices") adds the Rust SDK of
section 10, "The Rust SDK": `packages/bundle-rs`, the crate `doric-bundle`
(described in its [README](../../packages/bundle-rs/README.md)). It is the
bundle side of the control stream, server side only: a bundle implements
`Bundle` (`services`, `activate`, `stop`), registers its methods in `Services`
(`unary`, `server_stream`, `client_stream`) and calls `doric_bundle::run` from
`main`. Per A28 it has no client of the router, so a Rust bundle calls no other
bundle. It does not validate requests against protovalidate rules, but a
request that does not decode ends the call `invalid_input`. Its conformance
fixture
`packages/bundle-rs/examples/conformance.rs` mirrors the TypeScript fixture,
and `packages/bundle/tests/conformance/rust.test.ts` runs the conformance
suite against it; `bundle:conformance` depends on
`doric-bundle:compile-example`.

Where the spec says nothing, S72 chose:

- a handler is polled once before the reader takes the next frame, as the
  TypeScript SDK runs it synchronously;
- after `StopResult` the SDK waits up to 250 ms (`FLUSH_GRACE`) for the host to
  end the stream;
- a cancelled call waits for its handler instead of aborting it, and ends
  `CANCELLED` whatever the handler answers;
- a method the bundle did not register answers `unknown_contract`
  (`UNIMPLEMENTED`);
- the process exits 70 also when its environment is missing or malformed and
  when the connection fails;
- logs are JSON lines on stdout with `level`, `msg`, `bundleId`, `generation`
  and `incarnation`; lines logged before the environment is read have no
  instance fields;
- a request that does not decode ends the call `invalid_input`; in a
  client-streaming call it is the last item of `Requests`, an `Err`;
- a panic in `activate` answers `internal`; a panic in `stop` is logged, and
  `StopResult` and exit 0 follow;
- a control stream that ends during the stop exits 0;
- the process exits 70 also when the first host frame is neither `Accepted`
  nor `Rejected`, and when its runtime fails to start;
- an empty environment variable counts as missing;
- a `deadline_unix_ms` of 0 or NaN means no deadline;
- the Hello timeout of 10 s counts from process start;
- handlers still running at exit are abandoned;
- `FLUSH_GRACE` starts once `StopResult` has left the outbound queue.

Rules for bundle authors, from S72's review:

- a handler must not block before its first `.await`: the SDK polls it once
  before reading the next frame, so a blocking handler holds back
  `HealthCheck`, `CallCancel`, `CallCredit` and `Stop`, and the host can
  quarantine the instance after `health_timeout`; blocking work goes to
  `tokio::task::spawn_blocking`;
- the 4 MiB limit applies to the encoded frame, not only to the message:
  a response whose frame would pass it ends the call `limit_exceeded`. The
  review applied the same rule to the TypeScript SDK's call server
  (`packages/bundle/src/sdk/host/serve.ts` measures the encoded
  `ConnectRequest` frame) and added two boundary cases to the conformance
  suite, run on both fixtures: `bundle:conformance` went from 58 to 62 tests.

S72's verification: T4.5 and AC4.3 pass on x64 in this sandbox
(`npx nx run bundle:conformance`, 58 of 58 tests, the TypeScript and Rust
fixtures, run before the review added the two boundary cases above; 62 of 62
after it); arm64 is left to CI. AC4.6 holds for the SDK:
`#![forbid(unsafe_code)]`, clippy with `-D warnings`, `rustfmt --check`, and
`cargo test` with 6 tests and 1 doctest.

Slice S73 (spec version 6.56, QD, T4.21) adds the contract
`storage.kv/v1` (`packages/bundle/proto/doric/storage/kv/v1/kv.proto`,
`KvService` with `Get`, `Range` and `Commit`, generated as `kv_pb.ts`; per A76
it has no count or size rules) and `startTestProcess` in `bundle/testing`
(`packages/bundle/src/testing/process.ts`), which spawns one built bundle
process under a test router, activates it and hands the test Connect
transports whose calls reach the process as host-to-bundle calls. As of S73,
nothing serves or calls `storage.kv/v1` yet. The conformance suite's `Session` moves
to the internal `src/testing/conformance/session.ts` and answers a process's
own calls with `undeclared_requirement`. `bundle:test` also runs
`tests/testing/*.test.js` and depends on `doric-bundle:compile-example`.

Where the spec says nothing, S73 chose:

- an empty `command` rejects with `ContractError('invalid_input')`;
- a unary or client-streaming call that ends OK with other than one response
  fails `internal`;
- the instance and every stamped caller have version `0.0.0`, generation 1
  and incarnation 1;
- a stricter Hello check: besides another bundle or generation it rejects
  another protocol version or incarnation, a first frame that is not Hello and a
  control stream without the instance token;
- a call's deadline comes from the Connect call's `timeoutMs`;
- bidi-streaming methods are supported too;
- `process.ts` imports `session.ts` lazily, when `startTestProcess` runs.

S73's verification: `bundle` typecheck, build and test (1382 pass) and
`bundle:conformance` (62 pass). Known issue: `tests/platform/drain.test.js`,
"starts generation 2…", is flaky; it failed once in a full run and passed
alone 10 of 10 times.

Slice S74a adds the engine bundle
[`bundles/foundation/sqlite`](../../bundles/foundation/sqlite/README.md) (crate
`doric-sqlite`, Nx project `sqlite`), the first server of `storage.kv/v1`, in
Rust on `rusqlite` 0.43.0 with SQLite bundled, and `doric_bundle::log(Level,
&str)` to the Rust SDK. The root `Cargo.toml` gains the member and `rusqlite`;
`package-lock.json` is regenerated (below). What it does:

- one file, `$DORIC_STORAGE_PATH/doric.sqlite3`, in the current directory when
  the variable is unset or empty; WAL, format `user_version = 1`;
- the open reads `user_version` first and refuses an unknown format
  (`storage_format_unsupported`) or a missing directory
  (`storage_path_missing`) without touching anything;
- one writer thread with a queue of 64 runs the commits one at a time in
  `BEGIN IMMEDIATE` transactions; four read-only connections serve `Get` and
  `Range`, which answer through channels of 16;
- the prefix check (`not_owner`), the limits (`limit_exceeded` with
  `details.limit`) and A76's `invalid_input` refusals run before any
  transaction;
- every call before activation answers `unavailable`; stop runs
  `wal_checkpoint(TRUNCATE)`, so the `-wal` file is empty after it unless the
  checkpoint is blocked or fails, which is logged at `warn`.

Cancellation, now in section 17 of the spec: a `Commit` whose stream ends
because the call was cancelled writes nothing; a cancelled `Commit` writes
nothing unless the writer has already begun its transaction; a cancelled read
stops at its next answer; the SDK ends a cancelled call with gRPC `CANCELLED`.
A checkpoint failure on stop is logged at `warn` and the connection still
closes. The order of the checks is part of the contract (see the bundle's
README, "Errors"). The manifest is S75b's; not yet: read-only mode (S88, with
the inspection tool; the spec records the deferral).

The lockfile: S72 added `doric-bundle` without updating `package-lock.json`,
so `npm ci` failed from S72 on. S74a regenerated it with
`npm install --package-lock-only --ignore-scripts` (provenance per HC-008):
it gains `doric-bundle` and `sqlite` and drops 25 stale `extraneous`
workspace entries.

S74a's verification: `cargo test` with 43 tests (`sqlite`) and 8 tests and 1
doctest (`doric-bundle`); `nx run-many -t lint test build format-check compile
-p sqlite doric-bundle` with `-D warnings`; `bundle:conformance` (62 pass); and
an end-to-end smoke through `startTestProcess`: a put answers position 1, a get
answers the value at version 1 and nothing at 0, `b/k` from caller `a` is
`not_owner`, and stop exits 0 with an empty `-wal`.

Slice S74b adds the TypeScript side of `storage.kv/v1` in
[`packages/storage`](../../packages/storage/README.md):

- the error codes `condition_failed` (gRPC `ABORTED`), `storage_path_missing`
  and `storage_format_unsupported` (both `FAILED_PRECONDITION`, the default) in
  `contractErrorCodes` of `bundle/contracts`;
- `Kv`, `kvLimits` and `kvClient` from the root entry `storage`: the client
  interface, the frozen limits by the names `details.limit` reports, and the
  adapter of a Connect `KvService` client that turns every `ConnectError` into
  its `ContractError`;
- `runKvConformance` from `storage/conformance`, the KV conformance kit: 29
  cases at S74b (33 since S75a, 31 of them in a default run), the last a seeded sequence of 2,000 operations checked against a
  model (seed 20261127, or `DORIC_KV_SEED`);
- the entry `storage/testing` with `openTestEngine`, which spawns the debug
  `doric-sqlite` binary through `startTestProcess`, in a `mkdtemp` directory
  that `close()` removes or on a given `path` it leaves; the internal
  `openTestEngineAt` in `test-engine.ts` takes the binary path;
- the tests `kv.test.ts` (T4.2, the kit on the engine), `kv-file.test.ts`
  (T4.18, the storage path and file format) and `test-engine.test.ts` (T4.20,
  without its `openTestStorage` case, which S77b1 built as TE1–TE2);
- `storage:test` depends on `sqlite:compile`, and CI's platform test step runs
  `storage`.

Its decisions:

- `openTestEngine` finds the repository root by walking up from its module to
  the nearest directory holding `nx.json`, so it works from `src`, `dist` and
  `dist-tests/src` alike.
- The kit compares the hexadecimal `details.key` of a refusal without regard
  to case, so an engine may answer either case.
- The `commitItems` case is slow, 66.5 s of `kv.test.ts`'s 76.9 s: it sends a
  commit of 200,001 items, refused, and one of 200,000, which passes. S75a
  moved it out of `storage:test` into `storage:test-heavy`.

S74b's verification: `storage:test` passes 248 of 248 in about 77.5 s
(`kv.test.ts` 76.9 s, `kv-file.test.ts` 1.07 s, `test-engine.test.ts`
1.65 s); before `kvClient` existed the kit passed against the real engine
through an adapter with seeds 20261127, 1 and 42; `nx affected -t typecheck`
passes on 57 projects. Still to come then: `openStorage` and `openTestStorage`
(built in S77b1), the storage library (S77–S78), and the deletion of `storage/memory` and
the old suites (S85a).

Slice S75a (spec version 6.56, "S75's plan") adds the native host part:

- a v2 manifest's `host.kind` is `sea` (the default) or `native`; a native
  part refuses `host.httpPrefix` and `host.assets`;
- for a native part the build runs no host esbuild, refuses a bundle that has
  `src/host/main.ts`, and takes the contracts the part provides from
  `nativeProvides({ manifest, index })`: each listed id the index knows as a
  `HOST` contract with a contract-role service;
- `stage` writes `host/command.json` with the absolute debug executable under
  `--dev`, and otherwise copies the release executable to `host/doric-<id>`
  (0755); both come from `StageOptions.targetDir`, by default
  `resolve('dist/target')`;
- `storage.kv/v1` becomes a basic host contract (13 in all) and a backend: a
  foundation bundle that replaces a facade may require it, and its providers
  activate with the other backends first;
- the KV kit's two 200,001-item cases (`commitItems` among them) run only
  under `runKvConformance(harness, { heavy: true })`: a default run registers
  31 of the 33 cases, and the new target `storage:test-heavy` and CI step
  "Run heavy storage tests" (30-minute timeout) run the heavy 2;
- `clientFailure(error, call?)` answers `cancelled` or `deadline_exceeded`
  for an `internal` or `cancelled` failure once the call's signal has aborted
  or its deadline has passed, so `kv-client.test.ts` no longer fails on a
  deadline that surfaced as `internal`.

The `sqlite` manifest is S75b.

S75a's verification: `bundle:test` passes 1399 of 1399;
`doric-host:build-bundles` succeeds; `storage:test` passes 256 tests in about
22–25 s and `storage:test-heavy` 2 tests in 203 s; `kv-client.test` passed 50
consecutive runs after the deadline fix.

Slice S75b (spec version 6.57) gives `sqlite` its manifest:

- `bundles/foundation/sqlite/manifest.json`: version 2, `1.0.0`,
  `engines.doric` `^1.0.0`, provides `storage.kv/v1@1.0.0`, `host.kind`
  `native`; the package is at `0.0.1`, tagged `type:rust` and `type:bundle`,
  and the `kv.proto` header reads `storage.kv/v1 (host, 1.0.0)`;
- monodon's cargo `build` target is renamed `sqlite:check`; `sqlite:build` is
  the bundle build, depending on `compile` and `bundle:build`, and
  `bundle:test` depends on it;
- `doric-host:build-bundles` builds and stages `sqlite` (`host/command.json`
  naming the debug executable); `sqlite` is not in the composition until S84;
- the host image (`app/backend/doric-host/.Dockerfile`) copies cargo and
  rustup from a digest-pinned `RUST_IMAGE` stage, sets
  `RUSTUP_TOOLCHAIN=1.100.0`, installs `gcc` and `libc6-dev`, copies the Cargo
  files and `stub-rs`, and keeps only
  `dist/target/doric-sqlite/debug/doric-sqlite`; three broken `mkdir`/`mv`
  lines are removed, since tsc already writes `dist/src/`;
- `package-lock.json`: the `sqlite` entry goes from `1.0.0` to `0.0.1`,
  regenerated with
  `npx -y npm@11.13.0 install --package-lock-only --ignore-scripts`;
- tests: T4.22's platform case (`native-host.test.ts`);
  `platform-contracts.test.ts` checks manifests in their published form, with
  `host.kind` stripped; `tests/lint.test.mjs` checks that the Rust image tag
  and `RUSTUP_TOOLCHAIN` match `rust-toolchain.toml`.

S75b's verification: `bundle` and `sqlite` pass 1401 Node tests and 43 cargo
tests (T4.22 in 2.6 s); `storage:test` 256 of 256; `lint:test` 49 of 49 and
`boundaries.test.mjs` 37 of 37. The `doric-host` tests were not run (no
database). The image builds: `DOCKER_BUILDKIT=0 docker build --target
agent-runtime` exits 0, and in the image `find dist/target -type f` lists only
`dist/target/doric-sqlite/debug/doric-sqlite` and
`app/backend/doric-host/dist/src/index.js` exists.

Slice S76 (spec version 6.57) splits `sqlite` and makes `storage.kv/v1`
platform-only:

- `bundles/foundation/sqlite` is two crates in the one Nx project `sqlite`:
  `engine/`, the library `doric-sqlite` (`SqliteEngine`, the traits
  `KvEngine`, `ReadTxn` and `WriteTxn`, the types `KeyRange` and `Entry`,
  `refusal`, `sqlite_version`, `limits`, `kv`), and `storage/`, the package
  `doric-storage`, whose binary keeps the name `doric-sqlite` and its path
  `dist/target/doric-sqlite/{debug,release}/doric-sqlite`; the root
  `Cargo.toml` lists both. `check` and `compile` run on `doric-storage`;
  `test`, `lint` and `format-check` cover both crates, and `test` has no
  `production` configuration;
- `storage.kv/v1` serves only the caller `doric`: any other caller is
  `not_owner` (`storage.kv/v1 serves only the platform.`, no details) before
  any limit, store or I/O; the guarantee-8 prefix checks and the order of the
  checks are unit-tested in `engine/src/access.rs` (inline) and
  `engine/src/limits/tests.rs`;
- a `KvEngine` write is one `BEGIN IMMEDIATE` transaction on the writer
  thread, its position consecutive with the KV commits; `on_commit` runs after
  `COMMIT` and a rollback drops it; `foreign_write` uses
  `PRAGMA data_version`. A read is a `BEGIN DEFERRED` snapshot on a reader;
- the gateway's `servedMethods` never serves a method of `internalContracts`
  (`['storage.kv/v1', 'storage/v2']`, `packages/bundle/src/contracts/ids.ts`);
- the KV kit calls as `doric` throughout: `access.ts` keeps one refusal case
  for other callers, the two-caller race case is gone, and the kit has 30
  cases (28 in a default run, 2 heavy); `kv-client` and `test-engine` call as
  `doric`, and `test-engine` gains a refusal case;
- the `kv.proto` header and the `Kv` and `TestEngine` doc comments say only
  the platform is served;
- known limitation: `cargo doc` warns of an output filename collision between
  the binary `doric-sqlite` and the library `doric_sqlite`.

S76's verification: `sqlite` is green, `doric-sqlite` passing 62 tests and
`doric-storage` 3; `storage:test` 254 of 254; `storage:test-heavy` 2 of 2 in
about 175 s; `bundle:test` 1402 of 1402 in the implementation run. In the
cleanup run `drain` flaked twice under load, then passed 10 of 10 alone.

Slice S77a1 (spec version 6.57) adds the `storage/v2` contract and the
engine's index-key library, with no handler serving the contract yet:

- `packages/bundle/proto/doric/storage/v2/storage.proto`
  (`storage/v2 (host, 2.0.0)`, package `doric.storage.v2`): `Register`, `Get`,
  `Query`, `Read`, `Commit`, `Health`, `PutBlob`, `GetBlob` and `DeleteBlob`;
  `RegisterRequest`/`RegisterResponse` carry a descriptor set of at most
  2 MiB, a limit the `Register` handler enforces from S77a2, `QueryPage` has `optional string next_cursor`, and the other messages
  are copied from `storage/v1`. It coexists with `storage/v1`, which `core`
  serves until S84; `sqlite` serves it from S77a2;
- `storage/v2` is a basic host contract (now 14), in `basicHostContractFiles`
  and in `BACKENDS`, so its providers come first among the foundation and a
  foundation facade replacement may require it, and in `internalContracts`
  since S76;
- `doric-storage` gains `lib.rs` with `keys` (`Element`, `encode`, `decode`,
  `key`, a byte-for-byte port of `encodeIndexKey` and `decodeIndexKey` of
  `packages/storage/src/keys.ts`) and `schema` (`json_form`, protobuf-es
  `toJson` with `alwaysEmitImplicit` over prost-reflect
  `skip_default_fields(false)`, and `index_values`, as `indexValues` and
  `resolvePointer`); the Rust engine owns the encoding;
- the golden file `bundles/foundation/sqlite/storage/tests/fixtures/index-keys.json`
  is written by the one golden test in `schema.rs` with
  `DORIC_WRITE_GOLDEN=1`, from the fixture `storage/tests/fixtures/index_keys.proto`,
  outside every buf module and compiled by protox;
  `packages/storage/tests/index-parity.test.ts` (T4.23) recomputes every key
  with `keys.ts` and protobuf-es;
- the Cargo workspace gains `prost-reflect` (with `serde`) and `serde_json`,
  and `Cargo.lock` 7 packages.

S77a1's verification: `doric-sqlite` passing 62 tests and `doric-storage` 15
lib tests and 3 bin tests; `storage:test` 257 of 257; `bundle:test` 1405 of
1405, after one run that flaked and two reruns that passed; `buf lint` and
`proto-check` pass.

Slice S77a2 (spec version 6.57) serves `storage/v2`'s `Register` from
`sqlite`, which is still not in the composition:

- `bundles/foundation/sqlite/proto/doric/storage/layout/v1/layout.proto`
  (package `doric.storage.layout.v1`, generated only for Rust):
  `TypeDeclaration`, `IndexDeclaration` and `DocumentHeader`; it is a buf
  module in `buf.yaml`, and `buf export` puts it in `dist/proto`;
- `storage/build.rs` generates the messages of `storage/v2` and `layout` with
  services cleared, keeping the `google/protobuf/*` files prost-build needs
  for `google.protobuf.Value`;
- `doric-storage` gains `layout.rs` (the record keys `("schema", hash)`,
  `("schema.current")`, `("type", t)` and `under`),
  `schema/declarations.rs` (`pool` and `declarations`) and `register.rs`
  (`prepare` and `Registrations::apply`), and `testing.rs`, which compiles
  test protos with protox; `doric_sqlite::hex` is now `pub`;
- `Register` refuses the caller `doric` and a type or stream prefix outside
  the caller's namespace with `not_owner` (a type's namespace is everything
  before its first `.` or `/`, a stream prefix's owner everything before its
  first `.`), a descriptor set over 2 MiB with `limit_exceeded`, and with
  `invalid_input` an index field that is not a singular scalar or well-known
  value, more than 16 indexes or 8 fields, a duplicate index name, a type
  declared twice, and an empty or more-than-128-byte id; it reads the
  `storage_type` and `stream_entry` options with prost-reflect;
- it hashes the set with SHA-256 and stores the schema and current, writes
  nothing for a set with nothing new, rewrites a declaration without a
  rebuild when only `messageType` or `schema` changes, answers changed
  indexes on a type that has documents with `invalid_input` ("not supported
  yet") until S77a4a, which removed the refusal, keeps the highest generation in engine memory only, and
  collects the schemas no longer named;
- `manifest.json` provides `storage/v2@2.0.0`; the workspace gains `sha2` 0.11.2
  (8 packages); `doric-storage` gains `sha2`, `prost-types`, and the build
  dependencies `protox` and `tonic-prost-build`, already workspace
  dependencies;
- `drain.test.ts` and the scripted fixture gain the mode `call-on-trigger`:
  "starts generation 2…" makes its second call only after `publish`
  resolves, which removes its timing race;
- the scripted fixture gains the provider mode `generations-held`, whose
  `Register` holds its answer until the log has a line starting with
  `test answer `, and `triggered()` takes that prefix: "lasts while a unary
  call it made is in flight…" publishes, checks that generation 1 has not
  deactivated, writes `test answer 0`, then waits for `settings answered` and
  for app 1.1's `deactivated`, and waits for the draining state through the
  publish answer, since the app's mode `call-repeat` logs no `changed:` event.
  Both races were in the tests, under CPU load, not in the router. The test
  alone passes 3 of 3, the whole `drain.test` under 25 busy loops 3 of 3, and
  `crash.test` under the same load 3 of 3.

S77a2's verification: `doric-sqlite` passing 62 tests and `doric-storage` 45
lib tests and 7 bin tests; `storage:test` and `lint:test` (49 of 49) pass;
`buf lint` and `proto-check` pass; `bundle:test` 1406 of 1406, twice, after
both drain fixes.

Slice S77a3a (spec version 6.58), the first half of S77a3, serves
`storage/v2`'s `Commit` and `Get` from `sqlite`, still not in the composition:

- `Commit` refuses the caller `doric`, then checks each item as it arrives: an
  item with no case set is refused, stream items are refused
  (`Stream items are not supported.`); a chunk needs a put before it and holds
  1 byte to 1 MiB; then the type's length, its namespace and the id's length
  (512 bytes); an expected revision in 0..=u32::MAX; 10,000 items, `chunk`
  items not counted (`limit_exceeded` `"batch"`); 16,777,216 bytes per document
  (`"document"`), then 67,108,864 bytes per batch (`"batch"`). When the stream
  ends, a cancelled call is `cancelled`, then an empty batch is refused. A read
  transaction then answers `unknown_type` (puts, expects and deletes), decodes
  indexed puts and computes their keys; a key over 2,048 bytes without its
  prefix is `limit_exceeded` `"indexKey"`. The writer reads the declarations
  again and recomputes keys whose declaration changed (the change is never
  refused, but a recomputed put can still fail with `invalid_input`,
  `invalid_index_value` or `limit_exceeded` `"indexKey"`, before any
  `revision_conflict`), then runs expects
  (`revision_conflict` `{type,id,expected,actual}`), deletes and puts
  (`unique_conflict` `{type,index}`, per put, against the state after the
  batch's deletes and earlier puts). Only values of a type with indexes are
  decoded. Revisions count per put, so a
  delete then a put restarts at 1; values are re-split at 983,040 bytes.
- `updatedAt`, only in `DocumentHeader`, is monotonic within one process, in
  `toISOString`'s format; two commits may share it.
- `Get` checks `doric`, the type's length, the namespace and the id's length,
  then `unavailable` and `unknown_type`, and streams through a bounded channel;
  an absent document answers no item, as in v1.
- Descriptor pools are cached in memory, 32 per process, least recently used,
  keyed by schema hash; a failed build is not cached.

S77a3a's verification: `doric-storage` 107 lib and 7 bin tests, `doric-sqlite`
62; no test exercised the handlers `commit_documents` and `get_document` then
(resolved by S77b1's CL1–CL3 and S77b2's conformance kit). `npx nx run-many -t check compile lint test
format-check build -p sqlite --skip-nx-cache`, with clippy `-D warnings` and
`cargo fmt --check`, passed.

Slice S77a3b (spec version 6.59), the second half of S77a3, serves
`storage/v2`'s `Query` from `sqlite`, which completes S77a3:

- `Query` refuses the caller `doric`, then checks that the request holds a
  `storage_query` (`A query request holds a storage_query.`), the type's length
  and namespace, a `limit` of 1–1000 (`LIMIT`), an `order` absent, `asc` or
  `desc`, the kinds of the values in `equals` and then of the bounds (no kind is
  `invalid_input`; a struct, a list or a non-finite number is
  `invalid_index_value`, in `equals` too), the bound pairs, and a cursor in
  unpadded base64url; then `unavailable`; then, in the read transaction,
  `unknown_type`, an undeclared index (`Type T has no declared index …`), the
  arity (`equals` no longer than the index's fields, and shorter when there is a
  range) and a cursor within the bounds
  (`The cursor is outside the query's bounds.`).
- A page is one read transaction, so one snapshot: up to `limit` + 1 entries,
  reversed for `desc`, strictly after the cursor; the `page` item comes first,
  then each `document` and its chunks; an empty result is one `page` item.
  `next_cursor` is set only when a (`limit` + 1)th entry exists, as the
  unpadded base64url of the tuple bytes of the page's last document's entry
  (not the (`limit` + 1)th entry's) after `("idx", type, name)`: the values
  for a unique index, the values then the id for a non-unique one, whose ties
  sort by id, bytewise. A non-unique entry whose last element is not a string is
  `internal`, which cannot be reached.
- `keys::bounds` ports `keyBounds`; `Get` and `Query` share `DocumentItems`,
  `emit_document` and `Engine::stream_read`; `base64` 0.22.1 is a workspace
  dependency.

S77a3b's verification: `doric-storage` 143 lib and 7 bin tests (the six `bounds`
tests of `storage/src/keys.rs:384-495`; `query/tests/{check,page,paging}.rs`, 13, 10 and 7), `doric-sqlite`
62; no test exercised the handlers `get_document`, `commit_documents` or
`query_documents` then (resolved by S77b1's CL1–CL3, for the first two, and
S77b2's conformance kit, for all three). `npx nx run-many -t
check compile lint test format-check build -p sqlite --skip-nx-cache`, with
clippy `-D warnings` and `cargo fmt --check`, passed.

Slice S77a4a (spec version 6.60), the first half of S77a4, makes `storage/v2`'s
`Register` rebuild the indexes of a type that has documents in the same write
transaction (A81), instead of refusing with `invalid_input`
(`storage/src/register/backfill.rs`):

- Indexes are compared as whole declarations, name, fields and `unique`; only
  the ranges are cleared by name, so a rename is a removal plus a new index and
  a change of fields or `unique` under one name is a change. The changed or
  removed ones are cleared, the new or changed ones built, in declared order; a pure reorder rebuilds nothing
  (OQ3). Each header's `index_keys` is rewritten in declared order, the
  unchanged indexes keeping their keys, and its revision and `updatedAt` stay
  (OQ6).
- A rebuild of more than 100,000 documents (`REBUILD_DOCUMENTS`; 200,000 until
  S77c2, which lowered it on RK27's measurement, see "Phase 4: write stalls"),
  a removal included, is `limit_exceeded` with `"rebuild"`, counted keys-only
  before any decode; exactly the limit passes (OQ4). The ids are collected first, since a
  range visitor cannot call `get`, so one value is held at a time (S77a4's plan finding PF7).
- A duplicate under a rebuilt unique index is `unique_conflict` with
  `{ type, index, ids }`, `ids` the holder then the second document in id key
  order; only the first, of the lowest index in declared order, is reported,
  after every document is read (OQ2). The walk goes on after a conflict is
  recorded: if a later document fails to decode, fails `index_values` or
  `layout::index`, or is missing its header or a chunk, that error is answered
  instead of the recorded `unique_conflict`. No test covers the first-conflict
  rule across two unique indexes yet; the only conflict test has one. `Commit` keeps `{ type, index }`; S77b's
  conformance case Q10 must expect `ids` from a rebuild (OQ10, S77a4's plan finding PF4).
- A value that does not decode keeps `json_form`'s `invalid_input` (OQ5); an
  index field that holds an object or an array is `invalid_index_value`, from
  `schema::index_values`; a new key over 2,048 bytes is `limit_exceeded` with
  `details.limit` `"indexKey"`, from `layout::index`; a message missing from
  the pool, a missing header or chunk, a header that does not decode and a
  document key that holds no id are `internal`. Any error rolls back the
  declaration, the schema, `schema.current` and the generation.
- The handler logs each rebuild at `info`:
  `Rebuilt the indexes of <type>: <n> documents in <ms> ms.` (OQ8, S77a4's plan finding PF5).

S77a4a's verification: `doric-storage` 154 lib and 7 bin tests (12 in
`register/tests/backfill.rs`, the 200,000-document rebuild, about 4.6 s, and the
200,001 refusal in the normal suite, OQ11; the 200,000 documents carry empty
`DocumentHeader::default()` headers and the change only removes an index, so
nothing is decoded, and the longest stall stays for S77c's case (a)), `doric-sqlite` 62; `cargo test`,
clippy `-D warnings`, `cargo fmt --check` and `npx nx run-many -t check compile
lint test format-check build -p sqlite` passed.

Slice S77a4b (spec version 6.61), the second half of S77a4, adds the cache of
document headers (A80, `storage/src/cache.rs`) and fixes the engine's
`data_version`:

- PF1: `engine/src/writer.rs`'s `run`, the `storage.kv/v1` commit path, no
  longer reads or stores `data_version`; only `transact`, a storage write's
  transaction, does. Before, a foreign write followed by a `storage.kv/v1`
  commit was hidden from the next storage write. `WriteTxn::foreign_write`'s
  doc says a `storage.kv/v1` commit changes neither its answer nor what it
  compares against (E1, `engine/src/store/foreign.rs`).
- `Headers` caches `Header`, a `DocumentHeader` without `chunk`, in an LRU
  bounded in bytes: `CACHE_BYTES` (64 MiB), each entry its key, its
  `index_keys` and `ENTRY_BYTES` (64). An entry larger than the bound is not
  cached, a bound of 0 caches nothing, an absent document is never cached
  (OQ7), and clones share one cache.
- `DORIC_SQLITE_CACHE` (`CACHE_VARIABLE`): unset, empty or `1` turns the cache
  on, `0` off; any other value, non-UTF-8 included, fails the activation before
  any open with `invalid_input`,
  `DORIC_SQLITE_CACHE is "0" or "1"; "<value>" is not.` (the value through
  `to_string_lossy`, the coordinator's choice) and `details.variable` (OQ9).
  `activate` calls the private `activate_from(storage_path, cache)` with
  `std::env::var_os`, which sets nothing on an error, so the tests need no
  `set_var`, which `forbid(unsafe_code)` with edition 2024 forbids (PF8).
- `Headers::begin(txn)` clears the cache when `foreign_write()` is true and
  returns a `Staged` overlay: `header` reads what it staged, then its clean
  reads, then the cache (skipped for a forgotten key), then the transaction,
  keeping a transaction read as clean unless the key was forgotten; `put` and
  `forget` stage; `finish` queues the puts, removals and clean reads on
  `on_commit`, and a rollback drops them. A cache hit still updates the LRU
  recency inside the transaction, which a rollback does not undo; that changes
  only the eviction order (R2). `Commit` (`commit::apply`)
  reads expects, deletes and puts through it and calls `finish` only on
  success; `Register` (`register::write`) calls `begin` first (PF2), and its
  rebuild forgets each header it rewrites (OQ6), reading full headers through
  `stored_header` since it needs `chunk` and writing with `txn.put`. `Get` and
  `Query` never use it.
- Every `KvEngine::write` of `doric-storage` calls `Headers::begin` first,
  whether it touches headers or not: `transact` stores `data_version` after
  every write (`engine/src/writer.rs:258`), so a write that skips it would hide
  a foreign write from the next one (RK38). S78's head-only appends and S87's
  `Import` must follow it. Test fixtures that plant raw headers, such as
  `plant_headers`, are exempt.
- PF9: T4.25's other-process case uses a put's revision (H3, H4); the append
  case is S78's and the `Import` case S87's.
- Test moves, with no change of behaviour, for the 500-line rule: the binary's
  4 tests to `storage/src/main/tests.rs`, which also holds M1 and M2 (6 in
  all; the other 3 bin tests stay inline in `storage/src/kv.rs`, `kv::tests`),
  and the engine's to `engine/src/{writer,store,limits,readers}/tests.rs`
  (`engine/src/access.rs` keeps its tests inline).

S77a4b's verification: `doric-sqlite` 63 tests, `doric-storage` 168 lib and 9
bin tests (H1–H13 in `cache/tests.rs` and `cache/tests/{writes,engines}.rs`,
H3 and H4 each with a bound of 4,096 and of 0; M1 and M2; E1); `cargo test`,
clippy `-D warnings`, `cargo fmt --check` and `npx nx run-many -t check compile
lint test format-check build -p sqlite` passed.

Slice S77b1 (spec version 6.62), the first half of S77b (OQ9), adds the
`storage/v2` TypeScript client and its test helpers; S77b2 adds the v2
conformance suites in `packages/storage/src/conformance/v2/` (OQ1), with the
stream cases written as skipped tests until S78 (OQ2).

- `packages/storage/src/client/`: `types.ts` holds the full `Storage`
  interface (OQ4): `get`, `query`, `commit`, `read`, `health`, `putBlob`,
  `getBlob`, `deleteBlob`; `CommitBatch` with `expect`, `put`, `delete`,
  `dropStreams`, `truncate` and `append`; `StorageQuery` uses `IndexScalar`.
  Until S78 the engine refuses stream items with `invalid_input` "Stream items
  are not supported.", and `read`, `health` and the blob methods answer
  `unknown_contract` ("This bundle does not serve
  /doric.storage.v2.StorageService/<Method>."). `values.ts` (internal):
  `encodeValue` checks the type, then protovalidate, and refuses with
  `invalid_input`, `{type, id}` and the first violation in the message (OQ5);
  `chunksOf` makes chunks of at most 1 MiB, none for an empty value;
  `decodeValue` raises `invalid_output` with `{type, id}` and keeps unknown
  fields; `messagesOf` finds nested messages. `index.ts`:
  `descriptorSetBytesLimit` (2,097,152), `openStorage(context, files)`,
  `registerOver` and `storageOver`; it registers once, with no registration
  tracking (OQ8), and checks the descriptor set before any call. Its own
  `calling(call, run)` stays beside `rpc/call.ts`'s `calling(run)`, since
  merging them would change behaviour (a cleanup finding). `queryAll` goes to
  S80 (OQ7).
- `storage/testing`: `TestEngine.storage(bundleId, files, generation = 1)` and
  `openTestStorage(bundleId, files)`, which answers
  `TestStorage {storage, kv, reset, close}`; `reset()` calls `engine.reset()`
  and registers the files again, since the KV clear deletes the declarations
  (PF4).
- `bundle/testing`'s `transport(caller, generation = 1)` stamps the caller's
  generation (PF8, OQ6); `bundle/contracts` re-exports `closure`.
- `sqlite` (PF3, OQ3): a `storage.kv/v1` commit outside `doric/` suspends the
  header cache. `kv.rs`'s `outside_platform(request)` is true for a put,
  delete or positioned put outside `doric/`, or a clear range not within
  `["doric/","doric0")`; `commit` then takes `Headers::suspend()` after
  `finish` and `store()`. `begin` clears the cache while a suspension is held,
  and dropping the `Suspension` clears it again; on a cancel after the
  suspension is taken it is forgotten, so the cache stays off for that
  process, while a cancel seen earlier returns before any suspension exists. Before, `reset()` left
  the cache stale, since such a commit does not change `data_version`.
- `packages/storage/proto/doric/storage/conformance/v1/conformance.proto`
  declares `Note`, `Thread` and `Plain` for the suites; `storage` gains a
  `generate-proto` target, `./contracts/gen/*` and `@bufbuild/protovalidate`;
  `buf.gen.yaml` maps `doric/storage/conformance/` before `doric/storage/`
  (PF9). Variant declarations are built at run time (OQ10).
- Carried forward: PF1 (snapshot, C2, C3 and the failure suite's stream parts
  need S78), PF2 (the v1 kit stays for `postgres`, `memory` and `rpc` until
  S85a and S85b), PF5 (T4.8's `not_owner` through raw clients) and PF7 (the
  cases v2 changes), recorded in the spec's S77b1 block.

S77b1's verification: `storage` 274 tests (CL1–CL13 in
`storage-client.test.ts`, CL2's 16 MiB round trip about 0.9 s; TE1–TE3),
`bundle` 1409 (P1), `doric-sqlite` 63, `doric-storage` 171 lib and 11 bin
tests (S1 ×3, S2 ×2). The sandbox has no host `cargo`, so the Rust checks ran
in the `rust` 1.100.0 Docker image, and `storage:test` and `bundle:test` ran
without their cargo-dependent tasks.

Slice S77b2 (spec version 6.63) completes S77b with the `storage/v2`
conformance kit in `packages/storage/src/conformance/v2/`, not exported; the
v1 kit in `src/conformance/` is unchanged.

- `harness.ts`: `conformanceBundle` (`'conformance'`), `conformanceFiles`,
  `untilS78 = 'S78: streams'`; `V2Engine`, a `TestEngine` plus
  `raw(caller, generation)`; `V2Harness` with
  `open(bundleId?, files?, generation?)`, `raw`, `reset` and `fresh()`, a new
  engine for the generation cases, since `reset()` keeps the remembered highest
  generation (the kit closes it when the case ends); `V2Case`, `V2CaseOptions`
  (`skip`, `timeout`), `caseGroup`, `openV2Engine`, `openV2Harness` with
  `V2HarnessOptions` (`name`, `openEngine`), which answers `V2HarnessHandle`, a
  `V2Harness` with `close()`.
  `support.ts` holds run-time variants of the tests' helpers (`src/` cannot
  import `tests/`); `fixtures.ts`'s `contract` maps a raw `ConnectError` to a
  `ContractError`, deliberately not `rpc/call.ts`'s `calling`; `files.ts`
  builds the `FileDescriptorProto`s, with `streamFiles()` and `eventPrefix`,
  the stream prefix `conformance.note.events/` of the skipped cases. The
  `untilS78` doc comment lists every skipped case. A stray empty file
  `v2/{harness,support,index}.ts`, left by a failed brace expansion, was
  removed with its compiled outputs.
- `index.ts`: `storageV2Cases`, `instanceV2Cases`, `registrationV2Cases`,
  `v2ConformanceCases`, `runV2Case` and `runStorageV2Conformance(options)`
  with `V2RunOptions` (`name`, `cases`, `openEngine`, `skip`, `timeout`),
  which opens the harness before the cases and closes it after them, as
  `runKvConformance` does; the default timeout is 120 s.
- 63 cases, 41 active and 22 skipped with `untilS78`: D1–D7, `T4.3-prefix`,
  `T4.3-16MiB`; R1–R3; Q1–Q4; Q5, Q6, T4.9; Q7–Q10 (Q10's rebuild answers
  `unique_conflict {type, index, ids}`) and T4.23; C1, C4 and `not_owner`
  through raw clients, C2 and C3 skipped; X1, X2 and X5's document parts,
  `X1-streams`, X3, X4 and `X5-streams` skipped; P1 and P2 skipped; L2,
  `L2-bytes` and L3, no L1; REG1–REG5; GEN1–GEN3, each on `fresh()`. Also
  skipped, written in full against `Storage` (OQ2): `streams.ts` S1–S6 (group
  `sequence with gaps`, ported from v1 with `NoteEvent`) and
  `T4.3-event-3MiB` (an event of exactly 3,145,728 bytes round-trips, one byte
  more is `limit_exceeded`); `blobs.ts` B1–B5 and `T4.3-health`
  (`{status: 'unavailable', writable: false, reason: 'storage_unmeasurable'}`,
  or `ok` with integer `disk.blocks > 0` and `0 ≤ availableBlocks ≤ blocks`);
  `concurrency.ts` `not_owner-streams` (T4.8, in `storage-instances.test.ts`).
  `storageV2Cases` includes `streamCases` and `blobCases`. Not ported: B1's
  "blobs are not commits" (no `lastPosition`), B2's base64 refusal (v2 takes
  bytes; B2 checks that pieces give the same hash) and H2 (no `identity()`).
  Open for S78: no `details.limit` is named for an event over 3 MiB, so
  `T4.3-event-3MiB` checks only the code. S78 enables the skipped cases and
  may adjust their stream prefix.
- Behaviours the cases pin, confirmed against the engine: a range bound of
  another kind is allowed (`{gt: true}` on a number field); an empty type id is
  `invalid_input`, not `not_owner`; a no-field index lists every document in id
  order; a `Storage` registered without `Plain` refuses a `Plain` get with
  `invalid_input` before any call; `limit_exceeded`'s details are exactly
  `{limit}`. D1 indexed a 4,096-byte `tag` at first, which the engine rightly
  refused (`{limit: "indexKey"}`, A36); those bytes moved into `body`.
- `test-engine.ts`: `openTestEngineAt(binary, options?)` also answers
  `raw(caller, generation = 1)`; new `testEngineBinary()`; `repoRoot` moved
  here from `testing.ts`; `openTestEngine` is unchanged.
- S77b1's drift, fixed (CI1–CI10 in `storage-client-items.test.ts`): an
  appended event is chunked (an `event` item of at most 1 MiB, then `chunk`
  items); an event that encodes to 0 bytes is `invalid_input {stream}` before
  any call (`min_len: 1`); an `append` with no events is `invalid_input
{stream}` before any call (CI10); `dropStreams` and `truncate` on an undeclared stream
  are `invalid_input` before any call; `types.ts`'s summary of the client's own
  refusals is aligned.
- Cleanup findings: `fileOf` is duplicated in `v2/files.ts` and
  `tests/support/descriptors.ts` across the `src`/`tests` boundary;
  `npx biome check` on the package reports pre-existing format and import-order
  errors in `conformance/kv/*` and `rpc/*`.

S77b2's verification: `storage.test.ts` 49 cases (19 skipped),
`storage-instances.test.ts` 6 (3 skipped), `registration.test.ts` 8,
`storage-client-items.test.ts` 10; `storage` 347 tests, 325 pass, 0 fail, 22
skipped. Run times vary: L2 takes about 7–8 s
and REG5 about 1–2 s; `L2-bytes`, L3 and `T4.3-16MiB` about 1 s each.

Slice S77c (spec version 6.64) measures RK27's cases (a) and (b) on the
release binary: `packages/storage/tests/bench/rk27.ts`, the target
`storage:bench-rk27`, `testEngineBinary(profile = 'debug')` in
`src/test-engine.ts` and the report-only CI step "Run the RK27 measurements".
Its results are under "Phase 4: write stalls".

S77c's verification: its run of `storage:bench-rk27` printed the S77c rows
above, 200,000 documents for (a).

Slice S77c2 (spec version 6.64) lowers `REBUILD_DOCUMENTS` in
`bundles/foundation/sqlite/storage/src/register.rs` to 100,000 on S77c's
measurement; `register/tests/backfill.rs` rebuilds exactly 100,000 documents
and refuses 100,001 with `limit_exceeded` `{limit: "rebuild"}`. `rk27.ts`
backfills exactly the limit (`backfillDocuments = 100_000`, 10 commits of
10,000), since the engine refuses more. `COMMIT_ITEMS` and `commitItems`,
200,000, are unchanged.

S77c2's verification: `doric-sqlite` 63 tests, `doric-storage` 171 lib and 11
bin tests; `cargo test`, clippy `-D warnings` and `cargo fmt --check` pass;
`storage` 347 tests, 325 pass, 22 skipped; `storage:bench-rk27` exits 0 with
the confirming run under "Phase 4: write stalls".

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
- 2026-11-24: phase 3, slice S62c2, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.30): new `CatalogIndex.publicMethods()` lists every method of the
  contract-role services of every `HOST` contract whose id starts with `api.`,
  whatever its `expose`, in file then declaration order, the same array on
  every call. The gateway's `servedMethods` serves those whose contract has a
  provider, then the `DESKTOP` methods, each path once. Decision (Q11): the
  public API is recognised by the contract id `api.*`. The host still boots
  the kernel until S62c3.
- 2026-11-24: phase 3, slice S62c3, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.31): the host boots through `startHostPlatform` and `hostReady` on
  `startPlatform`, with no Express, Socket.IO or bridge; `Doric listening`
  logs `platform.publicPort`; SIGINT and SIGTERM run `platform.shutdown()`
  and exit 0; `Binding HTTP listener` logs `{address}` at the end of
  `beforeListen`; a recovery logs `Bundle recovery mode` and throws
  `BundleRecoveryError`. `withBasicContracts` adds the basic host contracts
  to the staged index. `stage --dev`, no `resident`, Compose restart and
  grace settings. `core`'s `Catalog` logs `Model catalog could not be read`
  on every `failed` result. Tests: `boot`, `bundles` and `secret-logs`
  rewritten, `bridge.test.ts` deleted, `tests/helpers/api.ts` and
  `processes.ts` new. Decisions: S62c3b rewrites `tests/helpers/platform.ts`
  and its four users (C3-1); the dropped `bundles.test.ts` cases (PC23, B14,
  stage-1 parity, kind registration, firecracker activation) come back in
  S62d or group E (C3-4). Open item: `packages/bundle` has no helper for the
  basic contracts; moving `withBasicContracts` there needs an exported list
  of basic files or an option of `readStagedCatalogIndex` or `startPlatform`.
- 2026-11-24: phase 3, slice S62c3b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.32): the host's test helper `tests/helpers/platform.ts` boots the platform
  through `startHostPlatform` (staged `postgres`, `core`, `host-config`,
  `openai`, `openrouter`, `codex` and `claude`), checks that no kernel runner
  is left and that the public listener answers, and reads credentials and
  configuration over `secrets/v1` and `settings/v1` with `host-config/testing`;
  each platform fixture gets a fresh database (`databaseFixture`).
  `host-config`'s `unpackConfiguration` drops any `models` or `reasonings`
  list, empty or not, that the provider's kind does not keep (an unknown
  kind keeps its lists), so a stored `codex` provider no longer breaks the
  boot; `packConfiguration` and
  `unpackConfiguration` are exported from `host-config/testing`. Decisions:
  four `reference-race` cases stay `todo` until S62d, since `settings/v1` does
  no reference check and `host-config` refuses through its in-flight
  references (C3b-1); `credential-adapter`'s memory cases run on the platform
  over PostgreSQL instead of `createTestRouter` (C3b-2); the host helper reads
  configuration through `host-config`'s one reader (C3b-3). Left for S62d:
  `startHost`'s users in `packages/bundle` and the `core` and `postgres`
  test support, `memoryFoundation`'s in `packages/storage` and
  `app/desktop/doric`.
- 2026-11-24: phase 3, slice S62d1, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.34): `core`'s `secrets/v1.List` takes its turn in core's write queue, so a
  List that starts during a Delete answers after it settles, without the
  deleted id; a `host-config` replacement checking its credentials in that
  window could otherwise store a reference to a removed credential. `Delete`
  still asks `host-config`'s reference source, which reads `settings/v1.Get`
  outside the queue. `reference-race.test.ts` runs its four former `todo`
  cases over `host-config/v1` and `secrets/v1` as `doric`, holding a
  replacement in flight with the new `tests/helpers/held-catalog.ts`.
  Decisions: S62d is split into S62d1–S62d4; a delete during a replacement in
  flight answers `referenced` and the replacement is stored, a replacement
  after the delete answers `invalid` (Q3); no code for the remaining kernel
  users, which leave with S67, group F, phase 4 or group E (Q1).
- 2026-11-24: phase 3, slice S62d2, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.35): `doric-host-e2e` drives the host over `doric.api.*` with Connect JSON
  requests, in three cases: the T3.1 flow, the T3.1 refusals and AC3.5. The
  46 unary refusals answer HTTP 400 `invalid_argument` with their reason;
  `ProjectsService/ReadFile` and the two `Watch` streams answer the refusal in
  the Connect end message with HTTP 200. `socket.io-client` leaves
  `doric-host-e2e`'s `package.json`, and `tests/helpers/socket-inbox.ts` is
  deleted. Decisions: one `package-lock.json` line, made by this slice only
  (Q4); AC3.5 does not assert the pause reason (Q7).
- 2026-11-24: phase 3, slice S62d3, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.36): `withBasicContracts` and `basicHostContractFiles` move to
  `bundle/platform` (`packages/bundle/src/platform/basic-contracts.ts`), used
  by the host's boot. Each bundle registers its own `src/skills/*/SKILL.md`
  from its process: the host SDK (`registerBundleSkills`) reads them through
  `context.assets` after `activate` and registers them before
  `ActivateResult`, tracked for replay; a bad skill is skipped and logged
  `skill not registered`. `skills/v1` 1.3.0 stores `allowedTools` as given.
  Manifests: `core` 1.17.0, `files` 1.10.0, `git` 1.4.0, `threads` 2.2.0, `web`
  1.1.0, `default` 2.8.1. `doric-host`'s `bundles.test.ts` restores the owed
  host cases (C3-4, T3.2, T3.11, T7) and drops the kernel fixtures
  `crash-on-activate` and `probe`; the e2e gains T6 and stops on a failed
  Project with its `errorCode`. Decisions: SK-1 (Doric does not enforce
  `allowed-tools`), SK-2 (no platform registration, no ordering), replacing
  D10-6; `unavailable_tool` stays in the shared list until group F; the
  `yaml` parser in each host part's `main.mjs` (about 270 KB) is accepted;
  PC23 is S62d3b; T8 moves to S71 and P9 is met.
- 2026-11-25: phase 3, slice S62d3b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.38). PC23 runs on the platform in `doric-host`'s new
  `papercraft-library.test.ts`, over `doric.api.*`, with the platform fixture
  `tests/fixtures/platform-bundles/nodeless-sandbox` (a `sandbox/v1@1.1.0`
  provider whose `Exec` exits 127) in place of `docker`; the kernel fixture
  `generation-bundles/nodeless-sandbox` is deleted. `recorded()` and
  `baseEnvironment()` move into `tests/helpers/platform.ts`. No production
  change.
- 2026-11-25: group E's plan and phase 3, slice S64, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.37). Plan: S63a → S63b → S64 → S65a–d → S66; `scripts/fake-host` is to
  be retired in group E, though S66 leaves it in place because retiring it
  needs the root `package.json` edited, which no group E slice does; main may
  import `transport`'s generated status client.
  Known risk accepted: `Disable` and `ResetComposition` stay reachable without
  authentication on the public listener, since the host runs on a private
  network reached only through a Tailscale tunnel; without that, bind
  `DORIC_HOST=127.0.0.1`, filter the listener or authenticate those methods.
  S64 builds the window's Connect path: the client SDK's `scope`, the
  runtime's `hostClients`, `descriptors.binpb` in the distribution,
  `bundle/client` and `@connectrpc/connect` external, `windowFetch` and
  `windowHostClients`, and main's `createConnectRelay` with a per-generation
  descriptor index and `hostProviders`. `ClientContext.services` stays
  `Services`; client parts narrow with `as ClientServices`. Known gaps: a
  unary forward is not aborted when its window is destroyed; no test streams
  end to end through Electron; the desktop e2e needs `--no-sandbox` as root,
  which the nx `e2e` target does not pass.
- 2026-11-25: phase 3, slice S63a, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.39): the platform serves `doric.catalog/v1` in full (`Distribution`,
  `ReadArtifact`, `Watch`, `Disable`, `ResetComposition`) and the gateway
  serves the platform's `DESKTOP` methods; `PlatformOptions.composition`,
  a random `hostBoot`, a fixed publish order and `DiagnosticsStore.adopt`.
- 2026-11-25: phase 3, slice S63b, of
  [`docs/designs/grpc-processes.md`](../designs/grpc-processes.md) (version
  6.40): the host passes `composition` to `startPlatform`, so `Disable` and
  `ResetComposition` work on the booted host; the bridge and
  `socket-buffer.ts` are deleted; the router's drain no longer waits on
  resumable server streams the instance opened as caller. Open: the drain
  guard test asserts on the provider's log order, because a caller can receive
  `Stop` before a unary answer reaches its code; the host tests call over
  fetch with the generated schemas, as `@connectrpc/connect-node` is not a
  `doric-host` devDependency.
- 2026-11-25: phase 3, slice S65a, of
  [the spec](../designs/grpc-processes.md) (version 6.41): `runtime`'s and
  `chat`'s client modules call `RuntimeService`, `ThreadsService`,
  `AttachmentsService` and `ModelsService.Icons` over Connect; each bundle's
  tests use a fake `HostClients` over `createRouterTransport`, and the desktop
  e2e harness gains Connect fakes behind `hostForward`. Fixes: `53e2da80`
  (`catalogManifestSchema` accepts `host.assets`) and `fde5a1a4` (the dry
  activation answers `use(<DescService>)` of a host contract). Open: the
  contract-option read is copied in three files; `api/host.ts` stays an adapter
  until `records`, `project-watch` and `workspace-api` are ported; the e2e cases
  are unverified.
- 2026-11-25: phase 3, slice S65b, of
  [the spec](../designs/grpc-processes.md) (version 6.42): `papercraft`'s and
  `openui`'s client modules call `ThreadsService`, `PapercraftProgramsService`,
  `CommentsService`, `QuestionsService` and `ProgramsService.ReportErrors` over
  Connect; `papercraft.cache/v1.ensure`, the comment composer and send stay on
  the envelope. Each bundle's tests use a fake `HostClients` over
  `createRouterTransport`; papercraft's `fakeFrames` keeps a strong reference
  to its `MutationObserver` callback. Open: the `ClientServices` casts stay until
  the props are narrowed.
- 2026-11-25: phase 3, slice S65c, of
  [the spec](../designs/grpc-processes.md) (version 6.43): `settings`'s, `git`'s,
  `mcp`'s and `claude-login`'s client modules call `HostConfigService`,
  `ModelsService`, `ToolsService`, `SecretsService`, `CommandsService`,
  `McpService` and `LoginService` over Connect; each answer is read back as
  today's shape through the host's codec where the wire has no `null`, and each
  Connect failure is read through `fromConnectError`. `doric.browser/v1` and
  `workspace.dashboard/v1` stay on the envelope, and `mcp`'s `Watch` reopens
  through the SDK after `generation_lost` and resubscribes itself only after
  `disconnected` or `unavailable`. Each bundle's tests use a fake `HostClients`
  over `createRouterTransport`, and the desktop e2e harness fakes the settings
  services and `git.commands/v1` over Connect
  (`tests/support/{settings-host,workspace-content,workspace-host,transcript-500}.ts`),
  where `tests/settings-connect.test.ts` exercises them.
  Open: the `ClientServices` casts stay until the props are narrowed, and
  `settings` reads a Connect failure by shape because it declares no
  `@connectrpc/connect`; no test covers `git`'s Versioning credential list;
  `chat-connect.test.ts` and `settings-connect.test.ts` build their own forward
  without the git routes, so a git call there answers `UNIMPLEMENTED`.
- 2026-11-25: phase 3, slice S65d, of
  [the spec](../designs/grpc-processes.md) (version 6.44): `files`', `terminal`'s,
  `screen`'s, `usage`'s and `resources`' client modules call `FilesService`,
  `TerminalService`, `SessionsService`, `UsageService` and `ResourcesService`
  over Connect, each answer read back as today's shape. `terminal` gains
  `stream-source.ts` for `WatchProject` and `contracts`' `terminalOneofs`, and
  only `disconnected` and `unavailable` resubscribe, the SDK reopening the
  stream after `generation_lost`. Each bundle's tests use a fake `HostClients`
  over `createRouterTransport`; the `files` and `resources` story harnesses
  answer a generated service descriptor by its contract id; the desktop e2e
  harness fakes the four services behind `hostForward`
  (`tests/support/{workspace-content,workspace-host,transcript-500}.ts`),
  `transcript-500.ts` answering `terminal/v1` over Connect in place of the
  Socket.IO fake, and `screen` is the one contract it answers on nothing.
  Open: the `ClientServices` casts stay until the props are narrowed, and the
  e2e `terminalRoutes` fake holds its `WatchProject` stream open with a snapshot
  alone, so no `updated` or `output` item is exercised over Connect.
- 2026-11-25: phase 3, slice S66, of
  [the spec](../designs/grpc-processes.md) (version 6.45): Electron main speaks
  Connect. `src/platform/host/connect.ts` holds `connectHost`; one
  `Http2SessionManager` and one `ConnectTransport` over it serve the
  `api.status/v1` `StatusService.Watch` that is the connection status, main's
  own calls and the forward a window's Connect request travels on;
  `subscribe` hears changes and `onStatus` every attempt's outcome.
  `src/platform/bridge/host-bridge.ts` and
  `src/connection/{manager,status,relay}.ts` are deleted; `DispatcherDeps.host`
  (a `HostBridge`) is removed, the existing `connection: ConnectionSource` now
  imports from `host/connect`, and a host route on the envelope answers `unavailable`; `project.json` sets `externalDependencies: []`. Tests:
  new `tests/host-connect.test.ts`; the e2e `startFakeHost` is a Connect server
  on `node:http2` beside the legacy Socket.IO envelope; the envelope refusal is
  covered by `tests/dispatcher.test.ts` and `tests/core-scope.test.ts`; loopback
  HTTP/2 tests cover the forward's body, response, streaming and cancel, which
  fixed a forward that sent no request body. Open: `scripts/fake-host` is not retired (that
  needs the root `package.json`, which no group E slice edits); the Connect
  relay enforces no `desktopScope` (RK37 of the spec); the forward's error is a
  `ContractError` `unavailable` rather than a `ConnectError`; the e2e fake
  host's Socket.IO half is unused and is deleted in group F.
- 2026-11-26: phase 3, slice S67, of
  [the spec](../designs/grpc-processes.md) (version 6.46): the kernel and the
  in-process host are deleted. Gone: `packages/bundle/src/process/` (its
  `ajv.ts` moves to `src/sdk/host/ajv.ts`, and `bundle/host` keeps
  `ajvValidators`, which the root `bundle` no longer exports),
  `src/loader/activate.ts` (`startHost`), the kernel `doric.startup/v1`
  provider and `providePlatformServices`' `startup` option, `unavailable_tool`
  from the shared error-code list (no longer "until group F"),
  `kernel_requires_generation` from the quarantine reasons, the root `bundle`
  exports of the kernel, its transport and partitions (`StartupSink` stays in
  `bundle/platform`, where `doric-host` imports it), `storage/memory`'s
  `memoryFoundation`, `core`'s kernel entry and facades and `postgres`'
  `src/host/index.ts` (`activatePostgres`, `postgresEmbedded`); both bundles'
  `host-build.test.ts` assert that `dist/host/index.js` is absent. Decisions:
  `packages/bundle/tests/generation.test.ts` stays (it tests the live
  `activateEnvironment` and `generationOf`), `postgres`' `connectDatabase`
  stays for `createPostgres`, `core`'s `models/providers.ts` keeps
  `ConfiguredProvider`, `work-hold.test.ts` stays (Q-F3), and `core`'s
  dependency on `tool` is a boundary exception until S70. The kernel's
  lost-hold handover and window-hold cases are retired with no counterpart:
  the platform drains on work holds per instance.
- 2026-11-26: phase 3, slice S68a, of
  [the spec](../designs/grpc-processes.md) (version 6.48): the kernel entries
  `src/host/index.ts` of `claude`, `codex`, `openai`, `openrouter`, `docker`,
  `firecracker`, `host-config`, `claude-login`, `resources`, `usage`, `web`,
  `screen`, `comments` and `threads` are deleted, with `host-config`'s
  `src/kernel.ts` (`createHostConfig`, `HostConfig`, `boundTools`), the
  providers' `createKindProvider`, `claude-login`'s `loginService`,
  `resources`' `resourcesService`, `usage`'s `usageService`, `screen`'s
  `screenSessionsService`, `comments`' and `threads`' kernel ports and
  `kernelRegistrable`, and `docker`'s and `firecracker`'s `logSandboxPool`;
  each bundle's `host-build.test.ts` asserts that `dist/host/index.js` (and
  `host-config`'s `dist/kernel.js`) is absent. Decisions: `threads.ts` stays
  for `ThreadToolPorts`, `ScreenLease` stays for `rpc/lease.ts` and
  `rpc/sessions.ts`,
  `activateDockerSandbox` and `activateFirecrackerSandbox` stay for their
  tests, and contract exports without importers stay until a later slice; the
  package exports `./host` and `./kernel` dangle until S70. No boundary
  exception was needed.
- 2026-11-27: phase 3, slice S68b, of
  [the spec](../designs/grpc-processes.md) (version 6.49): the kernel entries
  `files/src/host/index.ts`, `git/src/host/{index,service}.ts` and
  `terminal/src/host/index.ts` are deleted, with the kernel symbols only they
  used, among them `terminal`'s `terminalService`, `TerminalHost.definition`
  and `TerminalList`; each bundle's `host-build.test.ts` asserts that
  `dist/host/index.js` is absent, and the kernel suites are ported onto the
  router or deleted (`files`' `activate`, `binding` and `router-files-parity`,
  `git`'s `router-parity` and `router-parity-project`, `terminal`'s `provider`
  and `router-parity`). Decisions: `files/src/host/{ports,sandbox}.ts`,
  `git/src/host/{ports,sandbox}.ts` and `terminal/src/host/{ports,peers}.ts`
  stay with only their live types (`git`'s `LeaseSandbox` too, which
  `routed.ts` uses); `createTerminalHost` stays as the live part's builder;
  `FilesV1`, `filesMethods`, `GitCommandsV1`, `gitMethods`, `TerminalServiceV1`
  and `terminalServiceMethods` stay until S69, since `transport` imports them;
  `TerminalV1` and `terminalMethods`, which nothing imports, stay until S69 as
  the plan schedules, a pending orphan of X4; `files/v1`'s `ContentInput.encoding` stays for
  `papercraft`. The routed `edit` answers `File not found: <path>` for a
  missing file again (it answered `Failed to read file: ENOENT: …` since S53):
  the lease's read failure arrives as `ContractError('internal', 'ENOENT: …')`
  without a Node code, so `edit` also reads a message that starts with
  `ENOENT:` as a missing file, a check that depends on the message text. Four
  boundary exceptions until S70 keep the dependencies the deleted tests
  orphaned: `files` → `pino` and `sandpool` (`tests/binding.test.ts`) and
  `terminal` (`tests/support/services.ts`); `git` →
  `@bufbuild/protovalidate` (`tests/support/parity.ts`). `terminal`'s `./host` package export dangles until
  S70.
- 2026-11-27: phase 3, slice S68c, of
  [the spec](../designs/grpc-processes.md) (version 6.50): the kernel entries
  `src/host/index.ts` of `mcp`, `openui` and `papercraft` are deleted, with the
  kernel symbols only they used: `mcp`'s `kernelMcpPorts`, `TOOL_ORDER` and
  `toDoricTool`; `openui`'s `kernelOpenuiPorts`, `questionsService`,
  `createValidation`'s service and `readSkillBesideModule`; `papercraft`'s
  `kernelPapercraftPorts`, `createPrograms` (with `ProgramsHost`),
  `createLibraryHooks`/`LibraryHooks`, `sandboxJobRunner`, `sandboxBundler`,
  `readRunnerBesideModule`, the probe wrappers (`probeSource`, `probeBytes`,
  `probeRepositoryRoot`, `kernelReaders`) and `readSkillBesideModule`; and the
  dead copy-md steps of `openui`'s and `papercraft`'s `project.json`. The
  skills and the runner are staged only through `host.assets`
  (`dist/host/skills/*.md`, `dist/sandbox/runner.mjs`) and read through
  `context.assets`; the host contracts in `contracts.json` are `local: false`,
  `mcp` and `openui` build no `schemas/`, and `papercraft`'s `dist/schemas`
  keeps only its desktop and client contracts. Each bundle's
  `host-build.test.ts` asserts that `dist/host/index.js` is absent, and the
  kernel suites are ported onto the router or deleted. Decisions: the three
  `ports.ts` stay for their live port types; seven `papercraft` exports whose
  only importer was the index re-export (`pickExport`, `pickStory`,
  `CompiledComponent`, `CompiledStyles`, `HARNESS_DIRS`, `harnessCandidates`,
  `SandboxBundle`) are no longer exported, their code kept; `moduleNative`,
  `bundleInSandbox` and `SandboxBundler` stay, live. The public contract
  exports `mcpMethods` (with `readSkill`), `OpenuiQuestionsV1`,
  `openuiQuestionsMethods`, `OpenuiProgramsV1`, `openuiProgramsMethods` and
  `PapercraftProgramsV1` have no importer left and stay, pending. A
  finished instance's skill registration is dropped by the platform, so the
  bundles' "cleanup disposes the skill" cases are deleted; `papercraft`'s
  `programs.test.ts` runs over `createProgramOperations`, since its 64 MiB
  memo exceeds the router's 4 MiB messages. No boundary exception is added.
- 2026-11-27: phase 3, slice S68d, of
  [the spec](../designs/grpc-processes.md) (version 6.51): the kernel entries
  of `runtime` and `default` are deleted. `runtime` loses `src/host/index.ts`
  (`activate`, `provideRuntime`, `RuntimeProvision`) and `src/host/peers.ts`
  (`CoreEventHooksV1`, imported only by the index); `RuntimeCore`,
  `createRuntimeCore` and `runtimeStores` move unchanged to `src/host/core.ts`,
  which `service.ts` and the `rpc/` files import. `default` loses
  `src/host/index.ts` (`activate`, `createExecutor`, `ActivateOptions`),
  `agentsService`, the disk fallback of `assetText` and the dead copy-md step
  of its `project.json`; `assetText` throws an `Error` naming the path, with no
  code, when nothing is installed or the installed texts lack the path.
  `src/host/ports.ts` keeps its type exports. The host contracts in
  `contracts.json` are `local: false`; `runtime`'s `dist/schemas` keeps only
  `runtime.records/v1.json`, and `default` builds no `schemas/`. Decisions:
  `provideRuntime` moves to the test support
  `tests/domain/support/provide-runtime.ts`, and `usageService` stays since it
  uses it; `kernelPorts` and `kernelBeforeModelRequest` move to
  `default/tests/support/envelope-ports.ts`, and the asset tests install the
  bundle's texts (`tests/support/assets.ts`). The kernel pause path of
  `default`'s executor and `generationLost` stay, against the plan: the router
  fails in-flight calls with `generation_lost`, which reaches the executor
  wrapped in `handler_failed`, and the run pauses only when its signal is
  aborted too: the `Run` call's signal, which aborts when its caller cancels
  the call or the router cuts it at a drain deadline
  (`packages/bundle/src/platform/router/drain.ts:81-85`,
  `flights.ts:227-240`); no router-world test covers it yet. Also kept,
  against the plan: `runtime`'s envelope services
  `src/host/services/{runtime,threads,workspace,lease,attachments}.ts`,
  `handover.ts`' `installHandover`, `lifecycle.ts`' `installStartStop` and
  `ports.ts`' `createPorts` have only test importers (`provide-runtime.ts`,
  the domain harness and the `handover-hooks`, `watches` and `attachments`
  tests) and stay as the envelope provision of the domain harness until
  phase 6 deletes the envelope (Q-F1).
  `DefaultAgentsV1`, `defaultAgentsMethods` and `SkillSourcesV1` have only test
  importers and stay. `runtime/tests/activation.test.ts` is deleted (its
  descriptor cases move to `descriptor.test.ts`), as is `event-sink.test.ts`'
  kernel sink case. No boundary exception is added.
- 2026-11-27: phase 3, slice S69, of
  [the spec](../designs/grpc-processes.md) (version 6.52): `transport`'s and
  `screen-relay`'s kernel entries and `doric.network/v1` are deleted, and the
  build no longer dry-activates the host part. `transport` loses
  `src/kernel.ts`, `src/host/{index,app,errors,services}.ts`, `routes/`,
  `sockets/`, `TransportServices`, and `sendAnswer` with its `express` import;
  new `src/host/api/input.ts` holds `pageInput`, `nameInput`, `ok` and
  `refused`, and `LeaseScope`/`ProjectScope` move to `api/ports.ts`.
  `screen-relay` loses `src/host/{index,service}.ts` and, from `relay.ts`,
  `ScreenRelayRouter`, `ScreenRelayResources`, `mount`, `mounted`,
  `handleRequest`, `handleUpgrade` and `screenPath`; `serve` is unchanged.
  `packages/bundle` loses `src/contracts/network.ts` (`DoricNetwork`,
  `DoricNetworkV1`, `NetworkResources`) and its `platform.ts` entry; the build
  (`cli.ts`) drops the host part from its dry-activated `parts`, ignores a
  stale `dist/host/index.js`, and `checkContractEnvironment` loses its host
  branch. Under X4, `TerminalV1`, `terminalMethods`, `terminalServiceMethods`,
  `FilesV1`, `filesMethods`, `GitCommandsV1` and `gitMethods` are deleted.
  Decisions: the dry-activation loop stays for desktopMain and client (the
  plan deleted the dry-activation code); `idInput` is not moved to
  `api/input.ts`, since nothing imports it; `rest-errors.test.ts` keeps its 4
  cases of the `restErrors` table, which no other test covers;
  `inventory-targets.test.ts` keeps `doric.network/v1` in
  `REMOVED_WITHOUT_PROTO`, since the inventory's section C still names the id;
  the router suites state each removed route's answer through
  `tests/support/route-answers.ts` instead of comparing with the kernel at run
  time. The unscheduled public contract exports without importers stay:
  `ScreenRelayV1`/`screenRelayMethods`, `TerminalServiceV1` and `terminal`'s
  exported schemas, `files`' `createInputSchema`/`createOutcomeSchema`,
  `usage`'s `UsageV1`/`usageMethods` and `transport`'s
  `CredentialCreateSchema`. Five boundary exceptions for `transport` until
  S70: `@types/express`, `express`, `pino`, `socket.io` and
  `socket.io-client`. Tests: `bundle-transport` 279 → 163,
  `bundle-screen-relay` 25 → 16, `bundle` 1362 → 1362 (one case deleted, one
  inverted case added).
- 2026-11-27: phase 3, slice S70, of
  [the spec](../designs/grpc-processes.md) (version 6.53): the dev tooling, the
  inventory check and every package file. Deleted: the fake host
  `scripts/fake-host/` with `tests/fake-host-bundles.test.mjs` and the root
  scripts `test:fake-host` and `doric:fake-host` (closing the spec's revision
  6.45, deviation 1), the CI step `npm run test:fake-host`, and the inventory
  check (`tests/contract-inventory.test.mjs`, its allowlist, support and
  fixtures), which leaves `lint:test`. The desktop e2e harness loses its
  Socket.IO half: the fake host listens with its HTTP/2 server directly, with
  no protocol sniff. Package files: the root drops `socket.io-client`;
  `doric-host` drops `express`, `socket.io`, `@grpc/grpc-js`,
  `@bufbuild/protobuf` and `cors` and the dev `socket.io-client`,
  `@types/express` and `@types/cors`; `transport` drops `express`, `socket.io`,
  `pino`, the dev `@types/express` and `socket.io-client`, and the export
  `./kernel`; `host-config` drops `./kernel`, and `claude`, `codex`, `openai`,
  `openrouter` and `terminal` drop `./host` (D1); `files` drops `pino`,
  `sandpool` and `terminal`, `git` `@bufbuild/protovalidate` and `core`
  `tool`. Every boundary exception until S70 goes with them; the file keeps
  S66's `core` entry. `package-lock.json` is regenerated with npm 11.13.0 and
  `npm ci` accepts it. `scripts/sea-spike`'s entries of `papercraft`,
  `runtime`, `mcp` and `docker`, broken since S68a, S68c and S68d, are deleted;
  the CI job builds `sqlite-node` and the native stub. CI's `lint:test` step is renamed "Test Biome configuration, bundle boundaries and provided versions". Corrected: `app/desktop/doric`'s
  `core-scope.test.ts` had failed since S67 in its 12 cases for `tools/v1`,
  `models/v1` and `secrets/v1`, whose host contracts have no schema document,
  so a window's envelope call to them is refused `unavailable` before any
  scope check; the cases now assert that refusal, and the window reaches those
  contracts over `doric:connect`, whose scope check stays RK37. Open: the
  public contract exports without an importer stay (the spec's 6.53 entry
  lists them). Tests: `lint:test` 53 → 48, `test:fake-host` gone, `doric-app`
  241/241.
- 2026-11-27: phase 3, slice S71, of
  [the spec](../designs/grpc-processes.md) (version 6.54): phase 3 measured on
  x64 against today's host on the same machine ("Phase 3: boot time (AC3.7,
  RK2)" and "Phase 3: memory (AC3.16, RK1)" above); no source file changes.
  RK2 passes (2,100 ms against 2,063 ms). RK1 failed A55's 2,816 MiB at
  3,161 MiB, and the owner raised its ceiling to 4,096 MiB idle for phases 3
  and 7 (A74), under which it passes. Bundle processes inherit the host's
  environment, so spawn to Hello is measured with a `NODE_OPTIONS` hook and no
  code (the group F plan's Q-G1). RK1's and RK2's gates (AC3.16, AC3.7) pass;
  phase 3 is not complete. Still open, as the owner's runs ("Phase 3: what is
  still open" above): T8 (RK18, RK31), whose procedure is "Phase 3: T8, for the
  owner to run" above; AC3.6 (RK6), which needs the Docker and Firecracker
  sandboxes; and the host and desktop end-to-end tests green on `postgres`.
- 2026-11-27: phase 3 closed, by the owner's decision A75 in
  [the spec](../designs/grpc-processes.md) (version 6.55): the owner declared
  phase 3 complete and let phase 4 start. T8 (RK18, RK31), AC3.6 (RK6) and the
  host and desktop end-to-end tests green on `postgres` were not run; they are
  waived, not met. Phase 4 deletes `postgres`, so the end-to-end baseline on
  `postgres` cannot be proved after it. "Phase 3: what is still open" is now
  "Phase 3: what was not run"; T8's procedure stays. No source file changes.
- 2026-11-27: phase 4, slice S72, of
  [the spec](../designs/grpc-processes.md) (version 6.56; section 10, "The
  Rust SDK"; [Phases](../designs/grpc-processes.md#phases), "Phase 4's
  slices"; A76–A78 make `sqlite` in Rust the only engine): the Rust SDK
  `packages/bundle-rs` (crate `doric-bundle`), its conformance fixture and the
  suite's Rust run. The root `Cargo.toml` gains the member
  `packages/bundle-rs`, tokio's feature `sync` and `tokio-util` 0.7.20. The
  choices the spec left open, the rules for handlers and the verification are
  under "Phase 4" above.
- 2026-11-27: phase 4, slice S73, of
  [the spec](../designs/grpc-processes.md) (version 6.56; QD, T4.21): the
  contract `storage.kv/v1` (unserved yet), `startTestProcess` in
  `bundle/testing`, and the conformance `Session` moved to an internal module.
  Its choices, verification and the flaky drain test are under "Phase 4"
  above.
- 2026-11-27: phase 4, slice S74a, of
  [the spec](../designs/grpc-processes.md) (version 6.56; section 17, "The
  engine"; Q1–Q11): the Rust engine bundle
  [`sqlite`](../../bundles/foundation/sqlite/README.md), serving
  `storage.kv/v1` over one SQLite file (no manifest yet), and
  `doric_bundle::log`, and the regenerated `package-lock.json` that fixes
  `npm ci`. Its choices and verification are under "Phase 4" above.
- 2026-11-27: phase 4, slice S74b, of
  [the spec](../designs/grpc-processes.md) (version 6.56; T4.2, T4.18, T4.20):
  the TypeScript `Kv` client, the KV conformance kit `runKvConformance`,
  `storage/testing` with `openTestEngine`, and three error codes. Its
  decisions and verification are under "Phase 4" above.
- 2026-11-27: phase 4, slice S75a, of
  [the spec](../designs/grpc-processes.md) (version 6.56, "S75's plan"): the
  native host part. A v2 manifest's `host.kind` is `sea` (default) or
  `native`, and a native part refuses `httpPrefix` and `assets`; the build
  runs no host esbuild for it, refuses its `src/host/main.ts` and takes its
  provides from `nativeProvides`; `stage` writes `host/command.json` with the
  absolute debug executable under `--dev`, else copies the release executable
  to `host/doric-<id>` (0755), from `StageOptions.targetDir`
  (`dist/target`). `storage.kv/v1` becomes a basic host contract and a
  backend a foundation bundle may require. The KV kit's 200,001-item cases
  move to `runKvConformance(harness, { heavy: true })`, run by the new
  `storage:test-heavy` target and CI step "Run heavy storage tests";
  `clientFailure(error, call?)` answers `cancelled` or `deadline_exceeded`
  for an `internal` or `cancelled` failure once the call's signal has aborted
  or its deadline has passed. The
  `sqlite` manifest (S75b) is not part of it.
- 2026-11-28: phase 4, slice S75b, of
  [the spec](../designs/grpc-processes.md) (version 6.57): the `sqlite`
  native manifest; `sqlite:build` becomes the bundle build and the cargo
  build is `sqlite:check`; `doric-host:build-bundles` stages `sqlite`, outside
  the composition until S84; the host image gains a digest-pinned Rust
  toolchain. Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S76, of
  [the spec](../designs/grpc-processes.md) (version 6.57): `sqlite` split into
  the library `doric-sqlite` (`engine/`) and the package `doric-storage`
  (`storage/`); `KvEngine` transactions; `storage.kv/v1` served only to
  `doric`, and the gateway never serves `internalContracts`. Its verification
  is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77a1, of
  [the spec](../designs/grpc-processes.md) (version 6.57): the `storage/v2`
  proto, registered as the 14th basic host contract and served by no handler
  yet; `doric-storage`'s `keys` and `schema`, which own the index-key
  encoding; the golden file `index-keys.json` and its TypeScript parity test.
  Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77a2, of
  [the spec](../designs/grpc-processes.md) (version 6.57): `layout.proto`,
  `storage/build.rs`, and `sqlite` serving `storage/v2`'s `Register`
  (declarations, namespace checks, SHA-256 schemas, generations); the drain
  test's `call-on-trigger` fix. Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77a3a, of
  [the spec](../designs/grpc-processes.md) (version 6.58): `sqlite` serves
  `storage/v2`'s `Commit` and `Get`, with the per-item check order, the
  `"document"` and `"indexKey"` limits, process-monotonic `updatedAt` and the
  descriptor-pool cache; S77a3 split into S77a3a and S77a3b. Its verification
  is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77a3b, of
  [the spec](../designs/grpc-processes.md) (version 6.59): `sqlite` serves
  `storage/v2`'s `Query`, with `keys::bounds`, the query's check order and
  arity (PF7), one snapshot per page and the base64url cursor (PF15, Q-C);
  S77a3 is complete. Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77a4a, of
  [the spec](../designs/grpc-processes.md) (version 6.60): `sqlite`'s
  `Register` rebuilds changed indexes of a type with documents in one write
  transaction, with the `"rebuild"` limit of 200,000 documents and
  `unique_conflict` `{ type, index, ids }`; S77a4 split into S77a4a and S77a4b.
  Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77a4b, of
  [the spec](../designs/grpc-processes.md) (version 6.61): `sqlite`'s storage
  writes cache document headers (A80, `DORIC_SQLITE_CACHE`), and a
  `storage.kv/v1` commit no longer hides a foreign write (PF1); S77a4 is
  complete. Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77b1, of
  [the spec](../designs/grpc-processes.md) (version 6.62): the `storage/v2`
  TypeScript client (`openStorage`), `TestEngine.storage` and
  `openTestStorage`, `transport(caller, generation)`, and the suspension of
  `sqlite`'s cache by a `storage.kv/v1` commit outside `doric/` (PF3); S77b
  split into S77b1 and S77b2. Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slice S77b2, of
  [the spec](../designs/grpc-processes.md) (version 6.63): the `storage/v2`
  conformance kit, 63 cases with 22 skipped until S78 (the stream, blob and
  health cases among them), and S77b1's drift fixes in the client, CI10
  included; S77b is complete. Its verification is under "Phase 4" above.
- 2026-11-28: phase 4, slices S77c and S77c2, of
  [the spec](../designs/grpc-processes.md) (version 6.64): RK27's
  measurements (a) and (b) on the release binary (`storage:bench-rk27`,
  `testEngineBinary('release')`, a report-only CI step), recorded under "Phase
  4: write stalls"; AC4.25 closed on them, and the `"rebuild"` limit lowered to
  100,000 documents (`REBUILD_DOCUMENTS`; `register/tests/backfill.rs` rebuilds
  100,000 and refuses 100,001; `doric-sqlite` 63, `doric-storage` lib 171 and
  bin 11), confirmed by a run of (a) at the limit (100,000 documents in 4,122
  ms). `COMMIT_ITEMS` and
  `commitItems`, 200,000, are unchanged. `format:check` failed on
  `kv-client.test.ts` and `kv-file.test.ts`, committed in `2fd8cbb7`, which the
  coordinator formatted; 18 other biome format failures predate S72.
