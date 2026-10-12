# Resources

`resources` provides `resources/v1` (stage 10, §3.12):

- `host()` reads the machine the host runs on, as `GET /resources` answers it
  (CPU count and percent, load average, memory and uptime). The CPU sample is
  module state of the generation process, so its first reading has no percent.
- `project()` reads the container of the Project in `call.scope.projectId` on
  the lease it holds now, through `runtime.lease/v1.withLease`. It never
  acquires a lease; a lease state comes back as data, and a provider without a
  reading answers an `unavailable` container.

The client part defines `<resources-monitor>`, the footer monitor for the
selected Project's sandbox and for the machine. `registerResourcesRegion` adds
it to `layout.panel.footer`; WP-10N calls it when the layout's provisional
monitor goes away.

```console
npx nx build bundle-resources
npx nx test bundle-resources
```
