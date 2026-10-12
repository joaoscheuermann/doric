# Usage bundle

`usage` answers a Thread's usage and cost and draws the footer's usage summary.

## Host

`usage/v1.thread(threadId)` reads the stored projection from
`runtime.usage/v1.read`. When the last measurement has no context capacity, it
asks `models/v1.contextWindow` and, for a finite capacity above 0, sets
`contextWindow` with `contextWindowSource: 'catalog'`. A recorded capacity is
never replaced, and no answer leaves it unknown. `undefined` means the Thread
does not exist (`thread_not_found` on `GET /threads/:id/usage`).

## Client

`<usage-summary>` shows the selected Thread's context window use and its whole
subtree's cost, polling `usage/v1` every 3 s. It renders nothing without a
selected Thread. Its footer item (`layout.footer`, id `usage`, order 30) is
added by `registerUsageRegion` once the layout drops its provisional item.
