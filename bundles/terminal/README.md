# Terminal contracts

`terminal` publishes the `terminal/contracts` entrypoint with `terminal/v1`:
`run(input, call)` starts a tracked command in the calling prompt's Thread,
resolving with its result in the foreground or at once with its terminal ID in
the background. It mirrors `packages/host`'s `TerminalControl`.

In this stage the package has no manifest and is never staged; the embedded
`host-adapter` bundle in `agents/doric` provides `terminal/v1` until the
`terminal` bundle does. It answers `unavailable` for a prompt whose host has no
live terminals, which leaves the `files` terminal tool its plain-command
fallback.

```console
npx nx build bundle-terminal
npx nx test bundle-terminal   # includes the packages/host parity assertions
```
