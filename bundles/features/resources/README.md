# resources

`resources` reports how hard the agent's environment is working: the CPU and
memory use of the selected Project's sandbox and of the machine the host runs
on. Its host part provides the `resources/v1` contract; its client part draws a
connection badge over the reader's avatar, which opens a popover with both
readings. It persists nothing and changes nothing it observes.

How bundles are loaded, activated and called is described in the
[`bundle` package README](../../../packages/bundle/README.md). The behavior
across bundles is described in the feature docs listed under
[Feature docs](#feature-docs).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                                          |
| `id`              | `resources`                                                                                                                  |
| `version`         | `1.1.5`                                                                                                                      |
| `engines`         | `{ "doric": "^1.0.0" }`                                                                                                      |
| `provides`        | `resources/v1@1.0.0`                                                                                                         |
| `requires`        | `runtime.lease/v1@^1.4.0`, `ui/v1@^1.0.0`, `regions/v1@^1.0.0`, `workspace.selection/v1@^1.0.0`, `runtime.records/v1@^1.0.0` |
| `optional`        | `log/v1`, `secrets/v1`                                                                                                       |
| `desktopScope`    | `resources/v1`: `projectId`, `threadId`, `promptId`                                                                          |
| `description`     | "The host machine and Project sandbox resource monitor."                                                                     |

- A composition without a provider of a required contract quarantines the
  bundle with `missing_dependency`
  ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).
- A desktop window may send `resources/v1` only the scope keys of
  `desktopScope`; the desktop refuses any other key with `invalid_input`
  ([manifest](../../../docs/architecture/bundles/manifest.md#desktopscope)).
  `project()` reads `projectId` alone.
- The `account` bundle is neither required nor optional: the client part
  imports only the type of its slot name (see [Client part](#client-part)).

[`package.json`](package.json) exports `./contracts`
(`dist/contracts/index.js`, with `src/contracts/index.ts` as the source
condition), `./contracts/gen/*` (the protobuf-es code `generate-proto` writes from `proto/`) and `./package.json`. It depends on `bundle`, `runtime`, `sandbox`,
`tslib` and `zod`; `@tanstack/react-query`, `account`, `desktop`, `happy-dom`,
`lucide-react` and `react` are dev dependencies.

## Parts

| Part      | Entry                                              | What it does                                                                  |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| contracts | [`src/contracts/index.ts`](src/contracts/index.ts) | Declares `resources/v1`, its types and its schemas.                           |
| host      | [`src/host/index.ts`](src/host/index.ts)           | Provides `resources/v1`: the machine reading and the Project sandbox reading. |
| client    | [`src/client/index.ts`](src/client/index.ts)       | Defines `<resources-monitor>` and adds it to the `account.status` slot.       |

The bundle has no desktop part and no sandbox part.

## `resources/v1`

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as
`ResourcesV1 = ref<Resources>('resources/v1')`, version `1.0.0`.

```ts
interface Resources {
  host(call?: CallArg): Promise<HostResources>;
  project(call?: CallArg): Promise<LeaseOutcome<ContainerResources>>;
}

interface HostResources {
  readonly at: string; // ISO-8601 time of the reading
  readonly cpuCount: number;
  readonly cpuPercent?: number; // 0..100 over every core
  readonly loadAverage?: number; // one-minute load average
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly uptimeSeconds: number;
}

interface ContainerResources {
  readonly status: 'ready' | 'unavailable';
  readonly at: string; // ISO-8601 time of the reading
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
}

// Declared in runtime/contracts and re-exported here.
type LeaseOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'pending' | 'unavailable' | 'expired' | 'missing' };
```

([`src/contracts/index.ts`](src/contracts/index.ts),
[`lease.ts`](../../runtime/runtime/src/contracts/lease.ts))

The module also exports the schemas each method is checked against, as
`resourcesMethods` ([`src/contracts/index.ts`](src/contracts/index.ts)):

| Method    | Input     | Output schema                                                                                                                                                                      |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`    | `noInput` | `hostResourcesSchema`: a strict object, so a field outside `HostResources` fails the call with `invalid_output`.                                                                   |
| `project` | `noInput` | `projectResourcesOutcomeSchema`: `{ status: 'ready', value: containerResourcesSchema }` or `{ status: 'pending' \| 'unavailable' \| 'expired' \| 'missing' }`, both loose objects. |

`containerResourcesSchema` is a loose object: it accepts fields beyond
`ContainerResources`.

Both methods are exposed to desktop windows (`expose: 'desktop'`)
([`src/host/index.ts`](src/host/index.ts)).

### `host()`

- Reads the machine the host process runs on from `node:os` on each call. It
  needs no scope and no lease
  ([`src/host/machine.ts`](src/host/machine.ts)).
- `cpuCount` is the number of entries `cpus()` returns; `memoryTotalBytes` is
  `totalmem()`; `memoryUsedBytes` is `totalmem() - freemem()`; `loadAverage` is
  `loadavg()[0]`; `uptimeSeconds` is `uptime()` rounded to whole seconds
  ([`src/host/machine.ts`](src/host/machine.ts)).
- `cpuPercent` is the busy share of every core between the previous call and
  this one, `100 × (1 − Δidle / Δtotal)` summed over the cores both samples
  hold, where a core's total is `user + nice + sys + idle + irq`, clamped to
  0..100. The previous sample is module state of the process that serves the
  contract, shared by every caller. The first call of the process, and a call
  whose counters did not advance, answer no `cpuPercent`
  (`cpuPercentBetween`, `readHostResources` in
  [`src/host/machine.ts`](src/host/machine.ts)).

### `project()`

- Reads the sandbox of the Project named by `call.scope.projectId`, through
  `runtime.lease/v1.withLease` in the call's scope. `withLease` runs the read on
  the lease the Project holds now and never acquires one: a Project without a
  live lease answers its lease state as data: `missing` when the Project has
  no record; `expired` when its record is in a terminal state; `unavailable`
  when it has no runtime in this process, when it is closing, or when closing
  starts or the lease drops while the read runs; `pending` while its runtime
  has no lease yet. A call for a Project in standby waits until this process
  adopts it
  ([`src/host/index.ts`](src/host/index.ts),
  [`lease.ts`](../../runtime/runtime/src/host/services/lease.ts),
  [`service.ts`](../../runtime/runtime/src/host/domain/service.ts)).
- A call whose scope has no `projectId` rejects with `invalid_input` and the
  message "runtime.lease/v1 needs a Project or Thread scope."
  ([`lease.ts`](../../runtime/runtime/src/host/services/lease.ts)).
- On a live lease it calls the sandbox's optional `stats()`. A reading answers
  `{ status: 'ready', value: { status: 'ready', at, …fields } }`, with each of
  `cpuPercent`, `cpuCount`, `memoryUsedBytes` and `memoryLimitBytes` copied
  only when the provider measured it, and `at` the time this bundle read it (the
  provider's own `at` is not kept). A sandbox without `stats`, a `stats()` that
  answers `undefined` and a `stats()` that throws all answer
  `{ status: 'ready', value: { status: 'unavailable', at } }`: a provider that
  cannot measure never fails the read
  (`readSandboxResources` in [`src/host/container.ts`](src/host/container.ts),
  [`sandbox.ts`](../../../packages/sandbox/src/lib/types/sandbox.ts)).

### Callers outside this bundle

The `transport` bundle lists `resources/v1` under `optional` and serves it over
REST: `GET /resources` answers `host()`, and `GET /projects/:id/resources`
answers `project()` bound to that Project
([`routes/resources.ts`](../../foundation/transport/src/host/routes/resources.ts),
[`routes/projects.ts`](../../foundation/transport/src/host/routes/projects.ts)).
Its status codes are described in the
[`transport` README](../../foundation/transport/README.md).

## Host part

[`src/host/index.ts`](src/host/index.ts) exports `activate`, which provides
`resourcesService`, and re-exports `readHostResources`, `cpuPercentBetween`
and `readSandboxResources`:

- `readHostResources(now?: Date): HostResources` — one machine reading, taken
  at `now` (default: the current time), advancing the module's CPU sample.
- `cpuPercentBetween(previous, current): number | undefined` — the busy share
  between two lists of `{ idle, total }` per-core counters, or `undefined` when
  the total did not advance.
- `readSandboxResources(sandbox: Sandbox, now?: Date): Promise<ContainerResources>`
  — one sandbox reading, as described under [`project()`](#project).

### Process entry (S50b)

The bundle also has a process entry, [`src/host/main.ts`](src/host/main.ts),
built to `dist/host/main.mjs`, for the bundle-process runtime
([bundle processes](../../../docs/features/bundle-processes.md)). It calls
`runBundle` with `ResourcesService` (`resources/v1`) listed statically. Every
method fails `unavailable` before activation.

- `Host` answers the machine reading.
- `Project` sends one `runtime.lease/v1` `Stats` and answers `ready` with the
  reading, or `{ status }` for a lease status (`pending`, `unavailable`,
  `expired`, `missing`). Any other failure rejects with its code: a runtime
  that is down is not hidden.

The kernel entry stays until S62. Since S62c1 the manifest requires
`runtime.lease/v1@^1.4.0`.

## Client part

### Activation

`activate` in [`src/client/index.ts`](src/client/index.ts):

1. Creates a React Query `QueryClient` whose defaults retry nothing, refetch
   neither on window focus nor on reconnect, and have `staleTime: 0`.
2. Defines the custom element `resources-monitor` (`RESOURCES_MONITOR_TAG`)
   through `ui/v1.define`, rendering under that query client
   ([`src/client/elements.tsx`](src/client/elements.tsx)). The element has no
   attributes or properties, and renders in light DOM with `display: contents`
   ([`react-element.ts`](../../../packages/desktop/src/react-element.ts)).
3. Adds the item `{ id: 'resources', tag: 'resources-monitor', order: 10 }` to
   the region `account.status` through `regions/v1.add`
   (`resourcesRegion`, `registerResourcesRegion`). The region name is the
   literal `'account.status'`, checked against the type of `ACCOUNT_STATUS`
   from `account/contracts` with an `import type` only. The `account` bundle
   draws that slot in a 14×14 box over the avatar
   ([`account` README](../../desktop/account/README.md)); without `account`
   the item is registered and not drawn.
4. Returns a cleanup that removes the region item, undefines the element and
   clears the query client.

### What the element reads

`ResourcesMonitorView` in
[`src/client/monitor/resources-monitor.tsx`](src/client/monitor/resources-monitor.tsx):

- The selected Project's id from `workspace.selection/v1.current().projectId`,
  re-read on each notification of its `subscribe`. The contract is a local
  structural copy of the two members it calls
  ([`src/client/api/peers.ts`](src/client/api/peers.ts)); it is described in
  the [`workspace` README](../../desktop/workspace/README.md).
- Whether the window is connected, that is whether
  `runtime.records/v1.connection()` answers `'connected'`, re-read on each
  notification of its `subscribe`
  ([`runtime` README](../../runtime/runtime/README.md)).
- While a contract has no provider, its value falls back: no Project, and not
  connected ([`src/client/hooks/use-service.ts`](src/client/hooks/use-service.ts)).
- It calls `resources/v1` from the window over Connect, through the generated
  `ResourcesService` (slice S65d): `host()` with no scope, and
  `project()` with the scope `{ projectId }`.

### Reads

`createResourcesReads` in
[`src/client/api/resources.ts`](src/client/api/resources.ts) wraps the two
calls:

- `host()` answers the `HostResources` the call returned.
- `project(projectId)` first checks the id: an id that is not a string, is
  empty, is longer than 200 characters or holds a NUL throws
  "The item identifier is invalid." without calling. It then answers
  `{ status: 'ready', container }`, `{ status: 'pending', retryAfterSeconds: 1 }`,
  or `{ status: 'unavailable' | 'expired' | 'missing' }`. A `ready` container
  whose `status` is not `ready` or `unavailable`, whose `at` is not a string, or
  whose numeric fields are not numbers throws
  "Doric returned an invalid response.".
- A failed call throws an `Error` whose message (`resourcesMessages`) is:

  | Contract error code                              | Message                               |
  | ------------------------------------------------ | ------------------------------------- |
  | `unavailable`, `disconnected`, `generation_lost` | "Doric backend is unavailable."       |
  | `invalid_output`                                 | "Doric returned an invalid response." |
  | any other error                                  | "The request could not be completed." |

  No screen shows these messages: the monitor keeps its last reading.

### Polling

[`src/client/hooks/use-resources.ts`](src/client/hooks/use-resources.ts):

| Query   | Key                        | Enabled                     | Interval                                                                                                                                                          | Other                                                 |
| ------- | -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| machine | `['resources', 'host']`    | always                      | 3000 ms                                                                                                                                                           | `refetchOnWindowFocus`, `staleTime: 1000`, `retry: 2` |
| sandbox | `['resources', projectId]` | while a Project is selected | 3000 ms; while `pending`, `retryAfterSeconds × 1000` with a floor of 1000 ms, so 1000 ms ([`read-policy.ts`](../../../packages/desktop/src/reads/read-policy.ts)) | `refetchOnWindowFocus`, `staleTime: 1000`, `retry: 2` |

- The queries run in `useResourcesSnapshot`, which the badge holds, so they
  run while the popover is closed
  ([`src/client/monitor/resource-monitor.tsx`](src/client/monitor/resource-monitor.tsx),
  [`src/client/monitor/connection-badge.tsx`](src/client/monitor/connection-badge.tsx)).
- `retry: 2` waits with React Query's default exponential delay between
  attempts, and `refetchInterval` pauses while the window is hidden (React
  Query's default `refetchIntervalInBackground: false`).
- A failed refresh keeps the last data of the query: the monitor never blanks,
  shows no error and raises no toast.

### Formatting and thresholds

All in [`src/client/domain/resources.ts`](src/client/domain/resources.ts),
pure functions of their arguments:

- `bytesLabel(bytes)`: the value in the smallest of `B`, `KiB`, `MiB`, `GiB`,
  `TiB` (base 1024) in which it is below 1024, or in `TiB` beyond that,
  rounded to one decimal with a trailing `.0` dropped (`"512 MiB"`,
  `"1.5 GiB"`); `"0 B"` for zero, negative or non-finite input.
- `memoryLabel(used?, limit?)`: `"—"` without a finite used value; the used
  value alone (`bytesLabel`) without a finite limit; else both values in the
  unit of the larger, `"0.3 / 2 GiB"`.
- `cpuLabel(percent?)`: the rounded whole percent, `"23%"`, or `"—"`.
- `resourceNotice(result)`: nothing for no result or a ready container;
  "Resources unavailable in this provider" for a ready answer whose container
  is `unavailable`; "Preparing environment…" for `pending`; "Environment
  unavailable" for `unavailable`, `expired` and `missing`.
- Memory warns when used ÷ limit ≥ `memorySaturationRatio` (0.85), with a
  positive finite limit.
- CPU warns only when sustained: `cpuSustained` counts consecutive readings at
  or above `cpuSaturationPercent` (90); the count reaching
  `cpuSustainedReadings` (3) warns, and a reading below 90 or without
  `cpuPercent` resets it to 0. `useCpuSustain` advances the count only for a
  reading with a new `at`, so one reading never counts twice
  ([`src/client/hooks/use-resources.ts`](src/client/hooks/use-resources.ts)).
  While there is no reading (no Project selected, or a lease state) the count
  and the verdict stay as they were, also across a change of Project, so the
  Sandbox `cpuWarning` can stay set while its section shows a notice or `"—"`
  ([`src/client/monitor/resource-monitor.tsx`](src/client/monitor/resource-monitor.tsx)).
- `freshnessLabel(at, now)`: "Updated Ns ago" under a minute, "Updated Nm ago"
  under an hour, else "Updated Nh ago", with a time in the future counted as 0
  seconds; an unparsable `at` gives an empty string.

### Snapshot

`useResourcesSnapshot(reads, projectId)` answers one `ResourcesSnapshot` per
render ([`src/client/monitor/resource-monitor.tsx`](src/client/monitor/resource-monitor.tsx)):

```ts
interface ResourcesSnapshot {
  readonly sandbox: ResourceSectionModel; // title 'Sandbox'
  readonly machine: ResourceSectionModel; // title 'Machine'
  readonly at?: string; // the container's `at`, else the machine's
}

interface ResourceSectionModel {
  readonly title: 'Sandbox' | 'Machine';
  readonly memory: string; // memoryLabel(used, limit)
  readonly cpu: string; // cpuLabel(percent)
  readonly memoryWarning: boolean;
  readonly cpuWarning: boolean; // the sustained verdict only
  readonly memoryRatio?: number; // used / limit clamped to 0..1, with a positive limit
  readonly cpuRatio?: number; // percent / 100, with a finite percent
  readonly notice?: string; // Sandbox only: resourceNotice(result)
}
```

The sandbox section takes its numbers from a `ready` answer's container, its
limit being `memoryLimitBytes`; the machine section takes them from the host
reading, its limit being `memoryTotalBytes`. With no Project selected the
sandbox section has no notice and shows `"—"` for both values.

### Badge

`ConnectionBadge` in
[`src/client/monitor/connection-badge.tsx`](src/client/monitor/connection-badge.tsx):

- A `<button type="button" data-slot="connection-badge">`, 14×14, named
  "Connection and resources", its own Tab stop, with a focus ring. Its
  `data-status` is the tone:
  - `disconnected` when not connected, whatever the readings say;
  - `warning` when connected and either section has `memoryWarning` or
    `cpuWarning`;
  - `connected` otherwise.
- It draws two `aria-hidden` spans as CSS masks: a 14×14 cutout of the
  cloud-fill glyph in `var(--sidebar)`, and a 10×10 status glyph inset 2 px —
  cloud-fill in `var(--paper-green)` when `connected`, cloud-off-fill in
  `var(--paper-red)` when `disconnected`, cloud-fill in `var(--warning)` when
  `warning`. The glyphs are SVG strings in
  [`src/client/monitor/cloud-glyphs.ts`](src/client/monitor/cloud-glyphs.ts),
  whose source and edit are recorded in [`PROVENANCE.md`](PROVENANCE.md).
- Its accessible description, in a visually hidden span, is "Disconnected"
  when not connected, else "Connected" followed by " · memory high" and
  " · CPU high" for each warning set in either section.
- A click opens a popover below it, aligned to its end, 256 px wide (at most
  the window width less 1 rem), holding `ResourcesPopoverBody`.

### Popover

`ResourcesPopoverBody` in
[`src/client/monitor/resource-monitor.tsx`](src/client/monitor/resource-monitor.tsx):

- A header (`data-slot="resources-popover-header"`) with the cloud glyph in
  green or the cloud-off glyph in red, then "Connected" or "Disconnected",
  then, when connected and the snapshot has an `at`, the freshness label of
  that `at`, read from the wall clock at render.
- A "Sandbox" section and a "Machine" section, both at half opacity while not
  connected. A section with a `notice` shows the sentence in place of its
  gauges; otherwise it shows a Memory gauge and a CPU gauge, each with its
  `lucide-react` icon (`MemoryStick`, `Cpu`), its label, its value, and a bar
  of `ratio × 100` percent when the ratio is set. A value with a warning, and
  its bar, wear the warning tone.

### Styles

[`src/client/styles.css`](src/client/styles.css) emits Tailwind utilities over
the platform theme (`desktop/ui/tailwind.css`) and defines no rule of its own.
It scans this part's sources, `packages/desktop/src`, and the client sources of
the `layout`, `chat`, `settings`, `account` and `workspace` bundles, so that the
sheet holds the same sorted set of shared classes as the window's other
sheets.

## Data and persistence

- Nothing is persisted. The host keeps one CPU sample per process in memory
  ([`src/host/machine.ts`](src/host/machine.ts)); the client keeps the last
  readings in memory, in its own query client under the keys above, which
  deactivation clears ([`src/client/index.ts`](src/client/index.ts)).

## Side effects

- The host part reads `node:os` and calls the leased sandbox's `stats()`; it
  never acquires, starts or stops a lease or a sandbox
  ([`src/host/index.ts`](src/host/index.ts),
  [`src/host/container.ts`](src/host/container.ts)).
- The client part defines one custom element and registers one region item
  ([`src/client/index.ts`](src/client/index.ts)).

## Configuration

None: no setting, environment variable or option. The intervals, thresholds
and the identifier limit are constants in
[`src/client/hooks/use-resources.ts`](src/client/hooks/use-resources.ts),
[`src/client/domain/resources.ts`](src/client/domain/resources.ts) and
[`src/client/api/resources.ts`](src/client/api/resources.ts).

## Limits

- One reading per call: the bundle keeps no history and no average beyond
  the CPU sample and the sustained-CPU count.
- A Project id sent from the window is at most 200 characters, non-empty and
  without NUL ([`src/client/api/resources.ts`](src/client/api/resources.ts)).
- The sandbox reading covers only the Project selected in the window, and
  only while its lease is live.

## Errors and failure behavior

- `host()` has no error of its own.
- `project()` rejects only with what `runtime.lease/v1.withLease` rejects
  with, such as a scope without `projectId`; a lease state is an outcome and a
  provider without a reading is an `unavailable` container.
- In the window, every failure of a read is absorbed by the query, which keeps
  its last data; the badge never throws.

## Build and test

Run from the repository root ([`project.json`](project.json), project
`bundle-resources`):

- `npx nx run bundle-resources:build` compiles `src/contracts` and `src/host`
  with `tsconfig.json` into `dist/`, type-checks `src/client`, `stories/` and
  `.storybook/` with `tsconfig.client.json` (no output), then runs the
  `bundle` build CLI, which bundles the client part and its sheet into
  `dist/client/`, writes `dist/contracts.json` and `dist/schemas/`, and
  dry-activates the parts
  ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)).
- `npx nx run bundle-resources:typecheck` runs the same two `tsc` steps
  without the CLI.
- `npx nx run bundle-resources:test` compiles `tests/` (`tsconfig.spec.json`)
  and `tests/client/` (`tsconfig.client-spec.json`) into the untracked
  `dist-tests/`, and runs them with `node --test`:
  - [`tests/contracts.test.ts`](tests/contracts.test.ts): the schemas.
  - [`tests/resources.test.ts`](tests/resources.test.ts): the host service and
    the window's reads, over a fake `runtime.lease/v1`.
  - [`tests/domain.test.ts`](tests/domain.test.ts): formatting and thresholds.
  - [`tests/client/connection-badge.test.ts`](tests/client/connection-badge.test.ts):
    the badge, the popover and the region item, under `happy-dom`, and the
    SHA-256 and length of each glyph against [`PROVENANCE.md`](PROVENANCE.md).
  - [`tests/workspace-sheet.test.ts`](tests/workspace-sheet.test.ts): the
    sheet's `@source` of the `workspace` client sources and the manifest
    version.

Stories of the element, the badge and the popover are in [`stories/`](stories),
with the fakes in [`stories/support/`](stories/support), which the client tests
also use; [`.storybook/preview.tsx`](.storybook/preview.tsx) wraps them in the
window's sheets.

The host loads the bundle because `resources` is listed in
[`composition.json`](../../../app/backend/doric-host/composition.json);
`npx nx run doric-host:build-bundles` stages it
([`project.json`](../../../app/backend/doric-host/project.json)).

## Feature docs

- [Resource monitor](../../../docs/features/resource-monitor.md)
- [Projects and Threads](../../../docs/features/projects-and-threads.md)
- [UI redesign](../../../docs/features/ui-redesign.md)
- [Host API](../../../docs/features/host-api.md)
