# Runtime contracts

`runtime` publishes the `runtime/contracts` entrypoint: typed references,
types and zod schemas of the runtime's contracts, including the per-prompt
`Host` types in `contracts/tool-host`. The bundle provides them over the
prompt-scoped host it builds for each prompt.

- `runtime.threads/v1` — `spawn`, `list`, `get`, `events`, `send`, `interrupt`
  and `terminate` over the calling prompt's direct children, through the
  `ThreadControl` type in `contracts/tool-host`.
- `runtime.workspace/v1` — `cwd` and `setCwd` of the calling prompt's Thread.
- `runtime.lease/v1` — `describe`, `exec`, `readFile` and `writeFile` on the
  sandbox leased to the calling prompt's Project. `exec` carries no abort
  signal and returns text only.

Every method is scoped by the `Call` it receives. Record schemas are loose, so
records with more fields than the contract names travel unchanged.

```console
npx nx build bundle-runtime
npx nx test bundle-runtime
```
