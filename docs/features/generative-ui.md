# Feature: generative UI in the conversation

- Status: `implemented` (2026-11-06; accepted 2026-11-03 as part of the [papercraft](papercraft.md) concept).
- Brief: the conversation's generative UI, the `openui` bundle ([bundles/features/openui/README.md](../../bundles/features/openui/README.md)). Papercraft's own fence, repository libraries and canvas are in [papercraft.md](papercraft.md).
- Specs: [docs/designs/openui.md](../designs/openui.md) (the shared base: packages, fences, the fold, render hosts, the skill, validation and phases) and [docs/designs/conversation-openui.md](../designs/conversation-openui.md) (generative UI in the conversation, the question form and actions).
- Decisions: the user's decisions U1–U48 are listed in [papercraft.md](papercraft.md#decisions); their implementation is recorded in [implementation-decisions.md](../architecture/bundles/implementation-decisions.md) under "OpenUI" (2026-11-06).

## Summary

The agent can answer with UI. It writes an OpenUI Lang program in an `openui-lang` fence of its answer, and the chat draws it while the answer streams: forms, tables, charts, and the question form with which the agent asks the reader to decide something. A click on a control goes back to the agent as the reader's next message, and errors in a drawn program reach the agent at its next prompt.

## Problem

Before this feature, an agent could only describe UI in words, and it asked the reader to choose through a dedicated tool, `ask`, with its own rows in the Thread log. Generative UI lets the answer itself carry the UI, and replaces `ask` with a program the same renderer draws ([conversation-openui.md](../designs/conversation-openui.md#problem)).

## Decisions

- **The conversation renders in the app, papercraft in a frame** (U18). Conversation fences are drawn by the app with react-ui's library and Doric's tokens; only papercraft's fences run in the isolated frame.
- **Generative UI replaces `ask`** (U12). The question form is a fence whose first line is `root = AskForm(…)`; `ask` and its `threads.asked/v1` and `threads.answered/v1` rows are gone, and old rows replay as nothing.
- **Actions send on click** (U21), only from the latest closed revision of a program in a main Thread, with the prompt-injection risk accepted.
- **Errors come only from drawn fences** (U23) and reach the agent at its next prompt (U19).
- **Instructions are a static skill** (U13, U37): `openui`, generated from OpenUI's prompt builder and committed.
- **No durable local state** (U38): form values and `$variables` reset when a fence remounts.
- **Its own feature doc** (docs step, 2026-11-06): the conversation's generative UI is described here rather than inside [papercraft.md](papercraft.md).

## Current behavior and contracts

- **Fences.** `openui-lang`, drawn by `<openui-fence>` and registered with `chat.views/v1.registerFenceRenderer`. An identity after the tag names the program; a later fence with the same identity is a patch merged by statement name, and a fence without one starts a new program. Each fence is a revision, `streaming`, `closed` or `unterminated`. No setting governs it.
- **Renderer chunk.** The client entry holds only the element, the projector and the live rows; OpenUI's renderer, the conversation library, the checks, the actions and the question form are in `client/chunks/renderer.js`, imported once per window at the first fence. Doric's tokens map 42 `--openui-*` variables.
- **The question form.** `AskForm` holds one to five `AskQuestion`s of two to six `AskOption`s each, with an optional `context`, and is never a patch. `openui.questions/v1` answers `status` and `answer`; the first answer is final, is sent as the reader's next message, and is written as `openui.answered/v1`.
- **Actions.** A click sends its text through `chat.send/v1.sendAction`, wrapped in `<ui-action program="…">`: the action's message, then the form's values or the program's `$variables`, at most 16,000 UTF-16 code units.
- **Errors.** `openui.programs/v1.reportErrors` keeps a drawn fence's errors per Thread, for both fence tags, and delivers them once, as one `validation` instruct at the start of the Thread's next prompt.
- **The skill.** `openui` (order 3400, loaded on demand): the language, the built-in components, the question form and how to read a `<ui-action>`. Its body is `bundles/features/openui/src/host/skills/openui.md`, regenerated with `OPENUI_SKILL_UPDATE=1` ([README](../../bundles/features/openui/README.md#development)).

## Evolution

- 2026-11-03: accepted by the user as part of the [papercraft](papercraft.md#evolution) concept, with the specs [openui.md](../designs/openui.md) and [conversation-openui.md](../designs/conversation-openui.md).
- 2026-11-06: stage 2 shipped the `openui` bundle behind `openui.generative-ui/v1`: fences, the question form, actions and validation feedback (`b891eb03`).
- 2026-11-06: stage 3 turned it on by default (`61b9681d`).
- 2026-11-06: stage 4 removed `ask` and the Generative UI setting (`814e2136`). Status `implemented`; this feature doc created.
