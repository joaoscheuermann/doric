# Resources contracts

`resources` publishes the `resources/contracts` entrypoint with `resources/v1`:
`host()` reads the machine the host runs on, as `GET /resources` answers it
(CPU count and percent, load average, memory and uptime).

In stage 9 the package has no manifest and is never staged: the
kernel-embedded `transport` bundle provides `resources/v1` beside the
`GET /resources` route, so a desktop window reads it over the bridge. Stage 10
moves the provider into the `resources` bundle, which also answers the
Project's container resources, without changing this import path.

```console
npx nx build bundle-resources
npx nx test bundle-resources
```
