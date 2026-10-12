# Terminal bundle

`terminal` provides `terminal/v1@1.1.0`: tracked shell commands of the
calling prompt's Thread (`run`) and the terminal sessions of every Project
(`list`, `create`, `snapshot`, `input`, `resize`, `stop`, and the
`watchProject` stream). The registry, OSC 633;E command tracking and
chunk-boundary redaction moved here from the runtime.

- **Host part** (`src/host`): the registry, the provider, the `terminal`
  tool (order 500, always available) and the cleanup on
  `runtime.hooks/v1.onThreadsClosingHook`.
- **Client part** (`src/client`): the window's terminal store and the
  elements `terminal-new-button`, `terminal-rows`, `terminal-manual` and
  `terminal-view`. Their region items and sidebar rows are added by
  `registerTerminalSurfaces` once the layout drops its provisional
  terminals (stage 10, WP-10N).

`terminal/contracts` keeps `TerminalV1` (`run` only) for the 1.0.0
consumers; `TerminalServiceV1` is the full 1.1.0 contract. The bundle is not
in any composition until stage 10's host switch (WP-10L).

```console
npx nx build bundle-terminal
npx nx test bundle-terminal
```
