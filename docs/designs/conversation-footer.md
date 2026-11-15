# Spec: conversation footer

- Ticket: none given.
- Status: `accepted` (2026-11-15, approved by jao.scheuermann), version 7 (2026-11-15). Phase 1 (chat 1.6.2, the viewer footer) is implemented (2026-11-15, branch `feat/sidebar-alignment`); phase 2 (layout 3.0.3, the conversation card's footer) is not yet implemented.
- Builds on: commit `5e636166` (branch `feat/sidebar-alignment`, two commits after `origin/main` `26f42a07`, which merged PR #57). Every line reference names the file as it is at that commit, except the papercraft preview, which git ignores (`.gitignore:9`), and the Base UI and Lexical sources, cited as installed in `node_modules` (`@base-ui/react` 1.8.0, `lexical` 0.51.0). Every path is written from the repository root.
- Requirements: U1–U4, set by the user (jao.scheuermann) on a papercraft preview, and the user's decisions of 2026-11-15 on the reviews (the band takes the pointer; chat lands before the layout; both phases are commits on `feat/sidebar-alignment`; the caret under the band is a known limitation). They are not reopened here. The user's U5 (remove the bottom split) is separate work ([Non-goals](#non-goals)).
- Visual target: the text of [Visual target](#visual-target). The preview `.doric/papercraft/previews/conversation-footer.tsx`, variant `glass-2`, is not normative and is git-ignored, so this spec states every class and length it settled.
- Feature docs: [docs/features/ui-redesign.md](../features/ui-redesign.md), whose conversation card and viewer card this change revises. No new feature doc.
- Identifiers: U1–U4 requirements; G1–G3 goals; D1–D8 design decisions; T-1 … T-10 tests; V-1 … V-10 visual checks; SR1, SR3–SR5 and SR7–SR11 risks; SQ1 and SQ3, both answered. Withdrawn: G4, G5, D9–D12, SR6 and SQ2 in version 2, SR2 in version 3 ([Revisions](#revisions) says what each was).

## Contents

- [Terms](#terms)
- [Visual target](#visual-target)
- [Problem](#problem)
- [Goals](#goals)
- [Non-goals](#non-goals)
- [Requirements](#requirements)
- [Design decisions](#design-decisions)
- [Design](#design)
- [Flows](#flows)
- [Contracts and versions](#contracts-and-versions)
- [Persisted data](#persisted-data)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Phases](#phases)
- [Files to change](#files-to-change)
- [Test plan](#test-plan)
- [Visual verification](#visual-verification)
- [Docs to update](#docs-to-update)
- [Questions](#questions)
- [Revisions](#revisions)

## Terms

Thread, Project, bundle, contract (`name/vN`, minor version), region and the inset card mean what the Terms of `docs/features/ui-redesign.md:24-76` say. Renderer sheet and bundle sheet mean what the Terms of `docs/designs/sidebar-alignment.md:73` say. A Figma node ID such as `99:8035` names a frame of the redesign's Figma file (`docs/features/ui-redesign.md:21`). The terms below are this spec's.

| Term                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user                                | jao.scheuermann, who set U1–U5 and the review decisions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Base UI                                 | The component library under the platform's `ScrollArea` (`docs/designs/sidebar-alignment.md:74`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Lexical                                 | The editor framework the transcript is built on (`lexical` 0.51.0).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Papercraft                              | The repository's tool that previews components in a conversation, and the bundle that draws its surfaces in the transcript (`docs/designs/sidebar-alignment.md:74`, `docs/features/papercraft.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Conversation card                       | The main window's card around the conversation: `SidebarInset` with `INSET_CARD` (`bundles/desktop/layout/src/client/views/workspace-view.tsx:295`). `INSET_CARD` is `flex min-h-0 flex-col overflow-hidden rounded-xl bg-background p-2 shadow-sm` (`bundles/desktop/layout/src/client/components/templates/inset-card.ts:13-14`); its `p-2` is the 8 px between the card's edge and everything in it. `SidebarInset` adds `relative` (`packages/desktop/src/components/sidebar.tsx:329`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Viewer card                             | The card of the viewer column, `<section aria-label="Viewer">` with `INSET_CARD` (`bundles/desktop/layout/src/client/components/templates/workspace-layout.tsx:137-147`). A child Thread's tab draws `<chat-thread-panel>` in it (`bundles/desktop/layout/src/client/hooks/thread-navigation.ts:16-25`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Child Thread                            | A Thread an agent spawned from another; its tab opens in the viewer card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Conversation                            | What `<chat-view>` draws for one Thread: the trail root, holding the trail column and the scroll area (`bundles/desktop/chat/src/client/components/organisms/conversation/index.tsx:515-526`). As a box, the conversation is the trail root's box.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Transcript                              | The content of the conversation's scroll area: one Lexical editor (`index.tsx:537-585`) that holds the Thread's turns and, at its end, the prompt the reader types (`bundles/desktop/chat/README.md:3-5`; `MarkdownPromptPlugin`, `ComposerDraft` and `SendPrompt` at `index.tsx:549`, `:563-564`). The transcript column is the editor's wrapper, `mx-auto … pb-80` (`index.tsx:532`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Fence                                   | A block of the transcript that another bundle draws, through `FenceElements` (`index.tsx:500-507`); papercraft's surfaces are fences.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Composer controls                       | `ComposerControls`: "Stop execution" while a queued edit is open and the Thread runs, and the send/stop/resume/save button (`bundles/desktop/chat/src/client/components/organisms/composer-controls.tsx:23-29`). They act on the prompt in the transcript; they are not where it is typed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Agent levers                            | On an agent Thread, the three controls `ThreadComposer` draws instead of the composer controls: pause the run, continue the prompt it left unfinished, or retry the last one (`bundles/desktop/chat/src/client/views/chat-composer.tsx:22-30`, `bundles/desktop/chat/README.md:21-25`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Main footer                             | `<footer data-slot="workspace-footer">`, the layout's footer under the conversation, which draws the `layout.footer` region (`workspace-view.tsx:327-332`): the settings execution picker (`settings-execution-picker`, order 20, `bundles/desktop/settings/src/client/index.ts:68-72`), the usage summary (order 30, `bundles/features/usage/src/client/index.ts:27-30`) and `<chat-composer>` (order 40, `bundles/desktop/chat/src/client/index.ts:93-96`), whose view draws `ThreadComposer` for the selected Thread (`chat-composer.tsx:16-18`): the composer controls or the agent levers.                                                                                                                                                                                                                                                                                                                                                                 |
| Viewer footer                           | `<footer data-slot="chat-thread-footer">`, which `ChatView withFooter` draws under the conversation with `ThreadComposer` (`bundles/desktop/chat/src/client/views/chat-view.tsx:78-85`); `<chat-thread-panel>` renders `ChatView withFooter` (`bundles/desktop/chat/src/client/elements/chat-elements.tsx:44-48`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The two footers                         | The main footer and the viewer footer. Today both have the class set `flex h-7 shrink-0 items-center justify-end gap-1 pl-2 text-[11px] font-normal` (`workspace-view.tsx:329`, `chat-view.tsx:80`) and sit in flow under the conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Footer weight rule                      | The renderer sheet's rule that sets `font-weight: 400 !important` on every `footer`, every element whose `data-slot` ends in `-footer`, and all their descendants (`app/desktop/doric-renderer/src/styles.css:87-93`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Row                                     | The footer's 28 px line of items: `h-7`, `items-center justify-end gap-1 pl-2`, 11 px text, weight 400; its buttons are 24 px (`size-6`, `bundles/desktop/chat/tests/client/chat-view.test.ts:1173`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Band                                    | A footer as this spec draws it: 8 px of top padding over the row, 36 px in all (`h-9 pt-2`; `box-sizing: border-box` comes from Tailwind's preflight, `bundles/desktop/layout/src/client/styles.css:25`), floating over the bottom 36 px of the conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Floating                                | Absolutely positioned over a sibling instead of following it in flow, so the sibling runs under it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Conversation frame                      | The new `relative` container that holds the conversation and the floating main footer ([§1](#1-the-conversation-frame)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--chat-footer-height`                  | The new custom property that `<chat-view>` reads: the height of a footer floating over the bottom of its conversation. The band's owner sets it on the band's positioned parent; unset, it counts as 0 ([§4](#4-the-bar-and-the-scroll-padding)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Trail root                              | The conversation's wrapper `div.flex.min-h-0.min-w-0.w-full.flex-1` that holds the trail column and the scroll area (`index.tsx:515`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Trail column, handles                   | The conversation trail (`docs/features/ui-redesign.md:388`): a 26 px column left of the scroll area (`bundles/desktop/chat/src/client/components/molecules/thread-nav-rail.tsx:221`) with a `nav` centred on the column's height (`:222-225`) holding one 10 px handle per prompt (`h-2.5`, `:100`) and a last "Go to the end" handle (`:241-250`). A click on a handle jumps to its prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reading line                            | The line 40 % down the viewport where a jump puts a prompt's top and by which the active handle is chosen (`READING_LINE`, `bundles/desktop/chat/src/client/domain/thread-nav.ts:70-78`, `:96`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Scroll area, scroll root, viewport, bar | The conversation's `ScrollArea` with the class `conversation-scroll` (`index.tsx:526`): its root, "the scroll root" (`data-slot="scroll-area"`, `relative`), its viewport (`data-slot="scroll-area-viewport"`, `size-full`), whose only child is the transcript column (`index.tsx:532`; chat's sheet states it and styles the column as that child, `bundles/desktop/chat/src/client/styles.css:95-104`), and its vertical scrollbar, "the bar" (`data-slot="scroll-area-scrollbar"`, `data-orientation="vertical"`, `w-2.5 p-px`, a transparent left border, thumb `bg-border`) (`packages/desktop/src/components/scroll-area.tsx:19-57`). Base UI positions the bar with an inline style, `position: absolute; top: 0; bottom: var(--scroll-area-corner-height); inset-inline-end: 0` (`node_modules/@base-ui/react/scroll-area/scrollbar/ScrollAreaScrollbar.mjs:173-189`), and does not render it while the viewport does not overflow (`:58-60`, `:199`). |
| Bottom split                            | The `layout.main.bottom` region drawn in a vertical resizable panel under the conversation while an item asked for it through `layout.workspace/v1.setBottomVisible` (`bundles/desktop/layout/src/client/components/templates/conversation-terminals.tsx:13-36`, `workspace-view.tsx:117-120`, `:296-298`). No production code asks for it: the only caller of `setBottomVisible` is `bundles/desktop/layout/tests/workspace-additions.test.ts:155-160`, and the only `layout.main.bottom` item is a story fixture (`bundles/desktop/layout/stories/support/fake-host.ts:164-166`).                                                                                                                                                                                                                                                                                                                                                                             |
| The preview                             | `.doric/papercraft/previews/conversation-footer.tsx`. Its variants are `atual` (today), `clear`, `glass` (8 px blur), `glass-4`, `glass-2`, `glass-1` and `fade` (`:24-41`). The user chose `glass-2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Visual target

The preview's `glass-2` variant, as its source draws it, with the lengths this spec states:

- The footer floats over the conversation: `absolute inset-x-0 bottom-0 pt-2` over the 28 px row, `bg-background/70`, a 2 px backdrop blur (preview `:176-195`). Its box spans the card's content box: from 8 px inside the card's left edge, over the 26 px trail column, to 8 px inside its right edge, and its bottom is 8 px above the card's bottom edge.
- The band is 36 px (`BAND = 8 + 28`, preview `:51-52`). The transcript runs on under it and shows through the 70 % fill, blurred by 2 px.
- The bar runs from the scroll area's top to 36 px above its bottom (preview `:133-137`, `:162-165`), so it ends where the band begins. The 24 px button is centred in the 28 px row, 2 px under the row's top, so the bar ends 10 px above the button's top edge.
- The bar keeps its right edge at the card's content edge, 8 px inside the card's right edge, as today.
- The row is unchanged: `justify-end gap-1 pl-2 text-[11px] font-normal`, 24 px buttons, items drawn in `--foreground`.
- At the end of the scroll the transcript's last line stands clear of the band: the transcript column keeps its `pb-80` (320 px) bottom padding (`index.tsx:532`).

The preview mocks the scroll area with a plain `overflow-y-auto` div and a hand-drawn bar (`:153-175`); this spec's mechanism is the platform's `ScrollArea` ([§4](#4-the-bar-and-the-scroll-padding)). The preview's 1 px card border is the mock's (`:15`); the cards have none.

## Problem

- The two footers sit in flow under the conversation (`workspace-view.tsx:327-332`, `chat-view.tsx:78-85`), so the scroll area ends at the footer's top edge and the transcript is cut there while it scrolls. The user wants it to run on under a translucent footer.
- The row starts at the footer's top edge: no space separates it from the conversation above. The Files column's footer has 8 px (`my-2 … h-7`, `workspace-layout.tsx:170-171`); the user wants the same 8 px above the conversation footers.
- The bar runs the scroll area's full height (`scroll-area.tsx:48`, `data-vertical:h-full`), so its bottom end touches the footer row and its Send button.

## Goals

- G1. Both footers float over their conversation with the look of U1 and the geometry of U2 (U4).
- G2. The bar ends where the band begins and keeps its 8 px from the card's right edge (U3); where no band floats over a conversation, the bar runs its full height, as today.
- G3. The band takes the pointer as today's footer does: each interaction [V-5](#visual-verification) lists works as today, and a click, a wheel or a touch on the band's empty part scrolls nothing and reaches nothing under the band.

## Non-goals

- Removing the bottom split, `setBottomVisible` and `stores/bottom.ts`, and changing the `layout.workspace` contract for it (the user's U5). By the user's decision of 2026-11-15 this is separate work with its own spec; this spec keeps the split ([§1](#1-the-conversation-frame) places the frame inside it).
- Changing the footer items (picker, usage summary, composer controls, agent levers), their order or their regions.
- Changing the Files column's footer (`workspace-files-footer`) or the sidebar.
- Changing `ScrollArea` or any other platform component; `PLATFORM_VERSION` stays 1.6.0.
- Changing the transcript column's padding, the trail column or its handles.
- Letting the pointer through the band ([SQ1](#questions), answered).
- Moving the `layout.overlay` layer (`workspace-view.tsx:338-343`), which stays over the whole card.
- Changing the openui diagram cap ([SR11](#risks)).

## Requirements

- **U1** — The conversation footer floats over the conversation: the transcript scrolls on behind it instead of being cut at the scroll area's bottom edge. Footer background `bg-background/70` with a 2 px backdrop blur. The conversation keeps its `pb-80`, so its end still scrolls clear of the footer.
- **U2** — The footer gets 8 px above its row (`pt-2` + `h-7` = a 36 px band). The inset card's own `p-2` keeps the 8 px below and on the right; nothing else about the row changes (`justify-end gap-1 pl-2 text-[11px] font-normal`, 24 px buttons).
- **U3** — The conversation scroll area's vertical scrollbar stops where the footer band begins (36 px above the scroll area's bottom), about 10 px above the 24 px button, instead of touching it. It keeps its 8 px gap from the card's right edge.
- **U4** — Both footers get the same treatment: the conversation card's `workspace-footer` (layout bundle) and the child Thread tab's `chat-thread-footer` (chat bundle, `ChatView withFooter`).
- **User decisions on the reviews (2026-11-15).** The band takes the pointer as today's footer does; a wheel over its 36 px does not scroll the conversation. Chat 1.6.2 lands and ships before layout 3.0.3. Both phases land on the current branch, `feat/sidebar-alignment`, as two commits, one per phase, chat's first ([Phases](#phases)). Lexical's caret stopping under the band is accepted as a known limitation, with a follow-up planned and no fix in this change ([SQ3](#questions)).

| Requirement | Main footer (layout)                          | Viewer footer (chat)                    | Conversation scroll area (chat)       |
| ----------- | --------------------------------------------- | --------------------------------------- | ------------------------------------- |
| U1          | floats; fill and blur from the layout's sheet | floats; fill and blur from chat's sheet | `pb-80` kept                          |
| U2          | `h-9 pt-2`                                    | `h-9 pt-2`                              | —                                     |
| U3          | sets `--chat-footer-height`                   | sets `--chat-footer-height`             | bar height and scroll padding read it |
| U4          | yes                                           | yes                                     | both placements                       |

## Design decisions

| Id  | Decision                                                                                                                                                                                                                                                                                                       | Section                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| D1  | A new layout template, `ConversationFrame`, wraps the conversation in a `relative flex min-h-0 flex-1 flex-col` box that sets `--chat-footer-height: 2.25rem`, and draws the main footer as its last child, floating over its bottom. The frame sits inside the bottom split's top panel.                      | [§1](#1-the-conversation-frame)         |
| D2  | Both footers carry one class set for the band's geometry: `absolute inset-x-0 bottom-0 flex h-9 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal`. Their fill (`--background` at 70 %) and blur (2 px) are rules in the owning bundle's own sheet, keyed on the footer's `data-slot`.          | [§3](#3-the-band)                       |
| D3  | The viewer footer floats inside `div[data-chat-thread]`, which gains `relative` and, only `withFooter`, `--chat-footer-height: 2.25rem`; the footer is drawn only `withFooter`, as today.                                                                                                                      | [§2](#2-the-viewer-footer)              |
| D4  | The band takes the pointer: no pointer rule is added, so a click, a wheel or a touch on the band goes to the band or its items, as on today's footer.                                                                                                                                                          | [§5](#5-the-pointer-over-the-band)      |
| D5  | `--chat-footer-height` is `<chat-view>`'s documented input: chat owns its name and meaning, and each band's owner sets it beside its band, in the module that holds the band's class set. Chat's sheet ends the bar at `calc(100% - var(--chat-footer-height, 0px))`; unset, the bar is full height, as today. | [§4](#4-the-bar-and-the-scroll-padding) |
| D6  | Chat's sheet gives the conversation's viewport `scroll-padding-bottom: var(--chat-footer-height, 0px)`, so a block the browser scrolls into view stops above the band.                                                                                                                                         | [§4](#4-the-bar-and-the-scroll-padding) |
| D7  | Chat's sheet isolates the scroll area (`isolation: isolate`); the band, positioned and later in tree order, paints over it with no `z-index`.                                                                                                                                                                  | [§6](#6-stacking)                       |
| D8  | Nothing else in the conversation changes: the transcript column keeps `pb-80`, the trail root, trail column and scroll area keep their classes.                                                                                                                                                                | [§4](#4-the-bar-and-the-scroll-padding) |

## Design

### 1. The conversation frame

`bundles/desktop/layout/src/client/components/templates/conversation-frame.tsx` (new):

```tsx
import type { CSSProperties, ReactNode } from 'react';

/**
 * The band's geometry (conversation-footer spec, D2): 36 px, `pt-2` over the
 * 28 px row. Its fill and blur are this bundle's sheet rules.
 */
const CONVERSATION_FOOTER =
  'absolute inset-x-0 bottom-0 flex h-9 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal';

/**
 * The band's height for `<chat-view>` (`--chat-footer-height`, chat's
 * README): its bar ends and its scroll padding stops where the band begins.
 * Equal to the band's `h-9`.
 */
const FOOTER_HEIGHT = { '--chat-footer-height': '2.25rem' } as CSSProperties;

/**
 * The conversation, and over its bottom 36 px the floating conversation
 * footer, which draws `footer` (the `layout.footer` region). The conversation
 * runs on under the footer.
 */
export function ConversationFrame({
  children,
  footer,
}: {
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <div
      data-slot="conversation-frame"
      className="relative flex min-h-0 flex-1 flex-col"
      style={FOOTER_HEIGHT}
    >
      {children}
      <footer data-slot="workspace-footer" className={CONVERSATION_FOOTER}>
        {footer}
      </footer>
    </div>
  );
}
```

The constants are not exported. The cast follows the layout's own `--sidebar-width` (`workspace-view.tsx:64-67`). The frame's slot, `conversation-frame`, does not end in `-footer`, so the footer weight rule does not reach the transcript inside the frame, which keeps its weight 300 (`bundles/desktop/chat/src/client/styles.css:260-263`).

`workspace-view.tsx:296-332` (the split, `ThreadPane` and the footer) becomes:

```tsx
<ConversationTerminals
  bottom={bottomVisible && <Region name="layout.main.bottom" />}
>
  <ConversationFrame footer={<Region name="layout.footer" />}>
    <ThreadPane>{/* unchanged: core-outlet or Empty, :300-324 */}</ThreadPane>
  </ConversationFrame>
</ConversationTerminals>
```

`SidebarInset` (`:295`), the overlay's JSX comment (`:333-337`) and the overlay `div` (`:338-343`) stay as they are, the comment and the `div` after `</ConversationTerminals>`.

The frame goes inside `ConversationTerminals`, in its top panel, so the band floats over the conversation and `--chat-footer-height` reaches only the conversation, whether or not the split shows. With the split shown, the footer stands above the split instead of under it; no production code shows the split ([Terms](#terms), "Bottom split").

Under U5 the frame stays as this spec draws it. Removing the split removes only the `ConversationTerminals` wrapper: the frame becomes the card's first child, `<SidebarInset className={INSET_CARD}><ConversationFrame footer={…}><ThreadPane>…</ThreadPane></ConversationFrame><div data-slot="workspace-overlay" …/></SidebarInset>`. As a `min-h-0 flex-1` child of the card's flex column it fills the card's content box, as the split's `min-h-0 flex-1` group (`conversation-terminals.tsx:22`) does now, so the band's geometry, the property and the tests of this spec hold unchanged. The card-child footer stays rejected after U5 for its reasons that do not depend on the split ([Alternatives considered](#alternatives-considered)).

Geometry. The top panel is `flex min-h-0 flex-col` (`conversation-terminals.tsx:23`) inside the `min-h-0 flex-1` group (`:22`), which fills the card's content box: 8 px inside the card on every side (`INSET_CARD`'s `p-2`). Without the split, the top panel is the group's only panel and fills it, and the frame (`flex-1`) fills the panel. The frame has no padding and no margin. `ThreadPane`, the `section[aria-label="Thread conversation"]` (`flex min-h-0 flex-1`, `bundles/desktop/layout/src/client/components/templates/thread-pane.tsx:10`), fills the frame's whole height, since the footer is out of flow: 28 px taller than today's section, which ended at the top of the in-flow `h-7` footer (`workspace-view.tsx:327-332`). `<core-outlet>` and `<chat-view>` are `display: contents` (`bundles/foundation/core/src/client/elements/lifecycle.ts:7-8`, `packages/desktop/src/react-element.ts:75`), and so is the `div.contents` that `ChatView`'s `IntentDispatcher` draws around the thread (`bundles/desktop/chat/src/client/components/organisms/intent-dispatcher.tsx:55`, `chat-view.tsx:66`; `ChatUiContext.Provider` draws no element), so the chat's `div[data-chat-thread]` (`flex h-full min-h-0 min-w-0 flex-1 flex-col`, `chat-view.tsx:67-70`) is a flex item of that section and fills it. The footer is `absolute inset-x-0 bottom-0`: as wide as the frame, its bottom on the frame's bottom, 8 px above the card's bottom edge.

The main footer is drawn whatever the section shows: the Thread's conversation or the Empty state (`workspace-view.tsx:300-324`, `:327-332`). The thread route is a child of `/` (`bundles/desktop/chat/src/client/index.ts:87-91`), whose only `<core-outlet>` is the one in the conversation card (`workspace-view.tsx:301`; the settings window's outlet is for `/settings`, `bundles/desktop/settings/src/client/views/settings-view.tsx:390`). So the routed `<chat-view>` is inside the frame and inherits `--chat-footer-height`; custom properties inherit through `display: contents` elements, which keep their place in the element tree.

The Empty state (`flex … flex-col items-center justify-center … p-6`, `packages/desktop/src/components/empty.tsx:9`) now centres on the frame's full height instead of the height above the footer: its centre moves 14 px down, and its 24 px bottom padding no longer keeps its content clear of the 36 px band: the content, of height `c`, centred in a section of height `H`, ends at `H/2 + c/2`, above the band's top `H - 36` only while `H ≥ c + 72` ([V-9](#visual-verification)).

The `layout.overlay` layer stays a sibling after the split, `absolute inset-0 z-20` over the card's padding box (`workspace-view.tsx:340`): it stays above the band.

The view's header comment (`workspace-view.tsx:1-5`) becomes:

```ts
// `<layout-workspace>` (stage 9 §5.4): the old renderer's `views/app.tsx`
// with the same hooks and props. The conversation is the child route in the
// inner `<core-outlet>`; the content footer is the `layout.footer` region,
// which `ConversationFrame` floats over the conversation's bottom; the
// header's actions are the `layout.header` region. The `layout.overlay`
// region is the floating layer over the conversation area.
```

### 2. The viewer footer

`chat-view.tsx:67-85` becomes:

```tsx
<div
  className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
  data-chat-thread={threadId}
  style={withFooter ? FOOTER_HEIGHT : undefined}
>
  <Conversation … />
  {withFooter && (
    <footer className={FOOTER_BAND} data-slot="chat-thread-footer">
      <ThreadComposer thread={thread} />
    </footer>
  )}
</div>
```

`FOOTER_BAND` (the class set of D2) and `FOOTER_HEIGHT` (`{ '--chat-footer-height': '2.25rem' } as CSSProperties`) are module constants in `chat-view.tsx`, side by side, with a comment that the height is the band's `h-9`. The `react` import (`chat-view.tsx:2`, today `import { useMemo } from 'react';`) becomes `import { type CSSProperties, useMemo } from 'react';`. Chat cannot import the layout's constants (the layout package exports only `./contracts` and `./package.json`, `bundles/desktop/layout/package.json:6-14`), so the class set is written in both bundles, as today's identical footer class set is (`workspace-view.tsx:329`, `chat-view.tsx:80`); [T-1](#test-plan) and [T-5](#test-plan) pin each to D2's set. The height does not cross the bundle line: each bundle pins its own band's `h-9` to its own `2.25rem` in one test.

Without `withFooter` (the routed `<chat-view>`), the div sets no `style`, so it inherits the frame's `--chat-footer-height`, and only gains `relative`, which positions nothing else: no descendant of the conversation relies on an ancestor beyond the trail column (`relative`, `thread-nav-rail.tsx:221`) and the scroll root (`relative`, `scroll-area.tsx:21`).

In the viewer card, `div[data-chat-thread]` fills the card's content box: the card (`INSET_CARD` with `flex-1 mb-2`, `workspace-layout.tsx:137-147`) holds the tabs' `flex h-full min-h-0 flex-col` root (`bundles/desktop/layout/src/client/components/organisms/workspace-tabs.tsx:147`), its `TabsContent` (`:156-161`) and the `min-h-0 flex-1` host the tab's element mounts in (`:226`); between that host and the div stand only `display: contents` boxes, `<chat-thread-panel>` (`react-element.ts:75`) and `IntentDispatcher`'s `div.contents` (`intent-dispatcher.tsx:55`). The footer's box is therefore the viewer card's content box's bottom 36 px, 8 px inside the card's left, right and bottom edges, as in the conversation card. The viewer card is not inside the conversation frame, so the viewer's conversation reads chat's own value.

### 3. The band

Both footers carry this class set, in this order:

```text
absolute inset-x-0 bottom-0 flex h-9 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal
```

- `h-9 pt-2`: 36 px in all, the row's 28 px content box under 8 px of padding (U2). `items-center` centres the items in the 28 px content box, so a 24 px button's top is 10 px below the band's top.
- `justify-end gap-1 pl-2 text-[11px] font-normal`: the row's classes, unchanged (U2). The footer weight rule still applies to the band and its items.
- `absolute inset-x-0 bottom-0`: floating over the bottom of the positioned parent (the conversation frame, or `div[data-chat-thread]`).
- No `z-index` ([§6](#6-stacking)); `workspace-overlay`'s `z-20` stays above the band.
- Dropped from today's set: `h-7` (the row height is now the content box of `h-9 pt-2`) and `shrink-0` (no effect on an absolutely positioned box).

The fill and the blur are rules in each owning bundle's sheet, unlayered:

- Layout's sheet (`bundles/desktop/layout/src/client/styles.css`, appended):

  ```css
  /* The conversation footer floats over the conversation (conversation-footer
     spec, D2): the card's background at 70 % with a 2 px backdrop blur, so the
     transcript shows through it. A rule, not utilities, because this sheet
     ships with the layout bundle whatever app runs it; the band's geometry
     classes are in every app's sheet already. */
  [data-slot='workspace-footer'] {
    background-color: color-mix(in oklab, var(--background) 70%, transparent);
    backdrop-filter: blur(2px);
  }
  ```

- Chat's sheet (`bundles/desktop/chat/src/client/styles.css`, unlayered, after the rules of [§4](#4-the-bar-and-the-scroll-padding)): the same rule keyed on `[data-slot='chat-thread-footer']`, with a comment naming the viewer footer.

The reasons differ by bundle. The layout's sheet emits no utilities (`bundles/desktop/layout/src/client/styles.css:7-9`), so a fill utility in the layout would depend on the renderer sheet of the app that runs it ([SR5](#risks)); the rule ships with the layout. Chat's sheet compiles chat's own utilities (`bundles/desktop/chat/src/client/styles.css:15-17`), so `bg-background/70 backdrop-blur-[2px]` would ship with chat as well; chat uses the rule for symmetry: both bands keep D2's one class set, both get their look from the same declarations, and [T-3](#test-plan) and [T-7](#test-plan) assert the same two declarations, so a change to the look is the same edit in each sheet.

`--background` is the platform's root token (`packages/desktop/src/styles/tokens.css:5`, dark `:100`), the colour `bg-background` paints, so the fill is the card's colour at 70 % in either theme. `color-mix(in oklab, … 70%, transparent)` is the form Tailwind 4 writes for an opacity modifier; Electron 44.4.3 (`package.json:52`) supports it.

No border, no top rule, no colour on the text: the existing assertions of `bundles/desktop/layout/tests/client/shell.test.ts:700-730` and of `bundles/desktop/chat/tests/client/chat-view.test.ts:1159-1177`, `:1208` and `:1210-1215` stay. The one other assertion of the viewer test, `chat-view.test.ts:1209`, compares the band against the test's `FOOTER_BAND` (`:1153-1154`, today's `h-7 shrink-0` set), which [T-5](#test-plan) replaces with D2's set.

Where the classes reach the window. Chat's sheet compiles the utilities of chat's own source (`bundles/desktop/chat/src/client/styles.css:15-17`), so the viewer band's classes ship with chat. The layout's sheet emits no utilities (`bundles/desktop/layout/src/client/styles.css:7-9`); the main band's classes come from the renderer sheet, which scans every bundle's client source when the app is built (`app/desktop/doric-renderer/src/styles.css:15-19`). Every class of the band's set is written in the sources the renderer sheet scans at `5e636166`: today's footer set, `absolute` and `inset-x-0` (`thread-nav-rail.tsx:224`), `bottom-0` (`packages/desktop/src/components/select.tsx:180`), `h-9` (`bundles/features/git/src/client/diff/diff-toolbar.tsx:34`) and `pt-2` (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:118`). So an app built before this change has rules for all of them ([SR5](#risks)). The fill and the blur are written by no client source as utilities (`bg-background/70` and `backdrop-blur-[2px]` appear nowhere at `5e636166`), which is why the layout's fill and blur are a sheet rule; `--chat-footer-height` is an inline style for the same reason.

### 4. The bar and the scroll padding

Chat's sheet, unlayered, after the `.conversation-scroll` rule (`bundles/desktop/chat/src/client/styles.css:257-263`):

```css
/* `--chat-footer-height` is the height of a footer floating over the bottom of
   the conversation: the footer's owner sets it to 2.25rem on the footer's
   positioned parent (`<chat-thread-panel>`'s own footer, and from layout 3.0.3
   the layout's conversation footer); unset, it is 0. The
   vertical bar ends where that footer begins (only its height changes, so it
   keeps its right edge), and a block the browser scrolls into view stops above
   it. */
.conversation-scroll
  > [data-slot='scroll-area-scrollbar'][data-orientation='vertical'] {
  height: calc(100% - var(--chat-footer-height, 0px));
}

.conversation-scroll > [data-slot='scroll-area-viewport'] {
  scroll-padding-bottom: var(--chat-footer-height, 0px);
}
```

Why it works:

- The bar's containing block is the scroll root (`relative`, `scroll-area.tsx:21`), whose height is the whole conversation's: the band floats, so the trail root and the scroll area fill the frame or `div[data-chat-thread]` (D8).
- Base UI sets `top: 0` and `bottom` inline (`ScrollAreaScrollbar.mjs:179-181`). With `top`, `height` and `bottom` all set on an absolutely positioned box, CSS ignores `bottom`, so the bar runs from the root's top for `100% - 2.25rem` and ends 36 px above the root's bottom (U3). Today's `data-vertical:h-full` already sets `height: 100%` against the same inline `bottom`, so with the property unset the rule computes today's height.
- The rule is unlayered, so it wins over the layered utility `data-vertical:h-full` (`scroll-area.tsx:48`) whatever their specificity; chat's sheet declares the layer order (`styles.css:13`).
- Base UI sizes and moves the thumb from the bar's own `offsetHeight` (`ScrollAreaViewport.mjs:163`, `:173`), so a shorter bar keeps a correct thumb, track click and drag.
- The selector keys on the platform's own attributes, `data-slot="scroll-area-scrollbar"` and `data-orientation` (`scroll-area.tsx:44-46`), and on the bar being the root's child (`:30`).
- Horizontal geometry does not change: the rule sets only `height`; Base UI keeps `inset-inline-end: 0` (`ScrollAreaScrollbar.mjs:182`), and this spec adds no padding or margin between the card and the scroll root, so the bar keeps its right edge 8 px inside the card (U3).
- U1's end of scroll: the transcript column's `pb-80` (`index.tsx:532`) leaves 320 px under the last block at the end of the scroll, more than the band's 36 px.

The scroll padding. CSS Scroll Snap 1 defines `scroll-padding` on every scroll container, not only snap containers, as the "optimal viewing region of a scrollport: the region used as the target region for placing things in view of the user", to "exclude regions of the scrollport that are obscured by other content (such as fixed-positioned toolbars or sidebars)" (<https://drafts.csswg.org/css-scroll-snap-1/#scroll-padding>, read 2026-11-15). The browser uses that region when it scrolls an element into view: `scrollIntoView({ block: 'nearest' })` for a queued prompt row (`bundles/desktop/chat/src/client/components/organisms/thread-queue.tsx:90`), `block: 'center'` for a comment reveal (`bundles/desktop/chat/src/client/utility/comment-thread.ts:28-31`, `bundles/desktop/chat/src/client/hooks/use-go-to-comment.ts:59`), `block: 'center'` for a papercraft surface's container when `showThread` opens one of its comment threads, inside a fence (`bundles/features/papercraft/src/client/surface/comment-flow.ts:275`, `:291-294`), and focus scrolling. [T-8](#test-plan) and [T-10](#test-plan) check that each real viewport's `scroll-padding-bottom` computes to 36 px; [V-10](#visual-verification) checks once, in the app, where a queued row, a comment reveal and a papercraft surface stop. The padding does not change the scroll range. Lexical's own caret scrolling does not use it ([SR3](#risks)).

Where no footer sets the property, the bar is full height and the scroll padding is 0: the trail story (`bundles/desktop/chat/stories/components/molecules/thread-nav-rail.stories.tsx:81`), a composition that routes `<chat-view>` without the layout (`docs/architecture/bundles/ui-composition.md:13`), and chat 1.6.2 on layout 3.0.2, whose footer is in flow.

The property is part of `<chat-view>`'s styling surface, as `docs/architecture/bundles/ui-composition.md:59` lists custom properties among what a component exposes; chat's README documents it and the layout's README says the frame sets it ([Docs to update](#docs-to-update)). It is not a contract ID and takes no `requires` entry ([Contracts and versions](#contracts-and-versions)).

### 5. The pointer over the band

The band adds no pointer rule (D4) and is painted over the conversation ([§6](#6-stacking)), so it now covers the transcript and the trail handles under its 36 px: they take no pointer until they are scrolled above the band. [V-5](#visual-verification) checks the band's items and its empty part; [SR9](#risks) covers the handles.

### 6. Stacking

Chat's sheet adds `isolation: isolate` to the existing `.conversation-scroll` rule (`styles.css:260-263`), so the scroll root, already positioned (`relative`, `scroll-area.tsx:21`), is a stacking context: every z-indexed layer inside the transcript paints inside it, at the scroll root's own level. Papercraft's surfaces are such layers, and they take the pointer: the pin layer's `pointer-events-auto absolute z-20` (`bundles/features/papercraft/src/client/surface/pins-layer.tsx:157`), its comment input at `z-30` (`:230`) and the node footer at `z-30` (`bundles/features/papercraft/src/client/surface/node-footer.tsx:67`). The band is positioned, has `z-index: auto` and comes after the scroll root and the trail column in tree order (it is the last child of the frame or of `div[data-chat-thread]`), so it paints over both and takes the pointer over them. The trail column's handles are positioned with no z-index (`thread-nav-rail.tsx:221-224`). Nothing else in the conversation's tree sets a `z-index` outside the scroll area (`index.tsx`, `thread-nav-rail.tsx` and `chat-view.tsx` write no `z-` class).

That is the one mechanism. A `z-index` on the band would add nothing with chat 1.6.2. Without the isolation (chat 1.6.1) no band `z-index` works: a `z-10` loses to the `z-20` and `z-30` layers, and a `z-index` above 30 puts the band over `workspace-overlay`'s `z-20` (`workspace-view.tsx:340`), which must stay above it. This is why chat ships first ([Contracts and versions](#contracts-and-versions)).

`backdrop-filter` makes the band the containing block of its `position: fixed` descendants. The footer items' overlays (tooltips, popovers, selects) portal out of the band, to the document body unless a `PortalContainerProvider` names a container (`packages/desktop/src/portal-container.tsx`; `popover.tsx:26-28`, `tooltip.tsx:39-41`, `select.tsx:71`), and none of the footer items sets one.

## Flows

1. A wheel over the main band's empty part, mid-conversation. The hit test finds the band; nothing scrolls ([§5](#5-the-pointer-over-the-band)).
2. A click on Send in either band. The button takes it as today.
3. The reader scrolls to the end. The last block stands 320 px above the viewport's bottom (`pb-80`), clear of the band.
4. A queued prompt row takes focus near the viewport's bottom (`thread-queue.tsx:90`). `scrollIntoView({ block: 'nearest' })` honours the viewport's 36 px scroll padding, so the row stops above the band ([§4](#4-the-bar-and-the-scroll-padding)).
5. The reader drags the bar. The bar ends at the band's top; the drag and a track click map over the bar's shorter height (Base UI measures the bar, [§4](#4-the-bar-and-the-scroll-padding)).

## Contracts and versions

| Contract or bundle | Phase | Before | After | Why                                                                                                                                            |
| ------------------ | ----- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` bundle      | 1     | 1.6.1  | 1.6.2 | Markup, sheet rules and the documented `--chat-footer-height` input; no contract change (`docs/architecture/bundles/versioning.md:57`, patch). |
| `layout` bundle    | 2     | 3.0.2  | 3.0.3 | Markup, an inline custom property and a sheet rule; no contract change (`versioning.md:57`, patch).                                            |
| `PLATFORM_VERSION` | —     | 1.6.0  | 1.6.0 | Nothing is added to the platform (`versioning.md:31`); no `engines.doric` changes.                                                             |

Versions bump from the manifests at `5e636166`; a phase that lands later bumps its bundle from the version at the commit it lands on, by patch.

The regions (`regions/v1`), `layout.footer`, `layout.overlay`, `layout.main.bottom` and `layout.workspace/v1` keep their names and contracts; `layout.footer` items now draw on the floating band.

Release order (the user's decision). Bundles come from the host and ship apart from the app (`versioning.md:33`), so layout and chat can meet at different versions. Chat 1.6.2 lands and ships before layout 3.0.3: phase 1's commit comes before phase 2's ([Phases](#phases)), and no bundle set ships layout 3.0.3 or later with chat older than 1.6.2. No manifest field can state this, since layout requires no chat contract; the rule is the phases' order and the release that follows it.

Delivery (the user's decision). Both phases land on the current branch, `feat/sidebar-alignment`, as two commits: phase 1's commit (chat 1.6.2, and the e2e test [T-10](#test-plan)) first, then phase 2's (layout 3.0.3, and [T-8](#test-plan)). Chat 1.6.2 is also the first chat version that ships the branch's two earlier chat commits, `0421586d` (the trail's own column and prompt-only handles) and `5e636166` (the trail moved to the conversation's left), which changed chat's client source (`thread-nav-rail.tsx`, `conversation/index.tsx`, `thread-nav.ts`, `use-thread-nav.ts`, `styles.css`) and left `bundles/desktop/chat/manifest.json` at 1.6.1. The feature doc's Evolution entry for phase 1 names them beside this change ([Docs to update](#docs-to-update)).

Rollback. Phase 2 is reverted alone, or phases 2 and 1 together; phase 1 is never reverted while phase 2 is in, since that ships layout 3.0.3 or later with a chat that lacks the isolation, the excluded mix. Reverting phase 2 alone leaves chat 1.6.2 on the layout's in-flow footer, the allowed mix. A revert that ships is a new commit that restores the code and bumps the bundle by patch from its current version (layout 3.0.4; chat 1.6.3 if chat is reverted too, in the same commit as or after the layout's), so no shipped version number is reused.

Mixed versions:

- Chat 1.6.2 with layout 3.0.2 (allowed; the state between the phases): the viewer band floats; the main footer stays in flow and sets no property, so the main bar runs its full height and ends at the footer's top, as today.
- Layout 3.0.3 with chat 1.6.1 (excluded by the release order). The old chat does not isolate its scroll root, so a papercraft layer scrolled under the main band (`pins-layer.tsx:157`, `:230`, `node-footer.tsx:67`) paints over the band and takes the clicks meant for Send, the execution picker and the usage summary; the old chat's bar runs its full height, its bottom 36 px behind the band's fill. No layout-side CSS fixes it ([§6](#6-stacking)).
- An app built before this change: [SR5](#risks).

## Persisted data

None.

## Alternatives considered

- **The preview's other variants.** `clear` (no fill), `glass` (8 px blur), `glass-4`, `glass-1` and `fade` (a gradient). The user chose `glass-2` (U1).
- **A pointer-transparent band** (version 2: `pointer-events: none` on the band, `auto` on its children), so a wheel, a swipe or a click on the band's empty part reaches the conversation. Rejected by the user's decision: the band takes the pointer as today's footer does.
- **Chat's rules hard-code the band's 2.25rem** (version 1). Rejected: chat's sheet would encode the layout's `h-9 pt-2`, an implicit dependency on another bundle's markup with no test across the two, and it assumes a band over every conversation, which shortens the bar where none floats (the trail story, a composition without the layout, chat 1.6.2 on layout 3.0.2). The custom property (D5) costs one named input, documented in both READMEs, and gives a full-height bar where no band floats.
- **Signalling only the footer's presence** (an attribute such as `data-conversation-footer` on an ancestor) and keeping 2.25rem in chat. Rejected: it fixes the cases without a band but leaves the layout's height in chat's sheet.
- **The fill and the blur as utilities** (`bg-background/70 backdrop-blur-[2px]`, version 2). Rejected: no client source writes them at `5e636166`, so the sheet of an app built before this change has no rule for them and the main band would draw transparent; the main band's look would depend on whichever bundle sheets were rebuilt. A rule in the owner's sheet ships with the bundle. In chat the utilities would ship with chat's own sheet; chat uses the same rule for symmetry ([§3](#3-the-band)).
- **The main footer as a child of the card**, `absolute inset-x-2 bottom-2`, with no frame (the card is positioned, `sidebar.tsx:329`). Rejected, with or without the bottom split: its insets would repeat `INSET_CARD`'s `p-2` in a second place, so a change to the card's padding would have to be made twice; and the two bands' class sets would differ (the viewer's parent has no padding, so it keeps `inset-x-0 bottom-0`), where D2 keeps one. While the split exists it is also wrong: the band would float over the card's bottom, which is the split's panel while the split shows, and `--chat-footer-height` set on the card would reach the split's content. U5 removes only the last two reasons ([§1](#1-the-conversation-frame)). The frame costs one `div` and one template.
- **Rendering the main footer inside the conversation's tree.** Rejected: the main footer is the layout's `layout.footer` region, with items from settings, usage and chat, drawn with or without a Thread (`bundles/desktop/chat/src/client/index.ts:93-96`; `workspace-view.tsx:300-332`); the Empty state has no chat tree to hold it.
- **A `ScrollArea` prop for a bottom inset.** Rejected: it is a platform addition (a `PLATFORM_VERSION` minor, `versioning.md:31`), and chat would need a guarded dynamic import or a raised `engines.doric` to use it on older apps; two rules in chat's sheet do the same.
- **Bottom padding on the bar instead of a shorter height.** Base UI counts the bar's padding (`ScrollAreaViewport.mjs:157`, `:173`), so the thumb would be right and the band would cover the padded part. Rejected: the rule would have to restate the platform's `p-px` (`scroll-area.tsx:48`) as `calc(1px + var(--chat-footer-height, 0px))`, coupling chat's sheet to the platform's padding; the height rule overrides only the height the platform already sets.
- **The band's height as a utility reading the property** (`h-(--chat-footer-height)`), so each bundle states the length once. Rejected: no sheet built before this change has that utility, and the band would lose its height; `h-9` is in every sheet.
- **A z-index on the band** in place of, or beside, the isolation. Rejected in [§6](#6-stacking).
- **A sticky footer inside the scroll viewport.** Rejected: the main footer is the layout's, outside chat's viewport.

## Risks

- **SR1 — A wheel over the band does not scroll.** The band takes the pointer (D4), so a wheel or a swipe over any of its 36 px scrolls nothing, as over today's 28 px footer; the band covers 8 px more of the conversation than today's footer took. The user chose this ([SQ1](#questions)). Mitigation: none; [V-5](#visual-verification) checks it.
- **SR3 — Lexical's caret scrolling ignores the scroll padding.** Lexical scrolls the caret into view against each scroller's bounding box and reads scroll padding only on the document element (`node_modules/lexical/src/LexicalUtils.ts:1701-1724`). The prompt is the last block of the transcript, so a reader who scrolled up and types in it makes Lexical scroll the caret into view from below, and the caret can stop inside the band, behind the 70 % fill. At the end of the scroll the prompt stands 320 px clear (`pb-80`). Mitigation: none in this change; the user accepted it as a known limitation and a follow-up is planned ([SQ3](#questions)); [V-6](#visual-verification) records where the caret stops.
- **SR4 — Mixed layout and chat versions.** Chat 1.6.2 with layout 3.0.2 keeps today's main bar. Layout 3.0.3 with chat 1.6.1 lets papercraft layers paint over the main band and take its clicks ([Contracts and versions](#contracts-and-versions)). Mitigation: the release order (chat first).
- **SR5 — An app built before this change.** Its sheets have every class of the band's set (all written in client sources at `5e636166`, [§3](#3-the-band)); the fill and the blur come from the bundles' own sheets, and the property is an inline style. Residual: none known.
- **SR7 — Fence layers over the band.** Without [§6](#6-stacking)'s isolation, a papercraft layer scrolled under the band paints over it and takes its clicks. Mitigation: `isolation: isolate` on the scroll area (chat 1.6.2) and the release order.
- **SR8 — Blur cost.** A 2 px `backdrop-filter` over a band 36 px tall and as wide as the card's content box re-samples what scrolls under it on every frame. Mitigation: [V-7](#visual-verification) measures the frame rate. If V-7 fails with the blur and passes with `backdrop-filter` unticked, the fallback is to remove the `backdrop-filter` declaration from both sheet rules and keep the 70 % fill; this changes U1, so it goes to the user before it lands.
- **SR9 — The trail column under the band.** The band spans the trail column, as in the preview. The column, like the section, is 28 px taller than today's, since the in-flow `h-7` footer no longer takes its 28 px ([§1](#1-the-conversation-frame)); the band covers the column's bottom 36 px. The trail `nav` is centred on the column's height (`thread-nav-rail.tsx:222-225`): its centre moves 14 px down. Handles in the band's 36 px take no clicks (D4). For a trail `n` px tall in a section `S` px tall (after this change), the trail's bottom is at `S/2 + n/2` and the band's top at `S - 36`, so the lowest handles and "Go to the end" reach the band when `n > S - 72`. Today the trail's bottom reaches the section's bottom edge, `S - 28`, when `n > S - 28`. Against today, `(n - (S - 28))/2 + 22` px of the trail's bottom is out of reach where `(n - (S - 28))/2` px was: 22 px more, about two 10 px handles (`h-2.5`, `thread-nav-rail.tsx:100`). The reading line moves 11.2 px down too (40 % of a viewport 28 px taller, `thread-nav.ts:70-78`, `:96`): a jump puts the prompt's top 11.2 px lower, and the active handle changes 11.2 px later. The visible part of the viewport, above the band, is 8 px shorter than today's, so the reading line sits at 40 % of it plus 14.4 px (0.4 × 36). Mitigation: End and the wheel still reach the end; [V-4](#visual-verification) checks the handles and the jump.
- **SR10 — The property and the band's height drift apart.** `--chat-footer-height` names a length its setter must keep equal to its band's `h-9`, and the layout must keep the name chat reads. Within each bundle, [T-1](#test-plan) and [T-5](#test-plan) assert both values in one test. Across the bundles, a rename or a missing setter leaves the bar running its full height, its bottom 36 px behind the band's fill, and blocks scrolled into view stopping behind the band; [T-8](#test-plan) and [T-10](#test-plan) measure in the app that each bar ends at its band's top and that each viewport's scroll padding is 36 px. Mitigation: the name is documented in chat's README as `<chat-view>`'s input and in the layout's README as what the frame sets.
- **SR11 — The openui diagram cap.** The cap is the window's height less 112 px, against a scroll view the openui spec measured at the window's height less 80 px (`docs/designs/openui-diagrams-square-area.md:154`, `:157`), so a capped diagram scrolled into view has 32 px of comfort margin. The band hides 36 px of the scroll view where today's in-flow footer took 28 px, so the visible part is 8 px shorter and the margin 24 px. No change; [V-8](#visual-verification) checks a capped diagram.

## Phases

Both phases are commits on `feat/sidebar-alignment`, in this order ([Contracts and versions](#contracts-and-versions), "Delivery"). Each leaves the code building and its tests passing.

1. **Chat (phase 1), the first commit.** The viewer band, its fill and blur rule, the property on `div[data-chat-thread]`, the bar and scroll padding rules, the isolation and the chat stories; chat 1.6.2; the e2e test [T-10](#test-plan), which measures the viewer band in the app over layout 3.0.2; phase 1's doc edits ([Docs to update](#docs-to-update)). Correct on layout 3.0.2 ([Contracts and versions](#contracts-and-versions), "Mixed versions"). Passes: `bundle-chat:test`, `bundle-chat:typecheck`, `doric-renderer:test` (it compiles chat's sheet, `app/desktop/doric-renderer/tests/stylesheet.test.ts:99-116`, `:138-159`, `:306-310`), `doric-app-e2e:e2e` (run by hand where the target cannot, as root in this sandbox: `app/desktop/doric-e2e/project.json:31` starts `electron` without `--no-sandbox`; follow the procedure of `docs/designs/ui-redesign.md:933`, merging `app/desktop/doric/dist-tests` into `app/desktop/doric-e2e/dist-tests/doric` with `fs.cpSync(…, { recursive: true })`, not `cp -r`).
2. **Layout (phase 2), the second commit, on top of the first.** `ConversationFrame`, the band, its fill and blur rule, the property, the story shell and the stories that use it, the settings and usage story footers; layout 3.0.3; the e2e test [T-8](#test-plan); phase 2's doc edits. Passes: `bundle-layout:test`, `bundle-layout:typecheck`, `doric-renderer:test` (it compiles the layout's sheet), `doric-app-e2e:e2e` (by hand where the target cannot run, as in phase 1), and the settings and usage typechecks, which cover their stories.

## Files to change

Phase 1, chat (`bundles/desktop/chat`):

- `src/client/views/chat-view.tsx`: `:2` imports `type CSSProperties` beside `useMemo`; `:67-85` as [§2](#2-the-viewer-footer), with `FOOTER_BAND` and `FOOTER_HEIGHT`.
- `src/client/styles.css`: `isolation: isolate` in `.conversation-scroll` (`:260-263`); the bar and viewport rules and the viewer band's fill and blur rule after it ([§4](#4-the-bar-and-the-scroll-padding), [§3](#3-the-band)).
- `stories/support/inset-card.tsx`: the header comment's last four lines (`:4-7`) become (phase 2 replaces its last sentence with "The conversation card's footer is the same band, floating, from layout 3.0.3."):

  ```ts
  // the layout draws the conversation and the viewer. The footer band is the
  // viewer footer's (`chat-view.tsx`; Figma `32:51299`): 36 px tall, 8 px above
  // its 28 px row, 8 px from the left, 4 px between items, no rule; drawn in flow
  // here, since these stories have no conversation to float over. The
  // conversation card's footer is still a 28 px row in flow in the app.
  ```

  `FooterBand`'s class (`:39`) becomes `flex h-9 shrink-0 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal`. It keeps `shrink-0`: the band stays in flow, a flex item of the card's `flex min-h-0 flex-col` (`:21`). Its stories have no conversation to float over (`stories/views/chat-composer.stories.tsx:18-23`, `stories/components/organisms/composer-controls.stories.tsx:28-32`, `stories/components/organisms/agent-thread-controls.stories.tsx:22-26`, `stories/elements/chat-elements.stories.tsx:115-122`). Where a story passes `data-slot="chat-thread-footer"` (`composer-controls.stories.tsx:29`), the band's fill rule paints it, over the card's own colour. The `ChatView withFooter` stories (`stories/views/chat-view.stories.tsx:49`, `:61`, `:105`, `:117`) draw the floating band through `ChatView` and do not change.

- `tests/client/chat-view.test.ts`: [T-5](#test-plan), [T-6](#test-plan).
- `tests/client/conversation-styles.test.ts`: [T-7](#test-plan), with the `unlayered` helper it defines.
- `README.md:18-27`: phase 1's text ([Docs to update](#docs-to-update)).
- `AGENTS.md` (Styling): the sheet also holds the unlayered rules a floating footer needs: the conversation's bar and scroll padding, read from `--chat-footer-height`, and the viewer footer's fill and blur.
- `src/client/styles.css`'s header comment: names those unlayered rules beside the layered ones.
- `manifest.json:4`: 1.6.2.

Phase 1, e2e (`app/desktop/doric-e2e`):

- `tests/shell.test.ts`: [T-10](#test-plan); the import from `./support/workspace-host` (`:51`) adds `PAYMENT_FORM`, and the import from `./support/prototype-states` (`:35`) adds `closeViewer` and `SIDEBAR_ROWS`.
- `tests/support/prototype-states.ts`: `export` on `SIDEBAR_ROWS` (`:68`) and on `closeViewer` (`:166`); nothing else changes. `tests/support/shell-page.ts` does not change.

Phase 1, docs: `docs/features/ui-redesign.md`, phase 1's edits ([Docs to update](#docs-to-update)).

Phase 2, layout (`bundles/desktop/layout`):

- `src/client/components/templates/conversation-frame.tsx` (new): `ConversationFrame`, `CONVERSATION_FOOTER` and `FOOTER_HEIGHT` ([§1](#1-the-conversation-frame)).
- `src/client/views/workspace-view.tsx`: the header comment (`:1-5`) and `:296-332` as [§1](#1-the-conversation-frame); `import { ConversationFrame } from '../components/templates/conversation-frame.js';` beside the `ConversationTerminals` import. The overlay's comment and `div` (`:333-343`) do not change.
- `src/client/styles.css`: the band's fill and blur rule, appended ([§3](#3-the-band)); the header comment's first sentence (`:2-3`) becomes "The layout bundle's own rules (design §9.4): the Monaco and xterm scrollbar sliders, moved from the renderer's sheet and unlayered as before, and the conversation footer's fill and blur (conversation-footer spec, D2)."; the rest of the comment stays.
- `stories/support/shell.tsx`: `ContentFooter` (`:46-56`, used only at `:157`) is replaced by `ContentFrame` below, and `WorkspaceShell` (`:155-158`) draws `<SidebarInset className={INSET_CARD}>{children}</SidebarInset>`, with no footer of its own. The shell imports `ConversationFrame` from `../../src/client/components/templates/conversation-frame.js`.

  ```tsx
  /**
   * The conversation frame with the `layout.footer` region floating over its
   * bottom, as the workspace view draws it inside the split's top panel.
   */
  export function ContentFrame({ children }: { readonly children: ReactNode }) {
    return (
      <ConversationFrame footer={region('layout.footer')}>
        {children}
      </ConversationFrame>
    );
  }
  ```

- The three story files that pass `<ConversationTerminals>` to `WorkspaceShell` wrap each `ThreadPane` in `ContentFrame` inside `ConversationTerminals`, so every story nests split → frame → pane as `workspace-view.tsx` does. In `WithTerminals` the band then floats over the conversation in the split's top panel, not over the terminal panel, and `--chat-footer-height` does not reach the split's content. Each file imports `ContentFrame` from `../../support/shell.js`:
  - `stories/components/templates/workspace-layout.stories.tsx:12-19`: `Conversation()` returns `<ConversationTerminals><ContentFrame><ThreadPane>…</ThreadPane></ContentFrame></ConversationTerminals>`; `Workspace` and `NoOpenTabs` (`:39-41`, `:50-52`) draw it.
  - `stories/components/templates/conversation-terminals.stories.tsx:9-13`: the `conversation` constant becomes `<ContentFrame><ThreadPane>…</ThreadPane></ContentFrame>`, which `WithTerminals` (`:26-28`) and `ConversationOnly` (`:39`) pass as `ConversationTerminals`' children.
  - `stories/components/templates/thread-pane.stories.tsx:30-37` (`Conversation`) and `:48-62` (`NoThread`): `<ConversationTerminals><ContentFrame><ThreadPane>…</ThreadPane></ContentFrame></ConversationTerminals>`.
- `tests/client/shell.test.ts`: [T-1](#test-plan), [T-2](#test-plan).
- `tests/client/footer-styles.test.ts` (new): [T-3](#test-plan).
- `tests/tabs-menus.test.ts:214-219`: [T-4](#test-plan).
- `manifest.json:4`: 3.0.3.
- `README.md:53-55`, `:107`: [Docs to update](#docs-to-update).
- `AGENTS.md:44-46` (Boundaries) becomes: "`src/client/styles.css` holds only the Monaco and xterm slider rules and the conversation footer's fill and blur (one rule keyed on `[data-slot='workspace-footer']`); the utilities this bundle uses are emitted by the shell's sorted sheet, so do not add Tailwind directives here (WP6 decision on the cascade)."

Phase 2, the other bundles' story footers. Both draw the main footer's row for the `layout.footer` items' own stories and describe it as the 28 px band of `workspace-view.tsx`; both stay in flow and keep `shrink-0`:

- `bundles/desktop/settings/stories/support/frames.tsx`: the doc comment (`:12-16`) becomes "The conversation footer band at the end of the conversation's card, with room above it for the pickers' popovers: 36 px tall, 8 px above its 28 px row, drawn in flow, no rule and no fill of its own (`conversation-frame.tsx`)."; the footer's class (`:20`) becomes `flex h-9 shrink-0 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal text-muted-foreground` (its `text-muted-foreground` stays; it is not this change's).
- `bundles/features/usage/stories/support/footer.tsx`: the header comment (`:1-4`) becomes "The conversation's footer band, where `<usage-summary>` sits in the `layout.footer` region: a borderless 36 px band, 8 px above its 28 px row, at the bottom of the conversation's inset card over the window's sidebar-coloured canvas, drawn in flow, with room above it for the popovers that open upward."; the footer's class (`:11`) becomes `flex h-9 shrink-0 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal`.

Neither bundle's version changes: stories are not part of a built bundle (the built, git-ignored `dist/` of usage holds `client`, `contracts`, `host` and `schemas`, and that of settings `client`, `contracts.json`, `manifest.json`, `package.json` and `schemas`); each bundle's typecheck includes them (`bundles/features/usage/tsconfig.client.json:18-19`, `bundles/desktop/settings/tsconfig.json:17-18`).

Phase 2, e2e (`app/desktop/doric-e2e`):

- `tests/shell.test.ts`: [T-8](#test-plan).

Phase 2, docs: `GROUNDING.md`, `docs/features/ui-redesign.md` and `bundles/desktop/chat/README.md`, phase 2's edits ([Docs to update](#docs-to-update)).

## Test plan

Tests run with `npx nx run bundle-chat:test`, `bundle-layout:test` and `doric-app-e2e:e2e` (`app/desktop/doric-e2e/project.json`). happy-dom, the DOM the unit tests run in, computes no layout, so the unit tests pin markup and stylesheet text, as `bundles/desktop/chat/tests/client/conversation-styles.test.ts:9-11` already does; the e2e tests check in the app, for each band, that the bar ends at the band and that the viewport's scroll padding computes to the band's height (T-10 for the viewer band in phase 1, T-8 for the main band in phase 2); [Visual verification](#visual-verification) checks paint, lengths and interactions. The tests assert what this spec adds or relies on, not the full class sets of the elements around it.

- **T-1** (`layout/tests/client/shell.test.ts`, extending the test at `:699-730`, at a Project path as now): the `workspace-footer` element's class set equals the band set of D2; its parent is `[data-slot="conversation-frame"]`, whose classes include `relative`, whose `style.getPropertyValue('--chat-footer-height')` is `2.25rem` (the band's `h-9`), and which contains `section[aria-label="Thread conversation"]` before the footer, the footer being its last element child. The existing assertions (`font-normal`, no `font-light`, no `text-muted-foreground`, no `border-t`, the `layout.footer` probe inside the footer) stay.
- **T-2** (`shell.test.ts`, new): at a path `/projects/<id>/threads/<id>` of a Thread the fixture describes, the `core-outlet` is inside `[data-slot="conversation-frame"]`, so the routed conversation inherits the property.
- **T-3** (`layout/tests/client/footer-styles.test.ts`, new, reading `src/client/styles.css` as `conversation-styles.test.ts:19-20` does): the sheet, with its comments removed, contains no `@layer`, so every rule in it is unlayered (the layout's sheet has no layer today, `bundles/desktop/layout/src/client/styles.css`); and it has a rule `[data-slot='workspace-footer']` whose declarations are exactly `background-color: color-mix(in oklab, var(--background) 70%, transparent)` and `backdrop-filter: blur(2px)`. The file defines its own `uncommented`, `rulesIn` and `declared` helpers, copies of `conversation-styles.test.ts:88-89` and `:134-150` with the `declarations` parser they use (`:62-75`); the two bundles share no test helper module, and the layout's test does not import from chat's tests.
- **T-4** (`layout/tests/tabs-menus.test.ts:214-219`): the manifest test's version is 3.0.3 (title and `assert.equal`).
- **T-5** (`chat/tests/client/chat-view.test.ts`, the test's `FOOTER_BAND` at `:1152-1154` and the test at `:1179-1216`): the test's `FOOTER_BAND` is the band set of D2; the viewer band's class set equals it; its parent is `div[data-chat-thread]`, whose classes include `relative` and whose `style.getPropertyValue('--chat-footer-height')` is `2.25rem` (the band's `h-9`); the band is that div's last element child and follows the element that contains `.conversation-scroll`. The Send button and no separator stay asserted. A new case renders `ChatView` without `withFooter` and asserts `div[data-chat-thread]` has no `--chat-footer-height` of its own. The test reads the property through a helper, `ownFooterHeight`, that tries `style.getPropertyValue` first and falls back to the `style` attribute's text: happy-dom does not always expose a custom property React sets in an inline `style` object through `getPropertyValue`, though it writes it to the attribute.
- **T-6** (`chat-view.test.ts`, the test at `:1218-1232`): `pb-80` joins the list of classes the transcript column must have (`:1229`).
- **T-7** (`chat/tests/client/conversation-styles.test.ts`, new tests). The file gains a helper, `unlayered(sheet)`: the sheet with its comments removed (`uncommented`, `:88-89`) and every `@layer … { … }` block cut out, its braces matched the way `narrowBlock` (`:119-132`) matches them; chat's sheet has one such block, `@layer base` (`styles.css:26-148`). The assertions read `declared(unlayered(sheet), selector)` (`:145-150`), so a rule moved into a layer fails them: the rule `.conversation-scroll > [data-slot='scroll-area-scrollbar'][data-orientation='vertical']` has exactly one declaration, `height: calc(100% - var(--chat-footer-height, 0px))` (so it moves no edge but the bottom); the rule `.conversation-scroll > [data-slot='scroll-area-viewport']` declares `scroll-padding-bottom: var(--chat-footer-height, 0px)`; the `.conversation-scroll` rule declares `isolation: isolate` beside `container-type: inline-size` and `font-weight: 300`; and the rule `[data-slot='chat-thread-footer']` has exactly the two declarations of T-3.
- **T-8** (`app/desktop/doric-e2e/tests/shell.test.ts`, new, phase 2). It runs inside `describe('the real shell over the workspace bundles')` (`:80`), whose `before` hook (`:101`) boots the workspace window as `window` and its page as `contents`. It goes right after [T-10](#test-plan), which goes after the Files column test (`:325-368`) and before `const dir` (`:370`), so both run before the capture test (`:372-418`), which sets the content size to 1920×1080 (`:375`) and does not restore it. The Files column test's drag (`:360-361`) narrows the Files column only; T-8 and T-10 measure inside the conversation and viewer cards, whose widths do not enter their assertions. It uses the suite's helpers: `go` navigates the page, `THREAD_PATH` is the path of the fixture's open Thread (`tests/support/workspace-host.ts:332`), `inPage(contents, body)` evaluates an expression in the page (`tests/support/shell-page.ts:37-38`) and `until` polls a condition (`tests/support/harness.ts`, imported at `shell.test.ts:33`). The selectors are `V` = `section[aria-label="Thread conversation"] .conversation-scroll > [data-slot="scroll-area-viewport"]`, `B` = `section[aria-label="Thread conversation"] .conversation-scroll > [data-slot="scroll-area-scrollbar"][data-orientation="vertical"]` and `F` = `[data-slot="workspace-footer"]`. Steps:
  1. Read the content size with `window.getContentSize()`; `go(contents, THREAD_PATH)`; set the content size to 1280×640, the workspace window's minimum height (`bundles/foundation/core/src/desktop/appearance.ts:5`; a smaller size is clamped and the wait times out) (`window.setContentSize`, waited for with `until` as `:375-380` does) so the transcript overflows. A `finally` sets the content size back to the size read first and waits for it with `until` the same way.
  2. Precondition, in one `until` (`tests/support/harness.ts:306`, its default 20 s): `V` exists, its `scrollHeight` exceeds its `clientHeight`, and `B` exists (Base UI renders the bar only once it has measured an overflow, [Terms](#terms)).
  3. The bar meets the band: `B`'s `getBoundingClientRect().bottom` is within 0.5 px of `F`'s `getBoundingClientRect().top`; `getComputedStyle(F)` gives `height` `36px`, a `background-color` other than `rgba(0, 0, 0, 0)` and `backdrop-filter` `blur(2px)`; `getComputedStyle(V).scrollPaddingBottom` is `36px`. This step ties the layout's value and rule to chat's rules.

- **T-10** (`app/desktop/doric-e2e/tests/shell.test.ts`, new, phase 1). The viewer band in the app, in the same `describe` as T-8, right after the Files column test (`:368`). It runs on layout 3.0.2 in phase 1 and on layout 3.0.3 after phase 2; the viewer card is the same in both. The selectors are `V2` = `section[aria-label="Viewer"] .conversation-scroll > [data-slot="scroll-area-viewport"]`, `B2` = `section[aria-label="Viewer"] .conversation-scroll > [data-slot="scroll-area-scrollbar"][data-orientation="vertical"]` and `F2` = `section[aria-label="Viewer"] [data-slot="chat-thread-footer"]`. Steps:
  1. Read the content size with `window.getContentSize()`; `go(contents, THREAD_PATH)`; set the content size to 1920×640, the width at which the capture test shows `99:8508` (`:375`) and the workspace window's minimum height (`appearance.ts:5`; 1920×480 timed out), and wait for it with `until`. Open the child Thread `PAYMENT_FORM` (`tests/support/workspace-host.ts:204`) in the viewer as the capture does (`tests/support/prototype-states.ts:332-335`): `clickOn(contents, SIDEBAR_ROWS, PAYMENT_FORM.name)`, then `waitForSelector(contents, F2)`. A `finally` closes the viewer with `closeViewer(contents)` (`prototype-states.ts:166-178`), sets the content size back to the size read first and waits for it with `until`.
  2. Precondition, in one `until`: `V2` exists, its `scrollHeight` exceeds its `clientHeight`, and `B2` exists. `PAYMENT_FORM` carries the same conversation as the open Thread (`workspace-host.ts:175-180`): a prompt, its reasoning, a tool call and the answer (`workspace-content.ts:162-210`), then the reader's prompt, over the column's 320 px `pb-80`. The viewer's viewport is shorter than the 640 px window by at least the window's tab bar and the viewer's tab header, so the turns need only be taller than 320 px less those two together for the transcript to overflow. Both T-8 and T-10 assert overflow as a precondition, not a result: if a later fixture stops overflowing, the test lengthens the fixture's conversation (the content height cannot go below 640), and its assertions stay.
  3. The bar meets the band: `B2`'s `getBoundingClientRect().bottom` is within 0.5 px of `F2`'s `getBoundingClientRect().top`; `F2.parentElement` matches `[data-chat-thread]`; `getComputedStyle(F2)` gives `position` `absolute`, `height` `36px`, a `background-color` other than `rgba(0, 0, 0, 0)` and `backdrop-filter` `blur(2px)`; `getComputedStyle(V2).scrollPaddingBottom` is `36px`. This step ties chat's value to chat's rules in the app, in phase 1, before the layout changes.

  The existing e2e tests that click footer items with real mouse input (`tests/support/shell-page.ts:78-87`, `:180-191`; the execution picker in `tests/support/prototype-states.ts:306`) keep passing.

- **T-9**: `npx nx run bundle-chat:typecheck` passes in phase 1; `bundle-layout:typecheck`, `bundle-settings:typecheck` and `bundle-usage:typecheck` pass in phase 2. The typechecks cover the changed stories (`bundles/desktop/settings/tsconfig.json:17-18`, `bundles/features/usage/tsconfig.client.json:18-19`).

## Visual verification

In the app, light and dark, at the Figma states `99:8035` (a Thread open) and `99:8508` (a child Thread in the viewer card) as `app/desktop/doric-e2e/tests/support/prototype-states.ts:1-17` sets them up, measured with the developer tools. Each check passes when every condition holds, except V-6, which only records. After phase 1 the checks run on the viewer band only (V-1, V-2, V-3, V-5, V-6 and V-10 in the viewer card); after phase 2 every check runs on both bands.

- **V-1** Both bands: 36 px tall; bottom 8 px above the card's bottom edge; left and right edges 8 px inside the card's; the row's items centred 22 px below the band's top; the 24 px Send button's top 10 px below the band's top.
- **V-2** Both bars: the bottom equals the band's top; the right edge is 8 px inside the card's right edge, as at `5e636166`. The trail story in chat's Storybook shows a full-height bar.
- **V-3** The transcript scrolls on under both bands and shows through the 70 % fill, blurred by 2 px (`backdrop-filter: blur(2px)` computed on each band); at the end of the scroll the last block stands clear of the band.
- **V-4** On a Thread with enough prompts that the trail is taller than the section less 72 px ([SR9](#risks)): the handles above the band take clicks; a handle's jump puts its prompt's top 40 % down the viewport.
- **V-5** In each band: the execution picker opens its menu and changes the selection; the usage summary opens its breakdown; Send sends a prompt; Stop stops a run; "Stop execution" shows and works while a queued edit is open; on an agent child Thread, pause, continue and retry work. A click on the band's empty part changes nothing; a wheel and a two-finger trackpad swipe over the band's empty part and over its items scroll nothing ([SR1](#risks)).
- **V-6** Scrolled up by one screen, typing a character in the prompt: record whether the caret's line ends above the band's top or inside the band, as input for the planned follow-up ([SQ3](#questions), [SR3](#risks)). V-6 has no pass condition: the user accepted the caret stopping inside the band as a known limitation, so either outcome passes. The record goes in this spec's [Revisions](#revisions), under the version that runs V-6, and the follow-up starts from it.
- **V-7** At 1920×1080 on a 60 Hz display, with the Rendering panel's frame rendering stats on, a 5 s two-finger fling through a long transcript holds at least 55 frames per second, in both themes ([SR8](#risks)).
- **V-8** A capped openui diagram scrolled into view with `block: 'nearest'` stands clear of the band ([SR11](#risks)).
- **V-9** With no Thread selected, at a content size of 1280×640 (the window's minimum height): the Empty state's title and "New thread" button stand above the main band's top.
- **V-10** Once, in the app ([§4](#4-the-bar-and-the-scroll-padding), D6): with two queued prompts and the queue's last row near the viewport's bottom, focusing that row (`thread-queue.tsx:89-91`) scrolls it to stand above the band's top, not under it; a comment reveal (`use-go-to-comment.ts:59`) of a note in the lower part of the viewport centres the note in the part above the band; opening a comment thread of a papercraft surface whose container sits in the lower part of the viewport (`comment-flow.ts:291-294`) centres the container in the part above the band.

## Docs to update

Each edit goes in the commit of its phase, so every commit's docs describe the code at that commit.

Phase 1 (chat 1.6.2):

- `docs/features/ui-redesign.md`: the Status line (`:3`) adds "the conversation footer's phase 1, the viewer footer (U1–U4 for a child Thread's footer), implemented" with the date and a link to this spec, and says phase 2 is not yet implemented; the Specs line (`:5`) adds this spec; Current behavior's trail bullet and this change's bullets go under "Later changes add, each credited to its spec:", not under the sidebar alignment's list, and the trail bullet links the ui-redesign spec; the new bullet: "Viewer footer ([conversation footer spec](../designs/conversation-footer.md), phase 1, chat 1.6.2): a child Thread's footer in the viewer card floats over its conversation's bottom 36 px (8 px over the 28 px row), on `--background` at 70 % with a 2 px backdrop blur; the transcript scrolls on under it; the conversation's scrollbar ends where the band begins; the band takes the pointer as the footer did. Chat reads `--chat-footer-height` for the bar and scroll padding (0 when unset). The conversation card's footer is still in flow."; a bullet after it on the accepted limitations (the band scrolls nothing under a wheel over 36 px instead of 28, [SR1](#risks); the caret can stop inside the band, [SR3](#risks), [SQ3](#questions), follow-up planned; V-6's record goes in this spec's Revisions); "Chat 1.6.1" at `:378` becomes "Chat 1.6.2"; an Evolution entry dated on landing that states the behaviour above (the floating viewer band, the bar and scroll padding from `--chat-footer-height`, the isolation, the main footer still in flow, the accepted limitations) and the versions: chat 1.6.2, which also ships the trail's own column and prompt-only handles (`0421586d`) and the trail on the conversation's left (`5e636166`).
- `GROUNDING.md`: after `:125-126` (the footer weight), "A child Thread's footer in the viewer floats over the bottom 36 px of its conversation, 8 px over a 28 px row, on the background at 70 % with a 2 px backdrop blur; the transcript scrolls on under it, the conversation's scrollbar ends 36 px above the bottom and its scroll padding is 36 px. The conversation footer is still in flow."
- `bundles/desktop/chat/AGENTS.md` (Styling): `.conversation-scroll`'s `isolation: isolate` (D7) and that a footer band takes no `z-index`.
- `bundles/desktop/chat/README.md:18-20`: "`<chat-view>` reads `--chat-footer-height`, the height of a footer floating over its conversation's bottom, set by its host on an ancestor; its scrollbar ends and its scroll padding stops that far above the bottom; unset, 0. Its scroll area is isolated (`isolation: isolate`), so a footer that follows it paints over the transcript's layers with no `z-index`. Known limitations: the caret of a prompt being typed can stop under a floating footer (a follow-up is planned), and a wheel over the footer's band does not scroll the conversation;"; `:26-27`: "`<chat-thread-panel>`'s own footer floats over its conversation's bottom 36 px and sets `--chat-footer-height` to that height itself;"

Phase 2 (layout 3.0.3):

- `docs/features/ui-redesign.md`: the Status line's phase 1 clause gains "; its phase 2, the conversation card's footer, implemented" with the date, in place of "is not yet implemented"; the phase 1 bullet becomes "Conversation footers: the conversation card's footer and a child Thread's footer in the viewer card float over …" (the rest as in phase 1, without its last sentence; the limitations bullet names both footers); an Evolution entry dated on landing: "conversation footer, phase 2 ([spec](../designs/conversation-footer.md), U1–U4 for the conversation card's footer, D1–D8): layout 3.0.3, which needs chat 1.6.2 or later; U5, the bottom split's removal, is separate work."
- `GROUNDING.md`: phase 1's sentence (after the footer weight) becomes "The conversation footer and a child Thread's footer in the viewer float over the bottom 36 px of their conversation, 8 px over a 28 px row, on the background at 70 % with a 2 px backdrop blur; the transcript scrolls on under them, the conversation's scrollbar ends 36 px above the bottom and its scroll padding is 36 px." (its last sentence removed); `:428-429`, "The panel's footer carries the hardware monitor and shares the conversation footer's height.", becomes "The panel's footer carries the hardware monitor in a 28 px row, the height of the conversation footer's row." (the Files footer stays `my-2 … h-7`, `workspace-layout.tsx:170-171`, while the conversation footer becomes a 36 px band).
- `bundles/desktop/layout/README.md:53-55` ("Footers"): the conversation footer floats over the conversation's bottom 36 px, its fill and blur are this bundle's sheet rule, and the conversation frame sets `--chat-footer-height: 2.25rem` for `<chat-view>` (chat's README); layout 3.0.3 needs chat 1.6.2 or later in the same bundle set; `:107` (`layout.footer` row, "Where"): "the conversation footer, a 36 px band floating over the conversation's bottom".
- `bundles/desktop/chat/README.md`: phase 1's sentence on `--chat-footer-height` adds "(the layout's conversation frame sets 2.25rem, from layout 3.0.3)" after "on an ancestor". The chat bundle's version does not change for a README edit.
- `bundles/desktop/layout/AGENTS.md:44-46`: [Files to change](#files-to-change).

Between the two commits the docs say: the viewer footer floats, chat is 1.6.2, `<chat-view>` reads the property from its host; `GROUNDING.md` and the feature doc describe the viewer footer floating and the main footer still in flow; the feature doc's Status line records phase 1 implemented and phase 2 not; the layout's README still describes the main footer as it is at that commit, in flow and 28 px tall.

Checked, no change: `docs/architecture/bundles/layout.md:17`, `:74-75`, `:131` (name the footer region, not its geometry); `docs/architecture/bundles/ui-composition.md:13`, `:59`; `docs/features/ui-redesign.md:83`, `:89` and `:187` (the concept's problem, goals and a proposal, as decided); `docs/features/ui-redesign.md:384` ("layout 3.0.2" names the version that brought `layout.stack/v2`); `bundles/desktop/layout/src/client/components/templates/inset-card.ts:1-14` (states the card's look, not the footer); `bundles/desktop/layout/AGENTS.md:52-54` (the footer weight rule still applies). Not changed, as records of their changes as built: `docs/designs/ui-redesign.md` (`:414`, `:507`, `:529-530`, `:780`), `docs/designs/sidebar-alignment.md`, `docs/designs/openui-diagrams-square-area.md:387`.

## Questions

- **SQ1 — Wheel over the footer.** Answered by the user (2026-11-15): the band takes the pointer as today's footer does, and a wheel over its 36 px does not scroll the conversation (D4, [SR1](#risks)).
- **SQ3 — The caret under the band.** Answered by the user (2026-11-15): Lexical's caret scrolling can stop the caret inside the band ([SR3](#risks)); this is accepted as a known limitation, this change adds no fix, and a follow-up is planned. [V-6](#visual-verification) records where the caret stops, with no pass condition.

## Revisions

- **Version 1** (2026-11-15): first version, from the user's decisions U1–U5 on the preview's `glass-2` variant and the coordinator's proposals (the bar inset inside chat, the pointer path, the contract versioning).
- **Version 2** (2026-11-15), from the Scope review:
  - U5 out of scope by the user's decision. Withdrawn: G4 (the split and `setBottomVisible` gone), D9 (removing the split), D10 (`layout.workspace/v2` and layout 4.0.0), D12 (the two-phase split of U1–U4 and U5), §7 and §8 (their designs), phase 2 with its files, tests T-2.1–T-2.7 and docs, SR6 (the nine consumers in step) and SQ2 (the contract path); D11 (stories and e2e capture rows) withdrawn with the capture change; G5 (a statement of the test approach) folded into the Test plan's opening.
  - The band's height reaches chat through `--chat-footer-height`, set by each band's owner and read with a `0px` fallback; the frame sits inside the split's top panel; the card-child footer listed as an alternative; no `z-10` on the band; the e2e test reads styles with `inPage`; tests assert only what the spec adds or relies on.
- **Version 3** (2026-11-15), from the Comprehension, Critique, Structural and Style reviews:
  - The band takes the pointer (user decision): G3 rewritten, D4 replaced (it made the band pointer-transparent), its sheet rules and test removed, SR2 withdrawn (clicks on the band's empty part reaching the transcript), SR1 restated, T-8's wheel steps removed, SQ1 answered.
  - Chat 1.6.2 ships before layout 3.0.3 (user decision): two phases, chat first; the excluded mix and its click failure named.
  - The band's fill and blur are rules in each owner's sheet, not utilities (SR5); T-3 tests the layout's rule.
  - The scroll padding cites CSS Scroll Snap 1 and T-8 step 4 checks it in the app's Chromium; T-8 also checks the computed band and padding.
  - The transcript reset rule removed: no production code mounts a conversation inside the transcript (the only mounts are `bundles/desktop/chat/src/client/index.ts:90` and `bundles/desktop/layout/src/client/hooks/thread-navigation.ts:23`).
  - Terms added (Base UI, Lexical, Papercraft, Child Thread, Conversation, Transcript, Fence, Composer controls, Agent levers, Footer weight rule, Trail column and handles, Reading line, scroll root); SR8 gets a frame-rate check and a fallback; SR9 covers the reading line and unreachable handles; SR11's figures restated from the openui spec's measurement; V-5 lists the interactions, V-6 and V-7 get pass conditions, V-9 checks the Empty state; links and wording made consistent.
- **Version 4** (2026-11-15), from the second Scope review:
  - T-8 step 4 removed: it tested Chromium's `scroll-padding` on a scroller this change does not draw. The change's own part stays pinned by T-7 (the rule) and T-8 step 3 (the computed 36 px on the real viewport); V-10 checks once, in the app, where a queued row and a comment reveal stop.
  - §3 states why chat's band also takes its fill and blur from a sheet rule: symmetry, since chat's utilities would ship with chat.
  - The doc-comment fix in `composer-controls.tsx` removed from Files to change: it is unrelated to this change.
  - §5 cut to the one new fact (the band covers the transcript and the handles under it); the Terms "Follow, resume", the trail selection and the `useThreadNav` listeners removed.
  - §1 states the frame's fate under U5: it stays and becomes the card's first child; the card-child alternative's rejection lists first the reasons that hold without the split.
- **Version 5** (2026-11-15), from the Readiness and Codebase reviews and the user's decisions on them:
  - Delivery (user decision): both phases are commits on `feat/sidebar-alignment`, chat's first; chat 1.6.2 also ships the branch's earlier chat commits `0421586d` and `5e636166`. Rollback order stated: phase 2 alone, or both; never phase 1 alone.
  - SQ3 answered (user decision): the caret under the band is a known limitation with a follow-up planned; V-6 only records.
  - The layout stories nest split → frame → pane as production does: `WorkspaceShell` no longer draws the footer; a `ContentFrame` helper wraps each `ThreadPane` inside `ConversationTerminals` in the three story files.
  - The section grows by today's 28 px footer, not 36 px: SR9's reading line moves 11.2 px, its handle threshold is the section less 72 px and about two handles more are out of reach; V-4's precondition and the Empty state's threshold (`H ≥ c + 72`) corrected.
  - The phase 1 commit gets an in-app check of the viewer band, T-10; T-8 and T-10 get their place in the suite, a size restored in `finally` and the overflow check inside `until`.
  - Each doc edit is assigned to a phase, with the state of the docs between the commits; the layout's `AGENTS.md` Boundaries line and `GROUNDING.md:428-429` are updated.
  - T-3 and T-7 say how they tell an unlayered rule (no `@layer` in the layout's sheet; a new `unlayered` helper in chat's test).
  - Smaller fixes: `workspace-view.tsx:296-332` with the overlay's comment kept; the header comment texts given; `FooterBand` and the settings and usage story footers keep `shrink-0` and move to the 36 px band; `chat-view.tsx`'s `CSSProperties` import; `IntentDispatcher`'s `div.contents` in both geometry chains; papercraft's `comment-flow.ts:291-294` in §4 and V-10; the Terms' viewport citation; the viewer test's `:1209` assertion named as replaced.
- **Version 6** (2026-11-15), from phase 1's implementation:
  - T-8, T-10 and V-9 set 1280×640 or 1920×640, not ×480: the workspace window's `minHeight` is 640 (`bundles/foundation/core/src/desktop/appearance.ts:5`), and the 1920×480 run timed out waiting for the size. T-10's overflow arithmetic follows.
  - Each phase's `doric-app-e2e:e2e` names the manual run where the target cannot run as root (`app/desktop/doric-e2e/project.json:31`, no `--no-sandbox`): the procedure of `docs/designs/ui-redesign.md:933`, with the merge copy done by `cpSync … recursive`, not `cp -r`.
  - `doric-renderer:test` added to both phases' pass lists: it compiles both bundles' sheets (`app/desktop/doric-renderer/tests/stylesheet.test.ts:99-116`, `:138-159`, `:306-310`).
  - Phase 1's Files to change adds chat's `AGENTS.md` (Styling) and the chat sheet's header comment, which the implementation edits.
- **Version 7** (2026-11-15), from the Docs review of phase 1:
  - Phase 1's docs gain a `GROUNDING.md` sentence on the viewer footer (moved from phase 2, whose edit now extends it), the feature doc's Status line, a bullet on the accepted limitations (SR1, SR3), a heading that credits the trail and this change to their own specs, and an Evolution entry that states the behaviour; chat's `README.md` and `AGENTS.md` name the isolation (D7) and the limitations, and the README's thread-panel sentence states its own height.
  - The stories' `inset-card.tsx` comment names the viewer footer and says the conversation card's footer is still in flow; phase 2 rewords its last sentence.
  - V-6's record goes in these Revisions; T-5 explains its `getPropertyValue` fallback (happy-dom and React's inline custom properties).
  - The header records phase 1 implemented.
