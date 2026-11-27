# screen

Apply these rules to `bundles/features/screen/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the xpra screen of a Project's sandbox: ensuring the
session, publishing it, keeping the reader's screen views and their windows,
and drawing the Screens pane. Do not add to it serving the screen's HTTP or
WebSocket traffic: that belongs to the bundle that provides `screen.relay/v1`.
Do not add starting, stopping or acquiring a sandbox: that belongs to the bundle
that provides `runtime.lease/v1`. Do not draw the pane's group, header or
collapse control: that belongs to the bundle that provides `layout.stack/v2`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before changing it.
- Reach `screen.sessions/v2` only from `src/client/`, never from
  `src/desktop/`: a desktop generation has no route to a host contract. When
  the desktop part needs a host answer, add it to the dials of the `watch`
  state and take the answer through `deliver`, keyed by the dial's `seq`.
- Resolve `screen.sessions/v2` in the client with the scope `{ projectId }` of
  the dial's Project: the host part takes the lease from the call's scope.
- Run every sandbox command of the host part inside
  `runtime.lease/v1.withLease` of the call's scope, and never acquire a lease.
- Reach the sandbox's `/tmp` only through `sandbox.exec`, passing file content
  as an argument and never interpolating a value into command text:
  `sandbox.readFile` and `sandbox.writeFile` refuse paths outside the
  workspace.
- Keep the marker's token when a session restarts, and `forget` a Project's
  previous token before `expose` of a new one.
- Report a screen the reader cannot be served as a `ScreenSessionError` with a
  `ScreenUnavailableReason` in `src/host/session.ts`; let only a failure of a
  sandbox call or of the relay reject `attach`.
- Add a `screen.views/v1` method to `screenViewsMethods` in
  `src/contracts/index.ts` with `expose: 'desktop'`, and make a stream's
  listener the last item of its input tuple: a window reaches only exposed
  methods, and the desktop bridge treats only a last-item listener as a
  stream. Wire it in `screenViewsService` of `src/desktop/index.ts` through
  `envOf`, and implement it in `src/desktop/views.ts`. Give a
  `screen.sessions/v2` method `expose: 'desktop'` and serve it in
  `createScreenSessionsService` of `src/host/rpc/sessions.ts`.
- Keep the mapping of an answer to a status, the retry delays, `canRetry` and
  the window decision as pure functions in `src/desktop/status.ts`, and make
  every window call through `src/desktop/windows.ts`.
- Never store a status, a dial or window state in `views.json`. Add a stored
  field of a view as optional in `viewsFrom` of `src/desktop/store.ts`: one
  invalid entry makes the whole file read as no views.
- Keep the client's copies of `workspace.selection/v1` and `layout.stack/v2`
  in `src/client/peers.ts`, narrowed to what the part reads, and change a copy
  when its owner changes the members it reads: nothing checks the copy against
  the owner's definition. Never import `layout/contracts` or the `workspace`
  package, and never add `layout` or `workspace` to `package.json`.
- Make every `useSubscribed` read in `src/client/elements.tsx` return a
  primitive or a snapshot that keeps its identity while nothing changed: the
  selection answers a new object on every `current()`.
- Keep the elements free of state of their own: draw from the activation's
  store in `src/client/store.ts`. Wrap the root of an element that draws a
  `desktop/ui/sidebar` component reading the sidebar context, such as
  `SidebarMenuButton`, in `SidebarScope`: the layout's context does not reach
  the element.
- Put a control of the pane's header in the `<screen-group-action>` element,
  and register the pane only through `screenPane` in `src/client/index.ts`.
- When you add a utility class in `src/client/`, add it to the
  `@source inline(…)` list of `src/client/styles.css` and to `TOKENS` of
  [`tests/styles-cascade.test.ts`](tests/styles-cascade.test.ts), in the same
  order: an app whose own sheet lacks the class receives it only from this
  sheet. Keep the sheet at `source(none)`, under 8 KiB built, and
  free of the conflicting classes the test names.
- When you add a `ScreenUnavailableReason`, give it a row text and a retry
  choice in `presentationOf` of `src/client/elements.tsx`, and a retry delay
  and a `canRetry` answer in `src/desktop/status.ts`, in the same change.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "screen"`.
- Add session work in the sandbox to `src/host/session.ts` and its lease and
  relay handling to `src/host/provider.ts`; add view state and commands to
  `src/desktop/views.ts`; add what the pane draws to `src/client/elements.tsx`;
  add a new window-to-host call next to `src/client/api.ts`, answering `null`
  for every failure except an invalid identifier, as `createScreenApi` does.
- Add the test of each change in the same change: session behavior in
  [`tests/session.test.ts`](tests/session.test.ts) over the fake sandbox of
  [`tests/support/sandbox.ts`](tests/support/sandbox.ts); lease and relay
  handling in [`tests/provider.test.ts`](tests/provider.test.ts) over a
  `ScreenLease` and [`tests/router.test.ts`](tests/router.test.ts); decisions in
  [`tests/status.test.ts`](tests/status.test.ts); the views owner in
  [`tests/views.test.ts`](tests/views.test.ts), with an injected clock and id;
  the client's call, dial and mirror in [`tests/api.test.ts`](tests/api.test.ts),
  [`tests/dial.test.ts`](tests/dial.test.ts) and
  [`tests/store.test.ts`](tests/store.test.ts); the pane in
  [`tests/client/sidebar.test.ts`](tests/client/sidebar.test.ts), and a new
  pane state also as a story in `stories/`, which
  [`tests/client/story-pane.test.ts`](tests/client/story-pane.test.ts) renders.
- Update the feature doc [Screen](../../../docs/features/screen.md) with any
  change to the flow, the statuses, the pane or the windows.

## Verify

- `npx nx run bundle-screen:typecheck`: run it after any change under `src/`,
  `stories/` or `.storybook/`.
- `npx nx run bundle-screen:test`: run it after any change under `src/`,
  `tests/` or `stories/`, and run the tests only through this target, which
  builds the bundle first because the sheet test reads `dist/`.
- `npx nx run bundle-screen:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/` or
  `src/client/styles.css`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
