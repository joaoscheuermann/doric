# Feature: papercraft

- Status: `implemented` (2026-11-06; accepted 2026-11-03)
- Brief: this document, the concept of papercraft rebuilt on OpenUI. It replaces the version described, in Portuguese, in [docs/architecture/bundles/papercraft/README.md](../architecture/bundles/papercraft/README.md) and [isolamento.md](../architecture/bundles/papercraft/isolamento.md).
- Specs, one per concept since 2026-11-03, all approved by the user on 2026-11-04: [docs/designs/openui.md](../designs/openui.md) (the shared base and the phases, version 15), [docs/designs/conversation-openui.md](../designs/conversation-openui.md) (generative UI in the conversation and the question form, version 9) and [docs/designs/papercraft-openui.md](../designs/papercraft-openui.md) (papercraft's fence, repository libraries and canvas, version 13). The spike is dropped (U48): delivery starts with the new path behind the setting, and each stage ships when the user accepts it.
- Decisions: U1–U48 below, made by the user, U1–U41 on 2026-11-03, U42–U45 on 2026-11-04 and the rest on 2026-11-05. U48 withdrew four earlier decisions on the spike; they are not listed, and their numbers are not reused. Their implementation is recorded in [implementation-decisions.md](../architecture/bundles/implementation-decisions.md) under "OpenUI" (2026-11-06).

## Summary

Papercraft lets the agent show a visual change instead of describing it. The UI appears as a canvas node in the conversation, which the reader can pan and zoom, pin comments on, and send those comments back to the agent ([README](../architecture/bundles/papercraft/README.md#resumo)).

This concept rebuilds papercraft on OpenUI:

- The agent writes the UI as a short OpenUI Lang program inside its answer, and the canvas node draws it while it streams.
- A revision carries only the statements that changed.
- No Project file is written, and the `artifacts` bundle goes away.

## How to read this document

- **People.**
  - "The user" is the product owner who asked for this version and made decisions U1–U48. Those decisions bind the specs.
  - "The coordinator" is the workflow agent that collected those decisions and made proposals P1–P2. A proposal binds nothing until the user confirms it; P3 is accepted as U10, and P1 and P4–P8 as U17.
  - "The author" is the agent that wrote this document and ran the measurements in it.
  - "The reader" is the person using papercraft in a conversation (see [Users](#users)).
- **Identifiers.** Each kind of identifier is defined in its own section, and a reference to a later section names that section:
  - G: goals;
  - C: constraints;
  - U: user decisions;
  - P: proposals;
  - R: risks;
  - Q: open questions.
- **Paths** are written from the repository root.
- **Measurements.** The author installed `@openuidev/lang-core` 1.0.2, `@openuidev/react-lang` 1.0.2 and `@openuidev/react-ui` 0.18.1 in a scratch directory outside the repository on 2026-11-03, and measured with Node 22:
  - prompt sizes, by calling `openuiLibrary.prompt(...)`;
  - token counts, with `js-tiktoken` (`o200k_base` and `cl100k_base`);
  - bundle sizes, with esbuild 0.25.

### Terms

Doric:

- **Project**: a workspace of files with its own container, the **Project sandbox**, where the agent runs commands (`bundles/features/papercraft/src/host/sandbox.ts:1-8`).
  - The workspace is `/workspace`. A Thread's working directory starts there, moves inside it, and may be a repository root (`GROUNDING.md:625-632`), so one Project can hold several repositories.
  - A **repository library** is the OpenUI library of one repository. It is found per repository, the way today's harness is found by walking up from a file to the workspace root (`bundles/features/papercraft/src/host/harness.ts:1-16`). This document says "Project library" only where the distinction does not matter.
- **Thread**: one conversation. The **Thread log** is its durable event stream, `runtime.thread.events/<threadId>`; the model's streamed text arrives in it as `text.delta` events (`GROUNDING.md:1584-1592`).
- **Bundle**: a unit of product code with up to three parts (`docs/architecture/bundles.md:22`):
  - **host**: the backend, which runs tools and model calls;
  - **desktopMain**: the Electron main process;
  - **client**: a desktop window, also called **the app**.
- **Contract**: a named, versioned service interface between bundles, such as `chat.views/v1`.
- **Frame**: the isolated `<iframe sandbox="allow-scripts">` that draws a UI. This "sandbox" is the iframe attribute and has nothing to do with the Project sandbox ([isolamento.md](../architecture/bundles/papercraft/isolamento.md)).
- **Canvas node**: the block in a conversation answer that holds a frame. It also carries the canvas: pan, zoom, gestures, pins and the tree panel.
- **Pin**: the marker of an anchored comment. A **detached** pin is one whose anchor no longer exists in the program the node shows.
- **Projector**: a pure function of the chat that turns Thread events into conversation blocks (`bundles/desktop/chat/src/contracts/index.ts:44-55`).
  - **Replay** rebuilds the conversation from the whole log.
  - **Rewind** removes the events after a point ([README](../architecture/bundles/papercraft/README.md#replay-e-rewind)).
- **Lexical**: the editor framework that draws the chat's conversation (`bundles/desktop/chat/src/client/components/organisms/conversation/nodes/markdown-blocks.ts`).
- **Scene**: the tree of rendered elements and their boxes that the frame reports to the app. The tree panel and pins are drawn from it (`bundles/features/papercraft/src/client/frame-protocol.ts:204`).
- **Radix** and **Base UI**: unstyled React component libraries. react-ui is built on Radix, and today's frame import map provides Base UI.

OpenUI:

- **OpenUI**: an MIT-licensed project maintained by Thesys (https://github.com/thesysdev/openui) for "generative UI": a model writes a compact UI program, and a renderer draws it with a known component library (https://www.openui.com).
- **OpenUI Lang**: OpenUI's language. A **program** is a list of **statements**, one per line, each of the form `name = Expression`.
  - The `name` is the **statement name**.
  - Arguments are positional, references may point forward, and the statement named `root` is the entry (https://www.openui.com/docs/openui-lang/syntax).
  - An **inline component** is a component call written inside another statement's arguments. It has no statement name of its own.
- **Library**: the set of components a program may use. Each component is declared with `defineComponent`, a name, a description and a zod schema of its props.
  - `library.extend` derives a library from another by adding, overriding or removing components (https://www.openui.com/docs/openui-lang/whats-new).
  - `@openuidev/react-ui` ships the built-in libraries `openuiLibrary` and `openuiChatLibrary`.
- **Patch**: a program that holds only changed or new statements.
  - `mergeStatements` merges a patch into the previous program by statement name (https://www.openui.com/docs/openui-lang/incremental-editing).
  - `editMode` is the prompt option that teaches the model to write patches.
  - `inlineMode` is the prompt option that teaches the model to put programs in ` ```openui-lang ` fences with prose around them (https://www.openui.com/docs/openui-lang/system-prompts).

### An example

The reader asks for a settings page. The agent's answer contains this fence:

```openui-lang
root = Stack([header, notifications])
header = CardHeader("Settings", "Your account preferences")
notifications = Card([notifTitle, notifSwitches])
notifTitle = CardHeader("Notifications")
notifSwitches = SwitchGroup("notifications", [email, push])
email = SwitchItem("Email", "Weekly summary", "email", true)
push = SwitchItem("Push", "Mentions only", "push", false)
```

The reader pins "rename to Alerts and add SMS" on the `notifications` card. The agent answers with this patch:

```openui-lang
notifTitle = CardHeader("Alerts")
notifSwitches = SwitchGroup("notifications", [email, push, sms])
sms = SwitchItem("SMS", "Urgent only", "sms", false)
```

`mergeStatements` replaces `notifTitle` and `notifSwitches`, keeps the other five statements and adds `sms`. The author checked that both programs and the merged result parse against `openuiLibrary` with no errors. The program is 86 tokens and the patch 41 (`o200k_base`). The pin stays on `notifications`, because that statement name is unchanged.

## How papercraft works today

The `papercraft` bundle and the `artifacts` bundle work together:

- **Writing and recording.**
  - The agent writes a Project file, then calls the `papercraft_preview` tool (`bundles/features/papercraft/src/host/tools/papercraft-preview.ts`).
  - The tool reads the source once and builds it. The source is `html` markup or a `component` module (`bundles/features/papercraft/src/contracts/index.ts:29`).
  - A component module is wrapped in the Project's Storybook-shaped harness (`bundles/features/papercraft/src/host/harness.ts:1-3`), and a story file mounts the chosen story (`entry.ts:1-3`).
  - The tool then records an **artifact revision** of kind `preview`, with the payload `{source, path, entry?}` (`bundles/features/papercraft/src/host/kind.ts:40-46`).
- **The artifact registry.**
  - An **artifact** is an entry in the `artifacts` registry, with an identity and immutable numbered revisions. A **kind** is a registered type of artifact, and `preview` is the only kind ever registered (`bundles/features/papercraft/src/host/index.ts:24-26`).
  - Revision bytes live in the workspace under `.doric/artifacts/<artifactId>/<revision>/<path>` (`GROUNDING.md:1017-1022`).
  - The desktop copies them into a verified cache under `userData/artifacts/` and serves them at `doric://app/artifacts/<artifactId>@<revision>/` (`GROUNDING.md:1380-1383`, `app/desktop/doric/src/platform/protocol/handler.ts:215-232`).
- **Where previews appear.** Each revision is a new canvas node in the conversation (`docs/architecture/bundles/papercraft/README.md:553`). It can also open in a separate canvas window at `/papercraft/:projectId/:threadId/:artifactId` (`bundles/features/papercraft/src/desktop/commands.ts:1-4`).
- **Review policy.** The review policy is `proceed` (the default) or `request`, kept per Project in the setting `artifacts.review-policy/v1`. Under `request`, an Approve button writes `artifacts.approved/v1`, and the agent can wait for it (`GROUNDING.md:1020,1030-1034`).
- **Comments.**
  - A click anchors a comment by the element's `data-papercraft-source="path:line"` stamp, or else by a selector (`bundles/features/papercraft/src/client/anchor.ts:22,63-82`).
  - Drafts sit on the chat composer's stack and leave with the next prompt (`bundles/features/papercraft/src/client/comment.ts:1-28`).
  - The tool's result lists the open comments, and the agent answers them with `comment_reply` (`GROUNDING.md:1290-1292`).
- **Frames.** A window keeps at most three live frames, and the others show snapshots (`GROUNDING.md:1402`).

## Problem

- **Nothing renders while the model writes.**
  - The frame imports a finished module and calls `mount(root, {theme})` once (`bundles/features/papercraft/src/client/frames/preview/runtime.ts:542,588`).
  - It accepts `init` only once (`runtime.ts:680-681`), so no content can be pushed into a mounted frame.
- **Each preview and each revision costs the whole source.** The agent pays for a file write, a tool call and its result (`GROUNDING.md:1234-1236,1292`).
- **Every preview writes a Project file**, even to show an idea.
- **The agent can show UI only as a design preview of Project code.** The `ask` tool shows multiple-choice questions and returns the answer as the next user request (`bundles/features/threads/src/host/tools/ask.ts:10-11`). The agent cannot answer with a form, a table, a filterable list or a choice laid out as UI. Generative UI replaces `ask` (U12).
- **The code is large for what it does.** `bundles/features/papercraft/src` has 16,824 lines and its tests 11,829. The `artifacts` bundle, which serves only papercraft, adds 4,374 more.

## Goals and success measures

The user chose G1–G4 and their measures. G5 was added in review, so that the Project library (U2) has a measure. Every target was a proposal of this concept. U40 confirms G4's target, which a test checks (question Q6). Since U48 the other targets state what the design aims at: they are not measured before a stage ships and gate nothing, and each stage ships when the user accepts it. G1's conversation targets were added on 2026-11-03, when U18 moved conversation UI out of the frame.

| #   | Goal                                                                                           | Measure                                                                                                                                                                                                                                                                                   | Proposed target                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1a | Immediate feedback, first program                                                              | Time from the fence's first statement line reaching the Thread log to that statement painted: in the app for a conversation fence, in the frame for a papercraft fence (U18)                                                                                                              | Conversation: ≤ 500 ms once the renderer is loaded, ≤ 1 s for a window's first fence. Papercraft: ≤ 1 s with a warm frame (already booted and waiting), ≤ 2 s with a cold frame (booted for this fence)                                                                                                                                                                                                                        |
| G1b | Immediate feedback, revision                                                                   | Same measure for each completed statement of a patch, using the progressive merge of P4, in each host                                                                                                                                                                                     | Conversation: ≤ 500 ms. Papercraft: ≤ 1 s with a warm frame                                                                                                                                                                                                                                                                                                                                                                    |
| G2a | Fewer output tokens                                                                            | Output tokens per preview and per revision, from the Thread's usage aggregate (`GROUNDING.md:1585-1587`), on a fixed task set run today and after                                                                                                                                         | Median ≤ 50 % of today's per preview, ≤ 25 % per revision                                                                                                                                                                                                                                                                                                                                                                      |
| G2b | No higher total cost                                                                           | Input plus output tokens per preview and per revision, including OpenUI's instructions (R5) and the current program shown again after compaction (R2)                                                                                                                                     | Not above today's median                                                                                                                                                                                                                                                                                                                                                                                                       |
| G3  | Generative UI in the conversation, including every question the agent puts to the reader (U12) | Share of prompts where the agent picks the right medium, on a set of 20 prompts the user labels (10 better answered with UI, 10 with text); and, on a set of 10 tasks where the agent needs a decision from the reader, the share where it asks through a fence form rather than in prose | ≥ 80 % on the first set; ≥ 90 % on the second                                                                                                                                                                                                                                                                                                                                                                                  |
| G4  | Explore UI without touching the Project                                                        | `files/v1` writes and Project file changes caused by showing or revising a UI                                                                                                                                                                                                             | Zero Project file changes, checked by a test (U40). The only writes are `.doric/papercraft/.gitignore` (created on the first run, visible in `git status`), the runner copy in `.doric/papercraft/` (ignored by Git) and temporary job folders (removed at the end) (R7). U31's one-time `.doric/.gitignore` migration is the one exception, confirmed by the user (U40, [D8](../designs/papercraft-openui.md#the-migration)). |
| G5  | Project components look as they do in the product                                              | Pixel difference between a Project component in the frame and the same component in the Project's own app or Storybook, at the same viewport, theme and props, over every component of the Project library                                                                                | ≥ 90 % of components under 1 % differing pixels                                                                                                                                                                                                                                                                                                                                                                                |

The user also set four constraints. The user's request numbered them 5–8 after the four goals; this document calls them C1–C4:

- C1: this version does not use artifacts.
- C2: wherever possible, a community-maintained library replaces proprietary code.
- C3: remove as much code as possible.
- C4: the experience becomes simpler, faster and more satisfying.

C2 and C3 pull against each other: the OpenUI packages replace Doric code but bring 235 npm packages with them (R4).

## Users

- **The reader**, a designer or developer in a Doric conversation. They ask for a UI, watch it appear, pin comments on its parts, send them and see the result. They also answer the agent through UI in the answer, such as a form.
- **The agent**, which writes the UI as OpenUI Lang in its answer and revises it with patches.
- **The repository author**, who exposes a repository's components to the agent as a repository library, so that the UI the agent writes uses that repository's own design system (G5). Without a library, the agent can still preview any export of the repository (U14).

## Scope

In this version:

- A UI written by the agent as an OpenUI Lang program in a fence of its answer, drawn while it streams (U1).
- The built-in library `openuiLibrary`, themed with Doric's tokens, plus each repository's components through `library.extend` (U2, G5).
- Previewing any export of a repository file or story through a built-in component (U14).
- Questions to the reader as fence forms, replacing the `ask` tool (U12).
- Drawing in the existing isolated frame, and compiling repository libraries and previewed exports with the existing pipeline (U3, P2).
- Revisions as patches merged by statement name (U4).
- The canvas, rebased onto the program (U6).
- Local interactivity and `@ToAssistant` actions (P1).
- Removing the `papercraft_preview` tool, the `preview` kind and the `artifacts` bundle (U4).

## Non-goals

- Drawing the `artifacts.*` events of old conversations (U5).
- A side tab for a component's preview (U7). This version keeps that door open: a canvas node is addressed by Thread, program and revision, not by a chat DOM node.
- `Query`/`Mutation`, that is, tools or MCP called from the UI (P1).
- Writing a UI back into Project files. Turning an explored UI into Project code is an ordinary coding task.
- Durable local UI state: form values and `$variables` reset when the canvas node remounts (U38).
- OpenUI's runtime telemetry, which stays off (U8).

## Decisions

Made by the user, and binding for the spec:

- **U1 Inline fence.**
  - The agent writes the program in a markdown fence of its answer, as OpenUI's `inlineMode` does.
  - The fence tag is closed by U20 (question Q7); its info string also carries the program's identity (U11). The coordinator recommends `openui-lang`, because the prompt that `openuiLibrary.prompt()` generates with `inlineMode` already teaches that tag (measured).
- **U2 Library.** The built-in library is `@openuidev/react-ui`, themed through its `--openui-*` CSS variables. The Project's components extend it with `library.extend`. Both ship in this version.
- **U3 Isolation stays.**
  - Project components are untrusted code, so every UI is drawn in the existing frame: an opaque origin (`bundles/features/papercraft/src/client/surface/live-frame.tsx:6,278`) under a CSP with no `unsafe-eval` and `connect-src 'none'` (`app/desktop/doric/src/platform/protocol/csp.ts:47-58`).
  - The compile pipeline stays to compile the Project library: esbuild in the Project sandbox (`bundles/features/papercraft/src/host/compile.ts:1-18`) and Tailwind on the host (`css.ts:1-20`).
- **U4 No artifacts.**
  - The `papercraft_preview` tool, the `preview` kind and the `artifacts` bundle are removed.
  - The program lives in the assistant's answer in the Thread log.
  - A revision is a later patch fence, merged by statement name.
  - This also drops artifacts as Doric's general channel for durable agent deliverables, as [artifacts.md](../architecture/bundles/artifacts.md) defines them. That is the user's decision. [Docs and decisions made stale](#docs-and-decisions-made-stale) lists what it affects.
- **U5 Old previews disappear.** Old logs keep their `artifacts.*` events, and nothing draws them. No legacy rendering path stays.
- **U6 Keep the canvas.** Pins, moving, zoom, gestures and the tree panel stay. A comment anchors to a statement name, which survives revisions.
- **U7 Side tab** is out of scope, and this version must not close that door.
- **U8 Telemetry.** The anonymous install-time `postinstall` of `@openuidev/lang-core` is accepted (https://unpkg.com/@openuidev/lang-core@1.0.2/package.json, https://www.openui.com/docs/openui-lang/telemetry). Runtime telemetry is opt-in through `OPENUI_RUNTIME_TELEMETRY_ENABLED`, and Doric never sets it.
- **U9 OpenUI packages, used directly.** The three packages are pinned to exact versions, with no compatible reimplementation. `@openuidev/browser-bundle` cannot take Project components because it lacks `defineComponent`. Extended by U42.

Made by the user when accepting the concept:

- **U10 Delivery.** The concept is implemented in the order of P3: spike, then the new path behind a setting, then the default, then removal. U48 drops the spike: the new path behind the setting is the first stage.
- **U11 Program identity in the info string.**
  - A fence names its program in the info string, for example ` ```openui-lang settings `.
  - A fence with the same identity patches that program, and a fence with a new identity starts a new one.
  - Pins key by identity plus statement name, and a comment's target id is the identity.
  - This adds a prompt rule on top of OpenUI's generated instructions, a small custom protocol. The user accepts that cost against C2.
- **U12 Generative UI replaces `ask`.** The `ask` tool (`bundles/features/threads/src/host/tools/ask.ts`) is removed. A question to the reader becomes a fence form, drawn in the current visual style of `ask`'s question block. At concept level this means:
  - the `ask` tool leaves the model's tools;
  - its rules move to the fence form: only the main Thread asks the reader, and the answers arrive as the next user request (`ask.ts:10-11`);
  - every prompt and skill that mentions `ask` changes, and the spec lists them;
  - G3 covers these questions, and the boundary of the former "keep both" option no longer applies.
- **U13 Instructions as a mix.**
  - A static skill carries OpenUI's instructions for the built-in library and is loaded on demand.
  - Once the skill is loaded, the repository libraries' signatures reach the model in a retained `instruct` (part 7 of [Shape of the solution](#shape-of-the-solution)).
- **U14 Previewing any export stays.**
  - A built-in component mounts one export of a repository file or story.
  - It reuses today's export choice (`pickExport`, `bundles/features/papercraft/src/host/bundle.ts:338-368`) and harness (`harness.ts:1-16`).
  - Its props are not validated by a schema.
  - Registering a component in a repository library is therefore an improvement, with typed props and signatures the model reads, not a prerequisite for previewing it.

Made by the user on 2026-11-03, after accepting the concept:

- **U15 Repository libraries under `.doric/papercraft/schemas/`.**
  - A repository registers its components in library files kept in the repository, under the Doric-wide path `.doric/papercraft/schemas/`. In the user's words: "the name should not be .papercraft; it should be a Doric global, like .doric/papercraft/schemas".
  - Each file declares components with `defineComponent` and a zod schema.
  - The agent or the developer writes these files.
  - Components that are not registered still show through the export component (U14).
  - The files are versioned in Git (confirmed by the user on 2026-11-03). Today `.doric/` is app state, ignored as a whole by the `.doric/.gitignore` the artifacts store writes (`bundles/features/artifacts/src/host/store.ts:40-44,293-304`), so `.doric/` becomes versioned by default, and each bundle that keeps app state there ignores it with a `.gitignore` in its own folder ([D8](../designs/papercraft-openui.md#d8-doric-layout-and-versioning)).
  - Rejected: keeping the files local, not versioned. Nothing would be shared through Git, a clone or CI checkout would start without a library, schema changes would get no review, and the library could not follow the components it describes from commit to commit (D8 gives the full reasons).
  - This closes the declaration part of Q1.
- **U16 A fence without an identity starts a new program.** It never patches the Thread's last program (spec [D3](../designs/openui.md#d3-identity-and-revision)). This replaces the proposal in R1.
- **U17 P1 and P4–P8 confirmed**, as the spec adopts them (P1 as D20, P4 as D5, P5 as D2, P6 as D19, P7 as D14, P8 as D25). P2 is replaced by U18.
- **U18 Render hosts.** In the user's words: "only papercraft goes in the iframe; everything else is in the app, because only papercraft is the exception to OpenUI's model". Generative UI in the conversation (forms, tables, choices, the question form that replaces `ask`, and actions) renders in the app's own DOM, as OpenUI's `Renderer` does by default. Only papercraft renders in the isolated frame, with the canvas, because it runs untrusted repository code (U15 libraries, `Export`) and its canvas is built on the frame. This replaces P2. The spec routes by fence tag: ` ```openui-lang ` for conversation UI, ` ```papercraft ` for papercraft ([D7](../designs/openui.md#d7-render-hosts-and-routing)).
- **U19 Validation feedback is automatic** (spec D18 confirmed): a fence's errors reach the agent at the start of the next prompt, as OpenUI's documented `onError` pattern sends them back to the model ([D18](../designs/openui.md#d18-validation-feedback-u19)). This answers Q4. Narrowed by U23.
- **U20 Routing, owner and renderer loading confirmed** (spec D7, D27, D29). The fence tag on the opener line decides the host: ` ```openui-lang ` renders in the app, ` ```papercraft ` in the frame ([D7](../designs/openui.md#d7-render-hosts-and-routing)). A new `openui` bundle owns the conversation UI, the question form and the shared code ([D27](../designs/openui.md#d27-the-openui-bundle)). The renderer loads at a window's first fence, through a new client-chunk kind in `packages/bundle`; preloading at idle stays the fallback ([D29](../designs/conversation-openui.md#d29-the-conversation-renderer-in-the-app)). This answers Q7.
- **U21 Conversation actions send on click** (spec D20 changed), as OpenUI's example does. The click sends the action's message as the reader's next message through the chat's send path, a steer while a prompt runs and a prompt otherwise. There is no review step. The message is marked as coming from the UI, and one action per fence is in flight at a time. The user accepts the risk knowingly: after one click, text the model wrote becomes the reader's message, which is prompt injection through model-written button text ([D20](../designs/conversation-openui.md#d20-actions-back-to-the-agent-p1)). This changes P1's "no send from the frame", "rate limit" and "prompt injection" mitigations for conversation fences. The question form keeps its own send. Whether papercraft fences have actions was left pending; U22 decides it. Narrowed by U26.
- **U22 Papercraft fences have no actions**, as today (spec D6 confirmed, [D6](../designs/papercraft-openui.md#d6-the-frame-entry-and-protocol-2)). Inside the frame, a preview changes only its local state: `$variables`, tabs, forms. The frame protocol has no `action` message. Feedback to the agent goes through pinned comments. An action expression in a papercraft fence (`@ToAssistant`, `@OpenUrl`, `@Run`) is reported to the agent by validation as an error, not a warning, with a hint that actions belong in conversation fences: validation sends errors only, and a control that does nothing is a defect the agent must fix. This narrows P1: actions exist only in conversation UI, which the app draws.
- **U23 Errors only from drawn fences** (spec D4, D14 and D18; narrows U19). A fence's errors reach the agent only when a window drew it, from the renderer's `onError`; no host reads or parses fences ([D4](../designs/openui.md#d4-the-program-reducer), [D18](../designs/openui.md#d18-validation-feedback-u19)). A papercraft fence drawn without its repository library reports no errors ([D14](../designs/papercraft-openui.md#d14-caching-and-serving-p7)).
- **U24 No programs instruct after a compaction** (spec D17). The skill's rule makes the model write a program whole when its last text is gone ([D17](../designs/openui.md#d17-instructions-the-skills-u13-concept-q3)). This answers Q3.
- **U26 Actions only on the latest closed revision, in a main Thread** (spec D20; narrows U21). A click on an older revision, on a fence still streaming, or in a subagent's Thread sends nothing ([D20](../designs/conversation-openui.md#d20-actions-back-to-the-agent-p1)).
- **U27 A rewind reopens an answered question** (spec D22). The answer is recorded under the prompt that took it; a rewind of that prompt makes the question pending again ([D22](../designs/conversation-openui.md#d22-the-question-service-durable-state-and-the-main-thread-rule)). A rewind removes rows by log position, so rewinding a prompt that ran between the question and the answer also makes the question pending again (D22).
- **U28 `Modal` drawn inline** (spec D29). No model-written dialog covers the window ([D29](../designs/conversation-openui.md#d29-the-conversation-renderer-in-the-app)).
- **U29 Old asks and `@OpenUrl`** (spec D30 and D7). In stage 4 old `threads.asked/v1` rows draw nothing and their answers stay as user text ([D30](../designs/conversation-openui.md#d30-removing-ask)); `@OpenUrl` is disabled in stages 2–4 and shows its URL as text ([D7](../designs/openui.md#d7-render-hosts-and-routing)). This answers Q9.
- **U30 Repository library pipeline** (spec D12, D14, D15 and D28). Evaluation runs in the Project sandbox under Node, with stubs that fail only when a schema reads them ([D12](../designs/papercraft-openui.md#d12-evaluation-for-signatures)); a library is built when a window draws a fence and at prompt start in Threads that loaded the skill, after a manifest check ([D14](../designs/papercraft-openui.md#d14-caching-and-serving-p7), [D28](../designs/papercraft-openui.md#d28-the-papercraft-skill-and-the-library-instruct)); the harness wraps the whole program ([D15](../designs/papercraft-openui.md#d15-harness-and-theme-for-library-components-concept-q1-rest-q5)). This answers the rest of Q1.
- **U31 `.doric/` migration and ignored schemas** (spec D8). papercraft deletes `.doric/.gitignore` once, when its content is exactly `*`; the library job reports a Git rule that hides the schemas, in place of a skill rule ([D8](../designs/papercraft-openui.md#d8-doric-layout-and-versioning)).
- **U32 The harness search stops at the repository root** (spec D15), for libraries, `Export` and today's previews ([D15](../designs/papercraft-openui.md#d15-harness-and-theme-for-library-components-concept-q1-rest-q5)).
- **U33 Leftovers** (spec D19, D25 and D26). The Approve step and the `request` policy are not replaced; the canvas window is rekeyed to the program identity; the persisted-data rules of D25 hold; the comment kind becomes `papercraft-program`; `comment_reply` stays ([D19](../designs/papercraft-openui.md#d19-comments-and-pins-p6-u6-u11), [D25](../designs/papercraft-openui.md#d25-removal-and-persisted-data-p8-concept-q8), [D26](../designs/papercraft-openui.md#d26-the-canvas-and-its-window)). This answers Q8.
- **U34 Theme** (spec D15). Repository components keep the repository's own CSS; react-ui components take Doric's tokens; G5 measures the result ([D15](../designs/papercraft-openui.md#d15-harness-and-theme-for-library-components-concept-q1-rest-q5)). This answers Q5.
- **U35 Library limits, name collisions and `.papercraft/`** (spec D11, D14, D16 and D28). The limits hold: at most 100 schema entry files of 16 KiB each and 1 MiB in all, a 64 MiB host memo, a desktop cache cut from above 256 MiB to 128 MiB at start, two runner jobs per Project, a 10 s evaluation timeout, a 5-minute hold of a crashed job and a library instruct of at most 16,000 characters ([D14](../designs/papercraft-openui.md#d14-caching-and-serving-p7)); a repository component named like a built-in is a compile error ([D11](../designs/papercraft-openui.md#d11-schemas-layout-and-the-library-module)); a harness may still live in `.papercraft/preview.<ext>`. Extended by U44; its cut-back timing is changed by U45.
- **U37 Two skills** (spec D17). `openui` holds the language and the built-in components, its text generated from OpenUI and committed to Git; `papercraft`, at most 8,000 characters, holds the papercraft fence, `Export` and the repository libraries and tells the agent to load `openui` first ([D17](../designs/openui.md#d17-instructions-the-skills-u13-concept-q3)).
- **U38 No durable local state.** Form values and `$variables` reset when a fence remounts, in both hosts. This answers Q10.
- **U39 Docs** (spec Docs to update). The specs update the affected sections of GROUNDING.md and the READMEs in the stages they name; papercraft's feature doc replaces the Portuguese README and `isolamento.md` and keeps a summary of the frame decisions ([Docs to update](../designs/openui.md#docs-to-update)). This answers Q11.
- **U40 G4's target** (spec D8, D14 and PC17). Showing or revising a UI changes no Project file, and a test checks it (PC17). The only writes are `.doric/papercraft/.gitignore` (created on the first run, visible in `git status`), the runner copy in `.doric/papercraft/` (ignored by Git) and temporary job folders (removed at the end). The `.doric/.gitignore` migration that U31 decided runs before papercraft's first runner job in a workspace, so showing a UI can run it, once per workspace and only when the old file exists; the user confirmed it as G4's only exception ([D8](../designs/papercraft-openui.md#the-migration)). With U48 this answers Q6.
- **U41 `ask` is withheld in stage 3** (spec D24). While the setting is on in stage 3, `openui` withholds `ask` through `threads.ask/v1` 1.2.0 `withholdTool`, as D24 states; leaving `ask` registered until stage 4 is rejected, because the model would have two ways to ask during a release where the new path is the default ([D24](../designs/openui.md#d24-the-setting-and-rollback)).
- **U42 react-ui's peer dependencies** (spec D31; extends U9). A root `overrides` entry in `package.json` resolves react-ui 0.18.1's `zustand` `^4.5.5` peer to the repository's zustand 5, and `@openuidev/react-headless` is accepted as an installed peer that no Doric module imports. react-ui's `./genui-lib` entry imports from zustand only `create` and `useShallow` (`dist/genui-lib/index.mjs:27-28`), both in the installed zustand 5.0.15, and nothing from react-headless. The spike's install verifies both ([D31](../designs/openui.md#d31-the-built-in-library-and-dorics-tokens)). This answers the spec's open question 8.
- **U43 `ask`'s look is checked by markup** (spec C9). The goal that `ask`'s look is kept is checked by markup, not pixels: each of the 12 story states renders the same `innerHTML` with the `openui` bundle's copy as with `threads`', over the same CSS. The repository has no screenshot harness ([Goals](../designs/conversation-openui.md#goals)). This answers the conversation spec's open question 6.
- **U44 `AskForm` is a reserved name** (spec D11 and D6; extends U35). A repository component named `AskForm` is a compile error, so the hint a papercraft fence that names `AskForm` gets, "Questions go in openui-lang fences.", is always right ([D11](../designs/papercraft-openui.md#d11-schemas-layout-and-the-library-module)). This answers the papercraft spec's open question 10.
- **U45 The desktop cache is cut back at the first `ensure`** (spec D14; changes U35's timing). The cut-back from above 256 MiB down to 128 MiB runs at the first `ensure` of each app session instead of at start, and still before any frame of that session loads a module. A desktop part gets no `doric.*` answer during activation (`bundles/features/artifacts/src/desktop/index.ts:11-13`) ([D14](../designs/papercraft-openui.md#d14-caching-and-serving-p7)).
- **U48 The spike and its measurements are dropped** (2026-11-05; spec Phases). OpenUI exists to improve the reader's usability; performance is handled while each stage is built, not gated on measurements. Stage 1 is not carried out, its measuring instrument is deleted, and each of stages 2, 3 and 4 ships when the user accepts it. The options a measure would have triggered stay in the specs as risk notes without thresholds. Four earlier decisions, on the spike's runs and stage gates, its task sets and targets, its test repository's library names and the statistic of its targets, are withdrawn; with U40 this answers Q6 ([Phases](../designs/openui.md#phases)).

Proposed by the coordinator; P1 confirmed by U17 and narrowed by U22 to conversation UI, P2 replaced by U18:

- **P1 Interactivity.**
  - **Local state.** `$variables`, tabs, toggles and forms, which the renderer runs by itself (https://www.openui.com/docs/openui-lang/actions).
  - **`@ToAssistant`.** A button that proposes a message to the conversation. The frame runs untrusted Project code, so nothing it reports, a click included, is trusted. The mitigations are part of the proposal:
    - **No send from the frame.** The frame only reports "this action proposes this text". The app draws the proposal outside the frame, under the canvas node, with the full text and any `context` value, editable. Only the reader's click on the app's own send control sends it, through the chat's normal send (`chat.send/v1`, `bundles/desktop/chat/src/contracts/index.ts:606-613`). After U18 the conversation draws this UI in the app, and U21 replaces this mitigation there: a conversation action sends on click ([D20](../designs/conversation-openui.md#d20-actions-back-to-the-agent-p1)). U22 removes actions from papercraft fences, so the frame sends no text at all ([D6](../designs/papercraft-openui.md#d6-the-frame-entry-and-protocol-2)).
    - **Rate limit.** One open proposal per canvas node. A new proposal replaces the open one, as a new `ask` call replaces an unanswered one today (`ask.ts:10-11`). Proposals that arrive while the agent is running are held until it ends. For conversation fences, U21 replaces this with one action in flight per fence; an action while the agent runs steers it.
    - **Marked origin.** The sent text travels in an envelope that names the canvas node it came from, the way comments travel in `<comments>` (`chat/src/contracts/index.ts:609`). The model and the log can therefore tell UI-originated text from typed text. For conversation fences this is the `<ui-action>` envelope and a caption in the transcript (U21).
    - **Prompt injection.** Button text is written by the model and may repeat text the model read elsewhere. The reader sees and can edit the exact text before sending, and the envelope tells the model that the text came from a UI it wrote. For conversation fences, U21 drops the review and accepts this risk.
  - **Out of this version: `Query`/`Mutation`.** They would need a frame → app → host bridge and a permission model (https://www.openui.com/docs/openui-lang/queries-mutations). The desktop can reach only `catalog` of `tools/v1` today (`packages/bundle/src/contracts/basic/tools.ts:174-178`).
- **P2 One render path.** Every fence is drawn in the frame, whether or not it uses Project components. **Replaced by U18.**

Proposed by this concept; P4–P8 confirmed by U17:

- **P3 Delivery order.** Accepted by the user as U10.
  1. **Spike.** Measure the riskiest assumptions against the G1, G2 and G5 targets.
  2. **New path behind a setting.** The fence path ships behind a setting, next to the old tool.
  3. **Default.** The fence path becomes the default, and `papercraft_preview` and `ask` leave the model's tool list (U12).
  4. **Removal.** The `artifacts` bundle and the `preview` kind are removed, and P8 lands.

  Until step 4, turning the setting off is the rollback. U4 and U5 remain the end state.

- **P4 Progressive merge of patches.** While a patch streams, the canvas node shows `mergeStatements(base, completed statements of the patch)`. The trailing, unfinished line is held back.
  - OpenUI advises merging only after the stream ends, because "root is half written, and mergeStatements would drop the statements it cannot reach yet" (https://www.openui.com/docs/openui-lang/incremental-editing). Holding back the unfinished line removes that case.
  - The author checked this with lang-core 1.0.2:
    - merging each completed-line prefix of a patch gives a valid program at every step;
    - a half-written `root` drops the tree;
    - a new statement written before the `root` that references it stays hidden until that `root` line completes.
- **P5 Fence states.** A fence is _streaming_, _closed_, or _unterminated_: the answer ended, was aborted or failed with the fence still open, which the chat would otherwise draw as still streaming (`bundles/desktop/chat/src/client/domain/markdown.ts:406-419`).
  - An unterminated fence keeps its completed statements, as P4 does, and its canvas node is marked incomplete.
  - It becomes the base of the next patch, since the model has seen its own text.
  - The agent is told, through the channel R6 uses.
- **P6 Anchor form.** A comment's anchor uses the existing `selector` form, with the statement name as `selector` and the component name as `label`.
  - The `source` form is not used, because it requires a file `path` (`bundles/features/comments/src/contracts/index.ts:26-31`).
  - A click inside a portal, or on an element with no named statement above it, falls back to the `point` form (R14).
- **P7 Move the verified cache.** papercraft keeps the existing verified cache (240 lines, `bundles/features/artifacts/src/desktop/cache.ts`) and the protocol route, under its own name, to serve compiled Project libraries. The route is generic: `ServedArtifacts` is only a root directory (`handler.ts:220-223`). This replaces "remove, then rebuild a smaller one" (R8).
- **P8 Old events claimed by papercraft.** papercraft registers a projector for `artifacts.created/v1`, `artifacts.revised/v1`, `artifacts.applied/v1` and `artifacts.approved/v1` (`bundles/features/artifacts/src/host/index.ts:28-31`) that returns no blocks. Without a claim, these events would be drawn as generic payload blocks (R10). Putting them in the chat's built-in list instead (`bundles/desktop/chat/src/client/domain/external-blocks.ts:20-23`) would tie the chat to a bundle that no longer exists.

## The user-visible loop

1. The reader asks for a UI.
2. The agent's answer streams prose, then an `openui-lang` fence. When the opening line arrives, a canvas node takes the place of the code block.
3. Statements are drawn as they arrive. The parser re-runs on each chunk, closes pending strings and brackets, and drops references it cannot resolve yet (https://www.openui.com/docs/openui-lang/renderer). Prose after the fence keeps streaming below the node.
4. In the canvas node, the reader pans, zooms, opens the tree panel and clicks a component. A pin appears on the component's statement. The reader types a comment and sends it with `Cmd/Ctrl+Enter`. The comment travels in the prompt envelope, `<comments>` then `<message>` (`chat/src/contracts/index.ts:606-613`), as it does today.
5. The agent answers with prose and a patch.
6. A new canvas node appears in the new answer, starting from the program with the same identity (U11). Completed patch statements are drawn as they arrive (P4). The pin is still on its statement, and the agent can answer the comment and resolve it with `comment_reply`, as it can today (`bundles/features/comments/src/host/tools/comment-reply.ts:1-9`).
7. The earlier canvas node stays in the earlier answer, showing the program as it was then. Every revision shows every comment thread, as today (`bundles/features/papercraft/src/client/surface/thread-open.ts:3-4`).

When the agent answers with a form, the loop is shorter. The reader fills it in and clicks its button, the app shows the proposed message under the canvas node, and the reader sends it (P1). A question the agent needs answered before it continues is such a form, drawn in the visual style of today's `ask` block, and its answer arrives as the next user request (U12).

## Shape of the solution

This section was written before U18. Where it says the frame draws every fence, U18 applies: conversation fences render in the app, and only papercraft fences in the frame; the specs give the current shape ([openui.md](../designs/openui.md#overview)).

This section stays at the level of data flow and responsibilities. Code-level evidence is in [Risks](#risks), and interfaces are for the spec.

```text
model ──text.delta──▶ Thread log ──▶ chat (fence by tag) ──▶ canvas node (client)
  ▲                       │                                    │ program text, state
  │                       ▼                                    ▼
  └── instruct ◀── host: fence rule, reducer,        frame: OpenUI renderer
      (retained)      instructions, validation*         + react-ui + Project library
                          │                                    ▲
                          └── Project library compile ── served (P7) ┘
                                                    * only if Q4 asks for it
```

1. **Instructions to the model.**
   - The host builds OpenUI's instructions with `generateSystemPrompt` from `@openuidev/lang-core`, which runs without React (https://www.openui.com/docs/openui-lang/system-prompts). It passes `inlineMode`, `editMode`, a `preamble` that fits inside Doric's own system prompt, and the Project library's signatures.
   - Measured: `openuiLibrary` has 82 components. Its instructions are 38,211 characters, or 9,667 tokens in `o200k_base` (9,631 in `cl100k_base`).
   - They reach the model as U13 decides: a static skill with the built-in library, loaded on demand, and the repository libraries' signatures in a retained `instruct` (part 7) once the skill is loaded.
2. **The fence in the chat.**
   - The chat parses markdown itself and draws a fence as a Lexical code node, whose text keeps the opening line with its tag (`bundles/desktop/chat/src/client/domain/markdown.ts:129-133`, `markdown-blocks.ts:164-169`).
   - Two ways to turn an `openui-lang` code node into a canvas node:
     - **Lexical, preferred.** Through the existing `chat.lexical/v1` (`registerNodes`, `registerExtension`; `chat/src/contracts/index.ts:82-91`), papercraft replaces a code node whose opening line is ` ```openui-lang ` with its own node. This needs no new public contract for drawing. What the node lacks is its context: which Thread and answer it belongs to, its place among the Thread's fences, and whether the answer has ended (P5). The spike checks whether that context can be read in the conversation editor.
     - **A new chat contract, as a fallback.** A bundle registers an element for a fence tag, and the chat hands it the fence's text, its state and its context.
   - Either way, there is **one fence rule**: the chat's opener and closer (`markdown.ts:129-140`). papercraft's reducer uses the same rule, so the chat and papercraft agree on what a fence is and on its ordinal (R15).
3. **The program reducer.**
   - A pure function in papercraft folds the fences of one program in order and gives, for each fence, the full program as of that fence.
   - It is not a chat projector, because the chat's built-in projection owns `text.delta` (`external-blocks.ts:44-50`). The client runs it over the answer text it already holds; the host runs it over the Thread log.
   - It merges once per closed fence and memoizes by fence text, so a 100 ms chat flush re-merges only the fence still streaming (R16).
   - A rewind that removes a fence removes its revision, because the input no longer holds it.
4. **The frame.**
   - The frame entry is rebuilt around OpenUI's `Renderer` with `openuiLibrary`, extended with the Project library.
   - The protocol gains two messages:
     - app → frame: "here is the program text, and whether it is still streaming", repeatable on a mounted frame;
     - frame → app: actions (P1) and OpenUI errors.
   - The frame keeps reporting its scene for pins and the tree.
5. **The Project library.**
   - Each repository may declare its components in files under `.doric/papercraft/schemas/` (U15), whose exports are `defineComponent` results. The compile pipeline bundles them as one library, with all of their exports.
   - `react`, `@openuidev/react-lang` and `zod` stay external and resolve to the frame's copies (R17).
   - The library's signatures for the instructions, and its JSON Schema for validation, exist only once the module is evaluated. Today's pipeline only bundles (`compile.ts:1-15`). Where evaluation happens is also question Q1:
     - in the Project sandbox under Node, where the agent already runs Project code;
     - or in the frame, which loads the module anyway.
   - Without a Project sandbox, the host bundles through `files/v1` (`compile.ts:5-6`), and nothing evaluates the module. In that case only the built-in library is offered, and the canvas node says why.
   - **The export component (U14).** A built-in component names a repository file and, optionally, an export or story. The pipeline compiles that export as today, with today's export choice and harness, and the frame mounts it. Its props are passed through without a schema, so the model gets no signature for them and errors show only at render (R18). A repository needs no library for this.
6. **Comments.**
   - `comments/v1` needs no change, because it never interprets a target or an anchor (`bundles/features/comments/src/host/comments.ts:1-6`).
   - The target is `{kind, id: the program's identity (U11), revision: the fence's ordinal in that program}`, and the anchor follows P6.
   - A pin whose statement no longer exists shows as detached.
7. **Host channel to the model.**
   - The current program after compaction (R2), and validation errors if Q4 wants them sent automatically (R6), reach the model through `runtime.threads/v1.instruct`.
   - `instruct` gives the Thread an instruction from a bundle, as a steer of the running prompt, or queued when nothing runs (`bundles/runtime/runtime/src/contracts/threads.ts:391-409`).
   - With `retain`, the executor keeps it "one per bundle and reason, through every compaction" (`bundles/runtime/runtime/src/contracts/model.ts:214-219`, `GROUNDING.md:757-762`).
   - This leaves `system` untouched, so the instructions in item 1 stay cacheable. The only request hook, `onBeforeModelRequestHook`, takes `{ system }` alone (`bundles/runtime/default/src/contracts/index.ts:21-32`).

## What is removed and what is kept

Line counts are from this tree on 2026-11-03. A kept client file counts as "changed" when it names `artifactId`, `revision`, the source stamp or the `init` message. That is a heuristic, and the spec confirms it file by file.

| Part                                                                                                                                                                                                                                                                                                                                                                                                                      | Lines | Fate                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------- |
| `bundles/features/artifacts/src`, except `desktop/cache.ts`                                                                                                                                                                                                                                                                                                                                                               | 4,134 | Removed, with its 3,110 lines of tests                                                                |
| `bundles/features/artifacts/src/desktop/cache.ts` and the protocol route                                                                                                                                                                                                                                                                                                                                                  |   240 | Moved to papercraft and renamed (P7)                                                                  |
| papercraft host: `tools/papercraft-preview.ts` 308, `kind.ts` 108, `previews.ts` 576                                                                                                                                                                                                                                                                                                                                      |   992 | Removed                                                                                               |
| papercraft host `entry.ts`, the module that mounts one export or story                                                                                                                                                                                                                                                                                                                                                    |   335 | Kept, adapted for the export component (U14)                                                          |
| papercraft client: `domain/preview-state.ts`, the reducer of `artifacts.*` events                                                                                                                                                                                                                                                                                                                                         |   447 | Removed; the program reducer replaces it                                                              |
| papercraft contracts: `papercraft.previews/v1`, the artifact kind and the copies of `artifacts/v1` and `artifacts.cache/v1` (`contracts/index.ts:26-132,167-359`)                                                                                                                                                                                                                                                         |   300 | Removed                                                                                               |
| papercraft tests: `tool`, `previews`, `client/preview-state`, `client/frame-runtime-old-revision`                                                                                                                                                                                                                                                                                                                         | 1,252 | Removed                                                                                               |
| papercraft client, unchanged: gestures, viewport, fit, pins layer, tree panel, comment field and overlay, thread popover and log, frame focus, stand-in, node footer, avatar, overlays, styles, and the frame's input, scene and storage                                                                                                                                                                                  | 3,663 | Kept as is                                                                                            |
| papercraft client, changed: `snapshots`, `live-frames`, `frame-memory` and `controller`, keyed by artifact and revision and assuming an immutable revision (`snapshots.ts:13-15,32-33,56`; `frame-memory.ts:1-4`); `frame-protocol` and `live-frame` (new messages); `scene-graph`, `scene`, `pin-geometry` and `comment-flow` (statement anchors); `command-toolbar`, `preview-header`, `threads-view` and `thread-open` | 3,586 | Kept, changed in part                                                                                 |
| papercraft client, rebased from artifact to program: `preview-container`, `preview-surface`, `preview-data`, `comment`, `anchor`, `canvas-registry`, `commands`, `elements`, `index`, `block`, `frames/preview/runtime`                                                                                                                                                                                                   | 3,680 | Kept, largely rewritten                                                                               |
| papercraft host compile pipeline: `bundle.ts`, `compile.ts`, `css.ts`, `sandbox.ts`, `theme.ts`, `paths.ts`, plus `sandbox/`                                                                                                                                                                                                                                                                                              | 2,549 | Kept; a library mode is added beside the single picked export, which the export component keeps (U14) |
| papercraft host `harness.ts`                                                                                                                                                                                                                                                                                                                                                                                              |   120 | Kept for the export component (U14); whether it also wraps library components is question Q1          |
| `docs/architecture/bundles/artifacts.md`                                                                                                                                                                                                                                                                                                                                                                                  |   236 | Removed                                                                                               |

**Totals.**

- **Removed:** about 5,870 source lines, 4,360 test lines and 236 doc lines.
- **Kept:** of the 15,085 papercraft source lines that stay, about 3,660 stay unchanged. The rest changes, because U6 keeps a canvas built around immutable artifact revisions and U3 keeps the compile pipeline.
- **New code:**
  - the fence handling in the chat (or the Lexical node);
  - the program reducer and fence states;
  - the frame renderer and its two new messages;
  - the library compile mode, with its evaluation step;
  - instruction delivery and the `instruct` channel;
  - the action proposal UI.

  The spec estimates its size. The third-party weight is in R4.

**Persisted data that stays behind.** The proposals below were for question Q8; U33 accepts them as spec D25 states them.

- **The desktop cache** under `userData/artifacts/` (`handler.ts:221`): delete the folder once, on the first start of the version that removes `artifacts`. Its size depends on each user's history and is not measured.
- **Each workspace's `.doric/artifacts/`** (`GROUNDING.md:1021-1022`): leave it in place. Doric stops reading it, and the release notes tell users they can delete it. Doric does not delete files in a user's workspace by itself.
- **The setting `artifacts.review-policy/v1`** (`GROUNDING.md:1020`): ignore it. Nothing reads it any more, and removing an unread setting is left to the settings bundle.

### Docs and decisions made stale

- [docs/architecture/bundles/artifacts.md](../architecture/bundles/artifacts.md): the whole concept of artifacts as the agent's durable deliverables, with identity, revisions, review policy and storage in `.doric/`.
- [docs/architecture/bundles.md:193-197](../architecture/bundles.md): the section "Artefatos e revisão" and its Papercraft entry.
- [docs/architecture/bundles/comments.md](../architecture/bundles/comments.md): comments on an artifact revision (`:7`, `:24-26`), and "a comment never authorizes", which links to the artifacts review policy (`:16`).
- [docs/architecture/bundles/papercraft/README.md](../architecture/bundles/papercraft/README.md) and [isolamento.md](../architecture/bundles/papercraft/isolamento.md).
  - The README's decision "the artifact is code, not JSON; the agent does not describe the interface in a schema" (`README.md:16`) is reversed: the agent now writes a program in a component language.
  - The 2026-10-27 decision to isolate every preview in an iframe (`README.md:15`) stands.
- `GROUNDING.md`: the `artifacts` bundle (`:1017-1046`), papercraft's tool, canvas node and window (`:1234-1236,1241,1290-1292`), the frame and its cache (`:1380-1406`), and the `/artifacts/*` route (`:1671,1679`).
- `implementation-decisions.md` records no decision about the `artifacts` bundle. Its mentions of "artifact" concern `doric.catalog/v1` distribution files (`:508,578,600,636,732`).

## Alternatives considered

- **Stream the existing tool.**
  - Keep `papercraft_preview` and draw its `tool_call.delta` while the file streams.
  - Rejected: it keeps artifacts (C1) and Project file writes (G4), and does nothing for G2.
- **A tool that carries the program** (`show_ui {id, program}`), weighed by its costs.
  - **It would solve:**
    - R6 and Q4, because a tool result returns validation errors;
    - R1, because the call carries an explicit identity, which U11 instead puts in the info string;
    - R15 and P5, because a tool call has one clear end, and an aborted call has a defined state;
    - and it needs no fence handling in the chat.
  - **It would cost:**
    - About 20 % more output tokens. JSON escaping of the program's many quotes gave 164 tokens for a 137-token program (`o200k_base`), which works against G2a.
    - Partial-JSON decoding of `tool_call.delta` to draw while streaming.
    - Prose and UI split into separate parts of the answer, instead of inline.
    - Rewriting OpenUI's instructions. Without `inlineMode`, the generated prompt opens with "Your ENTIRE response must be valid openui-lang code — no markdown, no explanations" (measured). Inside a tool description, that line must be replaced through `preamble`. That is possible, but the instructions no longer match what OpenUI tests.
    - A tool-call block renderer in the chat, which the chat also lacks.
  - **Outcome:** U1 chose the fence. The costs above are what the tool route would pay instead of R1, R6 and R15.
- **Render built-in-only fences in the chat window, without a frame.** This boots faster and needs no protocol change. First rejected by P2, because it means two render paths and react-ui's dependencies enter the app's realm; then chosen by U18 for conversation UI, with routing by tag instead of by content ([D7](../designs/openui.md#d7-render-hosts-and-routing)).
- **A new chat contract for fences, rather than a Lexical node.** This is the fallback in part 2, kept only if the Lexical node cannot learn its context.
- **Remove the artifact cache and write a smaller one.** Rejected in favor of P7: the existing cache is 240 lines, verifies SHA-256 and serves through a generic route.
- **A compatible reimplementation, or `@openuidev/browser-bundle`.** Rejected by U9. The browser bundle also lacks `defineComponent`.
- **A fence tag of our own.** Rejected in the coordinator's recommendation for U1, because OpenUI's instructions teach `openui-lang`. After U18 the spec keeps `openui-lang` for conversation UI and proposes ` ```papercraft ` for papercraft fences only ([D7](../designs/openui.md#d7-render-hosts-and-routing)).

## Riskiest assumptions

Each can be tested in the P3 spike.

1. The model writes valid programs and patches from about 9.7k tokens of instructions plus the Project's signatures.
2. react-ui boots in the frame under its CSP fast enough for G1, and three live frames fit in a window's memory.
3. A statement-name stamp can locate every rendered component without changing layout (R14).
4. Patches stay correct across many revisions and across compaction.
5. The Project library evaluates outside a browser to produce its signatures (part 5).
6. The Lexical code node can learn its Thread, ordinal and answer state (part 2).
7. OpenUI's churn can be held behind one adapter per side.
8. The agent asks the reader through fence forms as reliably as it does through `ask` today (U12, G3).

## Risks

- **R1 Merge target and name collisions.**
  - OpenUI assumes one evolving program, and its docs advise against edit mode when each response is a new, unrelated UI (https://www.openui.com/docs/openui-lang/incremental-editing).
  - With one program per Thread, a second, unrelated UI patches the first: its new `root` drops the old tree, but `$variables` are always kept, and a reused name such as `header` inherits the first UI's pins.
  - Mitigation: U11 gives each program an identity. Remaining risk: the model reuses an identity for an unrelated UI or forgets it. A fence without an identity starts a new program (U16), and the skill's prompt rule (U13) teaches the identity with an example.
- **R2 Compaction.**
  - Compaction rewrites the history the model reads into a summary, while the events stay in the log (`docs/architecture/bundles/context-compaction.md:7`). The program a later patch needs can be condensed away.
  - Even without compaction, the model sees a base plus a chain of patches, not the merged program.
  - Mitigation: the host computes the current program with the reducer and gives it to the model as a retained `instruct`, one per program identity, which compaction keeps (part 7). Its cost counts in G2b. Question Q3 decides when it is sent.
- **R3 Frame cost.**
  - **Bundle size.** The renderer plus `openuiLibrary` is 3.0 MB of minified JS and 873 KB gzipped (esbuild, production mode, React external). The default CSS is 33 KB. The files are served locally, so the cost is parsing and evaluation.
  - **Not measured yet:** boot time, memory per live frame, and the cost of re-parsing on each push. OpenUI's streaming parser diffs appended text (lang-core 1.0.2 `dist/index.d.mts:715-722`), but a P4 merge rewrites the text, which forces a full re-parse at each completed line.
  - **Latency floor.** The log writes coalesced deltas at most 250 ms after the first (`GROUNDING.md:1588-1592`), and the chat flushes every 100 ms (`chat/src/contracts/index.ts:125`). Text therefore reaches the frame in steps of up to about 350 ms.
  - **Frame cap.** A window keeps at most three live frames (`GROUNDING.md:1402`). This concept proposes that the warm frame counts as one of the three and becomes the live frame of the next fence.
  - Mitigation: the spike measures all of the above, on a cold and on a warm frame.
- **R4 Dependency weight.**
  - **react-ui** has 34 dependencies, among them Radix, d3, react-markdown with KaTeX, react-syntax-highlighter and @tanstack/react-table. It also has the peers `zustand` and `@openuidev/react-headless`, and it is still 0.x.
  - **react-lang** depends on `@openuidev/devtools` and `@openuidev/observability` (npm registry, 2026-11-03).
  - **Install.** The three packages with React, zod and zustand installed 235 packages.
  - **Transitive versions.** Exact pins do not fix transitive ranges: react-lang asks for `@openuidev/lang-core` `^1.0.2`.
  - Mitigation:
    - record the dependency as a decision, as for `@tailwindcss/oxide` and `happy-dom` (`docs/architecture/bundles/implementation-decisions.md:652,666`);
    - change the lockfile only through `npm install` (`GROUNDING.md:3207-3213`);
    - keep react-ui in the frame bundle only. Superseded by U18: react-ui also loads in the app, as a chunk loaded at a window's first conversation fence ([D29](../designs/conversation-openui.md#d29-the-conversation-renderer-in-the-app)).
- **R5 Instruction cost.**
  - About 9.7k tokens on every request once a Thread has loaded the skill (U13), plus the repository libraries' signatures. These counts use OpenAI tokenizers; the target model's tokenizer is counted in the spike.
  - The default preamble ("You are an AI assistant that responds using openui-lang") conflicts with Doric's system prompt, so a `preamble` is required.
  - Mitigation: U13 loads the skill only when needed; the skill stays static, so it stays cacheable.
- **R6 Invalid programs without a tool result.**
  - A fence has no tool result. OpenUI reports errors such as `unknown-component`, `type-mismatch` and `no-root` through `onError`, and drops invalid components rather than breaking the page (https://www.openui.com/docs/openui-lang/renderer).
  - Mitigation:
    - the canvas node always shows the frame's errors to the reader;
    - whether the agent learns them automatically is question Q4.
  - Only an automatic answer needs host validation, which means running the reducer and lang-core's parser on the host against the library's JSON Schema. The errors would then reach the model as an `instruct` steer of the running prompt, which it takes in "before its final answer would end the turn" (`threads.ts:376-380`). If Q4 chooses a reader's button instead, there is no host validation, and the JSON Schema output of part 5 is not needed.
- **R7 The library compile writes into the workspace.**
  - The host copies the runner into `.doric/papercraft/` once per runner version, and each compile writes a job folder there and removes it afterwards (`bundles/features/papercraft/src/host/sandbox.ts:4-8,61-62,92-93`), as it does today. papercraft writes `.doric/papercraft/.gitignore` before its first write there, which keeps the runner and the jobs out of Git ([D8](../designs/papercraft-openui.md#d8-doric-layout-and-versioning)).
  - A fence that uses only built-in components compiles nothing.
  - Mitigation: G4's target (U40) names these three writes and allows no other Project file change; U31's one-time migration of `.doric/.gitignore` is the one exception, confirmed by the user.
- **R8 Serving the library module.** The frame's `script-src` allows only `doric://app` and the import map hash (`csp.ts:50`), so the module cannot arrive as a `blob:`. Mitigation: P7 keeps the verified cache and route.
- **R9 Embedding gaps.**
  - **Remote images.** `openuiChatLibrary`'s instructions suggest picsum images (measured). react-ui's `TimelineToolCard` and `SourceContext` load favicons from google.com. The frame's `img-src doric://app data: blob:` blocks both (`csp.ts:53`).
  - **Fonts.** KaTeX fonts must come from `doric://app`, the only `font-src` (`csp.ts:52`).
  - **Devtools.** In a development build, react-lang imports `@openuidev/devtools`, which loads `devtools.browser.js` from cdn.jsdelivr.net (react-lang 1.0.2 `dist/index.mjs`, devtools 0.3.1 `dist/index.mjs`).
  - **Links.** `@OpenUrl` cannot navigate a frame that may only navigate to its own document (`docs/architecture/bundles/papercraft/isolamento.md:35`).
  - Mitigation:
    - use `openuiLibrary`, not the chat library;
    - add a prompt rule against remote images;
    - build the frame bundle in production mode;
    - question Q9 for `@OpenUrl`.
- **R10 Old events drawn as payloads.** A versioned event type that no projector claims becomes one generic block per event (`external-blocks.ts:6-7,92-115`). Mitigation: P8.
- **R11 Two design systems in one frame.**
  - react-ui is built on Radix and themed with `--openui-*` variables.
  - Project components today use Base UI from the import map (`app/desktop/doric/src/platform/protocol/frame.ts:15-30`) and a generic theme that "belongs to no application, Doric included" (`bundles/features/papercraft/src/host/css.ts:5-7`).
  - Mitigation: question Q5, measured by G5.
- **R12 OpenUI churn.**
  - **Releases.** lang-core first shipped on 2026-03-25, and 1.0.0 shipped on 2026-10-12. From 2026-08-03 to 2026-11-03 it had 16 releases, going from 0.2 through 0.3 and 0.4 to 1.0 (https://registry.npmjs.org/@openuidev/lang-core).
  - **Other renderers.** The Vue, Svelte and Angular renderers stay on 0.4 (https://www.openui.com/docs/openui-lang/whats-new).
  - **Policy.** No breaking-change policy is stated (https://www.openui.com/docs/openui-lang/evolution-guide).
  - Mitigation:
    - exact pins;
    - one adapter module per side (host and frame) as the only importer of `@openuidev/*`;
    - the P3 setting as a rollback until removal.
- **R13 Actions from untrusted code.** Covered by P1's mitigations.
- **R14 Stamping statements changes layout.**
  - OpenUI passes each component its `statementId`; inline components have none (react-lang 1.0.2 `dist/index.mjs`, `RenderNodeInner`; lang-core 1.0.2 `dist/index.d.mts:158-161`).
  - To stamp built-in components, papercraft overrides them with `library.extend({components: {override}})`, which replaces a component "by name" (lang-core 1.0.2 `dist/index.d.mts:630`).
  - A wrapper element would change flex and grid layout. Radix dialogs, selects and tooltips render into portals outside any wrapper.
  - Mitigation:
    - the wrapper is `display: contents`, which has no box, and the scene computes the statement's box from its children's boxes;
    - a click inside a portal, or with no named statement above it, falls back to a `point` anchor that names the nearest component (P6);
    - a click on an inline component anchors to its nearest named ancestor.
- **R15 Two fence scanners.**
  - The chat ends a fence at any line of three or more backticks (`markdown.ts:134-141`), while lang-core's `stripFences` skips string literals.
  - A program string that holds such a line would end the chat's fence early, and the two sides would hold different text.
  - Mitigation:
    - papercraft never uses `stripFences`, and the chat's rule is the only one (part 2);
    - a prompt rule forbids lines of only backticks inside strings.
- **R16 Reducer cost.** The chat's projectors run over the whole log on every batch (`bundles/desktop/chat/src/client/hooks/use-external-blocks.ts:68-69`). Mitigation: the reducer merges once per closed fence and memoizes (part 3), and the spike measures it on a Thread with 50 revisions.
- **R17 Version coupling with the Project.**
  - Making `@openuidev/react-lang` and `zod` external ties every Project library to the frame's copies.
  - The peers accept `zod ^3.25 || ^4`, while Doric pins `zod ^4.4.3` (root `package.json:27`).
  - A Project built against zod 3, or against another react-lang, would compile and then fail at runtime.
  - Mitigation: the frame's versions are the contract. The compile resolves those imports to the frame's copies and refuses a Project whose `package.json` asks for an incompatible range, naming both versions.
- **R18 Unvalidated export props.** The export component (U14) passes props with no schema, so a wrong prop shows only when the export renders. OpenUI reports a component that throws as `render-error` (https://www.openui.com/docs/openui-lang/renderer). Mitigation: the canvas node shows the error, and it reaches the agent like any other (Q4). Registering the component in a repository library adds typed props.
- **R19 Removing `ask`.** Prompts, skills and workflows that call `ask` stop working until they change (U12). The fence form must keep `ask`'s rules: only the main Thread asks, and the answer arrives as the next user request (`ask.ts:10-11`). Mitigation: `ask` leaves only at P3's default step, after the fence form works. The spec lists every mention of `ask`.

## Open questions

Ordered by impact on the spec. On 2026-11-03 the user answered the proposed concept's Q1, Q2 and Q4 (now U11–U13), part of its Q5 (U14) and P3 of its Q3 (U10). The rest were renumbered.

- **Q1 Repository libraries (rest of the former Q5).**
  - How does a repository declare its library? Closed by U15: versioned files under `.doric/papercraft/schemas/`, written by the agent or the developer ([D8](../designs/papercraft-openui.md#d8-doric-layout-and-versioning)).
  - Where is the module evaluated, when is it compiled, and does the harness wrap library components? Closed by U30: in the Project sandbox under Node with stubs; when a window draws a fence and at prompt start in Threads that loaded the skill, after a manifest check; the harness wraps the whole program.
- **Q2 Proposals.** Closed: P1 and P4–P8 are confirmed (U17), P2 is replaced by U18, and P3 is accepted as U10.
- **Q3 Compaction.** Closed by U24: no program is re-sent; the skill's rule makes the model write a program whole when its last text is gone.
- **Q4 Validation feedback.** Closed by U19: automatically, at the start of the next prompt.
- **Q5 Theme.** Closed by U34: repository components keep the repository's own CSS, and react-ui takes Doric's tokens; G5 measures the result.
- **Q6 Targets.** Are G1–G5's targets right, and which fixed task set sets today's baseline? Closed by U48 (no target is measured or gates a stage; each stage ships when the user accepts it) and U40 (G4's target, checked by a test).
- **Q7 Fence tag.** Closed by U20: `openui-lang` for conversation UI and `papercraft` for papercraft, each with the identity after it (U11, spec [D7](../designs/openui.md#d7-render-hosts-and-routing)).
- **Q8 Leftovers.** Closed by U33:
  - The Approve step and the `request` policy are not replaced.
  - The canvas window route `/papercraft/:projectId/:threadId/:artifactId` is rekeyed to the program identity.
  - The rules for persisted data in spec D25 hold.
  - The comment kind `papercraft-preview` (`bundles/features/papercraft/src/contracts/index.ts:612`) becomes `papercraft-program`.
  - `comment_reply` stays: it is the `comments` bundle's own, generic tool (`comment-reply.ts:1-9`).
- **Q9 `@OpenUrl`.** Closed by U29: disabled in stages 2–4; the URL is shown as text.
- **Q10 Local state.** Closed by U38: form values and `$variables` reset when a fence remounts, in both hosts.
- **Q11 Docs.** Closed by U39: the specs update GROUNDING.md and the READMEs in the stages they name, and this feature doc replaces the Portuguese README and `isolamento.md`, with a summary of the frame decisions.

## Current behavior and contracts

Stages 2–4 of [openui.md](../designs/openui.md#phases) shipped on 2026-11-06; the old preview path, `ask` and the `artifacts` bundle are gone. [How papercraft works today](#how-papercraft-works-today) describes the version before this concept. The current one:

- **Conversation UI** ([conversation-openui.md](../designs/conversation-openui.md), [bundles/features/openui/README.md](../../bundles/features/openui/README.md)). The agent writes OpenUI Lang in `openui-lang` fences, which the chat draws while the answer streams. A fence with an earlier identity is a patch merged by statement name. A click on a control is sent to the agent in a `<ui-action>` envelope through `chat.send/v1.sendAction`, only from the latest closed revision in a main Thread. A fence whose first line is `root = AskForm(…)` is the question form that replaces `ask`; `openui.questions/v1` answers it and writes `openui.answered/v1`. Errors of drawn fences reach the agent at its next prompt through `openui.programs/v1`. No setting governs any of it.
- **Papercraft** ([papercraft-openui.md](../designs/papercraft-openui.md), [bundles/features/papercraft/README.md](../../bundles/features/papercraft/README.md)). The agent writes a `papercraft <identity>` fence; the app draws it as a canvas node, with repository libraries from `.doric/papercraft/schemas/` and `Export(path, name?, props?)`, in the sandboxed frame `client/frames/openui.js`. Papercraft fences have no actions. Modules are served from `userData/papercraft/` at `doric://app/papercraft-modules/*`. Comments target `{ kind: 'papercraft-program', id: <identity> }`. The only Project writes are `.doric/papercraft/.gitignore`, the runner copy and temporary job folders, plus the one-time `.doric/.gitignore` migration.
- **Chat** ([bundles/desktop/chat/README.md](../../bundles/desktop/chat/README.md)). `chat.views/v1` 1.1.0 has `registerFenceRenderer` and `watchFences`; a queue receipt ends no turn.
- **Frame decisions kept** from [isolamento.md](../architecture/bundles/papercraft/isolamento.md): an opaque origin, the CSP, CORS by path prefix, at most three live frames per window with snapshots, and in-memory storage.
- **Persisted data.** Old `artifacts.*`, `threads.asked/v1` and `threads.answered/v1` rows replay as nothing. The desktop deletes `userData/artifacts/` at every start. Each workspace's `.doric/artifacts/` is no longer read, and users can delete it; Doric does not delete it. The setting `artifacts.review-policy/v1` stays stored and unread.

## Evolution

- 2026-11-03: concept proposed. It rebuilds papercraft on OpenUI with inline fences, patches merged by statement name, and no artifacts.
- 2026-11-03: revised after the Scope, Critique and Comprehension reviews.
  - Added: G5, the split of G1 and G2, proposals P3–P8, the `instruct` channel, the stale-docs list, persisted data, and risks R14–R17.
  - Weighed the tool alternative by its costs.
  - Recounted what is kept.
  - Added terms and an example.
- 2026-11-03: accepted by the user. Recorded U10 (delivery in P3's order, starting with the spike), U11 (identity in the info string), U12 (generative UI replaces `ask`), U13 (instructions as a static skill plus a retained `instruct`) and U14 (previewing any export stays). Added repository libraries, the export component and R18–R19, and renumbered the open questions.
- 2026-11-03: recorded U15 (repository libraries under `.doric/papercraft/schemas/`), which closes the declaration part of Q1, and linked the spec [docs/designs/papercraft-openui.md](../designs/papercraft-openui.md) (draft, version 1).
- 2026-11-03: the user confirmed that the schema files are versioned in Git. U15 records it as a decision, with "local, not versioned" as a rejected alternative; the spec is at version 2.
- 2026-11-03: recorded U16 (a fence without an identity starts a new program) and U17 (P1 and P4–P8 confirmed); P2 stays open. The spec is at version 3, after its Scope review: per-folder ignore files under `.doric/` (D8), and an action proposal drawn on the composer's stack (D20), pending.
- 2026-11-03: recorded U18 (conversation UI renders in the app, only papercraft in the frame; replaces P2) and U19 (validation feedback automatic; closes Q4); Q2 closed. The spec was split into three documents, one per concept: [openui.md](../designs/openui.md), [conversation-openui.md](../designs/conversation-openui.md) and [papercraft-openui.md](../designs/papercraft-openui.md) (version 4). G1 gained targets for conversation fences in the app.
- 2026-11-03: recorded U20 (D7, D27 and D29 confirmed; closes Q7) and U21 (conversation actions send on click, with the prompt-injection risk accepted; D6 pending, with its trade-offs in the papercraft spec). Specs now at [openui.md](../designs/openui.md) version 2, [conversation-openui.md](../designs/conversation-openui.md) version 2 and [papercraft-openui.md](../designs/papercraft-openui.md) version 5.
- 2026-11-03: recorded U22 (papercraft fences have no actions; spec D6 confirmed; P1 narrowed to conversation UI). Specs now at [openui.md](../designs/openui.md) version 3, [conversation-openui.md](../designs/conversation-openui.md) version 3 and [papercraft-openui.md](../designs/papercraft-openui.md) version 6.
- 2026-11-03: the stage 2 reviews of [openui.md](../designs/openui.md) (version 4) and [conversation-openui.md](../designs/conversation-openui.md) (version 4) were answered. Proposals pending the user's confirmation: no host reads fences, and errors come only from drawn fences through the renderer's `onError` (narrows U19); no programs instruct after compaction (answer to Q3); conversation actions only on the latest closed revision in a main Thread (narrows U21); question fences are never patched, and the answer is keyed by the questions' digest.
- 2026-11-03: the stage 2 reviews of [papercraft-openui.md](../designs/papercraft-openui.md) (version 7) were answered. Proposals pending the user's confirmation: fences are bound by a `papercraft.cwd/v1` event written at every prompt start and move, so the prompt that loads the skill draws repository components; a fence waits for its library, and one drawn without it reports no errors (narrows U19); the library instruct is given only at prompt start or at a move, never after a compile; the library job reports a Git rule that hides the schemas; the harness search stops at the repository root; fixed limits for libraries, the host memo and the desktop cache.
- 2026-11-03: recorded U23–U39, the user's answers to the stage 2 questions of the three specs (task sets and targets except G4's; two skills; no durable local state; docs; errors only from drawn fences, narrowing U19; no programs instruct; spike runs and stage gates; actions only on the latest closed revision in a main Thread, narrowing U21; rewind and `Modal` rules; old asks and `@OpenUrl`; the repository library pipeline, `.doric/` migration, harness stop, leftovers, theme and limits); Q1, Q3, Q5, Q8, Q9, Q10 and Q11 closed, Q6 answered except G4's target. Specs now at [openui.md](../designs/openui.md) version 5, [conversation-openui.md](../designs/conversation-openui.md) version 5 and [papercraft-openui.md](../designs/papercraft-openui.md) version 8.
- 2026-11-03: recorded U40 (G4's target: no Project file change, checked by PC17; the only writes are `.doric/papercraft/.gitignore`, the runner copy and temporary job folders; U31's migration is the one exception, which the user confirmed: once per workspace and only when the old file exists), which closes Q6; G4's row and R7 follow. The stage 3 Scope reviews of the three specs were answered: [openui.md](../designs/openui.md) version 6 (one error sink for both tags, the fold's memo without a chat contract rule, the question rule passed by its owner), [conversation-openui.md](../designs/conversation-openui.md) version 6 (a question keyed by its prompt and digest, one send route, no `refused` state, no chunk retry, no P2 question path) and [papercraft-openui.md](../designs/papercraft-openui.md) version 9 (no app check for `Query`/`Mutation`, no Thread cap on its entries, no stored flag for the desktop cache). Recorded U41: `ask` is withheld in stage 3, as D24 states, which closes [openui.md open question 7](../designs/openui.md#open-questions).
- 2026-11-04: the stage 4 Readiness and Codebase reviews were answered: [openui.md](../designs/openui.md) version 7 (the setting read by windows through `openui.setting/v1` and switched in a settings section, the `openui` skill's registration, the shell's error reporting rules, the 42 theme variables mapped to Doric's tokens, the queue-receipt change in full), [conversation-openui.md](../designs/conversation-openui.md) version 7 (the action text from react-lang's `formState`, the question service's ports, the renderer's entry and chunk split, the keys inside a fence, the markup check of `ask`'s look) and [papercraft-openui.md](../designs/papercraft-openui.md) version 10 (the old preview path kept beside the new one until stage 4, the memo keyed by Project, the rewind rule of the per-Thread entry, shims that read a namespace the frame publishes, canvas ids). The user then accepted the four recommendations of that resolution: U42 (react-ui's peer dependencies, extends U9), U43 (`ask`'s look checked by markup), U44 (`AskForm` reserved, extends U35) and U45 (the desktop cache cut back at the first `ensure` of each app session, changes U35's timing). U27 gains a clarification: a rewind removes rows by log position, so rewinding a prompt that ran between the question and the answer also makes the question pending again. No open question remains in the concept or the three specs.
- 2026-11-04: the repeated stage 4 Readiness and Codebase reviews were answered, with no change to a U-decision or a Goal, and the user approves the specs after this round: [openui.md](../designs/openui.md) version 8 (every browser build defines `process.env.NODE_ENV` as `"production"`, so OpenUI's dev tools neither mount nor ship; the `openui` skill's rules written word for word, with OpenUI's own rules kept; the fence node's rebuild, `watchFences` and the fold's and reporter's failure rules; when `openui` withholds `ask`) and [conversation-openui.md](../designs/conversation-openui.md) version 8 (an action's text for a form nobody typed into and for react-ui's card items; the question service's failures; one reading of a question for drawing, checking and supersession, with only a closed, valid question superseding; the client chunks' build; the default system prompt's line for `<ui-action>`; rollback by code) and [papercraft-openui.md](../designs/papercraft-openui.md) version 11 (the cwd event appended through a scoped call, at a move only while a prompt runs; library jobs started only at prompt start in Threads that loaded the skill; an instruct for every library failure; the full list of reserved component names; the worker's realm for schema evaluation; the frame without OpenUI's dev tools; a shell module shared by both frame entries).
- 2026-11-04 to 2026-11-05: Stage 1, the spike, was planned and its measuring instrument built ([openui.md](../designs/openui.md) versions 9 to 14, [papercraft-openui.md](../designs/papercraft-openui.md) version 12), and the user answered two of openui.md's open questions on that instrument. The specs stayed approved.
- 2026-11-05: recorded U48 (the spike and its measurements dropped; the instrument deleted; each stage ships when the user accepts it; four earlier decisions on the spike withdrawn), which closes Q6 with U40. Specs now at [openui.md](../designs/openui.md) version 15, [conversation-openui.md](../designs/conversation-openui.md) version 9 and [papercraft-openui.md](../designs/papercraft-openui.md) version 13; the options a measure would have triggered stay there as risk notes without thresholds.
- 2026-11-06: stages 2–4 shipped. Stage 2 added the `openui` bundle, the conversation fences, the question form, actions, validation feedback, and the papercraft fence with repository libraries behind `openui.generative-ui/v1`, plus the queue-receipt fix for every reader (commits `b891eb03`, `cedecbbf`). Stage 3 made the new path the default (`61b9681d`). Stage 4 removed the old preview path, `ask`, the `artifacts` bundle and the Generative UI setting (`814e2136`). Status set to `implemented`. Decisions are recorded in [implementation-decisions.md](../architecture/bundles/implementation-decisions.md), and the READMEs and `GROUNDING.md` describe the new path. Release note: each workspace's `.doric/artifacts/` can be deleted.
