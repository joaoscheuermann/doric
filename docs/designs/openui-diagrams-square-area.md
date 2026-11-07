# Spec: a square area for every OpenUI diagram

- Ticket: none; the change comes from the user's request of 2026-11-06, recorded as UD14–UD16 below.
- Status: `implemented`, version 6 (2026-11-06), acceptance pending: SA1 and SA2 ([Acceptance](#acceptance)) and the user's acceptance.
- Scope: the drawn area of the four diagram types of the `openui` bundle (`Flowchart`, `SequenceDiagram`, `EntityDiagram`, `MindMap`) becomes a square as wide as its container, with its height capped so it fits in the window (UD15). The `height` prop is removed from all four. It amends phase 1's F7 ([openui-diagrams.md](openui-diagrams.md#f7-drawing)) and phase 2's F20 ([openui-diagrams-phase2.md](openui-diagrams-phase2.md#f20-drawing)); all their other decisions stay.
- Why a separate document: both phase specs have version 5 as their accepted design, and both phases' code is in `06318f66`. Phase 1's status line reads `accepted` with the code implemented (`openui-diagrams.md:4`); phase 2's read `implemented`, with the code marked uncommitted (`openui-diagrams-phase2.md:4`): when this spec was written, phase 2's code was not yet committed. It has since been committed in `06318f66`. Each describes one change, and this change cuts across both. Phase 2 set the precedent of keeping an accepted, implemented spec as it is and writing the next change in its own document, linked from the earlier one ([openui-diagrams-phase2.md](openui-diagrams-phase2.md), "Why a separate document"). OpenUI's own spec added "stage 5" inside itself ([openui.md](openui.md#stage-5-fixes-after-use-u49u51)), but that change touched one spec only. Amending F7 and F20 in place would split one decision across two documents and rewrite text that the commit already implements.
- Builds on: commit `06318f66` (`feature/openui`), both phases committed, `openui` manifest 2.2.0, not released. Line references name the files at that commit. `openui` paths are under `bundles/features/openui/` unless written in full.
- Identifiers:
  - This spec's are SG1–SG4 (goals), F25–F27 (design decisions), FT38–FT40 (tests), SA1–SA2 (acceptance checks), FR25–FR31 (risks), M14–M18 (measurements) and step 10. They continue phase 2's numbering, except for goals and acceptance checks, which take the new prefixes SG and SA.
  - UD14–UD16 are new decisions of the concept, [docs/features/openui-diagrams.md](../features/openui-diagrams.md#decisions).
  - G (goals), UD (decisions), P (proposals), A (riskiest assumptions) and Q (questions) are the concept's.
  - F1–F12 and FT1–FT17 are phase 1's; F13–F24 and FT18–FT37 are phase 2's.
- Bundles touched: `openui` only, and its version stays 2.2.0 (F26). `packages/desktop` and `papercraft` do not change.
- Feature docs: [docs/features/openui-diagrams.md](../features/openui-diagrams.md) and [docs/features/generative-ui.md](../features/generative-ui.md).
- Measurements: [Measurements](#measurements) says where and how each was made.

## Contents

- [Problem](#problem)
- [Terms](#terms)
- [Goals](#goals)
- [Decisions already made](#decisions-already-made)
- [Non-goals](#non-goals)
- [Design decisions](#design-decisions)
- [Design](#design)
- [Phases](#phases)
- [Files to change](#files-to-change)
- [Test plan](#test-plan)
- [Measurements](#measurements)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Open questions](#open-questions)
- [Docs to update](#docs-to-update)
- [Revisions](#revisions)

## Problem

Today the area's height (see [Terms](#terms)) is set once, when the layout result arrives. With `height` written, the area is `height` clamped to 160–1200 px. Otherwise it is the drawing's height at the scale that fits the area's width, plus the fit's 24 px margin on each side, clamped to 160–560 px (`canvas.tsx:32-54`). `DiagramFrame` computes it in state and a layout effect (`canvas.tsx:369-376`) and writes it as an inline `height` (`canvas.tsx:384-385`). It is not computed again when the width changes (phase 1 F7, [openui-diagrams.md](openui-diagrams.md#f7-drawing)). So one diagram's area depends on the width at mount and keeps that height after a resize. A wide drawing gets a strip of at least 160 px, and a tall one is capped at 560 px at any width (M14).

The user wants every diagram area square, following its width, as long as it fits in the window. The `height` prop exists only to set the area's height, so with a square area it has no effect.

## Terms

Borrowed terms:

- From phase 1's [Terms](openui-diagrams.md#terms): error card, finding, fixture (`n/e/g/d`, for example 20/28/4/2), fit, interactive, latest revision, layout chunk, layout result.
- From phase 2's [Terms](openui-diagrams-phase2.md#terms): lang-core and react-ui, with versions; prompt builder; estimate; entity, mind-map and sequence fixtures (`e/r`, `t/d`, `p/s`, for example 10/12, 30/3, 3/12).
- From the concept's [Terms](../features/openui-diagrams.md#terms): diagram model, main Thread, skill.
- From the OpenUI spec's [Terms](openui.md#terms): fence, revision.

Other terms used here:

- **Static** means not interactive. A fence in an agent Thread, or a revision that is not the latest, draws its diagram static (UD8, phase 1 F8).
- **Report** is the list of a fence's errors that the agent receives (openui.md D18).
- **Readers** are `readFlowchart`, `readSequence`, `readEntities` and `readMindMap`, which make a diagram model from a component's props (phase 2 F14).
- **Seeds** are those of the phases' fixture generators, 7919 × 1–5.

The terms this spec adds:

- **Area**: the bordered, clipped element that holds the viewport's content `div` and the SVG (`canvas.tsx:381-408`). Its client box is what the fit fits into (`gestures.ts:64-73`).
- **Fence width**: the width of the fence's element (`openui-fence … w-full`, `src/client/chunks/renderer.ts:184-189`). In the conversation it is at most 736 px: the column is `max-w-3xl` (768 px) with `px-4` (`bundles/desktop/chat/src/client/components/organisms/conversation/index.tsx:522`), measured as 736 in M17.
- **Area width (W)**: the width of the area's container. That is the fence width for a diagram at the root or in a column `Stack`. In a row `Stack` of n children it is (fence width − (n − 1) × 12 px) / n, since the gap `m` is `--openui-space-m`, 12 px (react-ui 0.18.1 `dist/genui-lib/index.mjs:14942-14982`; M17).
- **Fit**: `fitViewport(content, area)` (`packages/desktop/src/viewport.ts:57-79`), called with no margin (`gestures.ts:68-71`), so the margin is the default 24 (`viewport.ts:60`). Its scale is `min(1, (area.width − 48) / content.width, (area.height − 48) / content.height)` clamped to 0.25–4 (`viewport.ts:15-20`). The upper clamp never applies to a fit, because the scale is already at most 1. The fit centres the content on both axes.
- **Visible conversation height**: the height of the conversation's scroll view, the window's content height less the workspace header and footer, 80 px together (M18).
- **Window size**: the workspace window is created 1280 × 800 with a minimum of 960 × 640 (`bundles/foundation/core/src/desktop/appearance.ts:5`). These are outer sizes: the options pass them as `width` and `height`, clamped to the screen's work area, without `useContentSize` (`app/desktop/doric/src/platform/windows/appearance.ts:43-53`). On macOS the title bar is hidden (`titleBarStyle: 'hidden'`, `:62-71`), so the **content height** H, the `100svh` the cap reads, equals the outer height: 800 by default, 640 at the minimum. On Windows and Linux the native frame keeps its title bar, so H is smaller by that bar's height. The pixel values in this spec are for H = 800 and H = 640, macOS's defaults.
- **Cap**: the area's `max-height`, `calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)` (F25). The **area height** is min(W, cap): H − 112 with the token at its 40 px default: 688 px at H = 800 and 528 px at H = 640. Sx = W − 50 and Sy = min(W, cap) − 50 are the room inside the border and the fit's margin; when the cap does not bind, both equal S = W − 50.
- **Coverage**: the drawn drawing's box, clipped to the area's client box, as a share of the client box's area.
- **Pictures**: the SVG components `FlowchartPicture`, `SequencePicture`, `EntityPicture` and `MindMapPicture` (phase 2 F20).

## Goals

| Goal                       | Check                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SG1 Square area, capped    | FT38: the frame's area carries `aspect-square`, `w-full` and `max-h-[calc(100svh-40px-var(--doric-titlebar-height,40px)-32px)]`, and no inline height; all four types draw through `DiagramFrame`. M17 and M18 measure the CSS in Electron's Chromium. [SA1](#acceptance) checks it in the app.                                       |
| SG2 Fit and refit as today | FT39: a resize of the area refits the drawing; after a zoom it keeps the reader's viewport; "Fit to view" then fits the area's current size. The fit itself is covered by `packages/desktop/tests/viewport.test.ts:44-83` (centred, at most 100 %, the 25 % floor), and the zoom buttons and wheel by FT15 (`flowchart.test.ts:428`). |
| SG3 No `height` prop       | FT40: the model tests lose their `height` inputs and assertions, and the model types have no `height`. FT14: the regenerated skill prints no `height?` on the four diagram types.                                                                                                                                                     |
| SG4 Nothing else changes   | All other tests of both phases pass unchanged, apart from the edits listed in [Test plan](#test-plan).                                                                                                                                                                                                                                |

## Decisions already made

Made by the user on 2026-11-06. They are recorded in the concept as UD14–UD16 ([Docs to update](#docs-to-update)):

- **UD14 Square area.** The area of all four diagram types has an aspect ratio of 1:1. Its width is 100 % of the fence's width, its height equals that width, and the height follows the width on resize. The drawing starts fitted into the square, never above 100 %, and refits on resize until the reader pans or zooms, as today. UD15 caps its height. A diagram in a row `Stack` takes its slot's width (F25, FR29).
- **UD15 Height capped by the window.** Recorded when the user answered the Critique review's question on window height, 2026-11-06: "Sim, 1:1 até caber na tela" ("yes, 1:1 until it fits on the screen").
  - The area stays 1:1 while it fits. Its height is capped by the window's height, so the toolbar and the whole drawing are visible together.
  - In a short window the area becomes wider than tall.
  - F25 sets the cap, `calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`.
  - This replaces version 3's UD15, which had no cap.
- **UD16 No `height` prop.** `height` is removed from `Flowchart`, `SequenceDiagram`, `EntityDiagram` and `MindMap`: from their schemas, models, views and skill signatures. `openui` 2.2.0 is unreleased (FR26). The `height` of react-ui's charts (`src/host/skills/openui.md:71-73`) is out of scope.

## Non-goals

- The charts' `height` and any other react-ui component.
- A new fit rule. The margin stays 24 px, the fit never scales above 100 %, the floor stays 25 %, and the drawing stays centred (FR27).
- Changes to pan, zoom, the toolbar, the static rule (UD8, phase 1 F8) or `useDiagramViewport` (`gestures.ts:42-181`).
- Changes to papercraft's canvas node, which is already square (`bundles/features/papercraft/src/client/surface/preview-container.tsx:650-652`).
- A version bump, a contract change outside the diagram library, or a migration (FR26).

## Design decisions

| ID  | Decision                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F25 | The area is square through CSS (`aspect-square w-full`), not through a measured height. `DiagramFrame` loses `writtenHeight` and every height computation. Fit and refit are `useDiagramViewport`'s, unchanged. |
| F26 | `height` leaves the four schemas, models, view props and doc comments. A `height` the model still writes is dropped by lang-core and reported as `excess-args`.                                                 |
| F27 | The skill is regenerated. The four signatures lose `, height?: number`, and the diagram rules do not change.                                                                                                    |

## Design

### F25. The square area

**Data flow.** After the change, no height comes from the model. The area's CSS derives its height from its width, capped by the window's height.

**The area's contract.** The area's classes become `aspect-square w-full max-h-[calc(100svh-40px-var(--doric-titlebar-height,40px)-32px)]` plus its current border, clipping and focus classes, with no inline `height`. Its content `div`, the toolbar and the wrapper do not change. `DiagramFrame`'s new signature:

```ts
/**
 * The area, the viewport and, when `interactive`, the toolbar; `children` is the SVG.
 * The area is as wide as its container and as tall as it is wide (`aspect-square`), at most
 * the window's height less the workspace header, the footer and 32 px (`max-h-[…]`), so its
 * height follows its width until the cap. The viewport fits `content` into it and refits whenever the area
 * resizes, until the reader pans or zooms (`useDiagramViewport`). When `interactive`:
 * focusable, labelled `areaLabel`, with the toolbar ("Zoom out", percent, "Zoom in", "Fit to
 * view") and the gestures; otherwise none of these.
 */
export function DiagramFrame(props: {
  readonly content: { readonly width: number; readonly height: number };
  readonly interactive: boolean;
  /** The area's label when interactive: `<Type>, pan and zoom`. */
  readonly areaLabel: string;
  readonly children: ReactNode;
}): ReactNode;
```

`DiagramCanvas` keeps its props (phase 2 F20). It and the three other views stop passing a height.

**Why CSS and not a measured height.**

- The browser sets the height from the width in the same layout pass. No first frame is drawn at a stale height, and no ResizeObserver callback has to set React state and re-render the frame on every width change.
- Papercraft's canvas node already uses this rule: `aspect-square w-full` with only absolute children (`preview-container.tsx:650-652`), tested by its class (`bundles/features/papercraft/tests/client/canvas-element.test.ts:509`).
- The app runs in Electron 44.4.3 (`package.json:51`). Its Chromium lays out `aspect-ratio: 1 / 1` as square at every width measured (M17), and with `max-height` it keeps the full width and clamps only the height (M18).
- The `openui` stylesheet scans its own sources (`src/client/styles.css:8`, `@source './'`), so `aspect-square` is generated for `canvas.tsx`.

**Why the ratio holds.**

- Under the app's preflight (`packages/desktop/src/styles/theme.css:9`, `box-sizing: border-box`), the ratio applies to the border box. With the 1 px border, the client box is (W − 2) × (W − 2), still square (M17).
- The area has no child in flow: the content `div` is `position: absolute` (`canvas.tsx:397-405`). With `overflow-hidden`, the automatic minimum height is 0, so the drawing never stretches the area.
- In a row `Stack`, react-ui renders the children as direct flex items (`Stack` adds no wrapper, `genui-lib/index.mjs:14970-14982`). Each view's `w-full` root shrinks to its share, so each square is as wide as its slot (M17).

**The cap.** `calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`: the window's height less the workspace header, the workspace footer and 32 px.

- **The header and footer.**
  - The header is `h-10`, a fixed 40 px (`bundles/desktop/layout/src/client/components/templates/workspace-layout.tsx:80`), so the cap writes 40 px.
  - The footer, which holds the composer controls (`bundles/desktop/chat/src/client/index.ts:96`), is a chrome bar. Its height is the token `--doric-titlebar-height` (`packages/desktop/src/styles/theme.css:50-52`): 40 px by default (`packages/desktop/src/styles/tokens.css:251`), set per window at run time (`packages/desktop/src/client/chrome.ts:11`). The cap reads the token, so it follows the footer. Its fallback, 40 px, keeps the cap valid where `tokens.css` is not loaded: an undefined `var()` without one makes the whole `max-height` invalid, and the area would be uncapped. The window and the stories load it (`.storybook/preview.tsx:8` imports `theme.css`, which imports `tokens.css` at `:11`).
  - Together they are 80 px by default. M18 measured a scroll view of 720 and 560 px at H = 800 and H = 640.
- **The 32 px.** `calc(100svh - 40px - var(--doric-titlebar-height,40px))` alone already meets UD15: the toolbar sits inside the area (`canvas.tsx:410`), so an area as tall as the scroll view shows the toolbar and the whole drawing together.
  - The 32 px are a comfort margin. They leave 16 px above and below the area once it is scrolled into view, so its border stands clear of the header and footer and the reader need not scroll to the exact pixel.
  - The cap is H − 112: 688 px at H = 800 (macOS's default window), against a visible height of 720, and 528 px at H = 640 (its smallest), against 560 (M18).
- **Why `svh`.** The workspace sizes itself with `h-svh` (`bundles/desktop/layout/src/client/views/workspace-view.tsx:211`). In Electron's window, `100svh` is the window's content height (M18).
- **Why a Tailwind class.** The cap is an arbitrary value, as the repository already writes `max-w-[calc(100vw-2rem)]` (`bundles/desktop/chat/src/client/components/organisms/thread-queue.tsx:126`). The `openui` sheet scans `canvas.tsx` (`src/client/styles.css:8`). The repository's Tailwind 4 turns the class into `max-height: calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)` (M18). FT38 asserts it by class, as it does `aspect-square`.
- **When it applies.** The cap binds when W > cap:
  - At H = 800, every fence of 689 px or more: the widest fence gives a 736 × 688 area, not a square.
  - At H = 640, every fence wider than 528 px.
  - Never for areas in a row `Stack` of two or more at H ≥ 640, since 362 < 528 (FR29). On Windows and Linux, H is smaller than the outer height, and the cap binds from a narrower fence.

**Fit and refit.** These need no code change; this is what `useDiagramViewport` already does (`gestures.ts:32-82`):

- On mount, a layout effect fits `content` into the area's `clientWidth` × `clientHeight` (`:64-76`): (W − 2) × (min(W, cap) − 2).
- A `ResizeObserver` on the area refits on every size change (`:77-81`). Now that the height follows the width and the window's height, a change of either resizes the area, and the observer refits. The observer reports a height-only change, which M18 measured when the window's height changed with the width fixed.
- Until the reader pans or zooms, the shown viewport is the fit (`:57-60`). After that it is the reader's own, and refits only update the fit underneath. "Fit to view" clears the reader's viewport, so the latest fit shows and resizes refit again (`:179`).
- A static fence has no listeners and always shows the fit. The observer is attached whether or not the fence is interactive (`:75-82`), so a static diagram also follows the width.
- The wheel gesture (phase 1 F8) passes the area's `clientHeight` as the page height that scales a page-mode wheel delta (`:125`); it is now min(W, cap) − 2.

**Drawings of other shapes in a square.** For a drawing of w × h, the fit's scale is `min(1, Sx / w, Sy / h)`, clamped to at least 0.25, and the drawing is centred on both axes. M14 and M17 have the numbers.

- **Small** (w ≤ Sx and h ≤ Sy): drawn at 100 %, centred, and the rest of the square is empty. At W = 736 the nine small hand-written diagrams of M14 cover 7–16 % of the square (FR25).
- **Wide** (w / Sx ≥ h / Sy and w > Sx): the scale is Sx / w. The drawing is a band across the square, with equal empty space above and below. Today such a drawing got an area only as tall as the band plus the margins, and at least 160 px.
- **Tall** (h / Sy > w / Sx and h > Sy): the scale is Sy / h. The drawing is a column, with equal empty space left and right. Today the area stopped at 560 px. At W = 736 the square is taller, so tall drawings get a larger scale than today. At W = 480, 17 of 144 layouts get a smaller one. With the cap, at W = 736 and an area 688 px tall, no layout fits smaller than today. At 736 × 528, a 640 px window, 21 fit smaller than today (M14, FR27).
- **At the floor**, a sub-case of wide and tall: when w > 4Sx or h > 4Sy, the scale stays at 0.25. The drawing is centred and overflows the square on its long axis, so both ends are clipped. This happens today too: in 82 of 144 fixture layouts at W = 736 today, against 80 in the square. The reader pans to the ends; a static fence shows the middle (FR27).

### F26. Removing `height`

**What is removed.** `height` goes from the schemas of `Flowchart`, `SequenceDiagram`, `EntityDiagram` and `MindMap`. It also goes from the four diagram models (`FlowchartModel`, `SequenceModel`, `EntityModel`, `MindMapModel`) and the four view props interfaces. The readers take `props: unknown` and build only the keys they read, so a `height` in the props never reaches a model, and no finding is written (phase 2 F13's rule for out-of-schema values). No layout key changes, since none includes `height` today (`flowchart.tsx:29-31`, `sequence.tsx:52`, `entity.tsx:54`, `mindmap.tsx:46`).

**A `height` the model still writes.** OpenUI Lang passes arguments by position, so the schemas without `height` give `Flowchart` 4 parameters, `SequenceDiagram` 2, `EntityDiagram` 4 and `MindMap` 2. lang-core drops each argument past a component's parameters and reports `excess-args` on the statement, with the message "<Component> takes N arg(s), got M (K excess dropped)" (lang-core 1.0.2 `dist/index.mjs:3041-3043`, message `:2800`). So `Flowchart(nodes, edges, groups, "down", 400)` draws exactly like `Flowchart(nodes, edges, groups, "down")` and reports one error; M16 measured this for all four types. The error reaches the error card and the report like any `excess-args`. The report line carries lang-core's message, and the host uses its fixed text for the code only when an error has no message (`src/host/validation.ts:212`, openui.md D18). Doric adds no special case.

**Version and contracts.** `openui` stays 2.2.0: the version that added the four components is unreleased (UD16), so no released program uses the prop. `openui.programs/v1`, `openui.questions/v1`, `openui.answered/v1` and `openui/contracts` do not change.

### F27. The skill

`src/host/skills/openui.md` is regenerated with `OPENUI_SKILL_UPDATE=1` through FT14's generator (`tests/client/skill-text.test.ts:5`). Its four diagram signatures (`:175`, `:179`, `:185`, `:189`) become:

```text
Flowchart(nodes: Node[], edges?: Edge[], groups?: Group[], direction?: "down" | "right") — Boxes and arrows laid out automatically: flowcharts, pipelines, architecture with grouped regions.
SequenceDiagram(participants: Participant[], steps?: (Message | Note | Fragment)[]) — Messages between participants over time, in steps order.
EntityDiagram(entities: Entity[], relations?: Relation[], notation?: "er" | "class", direction?: "down" | "right") — ER or class diagram laid out automatically.
MindMap(root: Topic, layout?: "right" | "down") — A mind map (right) or a tree (down) from one root Topic.
```

The text is 68 characters shorter (M15). The diagrams' growth over the skill without diagrams therefore drops from the 3,847 characters the feature doc records (`docs/features/openui-diagrams.md:379`) to 3,779, under G6's 4,000 (FT14, `skill-text.test.ts:227-232`). The five diagram rules (`skill-text.test.ts:69-75`) never mention `height` and do not change. The charts' signatures (`openui.md:71-73`) keep their `height?`.

## Phases

One step, numbered after phase 2's steps 5–9:

| Step | Content                                                                                                                                          | Tests                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| 10   | F25's area and `DiagramFrame` contract; F26's removal from schemas, models, view props and views; F27's regenerated skill; the test edits below. | FT14, FT38–FT40, all others |

The step leaves the build, typecheck, lint and every `openui` test green. The removal and the square land together. Without the square, `writtenHeight` would still need `model.height`. Without the removal, `height` would be accepted and ignored, and the skill would still print it.

## Files to change

| File                                                                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openui` `src/client/diagram/canvas.tsx`                                                                                 | F25: remove `FIT_MARGIN`, `WRITTEN_HEIGHT`, `FITTED_HEIGHT`, `clamp` and `areaHeight` (`:29-54`), the height state and effect (`:369-376`), the then-unused `useLayoutEffect` and `useState` imports (`:11`, `:13`), and `writtenHeight` (`:361`, `:367`, `:464`). The area (`:383-385`) gains `aspect-square` and `max-h-[calc(100svh-40px-var(--doric-titlebar-height,40px)-32px)]` and loses its inline `height` (F25). The doc comments of `DiagramFrame` (`:352-358`, F25's text) and `DiagramCanvas` (`:447-451`, without "its height from `model.height`") change. |
| `openui` `src/client/diagram/definitions.ts`                                                                             | F26: remove `height: z.number().optional()` (`:107`, `:252`, `:291`, `:365`) and `height?` (number) from the prop-key doc comments (`:66-67`, `:183`, `:265`, `:308`).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `openui` `src/client/diagram/model.ts`, `sequence-model.ts`, `entity-model.ts`, `mindmap-model.ts`                       | F26: remove the field, its read and its spread: `model.ts:48-49,285-290`, `sequence-model.ts:49,199,243-245`, `entity-model.ts:54,102,204-206`, `mindmap-model.ts:27-28,69,72-74`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `openui` `src/client/diagram/flowchart.tsx`, `sequence.tsx`, `entity.tsx`, `mindmap.tsx`                                 | F26: remove `height?: unknown` (`flowchart.tsx:26`, `sequence.tsx:22`, `entity.tsx:24`, `mindmap.tsx:22`). F25: remove `writtenHeight` (`sequence.tsx:80`, `entity.tsx:84`, `mindmap.tsx:78`). `mindmap.tsx:37` reads "the model's JSON without `findings` and `cut`".                                                                                                                                                                                                                                                                                                    |
| `openui` `src/host/skills/openui.md`                                                                                     | F27: regenerated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `openui` `tests/client/diagram-drawing.test.ts`                                                                          | FT38 replaces `areaHeight` (`:384-394`) and the two height tests (`:419-453`); `withClientWidth` (`:396-415`) moves to `support/dom.ts` (FT39). The header comment (`:1-5`) says the area's height follows F7; it becomes "the area is square up to the cap (openui-diagrams-square-area.md F25)".                                                                                                                                                                                                                                                                        |
| `openui` `tests/client/flowchart.test.ts`                                                                                | FT39: three cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `openui` `tests/client/support/dom.ts`                                                                                   | FT39: add and export `withClientSize`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `openui` `tests/client/diagram-model.test.ts`, `entity-model.test.ts`, `mindmap-model.test.ts`, `sequence-model.test.ts` | FT40.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Not changed: `gestures.ts`, `packages/desktop/src/viewport.ts`, the pictures, the layout chunk, the stories (`stories/*.stories.tsx`, none passes `height`), `manifest.json` and `package.json`.

## Test plan

Every test runs in the bundle's existing `node:test` suite under happy-dom (`tests/client/support/dom.ts`).

- Happy-dom does no layout, so the square itself is checked by its class, as `canvas-element.test.ts:509` does for papercraft. M17 measures the same CSS in Electron's Chromium, and [SA1](#acceptance) checks it in the app (FR30).
- The fit's math and the reader's zoom already have tests (Goals, SG2). FT39 adds the refit on resize, its stop after a zoom and the return to the fit; all three are behavior that exists today (`gestures.ts:57-60,64-82,179`), so FT39 is a guard.
- A stray fifth argument is lang-core's behavior (M16), and its report is already tested: `tests/report.test.ts:77-121` passes an `excess-args` error with its message, and `tests/validation.test.ts:180-192` writes one without a message using the fixed text.

The tests below use the files' existing helpers:

- `draw(props, size)` (`diagram-drawing.test.ts:288-316`) renders a static `DiagramCanvas` for a Flowchart's props and a layout result of the given size.
- `mountP(options)` (`flowchart.test.ts:135-164`) mounts program `P` (`:39-46`) in a closed conversation fence, laid out by `fakeLayout` (`:86-130`).
- `transformOf(container)` (`flowchart.test.ts:190-213`) reads the viewport's translate and scale from the transform around the SVG.

The tests, in number order:

- **Status before the change.** FT38 fails today: the area has no `aspect-square` class and has an inline height. FT39 passes before and after the change; it guards the refit that the area's new height relies on. FT40 only removes assertions. FT14 passes today, fails once F26 removes `height` and before F27 regenerates the skill, and passes again after it; both happen in step 10.
- **FT14** (`skill-text.test.ts`): unchanged code. It passes once the committed `openui.md` is regenerated (F27), and its growth assertion (`:227-232`) still holds, 68 characters lower.
- **FT38** (`diagram-drawing.test.ts`), test "the area is square up to the cap: aspect-square, full width, max-height class, no inline height". `draw({ nodes: [node] })`; the SVG's grandparent, the area (area > content `div` > SVG, `canvas.tsx:381-407`), has the classes `aspect-square` and `w-full`, the class `max-h-[calc(100svh-40px-var(--doric-titlebar-height,40px)-32px)]`, and its `style.height` is `''`. One test covers all four types: `DiagramCanvas` (`canvas.tsx:462`), `SequenceView` (`sequence.tsx:78`), `EntityView` (`entity.tsx:82`) and `MindMapView` (`mindmap.tsx:76`) all render `DiagramFrame`.
- **FT39** (`flowchart.test.ts`), three guard cases that pass today.
  - Helper: `withClientWidth` moves from `diagram-drawing.test.ts:396-415` to `tests/client/support/dom.ts` as `withClientSize(size: { width: number; height: number }, run: () => Promise<T>): Promise<T>`. It defines `clientWidth` and `clientHeight` getters on `HTMLElement.prototype` that read `size.width` and `size.height` at each call, so a test changes the size by assigning to `size`, and it restores both descriptors after `run`, as `withClientWidth` does today.
  - Setup, inside `withClientSize` with `size` at 600 × 600: `globalThis.ResizeObserver` is a stub class, restored after, that keeps a set of callbacks: its constructor adds its callback to the set, `disconnect` removes it, and `observe` and `unobserve` do nothing (`flowchart.test.ts:648-670`). Then `mountP()`. "Resize" below means: `size` set to 400 × 400 and every callback in the set called inside `act`.
  - Expected fit at 400 × 400: scale 0.4, tx 24, ty 140, to 1e-6. `fakeLayout`'s result for `P`'s five nodes is 880 × 300 (`flowchart.test.ts:96,129`), and the fit into 400 × 400 is `min(352 / 880, 352 / 300)`, centred.
  - "a resize of the area refits the drawing": resize; `transformOf(container)` is the expected fit (`gestures.ts:64-82`).
  - "after a zoom, a resize keeps the reader's viewport": click "Zoom in" inside `act` and keep `transformOf(container).css`; resize; the transform's `css` is unchanged (`gestures.ts:57-60`).
  - "Fit to view after a resize fits the new size": click "Zoom in", resize, then click "Fit to view" inside `act`; `transformOf(container)` is the expected fit (`gestures.ts:179`).
- **FT40** (the four model test files): delete the `height` inputs and assertions, with no new test. The model types have no `height`, so the typecheck rejects any reader or test that reads it.
  - `diagram-model.test.ts`: `:50`, `:68`, `:84`, `:88`, `:440` and `:450`. The test at `:80` is renamed "direction is read as written".
  - `entity-model.test.ts`: `:77`, `:265`, `:271`, `:286` and `:291`.
  - `mindmap-model.test.ts`: `:50` and `:55`, and `height: 'tall'` and its assertion in the test at `:189` (`:192`, `:194`), renamed 'layout "down" reads down; "sideways" reads right, without a finding'.
  - `sequence-model.test.ts`: `:61`, `:74`, `:305` and `:314`.

### Acceptance

Manual checks by the user, made with both phases' acceptance checks ([phase 1](openui-diagrams.md#acceptance), [phase 2](openui-diagrams-phase2.md#acceptance)).

- **SA1.** In a main Thread, ask for one diagram of each type, and for two diagrams side by side in a row `Stack`.
  - In the default window, read the content height H as `window.innerHeight` in the developer tools (800 on macOS; less on Windows and Linux, whose title bar is native). An area as wide as its fence or slot is square while it is at most H − 112 px wide. With a wider fence it is H − 112 px tall: on macOS 688, for example 736 × 688. The developer tools show the area element's computed width, height and `max-height`.
  - Scrolled to an area, the whole area and its toolbar are visible together between the workspace header and footer.
  - In the smallest window, 640 px tall, a full-width area is H − 112 px tall (528 on macOS) and wider than tall, and is still visible whole.
  - Narrowing and widening the conversation pane below 768 px, and making the window shorter and taller, keeps each area within these rules and refits the drawing until it is zoomed. After a zoom, the area still follows the width but the zoom is kept, and "Fit to view" fits again.
- **SA2.** Ask the agent to change one of the drawn diagrams. It writes a patch with the same fence name, so the earlier fence becomes an older revision, which is static (UD8, phase 1 F8). That older fence's area follows the same rules and refits when the pane is resized or the window made shorter.

## Measurements

All on 2026-11-06 in `/workspace/scratch/diag-square`, a folder outside the repository, with Node 22 on Linux aarch64. They used the repository's compiled tests (`dist-tests`, built from the working tree at `06318f66`), elkjs 0.11.1, lang-core 1.0.2 and react-ui 0.18.1 as installed, and Electron 44.4.3. As in phases 1 and 2, the scripts are not kept, so the numbers cannot be re-run from the repository (FR30). Each entry gives the inputs and formulas, enough to rebuild its script.

- **M14 Drawing sizes and fit, today and in a square** (`sizes.mjs`).
  - **Inputs.** The phase 1 flowchart fixtures 20/28/4/2, 50/70/none and 100/200/25/4, in both directions. The phase 2 sequence fixtures 3/12, 8/50 and 20/200. The entity fixtures 10/12, 30/50 and 60/120, `er` and `class`, both directions. The mind-map fixtures 30/3, 100/5 and 300/8, both layouts. All use the seeds and the generators of `tests/client/support/random-graph.ts` (`randomFlowchart`, `randomSequence`, `randomEntityDiagram`, `randomMindMap`). They are read by the readers, sized under the estimate (`createMeasure('')`) and laid out by the layout chunk's `layout` or by `layoutSequence`.
  - **The nine small diagrams**, written by hand: a flowchart of 4 nodes and a pipeline of 7 nodes, each `down` and `right`; a sequence of 3 participants and 4 messages; an ER diagram of 3 entities and 2 relations, `down` and `right`; a mind map of 7 topics, `right` and `down`. That gives 144 layouts in all.
  - **Computed.** For each layout and W: today's area height (`canvas.tsx:44-54` with client width W − 2), today's fit scale in that area, the fit scale in the W × W square, and the coverage in the square. Per fixture and direction, the median width and the median height are taken over the five seeds.
  - **The nine small diagrams at W = 736:**

    | Diagram                     | Size      | Area today | Scale today | Scale in square | Coverage |
    | --------------------------- | --------- | ---------- | ----------- | --------------- | -------- |
    | Flowchart, 4 nodes, `down`  | 158 × 376 | 424 px     | 99 %        | 100 %           | 11 %     |
    | Flowchart, 7 nodes, `down`  | 153 × 410 | 458 px     | 100 %       | 100 %           | 12 %     |
    | Flowchart, 4 nodes, `right` | 520 × 100 | 160 px     | 100 %       | 100 %           | 10 %     |
    | Flowchart, 7 nodes, `right` | 783 × 62  | 160 px     | 88 %        | 88 %            | 7 %      |
    | Sequence, 3 × 4             | 311 × 278 | 326 px     | 99 %        | 100 %           | 16 %     |
    | ER, 3 entities, `down`      | 192 × 390 | 438 px     | 99 %        | 100 %           | 14 %     |
    | ER, 3 entities, `right`     | 601 × 126 | 174 px     | 98 %        | 100 %           | 14 %     |
    | Mind map, 7 topics, `right` | 300 × 240 | 288 px     | 99 %        | 100 %           | 13 %     |
    | Mind map, 7 topics, `down`  | 324 × 186 | 234 px     | 99 %        | 100 %           | 11 %     |

  - **Fixture medians at W = 736 (fit scale today → in the square).**
    - Flowchart 20/28/4/2 `down`, 855 × 1118: 46 % in a 560 px area → 61 %.
    - Sequence 3/12, 451 × 704: 72 % → 97 %.
    - Mind map 30/3 `right`, 296 × 1266: 40 % → 54 %.
    - Flowchart 20/28/4/2 `right`, 1864 × 559: 36 % → 37 %, one point more.
    - Mind map 30/3 `down`, 2237 × 186: 31 % in both, a band with 7 % coverage.
  - **All 144 layouts** (fit scale in the square compared with today; layouts at the 25 % floor, today → square):

    | W      | Larger | Smaller | Equal | At the floor |
    | ------ | ------ | ------- | ----- | ------------ |
    | 736 px | 57     | 0       | 87    | 82 → 80      |
    | 480 px | 13     | 17      | 114   | 111 → 113    |
    | 362 px | 4      | 18      | 122   | 119 → 125    |
    | 237 px | 2      | 14      | 128   | 125 → 132    |

    W = 362 and 237 px are two and three diagrams side by side in a row `Stack` at the widest fence (M17). At W = 480, today's area is taller than the square in 46 layouts.

  - **Small tall diagrams at W = 362**, where S = 312 px: the 4-node flowchart `down` and the 3-entity ER `down` drop from 100 % to 83 % and 80 %, and the 7-node pipeline `down` to 76 %. The other six small diagrams keep today's scale.
  - **Capped areas.** Fit scale at W = 736 in an area 688 px tall (H = 800) and 528 px tall (H = 640):

    | Area      | Larger than today | Smaller than today | Equal | At the floor |
    | --------- | ----------------- | ------------------ | ----- | ------------ |
    | 736 × 688 | 55                | 0                  | 89    | 82           |
    | 736 × 528 | 34                | 21                 | 89    | 82           |

- **M15 Skill length** (`skill.mjs`). Phase 2's M7 generator (lang-core's `defineComponent` for the sixteen components as phase 2 F13 defines them, `openuiLibrary.extend` and `prompt` with `openuiPromptOptions`, `inlineMode` and `editMode`) was run with and without `height` on the four types. Removing `height` shortens the text by 68 characters (4 × `, height?: number`). Only the difference is used: the generator's totals do not match the committed `openui.md` (45,177 UTF-16 units at `06318f66`), so they are not given. The four signatures printed are F27's.
- **M16 A fifth argument** (`extra.mjs`). `createParser` was run over react-ui's library extended with the sixteen components, the four types defined without `height`. `Flowchart(…, "down", 400)`, `SequenceDiagram(…, [], 500)`, `EntityDiagram(…, "er", "down", 300)` and `MindMap(Topic("R"), "right", 400)` each give one error `excess-args` on `root`, for example "Flowchart takes 4 arg(s), got 5 (1 excess dropped)". Their props equal the same calls without the last argument.
- **M17 Layout in Electron's Chromium** (`layout/main.js`, `layout/page.html`, run with `xvfb-run` and an offscreen `BrowserWindow`).
  - **Inputs.** A page with the app's `box-sizing: border-box` and these elements, each with its CSS reproduced:
    - the column (`max-width: 768px; padding: 0 16px`);
    - the fence and its `w-full` child (`renderer.ts:184-189`);
    - react-ui's `Stack` (`display: flex` with a 12 px gap);
    - a view root (`flex w-full flex-col`), the frame's wrapper (`relative w-full`) and the area (`aspect-ratio: 1 / 1; width: 100%; overflow: hidden`, 1 px border) holding an absolute SVG.
  - **Measured.** The window's width was set to 1200, 800, 700 and 500 px, and each area's offset and client sizes were read.
  - **One diagram:** areas of 736, 736, 668 and 468 px, square at every width, with client boxes 2 px smaller (734 at 1200 px).
  - **Two in a row `Stack`:** each area is 362 px, then 328 and 228 px. **Three:** 237 px, then 215 and 148 px.
  - **A column `Stack` of two:** each as wide as the fence.
  - **Resize:** with a 40-line paragraph above two diagrams, narrowing the window from 800 to 700 px moved the text below them up by 126 px. Each square shrank by 83 px, from 736 to 653 px with the page's scroll bar, and the paragraph grew by 40 px. At 500 px, each square was 453 px and the paragraph 400 px.
- **M18 The cap in Electron's Chromium** (`layout/cap.js`, `layout/cap.html`, run like M17).
  - **Inputs.** M17's page inside the workspace's frame, each part with its CSS reproduced:
    - a `100svh` column (`workspace-view.tsx:211`);
    - a 40 px header (`workspace-layout.tsx:80`);
    - a row holding a sidebar of 0 or 256 px and the conversation's scroll view. The app's sidebar defaults to 240 px (`workspace-layout.tsx:98-103`); with it, the conversation is 16 px wider, so the two sidebar cases would give 673 × 528 and 673 × 673 (computed, not measured). The heights and the clamp do not depend on the sidebar;
    - a 40 px footer (`workspace-view.tsx:283-288`).
      The area is followed by a 150 × 34 px toolbar placed as `canvas.tsx:410`'s. A `ResizeObserver` on the area counts its callbacks.
  - **Cases.** The window's content size (H, Terms) was set to 1280 × 800 (the default), 960 × 640 (the minimum), 1280 × 640 and 960 × 800. Three values of `max-height` were tried: none, `calc(100svh - 80px)` and `calc(100svh - 112px)`.
  - **Visible conversation height:** 720 px at H = 800 and 560 px at H = 640, H less 80, in every case.
  - **Area with `calc(100svh - 112px)`**, F25's cap with the token at its 40 px default:
    - 736 × 688 at 1280 × 800 and at 960 × 800 without a sidebar;
    - 736 × 528 at 1280 × 640 and at 960 × 640 without a sidebar;
    - 657 × 528 at 960 × 640 with the 256 px sidebar;
    - 657 × 657 at 960 × 800 with the sidebar, where 657 < 688 and the area stays square.
      In every case the width stayed the full width and only the height was clamped.
  - **Area with `calc(100svh - 80px)`:** exactly the visible height, 720 or 560 px.
  - **Tailwind** (`tw/build.mjs`): the repository's Tailwind 4 (`@tailwindcss/node` `compile` and the oxide scanner) builds `max-h-[calc(100svh-40px-var(--doric-titlebar-height,40px)-32px)]` as `max-height: calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`. The comma needs no escape; the form `,_40px` gives the same value with a space.
  - **Observer:** it fired on every change of the area's size, including a change of `max-height` that moved only the height (736 × 720 → 736 × 688). It did not fire when the size was unchanged.

## Alternatives considered

- **A measured height (ResizeObserver sets `height` to the area's width).** Rejected. It needs state and a re-render per width change, and it draws one frame at the old height on mount and on each resize. CSS gives the same box with no state, effect or observer. Papercraft's node already uses `aspect-square` (F25).
- **Keep `height` as an override of the square.** Rejected by UD16: the user asked for every area to be square.
- **Keep `height` in the schema and ignore it.** Rejected. The skill would still offer a prop with no effect, and a model writing it would get no signal. Removing it shortens the skill by 68 characters (M15), and lang-core reports a stray value (M16).
- **No cap: a square at every width.** Version 3's UD15. Rejected by the user: the area must fit in the window (UD15).
- **A fixed maximum height, as today's 560 px.** Rejected. It ignores the window: 560 px exceeds the 528 px the cap leaves at H = 640, and it wastes height in a tall window.
- **Cap at the visible height, without the 32 px.** Meets UD15 but not adopted. The area then fills the scroll view exactly (M18: 720 and 560 px), so it is visible whole only when scrolled to the pixel, with its border against the header and footer.
- **Cap by the measured scroll view (a ResizeObserver on the conversation, or container-query units).** Rejected. The scroll view belongs to the chat bundle (`conversation/index.tsx:516-519`). Measuring it from `openui` needs JavaScript state per frame, and container-query height units need `container-type: size` on a chat element, a change outside this bundle. The `svh` cap gives the same height while the header and footer are the only chrome (FR31).
- **Scale small drawings up to fill the square.** Rejected by UD14: never above 100 %, as today.
- **Align a drawing at the floor to its start (top or left) instead of centring it.** Not adopted. The user did not ask for it, it would change `fitViewport`, which papercraft shares (`viewport.ts:57-79`), and the case exists today too (M14: 82 of 144 at W = 736). It can be decided on its own later (FR27).

## Risks

- **FR25 Empty space and page length.**
  - **Risk.** Every diagram now takes a square as tall as its area width, up to the cap: 688 px in the default window. The nine small diagrams of M14 cover 7–16 % of a 736 px square, where today their areas were 160–458 px tall. A conversation with several diagrams grows longer.
  - **Mitigation.** The cap (UD15) bounds each area by the window. The rest is UD14 and UD15 as decided. The user judges it at [SA1](#acceptance). The other choices are listed in [Alternatives considered](#alternatives-considered).
- **FR26 A model writes `height` anyway.**
  - **Risk.** The charts still take `height` (`openui.md:71-73`), and earlier diagrams in a conversation may show one. Conversations made on `feature/openui` builds since `06318f66` hold diagrams written with the old signature. How many is not known; only development builds exist, since 2.2.0 is unreleased. Such a call, new or old, draws normally and shows one `excess-args` error in the error card and the report (M16).
  - **Mitigation.** The skill no longer prints `height?` on the diagrams (F27), and the error tells the model the argument was dropped. The error cards on development conversations are accepted. Reverting this change is safe: `height` is optional in the old schemas, so programs written without it stay valid there.
- **FR27 Narrow areas and the 25 % floor.**
  - **Risk.** At W = 480, 17 of 144 layouts get a smaller fit than today, because today's area could be up to 560 px tall (M14). A drawing at the floor is centred and clipped at both ends in the square, as it is today, and a static fence shows only its middle.
  - **Mitigation.** Pan, zoom and "Fit to view" are unchanged in interactive fences. Top-aligning is listed as an alternative for later.
- **FR28 Height changes on resize move the conversation.**
  - **Risk.** The area's height now follows its width one for one. Every change of the conversation pane's width while the pane is narrower than 768 px (the column's `max-w-3xl`, `conversation/index.tsx:522`) changes each diagram's height by the same amount. Narrowing the window from 800 to 700 px moved the text below two diagrams by 126 px (M17), against a 40 px change from a 40-line paragraph.
    - The conversation disables native scroll anchoring (`bundles/desktop/chat/src/client/styles.css:106-110`). Its own `preserveVisibleBlock` runs only on transcript updates (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/scroll-position.ts:77`). So nothing keeps the reader's place while the pane resizes.
    - While the cap binds, as for the widest fence in the default window, every change of the window's height also changes each capped area's height by the same amount (M18).
    - Before this change, diagram areas did not change height on resize (Problem); papercraft's canvas nodes already do.
  - **Mitigation.** None in this change. It follows from UD14's "the height follows the width on resize" and UD15's cap, and is accepted with them. Keeping the reader's place on resize would be a change to the conversation's scrolling, outside the `openui` bundle. [SA1](#acceptance) includes resizing.
- **FR29 Diagrams side by side.**
  - **Risk.** The skill lets a diagram go in a `Stack` (`src/host/skills/openui.md:417`), and a `Stack` can run in a row (`:21`). There, each square is as wide as its slot: 362 px for two and 237 px for three at the widest fence (M17).
    - Compared with today's areas of up to 560 px at those widths, the fit is smaller in 18 and 14 of 144 layouts, and 125 and 132 layouts are at the floor, against 119 and 125 today (M14).
    - The small tall diagrams drop from 100 % to 76–83 % at 362 px.
  - **Mitigation.** None in code. A diagram alone or in a column `Stack` keeps the fence width, and the reader can zoom an interactive one. The cap does not bind in a row (F25), so it makes this no worse. [SA1](#acceptance) includes a row of two.
- **FR30 What the tests and measurements do not cover.**
  - **Risk.** That the height follows the width up to the cap is CSS. The unit tests check only the class and the `max-height` value (FT38), because happy-dom does no layout; FT39 checks the refit, which is existing code (`gestures.ts:75-82`). M14–M18 rest on scripts outside the repository, as phases 1 and 2's measurements did. FR25, FR27, FR29 and the alternatives rely on them.
  - **Mitigation.** M17 and M18 measured the CSS in the app's Chromium, and [SA1](#acceptance) and [SA2](#acceptance) check it in the app. Each measurement entry gives its inputs and formulas.
- **FR31 Other chrome above or below the conversation.**
  - **Risk.** The cap counts only the workspace header and footer. When more chrome takes height from the scroll view, a capped area can again exceed the visible height and need scrolling to see whole. Examples are the `layout.main.bottom` split (`workspace-view.tsx:252-254`), a viewer tab bar, or a fence shown in a Thread side panel with its own 40 px footer (`chat-view.tsx:78-85`).
  - **Mitigation.** None in code; the cap takes the default layout (Alternatives, the measured scroll view). Pan, zoom and "Fit to view" still work inside the area. SA1 checks the default layout.

## Open questions

None. UD14–UD16 settle the behavior. FR25, FR27, FR28, FR29 and FR31 are consequences the user sees at [SA1](#acceptance).

## Docs to update

In the Docs step, after step 10:

- [docs/features/openui-diagrams.md](../features/openui-diagrams.md):
  - Add UD14–UD16 under Decisions, after UD13 (`:110`), and change "UD1–UD13" to "UD1–UD16" at `:5` and `:16`.
  - In the common rules (`:153`), replace the sentence on `height?: number` with: the area is square and as wide as its container, at most as tall as the window allows (UD15).
  - Remove `, height?: number` from the four component rows (`:166`, `:170`, `:176`, `:180`).
  - "Initial view" (`:257`): the drawing fits the area, a square capped at `calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`, never above 100 %, and refits on resize until the reader pans or zooms.
  - Current behavior (`:371-374`): drop `height?` and add the square area to "Drawing".
  - Update the skill growth in "Skill" (`:379`) to 3,779 characters.
  - Add an Evolution entry linking this spec.
- [docs/designs/openui-diagrams.md](openui-diagrams.md) and [docs/designs/openui-diagrams-phase2.md](openui-diagrams-phase2.md): one sentence on each status line (`:4`): [openui-diagrams-square-area.md](openui-diagrams-square-area.md) replaces F7's and F20's area height and removes the `height` prop. Their bodies stay as accepted. On phase 2's line, "uncommitted" is dropped, since `06318f66` commits the code.
- [docs/features/generative-ui.md](../features/generative-ui.md): the Specs line links this spec; the decisions become UD1–UD16; "Diagrams" says each is drawn in a square area capped by the window's height; the skill's diagram growth becomes 3,779 characters; an Evolution entry records the square area and the four diagram types' loss of `height`, acceptance pending.
- [bundles/features/openui/README.md](../../bundles/features/openui/README.md): its diagram lines (`:91-124`) do not mention height. Add "a square area as wide as its container" to "Pan and zoom" (`:119`).
- [docs/architecture/bundles/implementation-decisions.md](../architecture/bundles/implementation-decisions.md) (`:1340`, phase 1 section): a new dated section records UD14–UD16: the square area capped by the window's height, the `height` prop removed from the four diagram types, and `openui` staying 2.2.0, unreleased.

## Revisions

- **Version 1 (2026-11-06).** First version, from the user's decisions UD14–UD16 and commit `06318f66`, with measurements M14–M16.
- **Version 2 (2026-11-06).** Answers the Scope review.
  - FT39 is cut to one case, a resize refits, and the fit goal points to the existing fit and zoom tests.
  - F25 and F26 keep the contract, the removed props and the data flow; file and line detail moves to Files to change.
  - FT38 is one assertion on `DiagramFrame`'s area.
  - FT41 is dropped, since lang-core's dropping and the `excess-args` report are already covered (M16, `validation.test.ts`, `report.test.ts`).
  - FT40 only deletes the `height` inputs and assertions.
  - The earlier specs get one sentence each.
- **Version 3 (2026-11-06).** Answers the Structural, Style, Comprehension and Critique reviews, with a new measurement M17.
  - Identifiers: goals are SG1–SG4 and acceptance checks SA1–SA2, in their own `### Acceptance` section. The identifier line names every family, and a Measurements line is added.
  - Terms: a list of borrowed terms with their sources, and new terms for area width, coverage, static, report, readers, seeds and pictures.
  - UD15 states its checkable fact, at most 736 px. The decision itself waits for the user's answer to the Critique's window-height finding.
  - F25: bounded shape cases, the slot width in a row `Stack`, and the wheel's page height explained.
  - F26: the report carries lang-core's message, not the fixed text.
  - M14: inputs and formulas named, a table of the nine small diagrams, and W = 362 and 237.
  - M17 measures the CSS, row slots and resize movement in Electron's Chromium.
  - Risks: FR26 counts development conversations; FR28 is bounded by M17 and accepted; FR29 covers diagrams side by side; FR30 covers test and measurement limits.
  - SA1 and SA2 say how to check the square and how to produce an older revision.
  - Docs to update links the README and implementation decisions.
- **Version 4 (2026-11-06).** Records the user's answer on window height ("Sim, 1:1 até caber na tela") as UD15, which replaces version 3's "no cap".
  - F25 adds the cap `AREA_MAX_HEIGHT`, `calc(100svh - 112px)`, as an inline `max-height`, and generalizes the fit to Sx × Sy.
  - M18 measures the visible conversation height (720 and 560 px), the capped areas and the observer in Electron's Chromium, and M14 adds the capped fit counts.
  - FT38 asserts the cap. SA1 and SA2 include a short window.
  - FR25, FR28, FR29 and FR30 are updated, and FR31 covers chrome the cap does not count.
  - Alternatives reject no cap, a fixed 560 px, a cap at the exact visible height and a measured scroll view.
- **Version 5 (2026-11-06).** Answers the third Scope review.
  - The cap reads the footer's token: `calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`, as the Tailwind class `max-h-[calc(100svh-40px-var(--doric-titlebar-height,40px)-32px)]`. The header stays 40 px, since it is `h-10` and not the token.
  - The exported constant and the inline style are dropped, and FT38 asserts the class. M18 records that the repository's Tailwind builds it.
  - The 32 px are a comfort margin; the cap without them already meets UD15.
  - Terms keep only the 80 px fact, and M14 drops the comparison with the uncapped square.
- **Version 6 (2026-11-06).** Answers the Readiness and Codebase reviews.
  - Test plan: each test's status before the change is stated. FT39 is a guard with three cases (refit, a zoom kept across a resize, "Fit to view" after a resize), through `withClientSize`, moved from `withClientWidth` to `support/dom.ts`. SG2 no longer credits FT15 with the return to the fit.
  - Window sizes are outer sizes; Terms define the content height H, and the cap, SA1 and F25 are written in H, with macOS's values.
  - The cap's token has a 40 px fallback: `calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`.
  - Corrections: the header is `workspace-layout.tsx:80`; the sidebar default is 240 px; the fit's margin is the default; the phase specs' status; M15 keeps only the 68-character difference; the feature doc's line numbers; the test file's header comment is in Files to change; FR26 says reverting is safe.
