# Splash and recovery

- Status: living document. It describes the desktop's splash and recovery surface as implemented on 2026-11-20.

## Summary

The splash and recovery surface is one technical window of the desktop app, outside any bundle. Before any other window opens, it shows the steps of loading the composition; when loading fails, it shows what failed and offers the actions that correct the composition. The Electron main drives it ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)), and the page draws it ([`splash.ts`](../../../app/desktop/doric/src/splash-page/splash.ts), [`view.ts`](../../../app/desktop/doric/src/splash-page/view.ts)).

The surface uses no contract a bundle provides. It talks to the main through the platform-internal contract `doric.splash/v1`, and the main reaches the host only through the platform contracts `doric.catalog/v1` and `doric.diagnostics/v1`, so the surface works when the core or a foundation bundle is broken.

## One surface outside any bundle

The page and its code live in the desktop app, under [`splash-page/`](../../../app/desktop/doric/src/splash-page/index.html) and [`platform/splash/`](../../../app/desktop/doric/src/platform/splash/state.ts); no bundle contributes to it. It is a vanilla DOM page that imports no bundle code: its only stylesheets are the platform's `theme.css` (`/platform/desktop@<version>/theme.css`) and its own `splash.css` ([`index.html`](../../../app/desktop/doric/src/splash-page/index.html)). The protocol serves it at `doric://app/platform/splash@<version>/index.html`, where `<version>` is the shell version, with a content security policy of its own ([`resources.ts`](../../../app/desktop/doric/src/platform/protocol/resources.ts), [`csp.ts`](../../../app/desktop/doric/src/platform/protocol/csp.ts), [`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [doric:// protocol](doric-protocol.md)).

The window is frameless, 610 by 487 pixels, not resizable, sandboxed and context-isolated, with the same preload as every window; its background is the theme token `window` for the current light or dark mode, which the main reads from the platform's `tokens.json`, and it follows a change of the system theme as every window does ([`window.ts`](../../../app/desktop/doric/src/platform/splash/window.ts), [`tokens.ts`](../../../app/desktop/doric/src/platform/tokens.ts), [`main.ts`](../../../app/desktop/doric/src/main.ts)). It has no window key, refuses navigation away from its page and opens no other window, so bundles never see it ([`window.ts`](../../../app/desktop/doric/src/platform/splash/window.ts)).

The page draws an art pane beside the state. It shades one of three bundled photographs live with WebGPU when a device arrives within 1,000 ms, and otherwise shows the shaded export `art-shaded.webp`; an unpackaged build with `DORIC_SPLASH_ART=shaded` always shows the export ([`choose-art.ts`](../../../app/desktop/doric/src/splash-page/art/choose-art.ts), [`window.ts`](../../../app/desktop/doric/src/platform/splash/window.ts)). A GitHub link opens the project's repository: the page's click handler sends only the key `github`, and the main opens the URL it maps that key to; the anchor's `href` is not followed ([`splash.ts`](../../../app/desktop/doric/src/splash-page/splash.ts), [`state.ts`](../../../app/desktop/doric/src/platform/splash/state.ts), [`index.html`](../../../app/desktop/doric/src/splash-page/index.html)).

The surface writes nothing through `log/v1`. What the startup records, such as a failed recovery action or a failed `onAppReadyHook`, goes to the platform log, one JSON line per record on the main's console ([`log.ts`](../../../app/desktop/doric/src/platform/log.ts), [`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)).

## The contract `doric.splash/v1`

The page and the main talk through `doric.splash/v1`, which exists only between them; it is not in the platform's contract module and no bundle can reach it ([`protocol.ts`](../../../app/desktop/doric/src/platform/splash/protocol.ts)). Its full shape:

```ts
// doric.splash/v1 (desktop, splash page only)
state(): stream of SplashState   // the current state first, then every change
act(action: RecoveryAction): void

type SplashState =
  | { state: 'loading'; step: 'connecting' | 'catalog' | 'download' | 'verify' | 'activation';
      progress?: { done: number; total: number } }
  | { state: 'host-unreachable'; hostUrl: string; lastError: string; attempts: number; hasSnapshot: boolean }
  | { state: 'bundle-failure'; bundles: { id: string; version: string; reasons: QuarantineReason[] }[] }
  | { state: 'core-failure'; core: { id: string; version: string }; error: string; hasLastGoodCore: boolean }
  | { state: 'recovery'; reason: string; diagnostics?: Diagnostics; hasLastGoodCore: boolean };

type RecoveryAction =
  | { action: 'retry' }
  | { action: 'open-last-known' }
  | { action: 'continue' }
  | { action: 'disable'; bundleId: string }
  | { action: 'use-last-good-core' }
  | { action: 'reset-composition' }
  | { action: 'open-link'; link: 'github' };
```

`QuarantineReason` and `Diagnostics` are the platform's types from `bundle/contracts` ([Core](core.md), [Observability](observability.md)).

The IPC dispatcher answers the splash only from the splash window's main frame. Of contract calls it accepts `act` as a call and `state` as a subscription, with `bundleId: null`; any other contract or method fails with `unavailable`, and an action that fails the schema fails with `invalid_input`. Asked to describe its window, the splash gets a technical window with no key, no generation and the app's version, which the page shows; it has no catalog ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`state.ts`](../../../app/desktop/doric/src/platform/splash/state.ts), [`splash.ts`](../../../app/desktop/doric/src/splash-page/splash.ts)). The dispatcher opens the link of `open-link` itself and hands every other action to the startup.

## The startup behind the splash

The main opens the splash first and then runs the startup ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)):

1. **Connecting.** It waits for the host bridge, the Socket.IO namespace `/doric/bridge`. Each failed attempt shows `host-unreachable`.
2. **Catalog.** It reads `doric.catalog/v1.distribution()` from the host.
3. **Verify and download.** For every bundle whose host state is not `disabled`, it checks each listed file in the local cache against the SHA-256 the catalog gives, and fetches a missing or different file with `doric.catalog/v1.artifact`, keeping it only when its SHA-256 matches. A file that cannot be fetched or does not match quarantines its bundle with `invalid_part` ([`artifacts.ts`](../../../app/desktop/doric/src/platform/catalog/artifacts.ts), [`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts)).
4. **Activation.** It resolves the `desktopMain` and `client` parts and starts the generation's `desktopMain` process.
5. The splash stays at least 5 seconds in all, then the main fires `onAppReadyHook` in the new generation and starts a 30-second deadline ([`timing.ts`](../../../app/desktop/doric/src/platform/splash/timing.ts)).
6. The first window that calls `ready()` closes the splash. A window that becomes ready before `onAppReadyHook` fires closes it as soon as the hook fires.

The distribution, the cache and the resolution are described in full in [Composition and distribution](composition-and-distribution.md); `doric.catalog/v1` keeps its full shape there.

## States and actions

| State              | Shows                                                                                        | Actions                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `loading`          | The step: connecting, reading the catalog, downloading (with a count), verifying, activating | None                                                                                                  |
| `host-unreachable` | `Cannot reach <host URL>`, the last error and the attempt number                             | Retry; "Open last known composition", when a catalog snapshot exists                                  |
| `bundle-failure`   | "Some bundles cannot load" and each bundle with its version and reasons                      | Retry; "Continue without them"; "Disable", one per bundle                                             |
| `core-failure`     | The core's id and version, and the error                                                     | Retry; "Use last core that worked", when a core has activated before; "Return to default composition" |
| `recovery`         | The reason, and each bundle the newest generation's diagnostics hold as quarantined          | Retry; "Use last core that worked", when a core has activated before; "Return to default composition" |

Retry is the first action of every error state ([`view.ts`](../../../app/desktop/doric/src/splash-page/view.ts)).

## When each state appears

The startup chooses the state ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts)):

- **`host-unreachable`**, while the startup waits for the bridge before its first connected load. The bridge retries every 1,000 ms (`CONNECTION_RETRY_MS`), and also reconnects after the server refuses it ([`host-bridge.ts`](../../../app/desktop/doric/src/platform/bridge/host-bridge.ts)). The state updates with each attempt and ends when the bridge connects. A bridge lost later brings `recovery` at the next load.
- **`bundle-failure`**, during the first startup, when the desktop's resolution quarantined a bundle that has a desktop part and that the host did not quarantine: for example a file that failed verification, an `engines.doric` range the desktop's platform version does not satisfy, or a dependency on such a bundle. A bundle the host itself quarantined does not bring this state; the host's own quarantine is in [Core](core.md).
- **`core-failure`**, when the desktop's catalog resolves to recovery, when the `desktopMain` process cannot be spawned, exits before it reports ready, or reports the core's activation in recovery ([`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts)), or when the primary window reports that its client core failed. In the last case the splash opens again over the open windows ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). A splash reopened this way is not closed by a later `ready()`, and the 30-second deadline does not show `recovery` for it: the first `ready()` of the app's run is the only one that closes the splash ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)).
- **`recovery`**, in three cases:
  - loading fails, for example because the host's `distribution()` call fails or no catalog snapshot exists for the mode asked for; the reason is the error;
  - no window calls `ready()` within 30 seconds of `onAppReadyHook`; the reason is `No window became ready.`;
  - the app starts with `--recovery`; after a successful load, the surface shows `Recovery was requested with --recovery.` once.

A window that calls `ready()` after the deadline's `recovery` appeared still closes the splash, if no window closed it before ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)).

A load that follows an action on the `recovery` state of the deadline, or on a reopened `core-failure`, shows only `core-failure` or `recovery`. That `recovery` lists no bundles. Quarantined bundles do not stop it, `--recovery` is not shown again, and the 5-second minimum does not apply ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)).

The 30-second deadline is measured by the main, not by the provider of `hooks/v1`: it starts before the hook runs, and a hook that fails is only logged, so a broken provider of `hooks/v1` still leads to `recovery` ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts), [Hooks](hooks.md)). A handler of `onAppReadyHook`, an `observe` hook, that fails is reported to `doric.diagnostics/v1` as `hook_handler_failed`, or as `hook_handler_timeout` after 10,000 ms, and brings neither quarantine nor this surface ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`core/src/shared/hooks.ts`](../../../bundles/foundation/core/src/shared/hooks.ts)).

Which bundle fails first depends on the activation order, foundation first, then the core, then the others, described in [Hooks](hooks.md#firing-a-hook) and [Core](core.md). A quarantined foundation provider of a contract the core requires leaves the core unable to activate, so the surface shows the core's failure.

## What each action does

The startup waits in an error state until the page sends an action, then loads again in the mode the action chooses. An action sent while no state waits is dropped. In `host-unreachable`, only Retry and Open last known composition take effect ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)):

| Action                        | Effect                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry                         | In `host-unreachable`, asks the bridge to reconnect. After the 30-second deadline, shows `loading` at `activation` and fires `onAppReadyHook` again. In the `--recovery` state, it loads again in the same mode. Elsewhere, loads again; from the last-good-core mode, it returns to the connected mode. |
| Open last known composition   | Loads the saved catalog snapshot in the `disconnected-copy` mode, with no download                                                                                                                                                                                                                       |
| Continue without them         | Goes on with the generation already loaded, without the quarantined bundles                                                                                                                                                                                                                              |
| Disable                       | Calls `doric.catalog/v1.disable({ bundleId })` on the host, then loads again in the connected mode                                                                                                                                                                                                       |
| Return to default composition | Calls `doric.catalog/v1.resetComposition()` on the host, then loads again in the connected mode                                                                                                                                                                                                          |
| Use last core that worked     | Loads in the `last-good-core` mode (below)                                                                                                                                                                                                                                                               |

The host keeps the effect of Disable and Return to default composition in `composition.overrides.json` beside the active composition, never in the product database, and publishes a new generation; the core cannot be disabled ([Composition and distribution](composition-and-distribution.md#composition-overrides)). Disable accepts any other enabled bundle, one that the composition's `required` names included. Disabling such a bundle makes the host exit with code 1 once the new generation activates, and every later host start fails until `composition.overrides.json` is deleted by hand ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). An action that fails is logged as `Recovery action failed`, and the next load keeps the mode it had ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)).

## The last core that activated

Each time a generation's core activates its `desktopMain` part, the main records that core's id, version, generation and catalog entry as `lastGoodCore` in `userData/doric/state.json` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`state.ts`](../../../app/desktop/doric/src/platform/state.ts)). Its files stay in the verified cache: when the cache drops a generation's files, it keeps those of the last good core ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`artifacts.ts`](../../../app/desktop/doric/src/platform/catalog/artifacts.ts)).

In the `last-good-core` mode, the main takes the host's distribution when the bridge is connected, or the saved snapshot otherwise, makes the recorded core the composition's core, and loads only that core and the foundation ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts)). A window of a generation in that mode, as in `disconnected-copy`, cannot call a host contract: the dispatcher fails the call with `unavailable` ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)). The mode serves to diagnose and correct the composition, not to work on data.

## Related documents

- [doric-app README](../../../app/desktop/doric/README.md#the-splash-and-recovery-window): the splash window, the page and `doric.splash/v1` from the app's side.
- [Composition and distribution](composition-and-distribution.md): the distribution, the verified cache, the catalog snapshot, the composition overrides and `doric.catalog/v1`.
- [Core](core.md): quarantine, recovery mode and what the platform keeps outside the core.
- [Hooks](hooks.md): `onAppReadyHook`, the activation order and replacing the provider of `hooks/v1`.
- [Observability](observability.md): `doric.diagnostics/v1` and the diagnostics the `recovery` state shows.
- [doric:// protocol](doric-protocol.md): the splash page's path and policy.
- [Boundaries](boundaries.md): the platform's `doric.*` contracts and why bundles cannot reach them.
- [Platform packages](platform-packages.md): `theme.css` and the tokens.
- [Windows](windows.md): the windows the core opens and how a window reports a failure.
