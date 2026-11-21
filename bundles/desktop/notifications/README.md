# notifications

`notifications` tells you when an agent is done. When a prompt finishes in a
Thread you are not looking at, Doric shows a native operating system
notification with the Thread's name, the outcome and the start of the answer,
so you can leave a long task running and come back when it completes.

It is a desktop bundle with a client part (an observer in each workspace
window, with no UI) and a desktop part (the decision, in the desktop's
`desktopMain` process). The [main README](../../../README.md) describes Doric as
a whole, and [`packages/bundle`](../../../packages/bundle/README.md) how a
bundle is built, loaded and activated. The flow across bundles is described in
the feature doc [Notifications](../../../docs/features/notifications.md). This
README is the bundle's complete description.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                  |
| `id`              | `notifications`, version `1.0.2`, engine `doric ^1.0.0`              |
| `description`     | "Native notice when a prompt finishes outside the reader's view."    |
| `provides`        | `notifications.observations/v1@1.0.0`                                |
| `requires`        | `hooks/v1@^1.0.0`, `navigation/v1@^1.0.0`                            |
| `optional`        | `chat.hooks/v2`, `runtime.prompt-finished/v1`                        |
| `desktopScope`    | `notifications.observations/v1`: `projectId`, `threadId`, `promptId` |

`runtime.prompt-finished/v1` is an event type the decision accepts, not a
service the bundle calls. The bundle has no settings, tools, routes, elements
or storage types.

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts), exported as
  `notifications/contracts` through [`package.json`](package.json)): the
  observation schemas and `notifications.observations/v1`, listed under
  [Exports of `notifications/contracts`](#exports-of-notificationscontracts).
- **Client** ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/observer.ts`](src/client/observer.ts)): on activation it waits,
  through `hooks/v1.whenAvailable`, for `chat.hooks/v2`, and registers one
  observer on its `onThreadUpdateHook`; the registration is disposed when chat
  goes away or the bundle deactivates. It draws nothing and decides nothing.
- **Desktop** ([`src/desktop/index.ts`](src/desktop/index.ts),
  [`src/desktop/decide.ts`](src/desktop/decide.ts)): on activation it provides
  `notifications.observations/v1`, whose `report` decides whether an
  observation deserves a notice and shows it through `doric.notifications/v1`.

## Contracts provided

### `notifications.observations/v1` (desktopMain, 1.0.0)

Defined in [`src/contracts/index.ts`](src/contracts/index.ts) and provided by
[`src/desktop/index.ts`](src/desktop/index.ts), with cardinality `one`, the
default of `defineService`
([Contracts](../../../docs/architecture/bundles/contracts.md)). `CallArg` is
the optional call argument of `bundle/contracts`, described in
[The call](../../../docs/architecture/bundles/contexts.md#the-call):

```ts
interface NotificationObservations {
  report(observation: PromptObservation, call?: CallArg): Promise<void>;
}

// strict object
type PromptObservation = {
  threadId: string;
  threadName: string; // the name of the Thread record the chat holds
  event: ThreadEvent; // the live event, as received
  shownThreadId?: string; // navigation/v1.current()?.params.threadId at receive time
  windowFocused: boolean; // document.hasFocus() at receive time
};

// loose object: other fields pass through; only `type` and `event` are read
type ThreadEvent = { type: string; event: unknown };
```

| Method   | Input               | Output | `expose`  |
| -------- | ------------------- | ------ | --------- |
| `report` | `PromptObservation` | `void` | `desktop` |

`report` is exposed to windows over the desktop bridge, and a window may send
the scope keys `projectId`, `threadId` and `promptId` with it
([`manifest.json`](manifest.json)); the bundle's own client part sends no
scope keys ([`src/client/index.ts`](src/client/index.ts)). The platform
validates the input with `promptObservationSchema` before `report` runs and
rejects a mismatch with `invalid_input`, as
[Contracts](../../../docs/architecture/bundles/contracts.md) describes.
`report` resolves once the decision is made and any notice has been handed to
the platform; it has no error code of its own
([`src/desktop/decide.ts`](src/desktop/decide.ts)).

### Exports of `notifications/contracts`

From [`src/contracts/index.ts`](src/contracts/index.ts):

| Name                                           | What it is                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `threadEventSchema`, `ThreadEvent`             | The loose schema and type of one live Thread event                        |
| `promptObservationSchema`, `PromptObservation` | The strict schema and type of one observation                             |
| `NotificationObservations`                     | The service interface                                                     |
| `NotificationObservationsV1`                   | The contract reference `notifications.observations/v1`                    |
| `notificationObservationsMethods`              | The method table: `report` with its input and output schemas and `expose` |

## Contracts used

| Contract                     | Kind     | What for                                                                                                                                                                                                                                   |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hooks/v1`                   | requires | `whenAvailable` registers the observer once `chat.hooks/v2` is defined ([`src/client/index.ts`](src/client/index.ts))                                                                                                                      |
| `navigation/v1`              | requires | `current()?.params.threadId` is the Thread the window's route shows ([`src/client/index.ts`](src/client/index.ts))                                                                                                                         |
| `chat.hooks/v2`              | optional | `onThreadUpdateHook` delivers every live event of a Thread the window's chat holds ([`src/client/observer.ts`](src/client/observer.ts), [chat README](../chat/README.md))                                                                  |
| `runtime.prompt-finished/v1` | optional | The event type, besides `prompt.finished`, that closes a prompt ([`src/desktop/decide.ts`](src/desktop/decide.ts), [runtime README](../../runtime/runtime/README.md))                                                                      |
| `doric.notifications/v1`     | platform | `show({ title, body })` draws the native notice ([`src/desktop/index.ts`](src/desktop/index.ts)); its shape and bounds are in [Contexts and capabilities](../../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts) |

The client part does not import `chat/contracts`: it registers through
`ChatHooksV2`, a structural copy of the one chat hook it uses, an `observe`
hook defined by contract id in
[`src/client/observer.ts`](src/client/observer.ts), so a composition without
`chat` still loads the bundle. The copy's input is
`{ projectId, threadId, threadName, update }`, with `update` either
`{ kind: 'event', event: ThreadEvent }` or `{ kind: 'updated', thread }`;
nothing checks it against chat's definition.

## How a notice is decided

1. **The window observes.** For each `onThreadUpdateHook` call whose `update`
   is an `event`, the observer samples the Thread the route shows and whether
   the window has focus at that moment, and reports them with the Thread's id
   and name and the event, as received; it omits `shownThreadId` when the
   route names no Thread. An `updated` record is ignored
   ([`src/client/observer.ts`](src/client/observer.ts),
   [`src/client/index.ts`](src/client/index.ts)). Every window whose chat holds
   the Thread reports its events, whether or not it shows the Thread, and the
   desktop part decides each report on the reporting window's own route and
   focus; nothing merges the reports of two windows.
2. **Main decides.** `report` stays quiet when the window is focused and
   `shownThreadId` equals `threadId`. Otherwise it announces only an event
   whose `type` is `prompt.finished` or `runtime.prompt-finished/v1`, and
   ignores every other event ([`src/desktop/decide.ts`](src/desktop/decide.ts)).
3. **Main shows.** The notice's title is the Thread's name. Its body is the
   outcome read from the `status` of the payload `event.event`, where a payload
   that is not an object counts as no payload: `Prompt failed` for
   `failed`, `Prompt cancelled` for `cancelled`, and `Prompt completed` for any
   other value or none. When the payload's `text` is a string, its whitespace
   runs are collapsed to single spaces, it is trimmed and cut to its first 160
   code points; a non-empty result is appended as `<outcome> · <answer>`
   ([`src/desktop/decide.ts`](src/desktop/decide.ts)). The notice is shown
   through `doric.notifications/v1` with the call `report` received
   ([`src/desktop/index.ts`](src/desktop/index.ts)).

## Data, side effects and configuration

- **Data.** The bundle stores nothing; each report is decided from the
  observation alone ([`src/desktop/decide.ts`](src/desktop/decide.ts)).
- **Side effects.** One native notification per announced report, through
  `doric.notifications/v1` ([`src/desktop/index.ts`](src/desktop/index.ts)),
  and one `report` call over the desktop bridge per live event of a held Thread
  ([`src/client/observer.ts`](src/client/observer.ts)).
- **Configuration.** None: the bundle has no settings
  ([`manifest.json`](manifest.json)).

## Limits

- The answer in the body is at most 160 code points
  (`NOTIFICATION_LINE_LIMIT`, [`src/desktop/decide.ts`](src/desktop/decide.ts)).
  The platform bounds each line of a notice to 200 code points, and shows
  nothing for an empty title or on an unsupported platform
  ([Contexts and capabilities](../../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts)).
- Only the Threads a window's chat holds are observed
  ([`src/client/observer.ts`](src/client/observer.ts)); which Threads those are
  is described in the [chat README](../chat/README.md).

## Errors and failure behavior

A notice is a courtesy, and the Thread's own log still records the completion
as a `prompt.finished` event
([runtime README](../../runtime/runtime/README.md#runtimeprompt-finishedv1)):

- the observer never awaits a report, and a failing report or a throwing
  source never reaches the chat
  ([`src/client/observer.ts`](src/client/observer.ts));
- `report` never fails because a notice could not be shown: a rejection of
  `doric.notifications/v1.show` is swallowed
  ([`src/desktop/decide.ts`](src/desktop/decide.ts)).

Without `chat` the bundle loads and reports nothing
([`src/client/index.ts`](src/client/index.ts)).

## Build and test

```console
npx nx run bundle-notifications:build
npx nx run bundle-notifications:typecheck
npx nx run bundle-notifications:test
```

The build compiles the parts and writes `bundles/desktop/notifications/dist`
([`project.json`](project.json)); `doric-host:build-bundles` stages it into
`app/backend/doric-host/dist/bundles`
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
The `test` target builds the bundle first, compiles the tests to `dist-tests`
and runs them with `node --test` ([`project.json`](project.json)).

The tests live in [`tests/`](tests): [`observer.test.ts`](tests/observer.test.ts)
covers the observer (what each report carries, ignored `updated` records, and
that failures never reach chat), and [`decide.test.ts`](tests/decide.test.ts)
boots the built desktop part through
[`tests/support/desktop.ts`](tests/support/desktop.ts) and covers the decision
(which events are announced, the wording, the 160 code point bound, the
focused-Thread rule and a swallowed failure to show).
