# Runtime contracts

`runtime` publishes the `runtime/contracts` entrypoint: typed references,
types and zod schemas of the runtime's contracts. In this stage the package has
no manifest and is never staged; the embedded `host-adapter` bundle in
`agents/doric` provides the contracts over the per-prompt `Host` facade until
the `runtime` bundle itself does.

- `runtime.threads/v1` — `spawn`, `list`, `get`, `events`, `send`, `interrupt`
  and `terminate` over the calling prompt's direct children, mirroring
  `packages/host`'s `ThreadControl`.
- `runtime.workspace/v1` — `cwd` and `setCwd` of the calling prompt's Thread.
- `runtime.lease/v1` — `describe`, `exec`, `readFile` and `writeFile` on the
  sandbox leased to the calling prompt's Project. `exec` carries no abort
  signal and returns text only.

Every method is scoped by the `Call` it receives. Record schemas are loose, so
records with more fields than the contract names travel unchanged.

```console
npx nx build bundle-runtime
npx nx test bundle-runtime   # includes the packages/host parity assertions
```
