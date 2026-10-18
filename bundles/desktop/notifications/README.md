# Notifications bundle

`notifications` tells you when an agent is done. When a prompt finishes in a
Thread you are not looking at, Doric shows a native operating system
notification with the Thread's name, the outcome and the start of the answer,
so you can leave a long task running and come back when it completes.

It is a desktop bundle with a client part (an observer in the workspace
window, with no UI) and a desktop part (the decision, in the desktop main
process), loaded by the `bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Notices:** one native notification per finished prompt, shown through the
  platform's `doric.notifications/v1`.
- **Contract:** `notifications.observations/v1` (desktopMain), whose one method
  `report(observation)` is exposed to windows over the desktop bridge.

The bundle requires `hooks/v1` and `navigation/v1` and has no settings or
tools.

## How it works

1. **The window observes.** The client part registers on the
   [`chat`](../chat/README.md) bundle's `chat.hooks/v1` `onThreadUpdateHook`
   once chat is available. For every live event of a Thread the chat holds, it
   samples the Thread shown by the route (`navigation/v1`) and whether the
   window has focus, and reports both with the event and the Thread's name.
2. **Main decides.** The desktop part ignores everything except the event that
   closes a prompt (`prompt.finished`, or `runtime.prompt-finished/v1`), and
   stays quiet when that Thread is the one shown in a focused window.
3. **Main shows.** The notice is titled with the Thread's name. Its body is the
   outcome (`Prompt completed`, `Prompt failed` or `Prompt cancelled`), followed
   by `·` and the answer collapsed to one line of at most 160 code points
   when the prompt stated one.

## Failure behavior

A notice is a courtesy, and the Thread's own log still records the completion:

- the observer never awaits a report, and a failing report or a throwing
  source never reaches the chat;
- `report` never fails because a notice could not be shown.

The client part copies the one chat hook it uses by contract ID instead of
importing `chat/contracts`, so a composition without chat still loads it.

## Development

```console
npx nx build bundle-notifications
npx nx typecheck bundle-notifications
npx nx test bundle-notifications
```

The tests cover the observer and the decision: which events are announced,
the wording, the 160 code point bound and the focused-Thread rule. The build
writes `bundles/desktop/notifications/dist`, which `doric-host:build-bundles`
stages into `app/backend/doric-host/dist/bundles/notifications`. To rebuild and
stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
