# usage

Apply these rules to `bundles/features/usage/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to answering a Thread's usage and cost with its context
capacity filled from the live model catalog, to moving the context compaction
line, and to the conversation footer's summary of both. Never store or
aggregate usage here: the runtime measures and holds it. Never compact a
Thread here: hand the request to `runtime.threads/v1.compact`. Never look up a
model's capacity here: ask `models/v1`. Never add a setting or a field of the
compaction policy here other than `pressurePercent`: the configuration
belongs to `host-config`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Read usage only through `runtime.usage/v1.read` in `src/host/usage.ts`, and
  fill only a missing `contextWindow` there, through `withContextCapacity`:
  never replace a recorded capacity, and never let a failed or invalid
  catalog answer fail `usage/v1.thread`.
- Write the compaction line only through `host-config/v1.replace` with the
  whole configuration in force, changing `pressurePercent` alone, and answer
  the line the configuration still names when `replace` refuses: never throw
  for a refusal.
- Add a method to `usage/v1` in `usageMethods` and the `Usage` interface of
  `src/contracts/index.ts` and in `createUsageService` of
  `src/host/rpc/usage.ts`; give it the
  `(doric.platform.v1.method).expose = EXPOSE_DESKTOP` option in
  `proto/doric/usage/v1/usage.proto` only when a window calls it.
- Call `usage/v1` from the client part only through a function of
  `src/client/domain/read.ts` that sets a deadline (10 s for a read or a
  settings write, longer only for a call that runs a model generation) and
  turns every failure into an `Error` with a fixed message; never call the
  service from a component.
- Put client logic that needs no React and no DOM in `src/client/domain/`:
  `tsconfig.spec.json` compiles only that folder of the client part, so a
  test can reach no other client file.
- Put components in `src/client/components/`, hooks in `src/client/hooks/`,
  and the element definitions in `src/client/elements.tsx`; read every
  service inside a component through `services.whenAvailable`, so the summary
  keeps drawing while a provider is absent.
- Read the selected Thread only through `WorkspaceSelectionV1` in
  `src/client/api/workspace.ts`, and never import `workspace/contracts`. When
  the workspace changes the part of `workspace.selection/v1` this copy names,
  change the copy to match it: nothing checks the copy against the
  workspace's definition.
- Register the footer item only in `registerUsageRegion` of
  `src/client/index.ts`; add a control to the footer inside `<usage-summary>`,
  never as a second item of `shell.conversation.footer`.
- Keep the 50–95 whole-percent range of the compaction line equal in
  `writeCompactionTarget` of `src/client/domain/read.ts`, in `targetMin` and
  `targetMax` of `src/client/components/thread-usage.tsx`, in the
  `contextCompaction` schema of
  [`host-config`](../../foundation/host-config/src/host/config/schema.ts), and
  in the compaction check of
  [`settings`](../../desktop/settings/src/client/domain/config.ts); change all
  four in one change.
- Keep every `@source` line of `src/client/styles.css`: removing one lets a
  later sheet re-emit a shared class after a window bundle's responsive
  variant.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "usage"`.
- When you raise `version` in [`manifest.json`](manifest.json), change the version that
  `tests/workspace-sheet.test.ts` asserts in the same change, or `test` fails.
- Add the test of each change in the same change: a host test in
  [`tests/router.test.ts`](tests/router.test.ts), a test of a
  client call or its error in [`tests/read.test.ts`](tests/read.test.ts), and
  a test of a label or the cost breakdown in
  [`tests/usage.test.ts`](tests/usage.test.ts).
- Add a story under `stories/` for each new state the summary or a popover
  draws, with its fixture in `stories/support/usage.ts`.
- Update the feature doc [usage](../../../docs/features/usage.md) with any
  change to what the footer shows or what `usage/v1` answers, and
  [context compaction](../../../docs/features/context-compaction.md) with any
  change to `Compact Now` or the compaction line.

## Verify

- `npx nx run bundle-usage:typecheck`: run it after any change under `src/`,
  `stories/` or `.storybook/`.
- `npx nx run bundle-usage:test`: run it after any change under
  `src/host/`, `src/contracts/`, `src/client/domain/`, `tests/`,
  `src/client/styles.css` or `manifest.json`.
- `npx nx run bundle-usage:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/` or
  `src/client/styles.css`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
