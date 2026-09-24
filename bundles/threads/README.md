# Threads bundle

`bundle-threads` contains the delegation capabilities Doric exposes to its
agent. Its build produces `agents/doric/dist/bundles/threads`; the Direct host
loads that artifact through the `bundle` package.

## Capabilities

The bundle provides these always-available tools, which act only on the calling
prompt's direct child threads in the same project:

- `spawn_thread` — create a child chat and delegate a self-contained task;
- `list_threads`, `get_thread` — observe direct children and their events;
- `send_to_thread` — queue a follow-up instruction in a child;
- `interrupt_thread`, `terminate_thread` — cancel one active prompt or close a
  child subtree.

Each tool reads its capabilities from the per-prompt `Host` facade's `threads`
namespace, whose contract lives in `packages/host`. The bundle never imports
`agents/doric` internals.

Skills cover delegating self-contained work, inspecting delegated work, and
steering or closing children. The authoritative resource order and availability
flags are in [`manifest.json`](manifest.json).

## Change the bundle

1. Update a tool in `tools/<name>.ts` or add a skill at
   `skills/<name>/SKILL.md`.
2. Reach the host only through the `Host` contract; add a namespace to
   `packages/host` first if one is missing.
3. Keep each skill's `allowed-tools` references local to this bundle.
4. Update `manifest.json` when resources or their ordering change.
5. Build and test; the runtime loader accepts compiled `.js` tools only.

## Development

```console
npx nx build bundle-threads
npx nx typecheck bundle-threads
npx nx test bundle-threads
```

To rebuild every bundle used by the Direct host:

```console
npx nx run doric:build-bundles
```
