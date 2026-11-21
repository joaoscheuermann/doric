# Feature: Notifications

- Status: `implemented`

## Problem

A prompt can run for minutes while the reader works in another Thread, another app or another window. The reader needs to learn that it finished, and how it ended, without watching the Thread. A notice must not appear for a Thread the reader is already looking at in the window that reports the event, and a notice that cannot be shown must never break the conversation or hide a completion.

## Decisions

- The bundle `notifications` decides when to notify from the event that closes a prompt. The durable type `prompt.finished` is also read as `runtime.prompt-finished/v1`, so the decision accepts both type names.
- The native notice is the platform capability `doric.notifications/v1`, `show({ title, body })`, which exists in `desktopMain` only. The bundle shows notices from its desktop part, and no window part shows one.
- The Thread a window shows is the one its route names, read as `navigation/v1.current()?.params.threadId`, with no check of the route's pattern: every route with a `threadId` parameter counts as showing that Thread.
- The client part reaches chat's `onThreadUpdateHook` through a structural copy of the hook in its own observer, and never imports `chat/contracts`.

## Current behavior and contracts

### The bundle

- The `notifications` bundle, version 1.0.2, provides `notifications.observations/v1@1.0.0`, requires `hooks/v1` and `navigation/v1`, and lists `chat.hooks/v2` and `runtime.prompt-finished/v1` as optional ([manifest.json](../../bundles/desktop/notifications/manifest.json)). It has a client part, an observer in each app window that draws nothing and decides nothing, and a desktop part in `desktopMain` that decides and shows the notice ([src/client/index.ts](../../bundles/desktop/notifications/src/client/index.ts), [src/desktop/index.ts](../../bundles/desktop/notifications/src/desktop/index.ts)). It has no settings, tools, routes or storage. The [notifications README](../../bundles/desktop/notifications/README.md) describes the bundle in full.
- Without the `chat` bundle the client part loads and reports nothing: it registers its observer through `hooks/v1.whenAvailable` once `chat.hooks/v2` is defined, and disposes the registration when chat goes away or the bundle deactivates ([src/client/index.ts](../../bundles/desktop/notifications/src/client/index.ts)).

### The flow

1. **Chat reports live events.** Each app window's chat holds at most 20 Threads, the most recently viewed, each with its own watch ([chat's thread-chats domain](../../bundles/desktop/chat/src/client/domain/thread-chats.ts)). For every live event of a held Thread, as it arrives, the window's chat calls `chat.hooks/v2.onThreadUpdateHook` with the Thread's ids and name and an `update` of kind `event`; it also calls it with an `update` of kind `updated` for every updated Thread record, and never awaits the hook ([chat's thread-chats store](../../bundles/desktop/chat/src/client/stores/thread-chats.ts)). The chat README gives [the hook's shape](../../bundles/desktop/chat/README.md#chathooksv2-client-200) and describes [which Threads a window holds](../../bundles/desktop/chat/README.md#the-conversation).
2. **The window observes.** For each call whose `update` is an `event`, the observer samples, at that moment, the Thread the window's route shows (`navigation/v1.current()?.params.threadId`) and whether the window has focus (`document.hasFocus()`), and calls `notifications.observations/v1.report` with the Thread's id and name, the event as received, and the two samples. It ignores `updated` records and omits `shownThreadId` when the route names no Thread ([src/client/observer.ts](../../bundles/desktop/notifications/src/client/observer.ts), [src/client/index.ts](../../bundles/desktop/notifications/src/client/index.ts)).
3. **`desktopMain` decides.** `report` stays quiet when the observation's window was focused and `shownThreadId` equals `threadId`. Otherwise it announces only an event whose `type` is `prompt.finished` or `runtime.prompt-finished/v1`, and ignores every other event ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts)).
4. **`desktopMain` shows.** The notice goes to `doric.notifications/v1.show({ title, body })` with the call `report` received ([src/desktop/index.ts](../../bundles/desktop/notifications/src/desktop/index.ts)).

The decision reads each report alone: two windows that hold the same Thread send two reports for each of its events, and each is decided on its own window's route and focus ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts), [src/client/observer.ts](../../bundles/desktop/notifications/src/client/observer.ts)). A window that holds the Thread without focus, or without showing it, therefore announces the completion even while another, focused window shows that Thread.

### `notifications.observations/v1` (desktopMain, 1.0.0)

- One method, `report(observation)`, resolving to nothing, callable from a window's client part (`expose: 'desktop'`, described in [Contexts and capabilities](../architecture/bundles/contexts.md)) ([src/contracts/index.ts](../../bundles/desktop/notifications/src/contracts/index.ts), [src/desktop/index.ts](../../bundles/desktop/notifications/src/desktop/index.ts)).
- An observation carries the Thread's id and name, the event as received, and the window's two samples; of the event only `type` and its payload `event` are read. The platform rejects an input that does not match before `report` runs ([src/contracts/index.ts](../../bundles/desktop/notifications/src/contracts/index.ts)).
- `report` resolves once the decision is made and any notice has been handed to the platform ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts)). The [notifications README](../../bundles/desktop/notifications/README.md#notificationsobservationsv1-desktopmain-100) gives the full shape and the scope keys a window may send.

### The notice

- The title is the Thread's name ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts)).
- The body starts with the outcome, read from the `status` of the event's payload: `Prompt failed` for `failed`, `Prompt cancelled` for `cancelled`, and `Prompt completed` for any other value, for no status, and for a payload that is not an object ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts)). The payload of a finished prompt is described in the [runtime README](../../bundles/runtime/runtime/README.md#runtimeprompt-finishedv1).
- When the payload's `text` is a string, its runs of whitespace become single spaces, it is trimmed, and it is cut to its first 160 code points (`NOTIFICATION_LINE_LIMIT`). A non-empty result follows the outcome as `<outcome> · <answer>`; otherwise the body is the outcome alone ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts)).
- The platform bounds each line of a notice to 200 code points, shows nothing for an empty title or on a platform without native notifications, and only logs a refusal of the operating system ([app/desktop/doric/src/platform/native/notifications.ts](../../app/desktop/doric/src/platform/native/notifications.ts), [Contexts and capabilities](../architecture/bundles/contexts.md#shapes-of-the-platform-contracts)).

### Failures

- A notice is a courtesy: the Thread's own log still records the completion as a `prompt.finished` event ([runner.ts](../../bundles/runtime/runtime/src/host/domain/runner.ts), [threads.ts](../../bundles/runtime/runtime/src/host/store/threads.ts), [runtime README](../../bundles/runtime/runtime/README.md#runtimeprompt-finishedv1)). The [notifications README](../../bundles/desktop/notifications/README.md#errors-and-failure-behavior) describes the bundle's failure behavior.
- The observer never awaits a report; a rejected report and a throwing sample are swallowed and never reach chat ([src/client/observer.ts](../../bundles/desktop/notifications/src/client/observer.ts)).
- `report` never rejects because a notice could not be shown: a rejection of `doric.notifications/v1.show` is swallowed ([src/desktop/decide.ts](../../bundles/desktop/notifications/src/desktop/decide.ts)).
