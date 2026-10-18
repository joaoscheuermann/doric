# Host Kernel Instructions

Applies to `app/backend/doric-host/*`. Follow the root `GROUNDING.md` and
`AGENTS.md` first.

The host kernel reads the composition, starts the bundle platform, and owns
the native listener and generic desktop bridge. Projects, Threads,
configuration, credentials, sandbox settings, tools, and agent execution belong
to their bundles. Keep those features out of the kernel.

Keep `src/index.ts` as a small composition root. Put bundle loading and
composition checks in `src/lib/bundles/boot.ts`; put desktop bridge behavior in
`src/lib/bridge/`. Reuse existing bundle services and test helpers before
adding another adapter or abstraction.

Test host behavior through its public process, HTTP, Socket.IO, and platform
boundaries. The full PostgreSQL and Docker workflow lives in
`app/backend/doric-host-e2e`.
