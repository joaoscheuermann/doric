# Resources bundle

`resources` shows you how hard the agent's environment is working: a footer
monitor in the desktop app reports CPU and memory use for the selected
Project's sandbox and for the machine the host runs on.

It is a feature bundle that provides `resources/v1` from its host part and the
`<resources-monitor>` element from its client part, loaded by the `bundle`
platform. See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `resources/v1`, with `host()` and `project()` reads.
- **UI:** `<resources-monitor>`, the footer monitor for the selected Project's
  sandbox and for the machine.

## `resources/v1`

- `host()` reads the machine the host runs on, as `GET /resources` answers it
  (CPU count and percent, load average, memory and uptime). The CPU sample is
  module state of the generation process, so its first reading has no percent.
- `project()` reads the container of the Project in `call.scope.projectId` on
  the lease it holds now, through `runtime.lease/v1.withLease`
  (`GET /projects/:id/resources`). It never acquires a lease; a lease state
  comes back as data, and a provider without a reading answers an
  `unavailable` container.

## Desktop UI

The client part defines `<resources-monitor>`. Its activation adds it to the
window's global footer (`layout.global-footer`, id `resources`, order 100)
through `registerResourcesRegion`. Without the layout there is no selected
Project, so only the machine reading is shown.

## Development

```console
npx nx build bundle-resources
npx nx typecheck bundle-resources
npx nx test bundle-resources
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
