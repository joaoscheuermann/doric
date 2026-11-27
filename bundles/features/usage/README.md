# usage

`usage` shows what a conversation costs and how full its context window is.
Its host part provides `usage/v1`, which answers a Thread's stored usage with
the context capacity filled from the live model catalog, and moves the context
compaction line. Its client part draws `<usage-summary>` in the conversation
footer: the selected Thread's context use and the cost of the Thread and its
descendants, with a popover to compact the context or move the compaction
line.

Feature docs: [usage](../../../docs/features/usage.md) (the flow from the
measurement to the footer), [context compaction](../../../docs/features/context-compaction.md)
(what a compaction does), [conversation](../../../docs/features/conversation.md)
(the footer band it sits in), [workspace window](../../../docs/features/ui-redesign.md)
(the slot `shell.conversation.footer` it fills), [per-thread model](../../../docs/features/per-thread-model.md)
(the execution picker beside it), [host API](../../../docs/features/host-api.md)
(the REST route that reads `usage/v1`). How bundles are built and loaded is in
[`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                                                                                       |
| `id`              | `usage` (the `name` of [`package.json`](package.json))                                                                                                                    |
| `version`         | `1.0.6`                                                                                                                                                                   |
| `engines`         | `doric: ^1.0.0`                                                                                                                                                           |
| `description`     | Thread usage and cost, with the context capacity from the live model catalog.                                                                                             |
| `provides`        | `usage/v1@1.1.0`                                                                                                                                                          |
| `requires`        | `runtime.usage/v1@^1.0.0`, `runtime.threads/v1@^1.0.0`, `host-config/v1@^1.0.0`, `models/v1@^1.1.0`, `ui/v1@^1.0.0`, `regions/v1@^1.0.0`, `workspace.selection/v1@^1.0.0` |
| `optional`        | `log/v1`, `secrets/v1`                                                                                                                                                    |
| `desktopScope`    | `usage/v1`: `projectId`, `threadId`, `promptId`, the scope keys a desktop window may send to it ([manifest](../../../docs/architecture/bundles/manifest.md))              |

Parts: `src/contracts/` (exported as `usage/contracts`), `src/host/` and
`src/client/`. The bundle has no desktop part.

## Contract `usage/v1`

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as `UsageV1`
(`ref<Usage>('usage/v1')`), with the method schemas `usageMethods`. Provided
by the host part ([`src/host/usage.ts`](src/host/usage.ts)). Every method is
given the `EXPOSE_DESKTOP` method option in
[`proto/doric/usage/v1/usage.proto`](proto/doric/usage/v1/usage.proto), so a desktop window may call each of them
([contracts](../../../docs/architecture/bundles/contracts.md)).

| Method                                     | Input (schema)                                | Output (schema)                                             |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| `thread(threadId)`                         | `string`                                      | `ThreadUsage \| undefined` (`threadUsageSchema.optional()`) |
| `compact(threadId)`                        | `string`                                      | `CompactResult` (`compactResultSchema`)                     |
| `compactionTarget()`                       | no argument (`z.tuple([])`)                   | `{ pressurePercent: number }` (loose object)                |
| `setCompactionTarget({ pressurePercent })` | `{ pressurePercent: number }` (strict object) | `{ pressurePercent: number }` (loose object)                |

Each method also takes the usual optional `call` argument (`CallArg`) of a
contract call.

### Data shapes

The contracts module re-exports `ThreadUsage`, `UsageTotals`, `ContextUsage`
and `CompactResult` from `runtime/contracts`, and `usageMethods` uses the
runtime's `threadUsageSchema` and `compactResultSchema`
([`bundles/runtime/runtime/src/contracts/model.ts`](../../runtime/runtime/src/contracts/model.ts));
the runtime fills them as the comments below say
([`bundles/runtime/runtime/src/host/store/usage.ts`](../../runtime/runtime/src/host/store/usage.ts)).
Every object schema of these shapes is loose: an unknown field passes.

```ts
interface UsageTotals {
  calls: number; // provider calls counted
  unpricedCalls: number; // calls with no reported cost
  cost: number; // sum of the reported `credits` amounts; the footer shows it as dollars
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

interface ContextUsage {
  model: string; // the model of the last measurement
  providerId?: string;
  contextWindowSource?: 'catalog'; // set when usage/v1 filled the capacity
  contextWindow?: number; // capacity in tokens
  inputTokens?: number; // tokens of the last measured input
}

interface ThreadUsage {
  context?: ContextUsage; // absent before the first measurement
  total: UsageTotals; // the Thread and all its descendants
  threads: (UsageTotals & {
    // each Thread of that subtree, with its own charges
    threadId: string;
    name: string;
    parentThreadId?: string;
  })[];
}

type CompactResult =
  | {
      status: 'compacted';
      condensedMessages: number;
      retainedMessages: number;
      tokensFreed: number;
    } // tokensFreed is an estimate
  | {
      status: 'refused';
      reason: 'disabled' | 'missing_history' | 'nothing_to_compact';
    }
  | { status: 'failed'; code: 'summarizer_failed' | 'unsafe_boundary' }
  | { status: 'missing' | 'inactive' | 'busy' | 'not_supported' };
```

### Behavior of each method

- `thread(threadId)` reads `runtime.usage/v1.read(threadId)` and answers
  `undefined` when the runtime does (the Thread does not exist). When the
  answer has a `context` without `contextWindow`, it asks
  `models/v1.contextWindow` with the context's `model`, and with its
  `providerId` only when the context names one. A finite answer above 0
  becomes `context.contextWindow`, with `contextWindowSource: 'catalog'`. Any
  other answer, or a rejected lookup, leaves the usage as stored. A recorded
  `contextWindow` is never replaced, and a usage without `context` is
  answered unchanged ([`src/host/usage.ts`](src/host/usage.ts),
  `withContextCapacity`).
- `compact(threadId)` answers `runtime.threads/v1.compact({ id: threadId })`
  unchanged ([`src/host/usage.ts`](src/host/usage.ts)). What a compaction
  does, and when it is refused, is in
  [context compaction](../../../docs/features/context-compaction.md).
- `compactionTarget()` reads `host-config/v1.current()` and answers
  `execution.contextCompaction.pressurePercent`, or `80`, the
  `pressurePercent` of `defaultContextCompaction` from `host-config/contracts`,
  when the configuration has no `contextCompaction` section
  ([`src/host/rpc/usage.ts`](src/host/rpc/usage.ts)).
- `setCompactionTarget({ pressurePercent })` reads the configuration in
  force and calls `host-config/v1.replace` with the same configuration, its
  `execution.contextCompaction` section (or `defaultContextCompaction` when
  absent) carrying the new `pressurePercent` and every other field unchanged.
  It answers the new value when `replace` answers `replaced`, and otherwise
  the value the configuration still names (the default's `80` when it has no
  section) ([`src/host/usage.ts`](src/host/usage.ts)). The host part checks
  no range itself: `host-config` refuses a value that is not a whole number
  from 50 to 95
  ([`bundles/foundation/host-config/src/host/config/schema.ts`](../../foundation/host-config/src/host/config/schema.ts)),
  and the executor reads the line from the configuration in force on its next
  run ([`bundles/runtime/default/src/host/compact.ts`](../../runtime/default/src/host/compact.ts),
  `compactionConfig`).

### Errors

- No method throws an error of its own. A rejection of `runtime.usage/v1`,
  `runtime.threads/v1` or `host-config/v1` reaches the caller unchanged; a
  rejection of `models/v1.contextWindow` is swallowed
  ([`src/host/usage.ts`](src/host/usage.ts)).
- An input or output that fails its schema is refused by the platform with
  the contract errors described in
  [contracts](../../../docs/architecture/bundles/contracts.md).

## Contracts used

| Contract                 | Part   | What for                                                                    |
| ------------------------ | ------ | --------------------------------------------------------------------------- |
| `runtime.usage/v1`       | host   | `read(threadId)`: the stored usage aggregate, unfilled                      |
| `runtime.threads/v1`     | host   | `compact({ id })`: the on-demand compaction                                 |
| `host-config/v1`         | host   | `current()` and `replace(configuration)`: the compaction line               |
| `models/v1`              | host   | `contextWindow({ providerId?, model })`: the capacity from the live catalog |
| `ui/v1`                  | client | `define('usage-summary', …)`                                                |
| `regions/v1`             | client | `add('shell.conversation.footer', item)`                                    |
| `workspace.selection/v1` | client | `current().threadId` and `subscribe(listener)`: the selected Thread         |
| `usage/v1`               | client | its own contract, over Connect as `UsageService`                            |

The host part imports `RuntimeUsageV1` and `RuntimeThreadsV1` from
`runtime/contracts`, `ConfigurationV1` and `defaultContextCompaction` from
`host-config/contracts`, and `ModelsV1` from `bundle/contracts`
([`src/host/usage.ts`](src/host/usage.ts)). The client part reaches
`workspace.selection/v1` through `WorkspaceSelectionV1`, a structural copy of
the part of the contract it reads, `SelectionSource`, and does not import the
workspace's contracts module ([`src/client/api/workspace.ts`](src/client/api/workspace.ts)).

## Host part

The host part runs as a process (below); its kernel entry `src/host/index.ts`,
with `activate`, `usageService` and `compactionTargetOf`, was deleted in slice
S68a. The service is `createUsageService` of
[`src/host/rpc/usage.ts`](src/host/rpc/usage.ts), with `withContextCapacity`
of [`src/host/usage.ts`](src/host/usage.ts). The part keeps no state.

### Process entry (S50c)

The bundle also has a process entry, [`src/host/main.ts`](src/host/main.ts),
built to `dist/host/main.mjs`, for the bundle-process runtime
([bundle processes](../../../docs/features/bundle-processes.md)). It calls
`runBundle` with `UsageService` (`usage/v1`) listed statically, over
`runtime.usage/v1`, `runtime.threads/v1`, `host-config/v1` and `models/v1`.
Every method fails `unavailable` before activation; routed failures keep their
codes.

- `Thread` answers `{}` when there is no stored usage; otherwise it fills a
  missing context window from the model catalog, only with a whole number. A
  failed `ContextWindow` read is ignored.
- `CompactionTarget` answers the stored `pressurePercent`, or the default 80.
- `SetCompactionTarget` replaces the host configuration with only
  `execution.contextCompaction.pressurePercent` changed. It answers the new
  value on `replaced` and the previous one on `invalid` or `rejected`; a
  `host-config/v1` answer without a configuration fails `invalid_output`.

The `usage/v1` proto header says version 1.1.0. The kernel entry was
deleted in slice S68a; since S62c1 the manifest provides `usage/v1@1.1.0`.

## Client part

[`src/client/index.ts`](src/client/index.ts): `activate` creates one
TanStack `QueryClient` for the bundle (queries default to no retry, no refetch
on focus or reconnect, `staleTime: 0`), defines the element `usage-summary`
through `ui/v1`, and adds the footer item
`{ id: 'usage', tag: 'usage-summary', order: 30 }` to the slot
`shell.conversation.footer` through `regions/v1` (`registerUsageRegion`). Its
cleanup removes the item, removes the definition and clears the query client.
The slot belongs to the `layout` bundle
([`bundles/desktop/layout/README.md`](../../desktop/layout/README.md)); the
other items of the footer are in [conversation](../../../docs/features/conversation.md).

### `<usage-summary>`

- The element takes no props. It renders in light DOM inside a
  `QueryClientProvider` with the bundle's query client and a
  `TooltipProvider` ([`src/client/elements.tsx`](src/client/elements.tsx)).
- It binds `usage/v1` and `workspace.selection/v1` with
  `services.whenAvailable`, so each is used only while a provider serves it,
  and reads the selected Thread id with `useSyncExternalStore` over
  `subscribe` and `current()`; a throwing `current()` counts as no selection.
  It mounts the summary again whenever the selected Thread changes, and draws
  nothing while no Thread is selected
  ([`src/client/components/usage-summary.tsx`](src/client/components/usage-summary.tsx),
  [`src/client/components/thread-usage.tsx`](src/client/components/thread-usage.tsx)).
- It reads `usage/v1.thread` with the query key `['thread', threadId, 'usage']`,
  every 3 s and on window focus, with `staleTime` 1 s and 2 retries, while both
  a Thread and a `usage/v1` provider are present
  ([`src/client/hooks/use-thread-usage.ts`](src/client/hooks/use-thread-usage.ts)).
  A failed read keeps the last data.

It draws two buttons ([`src/client/components/thread-usage.tsx`](src/client/components/thread-usage.tsx)):

- **Context**, labeled by `contextLabel`
  ([`src/client/domain/usage.ts`](src/client/domain/usage.ts)), with token
  counts in English compact notation with at most one decimal:
  `<used> / <capacity> · <percent>%` (percent rounded), `<used> / ?` without a
  capacity, `— / <capacity>` without a measured input, `—` without either.
  While no `usage/v1` provider is present it opens a tooltip:
  `Usage could not be refreshed.` after a failed read, else
  `Waiting for an OpenRouter measurement.`. Otherwise it opens the context
  popover below.
- **Cost**, labeled by `costLabel`: `—` before any data arrives, with no
  calls or when every call is unpriced, `~<$0.01` for a positive cost below one cent, else `~$<cost>` with
  two decimals; ` *` follows when any call is unpriced. It opens the cost
  popover below.

The **context popover** (`Context Window`):

- A bar of the used share of the capacity, clamped to 0–100 %, empty while the
  measurement or the capacity is unknown. Over the 50–95 % stretch of the bar
  lies a range input, step 1, for the compaction line. It loads its value with
  `usage/v1.compactionTarget()` and stays disabled until that answers and while
  a save runs; it starts at 80. A failed load shows its error in the status
  line and leaves the input disabled at 80.
- The line is saved with `usage/v1.setCompactionTarget` when the pointer is
  released, after an arrow, Home, End, PageUp or PageDown key, and on blur,
  only when the value differs from the last saved one. The answer becomes the
  shown and saved value, so a value `host-config` refuses moves the input back
  to the line in force with no message; a failed call restores the saved value
  and shows the error.
- Below the bar: the used tokens over the capacity, and `Compact at` with the
  line as tokens of the capacity, or as a percentage when the capacity is
  unknown; `—` until the line loads.
- `Context Breakdown`, collapsed at first: `Used context`, `Available space`
  (capacity minus used, at least 0), `Context window` and
  `Compaction threshold`; an unknown value, and the threshold until the line
  loads, reads `—`.
- `Compact Now` calls `usage/v1.compact` and shows `Compacting…` while it
  runs. The answer is shown as one sentence (`compactResultMessage`,
  [`src/client/domain/read.ts`](src/client/domain/read.ts)):

  | Answer                                 | Sentence                                                                             |
  | -------------------------------------- | ------------------------------------------------------------------------------------ |
  | `compacted`                            | `Compacted <n> message(s) into one summary (about <tokensFreed> tokens freed).`      |
  | `refused`, `disabled`                  | `Context compaction is disabled in the settings.`                                    |
  | `refused`, `missing_history`           | `This thread has no conversation to compact yet.`                                    |
  | `refused`, `nothing_to_compact`        | `Nothing condenses here: the recent conversation is already the smallest safe span.` |
  | `failed`                               | `The compaction failed (<code>); the log carries the attempt.`                       |
  | `busy`                                 | `Wait for the active run (and the queued input) to finish.`                          |
  | `missing`, `inactive`, `not_supported` | `This thread cannot be compacted.`                                                   |

- One status line at the bottom shows the last sentence or error.

The **cost popover**:

- `Could not refresh costs.` after a failed read, above the rest of the
  popover; below it, `No reported usage yet.` when there is no data or
  `total.calls` is 0, else the breakdown, so a failed read that kept earlier
  data shows the error line above the breakdown
  ([`src/client/components/thread-usage.tsx`](src/client/components/thread-usage.tsx)).
- The breakdown
  ([`src/client/components/cost-breakdown.tsx`](src/client/components/cost-breakdown.tsx)):
  `usageBreakdown` ([`src/client/domain/usage.ts`](src/client/domain/usage.ts))
  splits `threads` into the selected Thread's own entry (`Current Thread`,
  zero totals when absent) and every other entry (`Sub Threads`, with their
  summed subtotal). Each row shows its cost and `<n> call(s)` with compact
  input and output token counts; cached and reasoning tokens are not shown.
  `Sub Threads` is collapsed at first, disabled without entries, and opens to
  one row per descendant, named by its `name`. A footer row `Total` shows the
  cost of `total`.
- A partial cost carries ` *`, with `Partial: <n> calls have no reported
cost.` as its title and screen-reader text.

### How the window reaches `usage/v1`

The client part calls `usage/v1` over Connect, through the generated
`UsageService` (slice S65d), as a contract call on the services its element
receives. The window sends every Connect call over `window.doric.connect`, which
the preload carries over the platform channel `doric:connect` to Electron
main's `createConnectRelay`; the relay checks the sender, the
`doric-client-part`, the method and its scope, then forwards the call to the
host ([`packages/desktop/src/client/connect.ts`](../../../packages/desktop/src/client/connect.ts),
[`app/desktop/doric/src/app/api/preload.ts`](../../../app/desktop/doric/src/app/api/preload.ts),
[`app/desktop/doric/src/platform/bridge/connect-relay.ts`](../../../app/desktop/doric/src/platform/bridge/connect-relay.ts)).
The bundle declares no desktop part of its own.

The client wraps every call in [`src/client/domain/read.ts`](src/client/domain/read.ts):

- `readThreadUsage`, `readCompactionTarget` and `writeCompactionTarget` call
  with a deadline 10 s ahead; `compactThread` with a deadline 5 minutes
  ahead, since a compaction runs a model generation.
- A Thread id must be a non-empty string of at most 200 characters without a
  NUL character, or the call is not made and fails with
  `The item identifier is invalid.`.
- `writeCompactionTarget` refuses a value that is not a whole number from 50
  to 95 before calling, with `The compaction target must be a whole 50–95 percent.`.
- `readThreadUsage` fails with `The thread was not found.` when `thread`
  answers `undefined`.
- A contract error `unavailable`, `disconnected` or `generation_lost` becomes
  `Doric backend is unavailable.`; `invalid_output` becomes
  `Doric returned an invalid response.`; any other failure becomes
  `The request could not be completed.`.

### REST

The host route `GET /threads/:id/usage` belongs to the `transport` bundle,
which lists `usage/v1` under `optional`: it answers `usage/v1.thread` with
`Cache-Control: no-store`, and 404 `thread_not_found` when the answer is
`undefined`
([`bundles/foundation/transport/src/host/routes/threads.ts`](../../foundation/transport/src/host/routes/threads.ts),
[`bundles/foundation/transport/README.md`](../../foundation/transport/README.md)).

### Stylesheet

[`src/client/styles.css`](src/client/styles.css) emits only Tailwind
utilities over the platform theme (`desktop/ui/tailwind.css`), with no rules
of its own. It scans this part's sources, `packages/desktop/src`, and the
client sources of `layout`, `chat`, `settings`, `account` and `workspace`, so
that its utilities are the whole sorted set those window sheets use and a
later sheet re-emits no shared class after their responsive variants.

## Data and persistence

The bundle stores nothing. Usage is read from the runtime on every call; the
compaction line lives in the `execution.contextCompaction.pressurePercent`
field of the Doric configuration that `host-config` keeps
([`bundles/foundation/host-config/README.md`](../../foundation/host-config/README.md)).
The client keeps the usage only in its query cache.

## Configuration and limits

- The compaction line is a whole percentage from 50 to 95; 80 when the
  configuration has no `contextCompaction` section.
- The footer polls every 3 s per open window with a selected Thread.
- The bundle has no setting of its own.

## Development

- [`project.json`](project.json) declares `build` (`src/` without
  `src/client/` with [`tsconfig.json`](tsconfig.json), the client part with
  [`tsconfig.client.json`](tsconfig.client.json), then the bundle build into
  `dist/`), `typecheck` (the same two compilations, the first emitting declarations only;
  `tsconfig.client.json` also covers `src/contracts/`, `stories/` and
  `.storybook/`) and `test`.
- `test` compiles [`tsconfig.spec.json`](tsconfig.spec.json), which covers
  `src/host/`, `src/contracts/`, `src/client/domain/` and `tests/`, into
  `dist-tests/`, and runs `dist-tests/tests/*.test.js` with `node --test`:
  [`tests/router.test.ts`](tests/router.test.ts) (the host service through
  the router), [`tests/host-build.test.ts`](tests/host-build.test.ts) (the
  build, with no `dist/host/index.js`), [`tests/read.test.ts`](tests/read.test.ts) (the client calls and
  their errors), [`tests/usage.test.ts`](tests/usage.test.ts) (labels and
  breakdown) and [`tests/workspace-sheet.test.ts`](tests/workspace-sheet.test.ts)
  (the stylesheet scans the workspace client sources once, and the manifest
  version is `1.0.6`).
- `stories/` holds the stories of the element and its components, with
  fixture services in `stories/support/`;
  [`.storybook/preview.tsx`](.storybook/preview.tsx) wraps each story in the
  window's theme, this bundle's stylesheet and a tooltip provider.

```console
npx nx run bundle-usage:build
npx nx run bundle-usage:typecheck
npx nx run bundle-usage:test
```
