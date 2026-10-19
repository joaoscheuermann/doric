# Usage bundle

`usage` shows you what each conversation costs and how full its context
window is. The footer of the desktop app summarizes the selected Thread's
context use and the cost of its whole subtree, including the children it
delegated to, and lets you compact the context or move the point at which
Doric compacts it automatically.

It is a feature bundle that provides `usage/v1` from its host part and the
`<usage-summary>` element from its client part, loaded by the `bundle`
platform. See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `usage/v1`, with `thread`, `compact`, `compactionTarget` and
  `setCompactionTarget`.
- **UI:** `<usage-summary>`, the footer's context and cost summary.

## Host

`usage/v1.thread(threadId)` reads the stored projection from
`runtime.usage/v1.read`. When the last measurement has no context capacity, it
asks `models/v1.contextWindow` and, for a finite capacity above 0, sets
`contextWindow` with `contextWindowSource: 'catalog'`. A recorded capacity is
never replaced, and no answer leaves it unknown. `undefined` means the Thread
does not exist (`thread_not_found` on `GET /threads/:id/usage`).

The compaction members back the footer's context popover:

- `compact(threadId)` compacts the Thread through
  `runtime.threads/v1.compact`.
- `compactionTarget()` reads the pressure line, as a percentage of the context
  window, from the configuration in force (`host-config/v1`); an absent
  section answers the default.
- `setCompactionTarget({ pressurePercent })` writes it back to the
  configuration. A refused replacement keeps the line the configuration still
  names.

## Client

`<usage-summary>` shows the selected Thread's context window use and its whole
subtree's cost, polling `usage/v1` every 3 s. It renders nothing without a
selected Thread. Its popover holds the consumption bar, the compaction target
slider and the manual compaction. Its footer item (`layout.footer`, id
`usage`, order 30) is added by `registerUsageRegion` during activation.

## Development

```console
npx nx build bundle-usage
npx nx typecheck bundle-usage
npx nx test bundle-usage
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
