# notifications

Apply these rules to `bundles/desktop/notifications/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to announcing, as a native notice, a prompt that finishes in a
Thread the reporting window does not show while focused, and add to it no UI,
setting, tool or other kind of notice: drawing a Thread and its completion
belongs to the bundle that shows the Thread.

## Rules

- Keep `src/client/` an observer that draws nothing and decides nothing: for
  each live event of a Thread, sample the Thread the route shows and the
  window focus at the moment the event arrives, and report them with the
  event to `notifications.observations/v1`.
- Decide whether a notice is shown, and what it says, only in
  `src/desktop/decide.ts`, and show it only through `doric.notifications/v1`
  from `src/desktop/`.
- Announce only an event that closes a prompt (`prompt.finished` or
  `runtime.prompt-finished/v1`), and stay quiet only when the window that
  reported it is focused and its route shows that Thread.
- Decide each report on the reporting window's own route and focus alone, and
  never assume a single window: every app window whose chat holds a Thread (up
  to its 20 most recently viewed) reports that Thread's live events, whether or
  not it shows the Thread, and nothing merges the reports of two windows.
- Never await a report in the observer, and never let a failing report or a
  throwing source reach chat: chat does not await `onThreadUpdateHook` and
  calls it for every live event.
- Never let `report` reject because a notice could not be shown: the Thread's
  own log still records the completion.
- Never import `chat/contracts`: register on chat only through the structural
  copy `ChatHooksV2` in `src/client/observer.ts`, inside
  `HooksV1.whenAvailable`, and keep `chat.hooks/v2` under `optional` in
  [`manifest.json`](manifest.json), so that a composition without `chat` still
  loads this bundle.
- When `chat` changes the input of `onThreadUpdateHook`, change `ChatHooksV2`
  to match it: hooks are matched by contract id only, and nothing checks the
  copy against chat's definition.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "notifications"`.
- Update [`README.md`](README.md) and the feature doc
  [notifications](../../../docs/features/notifications.md) with any change to
  when a notice is shown or what it says.

## Verify

- `npx nx run bundle-notifications:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-notifications:test`: run it after any change under
  `src/` or `tests/`, and run the tests only through this target, which builds
  the bundle first, because the desktop tests load it from `dist/`.
- `npx nx run bundle-notifications:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
