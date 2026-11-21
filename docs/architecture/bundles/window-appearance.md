# Native window appearance

- Status: living document. It describes the native appearance of Doric's windows as implemented on 2026-11-20.

## Summary

A window's native appearance (its size, title bar, background color and theme) is split between three owners. The caller that opens a window states an intent, never Electron options. The platform's tokens state the measures and colors. Electron main turns intent and tokens into native options, then tells the window the safe area it left for the native controls; the window's shell writes that area as CSS variables, which the bars a bundle draws read. Main therefore knows no CSS of the renderer, and the renderer never guesses where main put the window buttons.

The app's theme is one preference for every window: `dark` by default, `light`, or `system`. Main gives it to Electron's `nativeTheme` before the first window opens, and the splash, every renderer, the code editors, the toasts and open terminals follow it.

## Intent: `appearance`

Every window request carries an optional `appearance`, validated by `windowAppearanceSchema` ([`windows.ts`](../../../packages/bundle/src/contracts/basic/windows.ts)):

```ts
{
  size?: { width: number; height: number; minWidth?: number; minHeight?: number };
  titleBar: 'native' | 'integrated' | 'none'; // default 'integrated'
  background: string; // a token name, not a color; default 'window'
}
```

- `native`: the operating system's frame and title bar.
- `integrated`: on macOS, the title bar is hidden and the native window buttons (the traffic lights) stay visible over the page, which draws its own draggable title bar. On Windows and Linux it is the native frame.
- `none`: no frame.

Main applies the mode when it creates the window ([`appearance.ts`](../../../app/desktop/doric/src/platform/windows/appearance.ts), [`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).

`doric.windows/v1` opens two kinds of window ([Windows](windows.md)). An **app window** loads an app route in the window's shell, with the app's preload and bundle contracts. A **view window** shows one page of the host in a `WebContentsView` filling the window, with no preload, no shell and no bundle contracts. Both take their native options from the same `appearance`, and an `integrated` view window on macOS keeps its window buttons visible; but a view window gets no chrome description, no `chrome` event and no safe-area variables, so on macOS an `integrated` view window has a hidden title bar over a page that draws none ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).

A bundle opens a window through `windows/v1`, which the `core` bundle provides and which applies the core's policies before it calls the platform contract `doric.windows/v1` ([`core` README](../../../bundles/foundation/core/README.md)); `doric.windows/v1`, window keys and the window description are in [Windows](windows.md). Both take the same `appearance`. The core opens the workspace window at 1280×800 (minimum 960×640) and the settings window at 960×720 (minimum 720×520), both `integrated` ([`appearance.ts`](../../../bundles/foundation/core/src/desktop/appearance.ts), [`index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts)).

## Measures and colors: the tokens

`desktop/ui` states the window tokens once, in its token module, and generates `tokens.json` from it ([`tokens.ts`](../../../packages/desktop/src/tokens/tokens.ts), [Platform packages and theme tokens](platform-packages.md)):

| Token                               | Value                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| `window.titlebarHeight`             | 40 (CSS px), also `--doric-titlebar-height`               |
| `window.trafficLight.size`          | 12                                                        |
| `window.trafficLight.insetX`        | 14                                                        |
| `window.trafficLight.reservedWidth` | 80: the inset, three buttons, two 8 px gaps and the inset |
| `window.backgrounds.window`         | The `--background` of the light and the dark variant      |

Main reads `tokens.json` once ([`tokens.ts`](../../../app/desktop/doric/src/platform/tokens.ts)). A `background` that names no token throws while main creates the window, so `doric.windows/v1.open` rejects ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)). The contract `doric.tokens/v1`, in `client` and `desktopMain`, has one method, `get()`, which returns the shared tokens, the default (light) variant and the window variables as a record of strings ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`tokens.ts`](../../../app/desktop/doric/src/platform/tokens.ts), [`platform.ts`](../../../packages/desktop/src/client/platform.ts), [Platform packages and theme tokens](platform-packages.md#dorictokensv1)). The window variables are fixed values, not the live safe area: `--doric-titlebar-height` is `40px`, `--doric-window-background` is `var(--background)`, and `--doric-safe-top`, `--doric-safe-left` and `--doric-safe-right` are `0px`. The live values are the ones the shell writes ([Safe area](#safe-area)).

## Native options

Main resolves the constructor options of a window from its appearance, the tokens, the platform and the primary display's work area ([`appearance.ts`](../../../app/desktop/doric/src/platform/windows/appearance.ts)):

- **Size.** Width and height are clamped between a fixed minimum of 320×240 and the work area; without a `size`, the window is 800×600. `minWidth` and `minHeight` pass through.
- **Background.** The `background` token's dark or light color, chosen by `nativeTheme.shouldUseDarkColors`. When the native theme changes, main sets every window's background to the `window` token's new color ([`main.ts`](../../../app/desktop/doric/src/main.ts)).
- **Title bar.** `integrated` on macOS gives `titleBarStyle: 'hidden'` and puts the traffic lights at `x = insetX` (14) and `y = (titlebarHeight − size) / 2` (14), so they sit centered in a 40 px bar; main then keeps the window buttons visible. `none` gives `frame: false`. Otherwise Electron's default frame stays ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).

The splash is a technical window with its own options: frameless, 610×487, not resizable, with rounded corners and the `window` background of the current theme ([`window.ts`](../../../app/desktop/doric/src/platform/splash/window.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [Splash and recovery](splash-and-recovery.md)).

## Safe area

Main describes the chrome it left to each app window (not to a view window) as `WindowChrome` ([`protocol.ts`](../../../packages/desktop/src/client/protocol.ts), [`appearance.ts`](../../../app/desktop/doric/src/platform/windows/appearance.ts)):

```json
{
  "titleBar": "integrated",
  "height": 40,
  "safeArea": { "top": 0, "left": 80, "right": 0 }
}
```

`safeArea.left` is `reservedWidth`; it is 0 for `none` and while the window is in fullscreen, where macOS hides the window buttons and their space returns to the content. The value does not depend on the platform: it is 80 for a `native` window too, and on Windows and Linux, where no window buttons sit over the page; what a bar does with it is the bar's own rule ([The bars that read the safe area](#the-bars-that-read-the-safe-area)). The window gets the chrome in its description when the shell starts, and again in a `chrome` event each time it enters or leaves fullscreen ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The shell writes `--doric-titlebar-height`, `--doric-safe-top`, `--doric-safe-left` and `--doric-safe-right` on the root element both times ([`chrome.ts`](../../../packages/desktop/src/client/chrome.ts), [`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts)).

## The bars that read the safe area

The page draws the draggable title area; main draws nothing there but the traffic lights. The bars read `--doric-safe-left`, not `--doric-titlebar-height`: every bar in an app window is fixed at 40 px.

- `desktop/ui` sets `.chrome-bar { height: var(--doric-titlebar-height) }` ([`theme.css`](../../../packages/desktop/src/styles/theme.css)), but the window's shell sheet, loaded after it, sets `.chrome-bar { height: 40px }` again, so a `.chrome-bar` in an app window is 40 px ([`styles.css`](../../../app/desktop/doric-renderer/src/styles.css)). The bars of `settings`, `terminal`, `files` and `git` use the class ([`settings-window.tsx`](../../../bundles/desktop/settings/src/client/components/templates/settings-window.tsx), [`terminal-view.tsx`](../../../bundles/features/terminal/src/client/view/terminal-view.tsx), [`file-view.tsx`](../../../bundles/features/files/src/client/file/file-view.tsx), [`diff-footer.tsx`](../../../bundles/features/git/src/client/diff/diff-footer.tsx)).
- `desktop/ui` also exports a `ChromeBar` component: a `.chrome-bar` with a drag region that, unless `inset` is false, pads its start by `--doric-safe-left` on every platform ([`chrome-bar.tsx`](../../../packages/desktop/src/chrome-bar.tsx)). No bundle renders it; its stories do ([`chrome-bar.stories.tsx`](../../../packages/desktop/stories/chrome-bar.stories.tsx)).
- In the workspace window, the bar at the window's leading edge is the `workspace` bundle's sidebar header, at the top of the sidebar column in both of the layout's forms. It is 40 px and draggable, and pads its start by `--doric-safe-left` (80 px when the variable is unset) only when `navigator.userAgent` contains `Mac`; elsewhere it pads 8 px ([`sidebar-header.tsx`](../../../bundles/desktop/workspace/src/client/components/organisms/sidebar-header.tsx), [`navigation-elements.tsx`](../../../bundles/desktop/workspace/src/client/elements/navigation-elements.tsx), [`dashboard.tsx`](../../../bundles/desktop/workspace/src/client/components/organisms/dashboard.tsx)).
- The title bar is `workspace`'s Project tab bar, the filler of `shell.titlebar.tabs`, 40 px and draggable. It starts after the sidebar column, and no caller passes it `inset`, so it never pads by the safe area ([`project-tabs.tsx`](../../../bundles/desktop/workspace/src/client/components/organisms/project-tabs.tsx), [`navigation-elements.tsx`](../../../bundles/desktop/workspace/src/client/elements/navigation-elements.tsx)). Its end draws the slot `shell.window.actions` on `/` and `/projects` (the page form) and the slot `shell.header.actions` on every other route; `layout` declares `shell.header.actions` but does not draw it itself ([`layout` README](../../../bundles/desktop/layout/README.md), [`workspace` README](../../../bundles/desktop/workspace/README.md)).
- The `layout` bundle draws no bar in the page form ([`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)). In the conversation form it draws two 40 px draggable strips: the viewer tabs' header (`workspace-viewer-header`), only while a viewer tab is open, and the Project panel's header (`workspace-files-header`), which holds the panel's tabs and ends with the slot `shell.window.actions` ([`workspace-layout.tsx`](../../../bundles/desktop/layout/src/client/components/templates/workspace-layout.tsx), [`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx), [Layout](layout.md)).
- A control inside a drag region opts out with `app-region: no-drag`, as the layout's resize handles and the Project panel's actions do ([`workspace-layout.tsx`](../../../bundles/desktop/layout/src/client/components/templates/workspace-layout.tsx), [`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)).

## Theme

The theme preference is `dark`, `light` or `system`, which follows the operating system ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). Main keeps it in `userData/doric/appearance.json` as `{ "theme": … }`; a missing, unparsable or unknown file reads as `dark` ([`appearance-store.ts`](../../../app/desktop/doric/src/platform/appearance-store.ts)).

Main reads the file and sets `nativeTheme.themeSource` while the platform prepares, before it opens the splash and the first window, so both open in the saved theme ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The value comes from `resolveThemeSource`: in an unpackaged run, `DORIC_THEME` set to exactly `light`, `dark` or `system` wins; otherwise the saved preference, and `dark` when none is saved. A packaged build (Electron's `app.isPackaged`) never reads `DORIC_THEME`, and the variable never changes what is saved ([`appearance.ts`](../../../app/desktop/doric/src/platform/appearance.ts)).

Everything drawn by the app follows the native theme through `prefers-color-scheme`, which `nativeTheme.themeSource` drives, including changes while a window is open:

- the splash ([`splash.css`](../../../app/desktop/doric/src/splash-page/splash.css));
- each renderer, which keeps the `dark` class on its root equal to the media query ([`scheme.ts`](../../../app/desktop/doric-renderer/src/scheme.ts), [`bootstrap.ts`](../../../app/desktop/doric-renderer/src/bootstrap.ts));
- the Monaco code view and diff editor ([`code-view.tsx`](../../../packages/desktop/src/code/code-view.tsx), [`diff-editor.tsx`](../../../packages/desktop/src/code/diff-editor.tsx));
- the Sonner toasts, whose theme is `system` ([`sonner.tsx`](../../../packages/desktop/src/components/sonner.tsx));
- an open terminal, which repaints on each change of the query ([`color-scheme.ts`](../../../bundles/features/terminal/src/client/view/color-scheme.ts), [`terminal-view.tsx`](../../../bundles/features/terminal/src/client/view/terminal-view.tsx)).

Native notifications are drawn by the operating system ([`notifications.ts`](../../../app/desktop/doric/src/platform/native/notifications.ts)).

### `doric.appearance/v1`

A platform contract of the `client` environment, available from platform 1.3.0. A bundle does not list it in its manifest; on an older app it has no provider, so a bundle detects it with `services.whenAvailable` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).

```ts
interface DoricAppearance {
  get(call?: CallArg): Promise<{ readonly theme: 'dark' | 'light' | 'system' }>;
  set(
    input: { readonly theme: 'dark' | 'light' | 'system' },
    call?: CallArg,
  ): Promise<void>;
}
```

- `get()` returns the saved preference, `dark` when none is saved or it is unreadable.
- `set({ theme })` writes `appearance.json` atomically and only then sets `nativeTheme.themeSource` to `resolveThemeSource` of the new value, which repaints every window. It rejects `invalid_input` for a value outside the three themes and `unavailable` when the file cannot be written; the saved preference and the shown theme are then unchanged ([`appearance.ts`](../../../app/desktop/doric/src/platform/appearance.ts), [`appearance-store.ts`](../../../app/desktop/doric/src/platform/appearance-store.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).
- In an unpackaged run with `DORIC_THEME` set to a valid theme, `set` saves the choice but repaints nothing, since `DORIC_THEME` still wins, and `get` answers the saved preference, not the theme shown ([`appearance.ts`](../../../app/desktop/doric/src/platform/appearance.ts)).

The window answers it through main ([`appearance.ts`](../../../packages/desktop/src/client/appearance.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The `settings` bundle's Appearance section uses it, and is offered only while a provider exists ([`settings` README](../../../bundles/desktop/settings/README.md)).

## Related documents

- [Windows](windows.md): `doric.windows/v1`, window keys and the window description that carries the chrome.
- [Platform packages and theme tokens](platform-packages.md): `desktop/ui`, its tokens and `tokens.json`.
- [Splash and recovery](splash-and-recovery.md): the splash window.
- [Layout](layout.md): the workspace window's regions and slots.
- [UI composition](ui-composition.md): how bundles fill those slots.
- [Core](core.md): the bundle that opens the workspace and settings windows.
- [Hooks](hooks.md): `onAppReadyHook`, where the core opens the workspace window.
- [Contracts](contracts.md): `bundle/contracts`, where `windowAppearanceSchema` and the `doric.*` contracts are defined.
