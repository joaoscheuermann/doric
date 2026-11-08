# Spec: OpenUI in the conversation — answers with UI, the question form and actions

- Ticket: none. The work comes from the accepted concept [docs/features/papercraft.md](../features/papercraft.md); no Linear issue exists for it.
- Status: stages 2–4 implemented (shipped on 2026-11-06; see [docs/features/papercraft.md](../features/papercraft.md#evolution)); stage 5 implemented (built on 2026-11-06): version 11 (2026-11-06) records the conversation's part of U49–U51 ([openui.md](openui.md#stage-5-fixes-after-use-u49u51)). Approved by the user, version 9 (2026-11-05), which records U48: the spike and its measurements are dropped, and each stage ships when the user accepts it; see [Revisions](#revisions).
- Companions: [openui.md](openui.md) (the shared base: packages, fences, fold, render hosts and routing, library and tokens, instructions, validation, setting, the `openui` bundle and phases) and [papercraft-openui.md](papercraft-openui.md) (papercraft's use of OpenUI). A decision lives in one document; the [decision map](openui.md#decision-map) lists all of them.
- Bundles touched by this document: `openui` (new; its conversation parts), `chat` (`chat.send/v1` 1.0.0 → 1.1.0 `sendAction` and the `<ui-action>` envelope, D20; the fence contract is [D1](openui.md#d1-the-fence-in-the-chat-a-new-chat-contract)), `threads` (`ask` withheld in stage 3 and removed in stage 4), `default` (one line of its system prompt, D20), `packages/bundle` (client chunks, D29).
- Feature docs: [docs/features/papercraft.md](../features/papercraft.md) (the concept, status `implemented`) and [docs/features/generative-ui.md](../features/generative-ui.md) (the conversation's generative UI, status `implemented`).
- Paths are written from the repository root. Line references are checked against commit `1baa9bb5` and name each file as it is before this change. References to OpenUI packages name the published file of the pinned version (lang-core 1.0.2, react-lang 1.0.2, react-ui 0.18.1 on unpkg).

## Contents

- [Problem](#problem)
- [Goals](#goals)
- [Terms](#terms)
- [Decisions already made](#decisions-already-made)
- [Non-goals](#non-goals)
- [Design decisions](#design-decisions)
- [Design](#design)
- [Phases](#phases)
- [Files to change](#files-to-change)
- [Test plan](#test-plan)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Open questions](#open-questions)
- [Docs to update](#docs-to-update)
- [Revisions](#revisions)

## Problem

Today the agent can show UI only as a design preview of Project code, and it asks the reader through the `ask` tool, whose answers arrive as the next user request (`bundles/features/threads/src/host/tools/ask.ts:10-11`). It cannot answer with a form, a table, a filterable list or a choice laid out as UI (concept [Problem](../features/papercraft.md#problem)).

With U18, the conversation follows OpenUI's own model: the agent writes an OpenUI Lang program in an ` ```openui-lang ` fence of its answer, and the shell draws it while it streams, with `Renderer` ([OpenUI's renderer documentation](https://www.openui.com/docs/openui-lang/renderer)). This document decides:

- how a conversation fence is drawn in the shell, and under which CSS and CSP rules (D29);
- how a question to the reader works without the `ask` tool (U12, D21, D22);
- how an action in the UI reaches the agent (P1, D20);
- how `ask` is withheld and then removed (D30).

The fence contract, identity, revisions, progressive merge, routing, library, instructions and validation are shared with papercraft and live in [openui.md](openui.md).

## Goals

The concept's goals ([Goals and success measures](../features/papercraft.md#goals-and-success-measures)) that this document serves, with what decides each: a test, or, where no test can, the user's acceptance of the stage that ships it (U48).

| Goal                                      | Check                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1a, G1b in the shell                     | The renderer loads at a window's first fence and draws each completed statement while the fence streams (D29, [D5](openui.md#d5-progressive-merge-of-patches-p4)); the user's acceptance (U48)                                                                              |
| G3 Generative UI, every question included | The `openui` skill's medium and question rules ([D17](openui.md#d17-instructions-the-skills-u13-concept-q3)); the user's acceptance (U48)                                                                                                                                   |
| `ask`'s look is kept (U12)                | `AskQuestions` and `Settled` are copied with their styles and stories; the props they gain default to today's output, and with those defaults each of the 12 story states renders the same markup in `openui` as in `threads` (test C9; checked by markup, not pixels, U43) |
| The answered state is durable (U12)       | After replay and after a reload an answered question still reads `answered`; after a rewind it reads `pending` exactly when the rewind removed its answered row ([Durable across replay and rewind](#durable-across-replay-and-rewind), test C6)                            |
| Only the main Thread asks (U12)           | `answer` in an agent Thread is `unavailable` and sends and writes nothing (test C5)                                                                                                                                                                                         |
| The app outside a fence is unchanged      | react-ui's layered sheet and Doric's tokens (D29, [D31](openui.md#d31-the-built-in-library-and-dorics-tokens)) and the unchanged shell CSP (D29); the user's acceptance (U48)                                                                                               |
| `ask` is gone after stage 4 (U12)         | No `ask` tool, no `threads.ask/v1` and no `<threads-ask>` registered; old `threads.asked/v1` rows draw no block (test C12)                                                                                                                                                  |

## Terms

Terms are those of [openui.md](openui.md#terms). This document adds:

| Term                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main Thread, agent Thread                 | A Thread the reader started (`origin` `user` or absent) and a Thread an agent spawned for a subagent (`origin` `agent`, `bundles/desktop/chat/src/client/domain/workspace.ts:26`). This document tests `origin === 'agent'` alone, as the runtime does when it refuses the reader's input (`bundles/runtime/runtime/src/host/domain/service.ts:1180,1222`); chat's `isAgentThread` also requires `parentThreadId` (`workspace.ts:51-54`) and is not used here. |
| `desktopScope`                            | The scope fields a desktop call carries to a host contract, declared per method in the manifest (`docs/architecture/bundles/implementation-decisions.md:1144`).                                                                                                                                                                                                                                                                                                |
| `CallArg`                                 | The optional last argument of a contract method: a call or call options (`packages/bundle/src/contracts/call.ts:60`).                                                                                                                                                                                                                                                                                                                                          |
| composer stack                            | The reader's draft comments above the composer, sent with the next prompt (`bundles/desktop/chat/src/client/stores/composer-stack.ts`).                                                                                                                                                                                                                                                                                                                        |
| paused queue                              | A Thread's queue of prompts held after the reader stopped a run; the composer resumes it before a new prompt so that prompt runs (`bundles/desktop/chat/src/client/hooks/use-thread-chat.ts:93-105`).                                                                                                                                                                                                                                                          |
| empty queue                               | A queue with no `current`, no `resumable` and no `items`. In the chat that is `queueItems(queue)` being empty (`bundles/desktop/chat/src/client/domain/queue.ts:43-49`), which the hook tests today (`use-thread-chat.ts:95`); on a host it is the same three fields of the runtime's `ThreadQueue` (`bundles/runtime/runtime/src/contracts/model.ts:489-497`). A paused queue that holds a `resumable` prompt is not empty.                                   |
| `ContractError` codes                     | `invalid_input` and `unavailable`, among others (`packages/bundle/src/contracts/error.ts`).                                                                                                                                                                                                                                                                                                                                                                    |
| `threads.asked/v1`, `threads.answered/v1` | Today's events of a question `ask` showed and of its answers, defined in `bundles/features/threads/src/contracts/index.ts:211-231` and folded by `bundles/features/threads/src/host/ask.ts:79-110`; `askProjector` draws them as `<threads-ask>` (`bundles/features/threads/src/client/index.ts:26,46`).                                                                                                                                                       |
| entry, chunk                              | The `openui` client's two builds: `client/index.js`, which the window loads with the bundle, and `client/chunks/renderer.js`, which the entry imports at the first fence (D29). Each is its own esbuild bundle, so a module both import exists twice; only import-map specifiers, `openui/contracts` among them, exist once per window (`packages/bundle/src/build/externals.ts:10-25`, `packages/bundle/src/build/parts.ts:118-119,173-174`).                 |

## Decisions already made

All of [openui.md](openui.md#decisions-already-made) bind this document. The ones it implements:

- **U12** Generative UI replaces `ask`, drawn in the current visual style of `ask`'s question block; only the main Thread asks; the answers arrive as the next user request.
- **U17** P1 is confirmed: local interactivity and `@ToAssistant`, as [D20](#d20-actions-back-to-the-agent-p1).
- **U18** Conversation UI renders in the shell; only papercraft renders in the frame ([D7](openui.md#d7-render-hosts-and-routing)).
- **U19** Errors reach the agent at the start of the next prompt ([D18](openui.md#d18-validation-feedback-u19)); U23 narrows it to fences a window drew, and U50 changes its timing.
- **U20** Routing by fence tag, the `openui` bundle and the renderer loaded at a window's first fence (D29) are confirmed.
- **U21** A conversation action sends on click, with no review step; the user accepts the prompt-injection risk of model-written button text ([R24](#risks)). U26 narrows it.
- **U22** Papercraft fences have no actions; the action rules of both hosts are in [D7](openui.md#d7-render-hosts-and-routing).
- **U23** Errors come only from fences a window drew, through the renderer's `onError` ([D18](openui.md#d18-validation-feedback-u19)).
- **U26** Actions work only on the latest closed revision, in a main Thread ([D20](#d20-actions-back-to-the-agent-p1)).
- **U27** A rewind of the prompt that took the answers makes the question pending again ([D22](#d22-the-question-service-durable-state-and-the-main-thread-rule)).
- **U28** `Modal` is drawn inline ([D29](#d29-the-conversation-renderer-in-the-app)).
- **U29** Old asks draw nothing in stage 4 and their answers stay as user text ([D30](#d30-removing-ask)); `@OpenUrl` is disabled in stages 2–4 ([D7](openui.md#d7-render-hosts-and-routing)).
- **U38** No durable local state: form values and `$variables` reset when a fence remounts.
- **U41** `ask` is withheld in stage 3 through `withholdTool`, not left registered until stage 4 ([D24](openui.md#d24-the-setting-and-rollback), D30).
- **U43** (2026-11-04) The Goal "`ask`'s look is kept" is checked by markup, not pixels: each of the 12 story states renders the same `innerHTML` with `openui`'s copy as with `threads`', over the same CSS (C9, [D21](#d21-the-question-form), [D29](#d29-the-conversation-renderer-in-the-app)).
- **U48** (2026-11-05) The spike and its measurements are dropped; each stage ships when the user accepts it ([openui.md](openui.md#decisions-already-made)). The Goals, D29, R19 and R26 cite no measure; the options a measure would have triggered (preloading at idle, renaming a leaking selector or keyframe, P2) remain risk notes without thresholds.
- **U49–U51** (2026-11-06) Stage 5 ([openui.md](openui.md#decisions-already-made)): the fence's errors in one card under it, listing `onError`'s errors and the conversation's own check (U49, [D29](#the-readers-error-card)); errors reach the agent in the same turn, or as a new prompt after it (U50, [Error feedback](#error-feedback)); the `openui` skill's patch rule and question limits (U51, [D17](openui.md#d17-instructions-the-skills-u13-concept-q3)).

## Non-goals

- No canvas, pins, tree panel or comments on a conversation fence. They are papercraft's ([papercraft-openui.md](papercraft-openui.md)).
- No repository components and no `Export` in a conversation fence ([D7](openui.md#d7-render-hosts-and-routing)).
- No `Query`/`Mutation`: no tool or MCP call from the UI (concept [P1](../features/papercraft.md#decisions)).
- No durable local state: form values and `$variables` reset when the fence remounts (U38).
- No question asked by a subagent: only the main Thread asks (U12).
- No patch of a question: a question fence is always a whole program ([D4](openui.md#d4-the-program-reducer)).

## Design decisions

| #   | Decision                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D20 | An action of the latest revision of a closed fence sends on click as the reader's next message, through `chat.send/v1.sendAction`, in a `<ui-action>` envelope; one action in flight per fence.                                      |
| D21 | The question form is the built-ins `AskForm`, `AskQuestion`, `AskOption`, fields from `ask`'s schemas, drawn with copies of today's `AskQuestions` and `Settled`; a later closed, valid question fence supersedes it.                |
| D22 | `openui.questions/v1` (`status`, `answer`) takes the questions the app parsed, keys the answer by the question's prompt and digest, sends it by D20's route, and writes `openui.answered/v1` under the prompt that took the answers. |
| D29 | The `openui` client draws `openui-lang` fences in the shell with `Renderer`, from a chunk loaded at the first fence; react-ui's layered sheet and Doric's tokens; `Modal` drawn inline; the CSP unchanged.                           |
| D30 | `ask` is withheld in stage 3 and removed in stage 4, with `threads.ask/v1` and its UI; old questions draw nothing.                                                                                                                   |

## Design

### Overview

```text
chat ─ fence `openui-lang <identity>` (D1, D2) ─▶ <openui-fence> element (D29)
                                                  │ one fold per Thread and tag (D4)
                                                  ▼
                                         Renderer in the shell, isStreaming (D5)
                                          ├─ question fence ─▶ AskQuestions ─▶ openui.questions/v1.answer (D21, D22)
                                          ├─ action ─▶ chat.send/v1.sendAction: prompt or steer (D20)
                                          └─ onError ─▶ openui.programs/v1.reportErrors (D18)
```

A conversation fence draws its own revision in its own answer: the fold gives each key the program as of that fence, so an earlier answer keeps the program as it was then. A new identity starts a new UI; a fence with an earlier identity patches it (U11, [D3](openui.md#d3-identity-and-revision)).

### D20. Actions back to the agent (P1)

#### Decision

A conversation action sends on click (U21), as OpenUI's example chat does: "Buttons without an action automatically send their label to the assistant (equivalent to @ToAssistant(label))", in the instructions react-ui 0.18.1 generates (`openuiLibrary.prompt()`, `@openuidev/react-ui/genui-lib`). The click sends the action's text as the reader's next message, through the chat's own route for a typed message.

#### What the model writes

```openui-lang release
root = Stack([intro, form])
intro = TextContent("Name the release before I tag it.")
form = Form("release", btns, [version])
version = FormControl("Version", Input("version", "1.4.0"))
btns = Buttons([Button("Tag it", @ToAssistant("Tag the release"), "primary"), Button("Not now")])
```

- `@ToAssistant(message, context?)` makes a button send `message`; a `Button` with no action sends its label (above). react-lang calls `Renderer`'s `onAction` with `{ type: "continue_conversation", humanFriendlyMessage, params, formState, formName }` (`ActionEvent`, lang-core 1.0.2 `dist/index.d.mts:284-295`):
  - `params` is `{ context }` for `@ToAssistant` with a context, and `{}` for one without it (react-lang 1.0.2 `dist/index.mjs:788-796`) and for a `Button` with no action (`:832-838`). An action object without steps, which react-ui's own components build, reaches `onAction` with its `params` as they are (`:762-777`). With no action of their own, react-ui 0.18.1's cards send the card's title, or a generated one such as "Composite card 1", as the message, with the item's fields spread into `params`: `itemIndex`, `itemId` and fields such as `itemHeaderTitle` (`withItemContext`, react-ui 0.18.1 `dist/genui-lib/index.mjs:4869-4900`, called at `:12000,12199,12319,12446,12582`). With an action plan, `withItemContext` appends the item's fields to each `@ToAssistant` step's `context` instead. Among its other callers, a list item sends its title with the item's own action (`:2549`), and with no action and so no parameters, a follow-up sends its text (`:14664`) and an `EditableTable` "Save Changes", with the table stored as the one field of a form named after the table (`:4171-4172`).
  - `formState` comes from `getFormPayload(formName)` (react-lang `:752-758`): `{ [formName]: fields }` when the store holds an object for that form, each field stored as `{ value, componentType }` (`:740-749`); otherwise, and outside a form, the whole store: every `$variable`, every form and every field outside a form. A control writes to the store only when the reader changes it, and `Input("version", "1.4.0")` sets a placeholder, not a value (react-ui `dist/genui-lib/index.mjs:13790-13794`), so a form nobody has typed into gives the whole store.
- `@Set`, `@Reset` and `@Run` are run by react-lang itself and never reach `onAction` (`dist/index.mjs:781-788,815-828`); `@Run` has nothing to run, since the conversation offers no `Query` or `Mutation`. `@OpenUrl` reaches `onAction` as type `open_url` and is disabled ([D7](openui.md#d7-render-hosts-and-routing)).
- So clicking "Tag it" after the reader typed `1.4.0` gives `formState` `{"release":{"version":{"value":"1.4.0","componentType":"Input"}}}`, and the button sends:

  ```text
  Tag the release

  release.version: 1.4.0
  ```

- Clicking "Tag it" without typing gives `formName` `release` and a store with no `release` key, and the button sends `Tag the release` alone (3 below).

#### The text

The chunk's `actions.ts` builds it from the `ActionEvent`, lines joined by `\n`:

1. `humanFriendlyMessage`, trimmed. When it is empty, the action sends nothing (below), whatever lines would follow.
2. The parameter lines, when at least one is written: a blank line, then `context: ` and the value of `params.context` when it is not `undefined`, then, for each other own key of `params` in the object's own key order, `<key>: ` and its value, each value written as in 4. So a card's click sends `itemIndex: 0`, `itemId: pg` and its other fields, and the agent learns which item was picked.
3. The value lines, when at least one is written: a blank line, then the value lines.
   - **A form whose values the store holds** (`formName` set and `formState[formName]` an object that is not an array): one line per field, in the object's own key order, `<formName>.<field>: <value>`.
   - **A form whose values the store does not hold** (`formName` set, and `formState[formName]` missing or not such an object): no line. react-lang then gives the whole store, whose other forms and fields the reader did not submit, and the reader entered nothing in this form.
   - **Outside a form** (`formName` absent): one line per top-level key of `formState` that starts with `$`, in key order, `<key>: <value>`. These are the program's `$variables`, which react-lang keeps as top-level keys of its store (`dist/index.mjs:575-580`). Other forms and fields outside a form are not sent: the reader did not submit them.
   - A field is unwrapped first: an object that is not an array and has its own key `value` stands for that `value`. This is react-lang's own rule (`unwrapFieldValue`, `dist/index.mjs:569-573`), which react-lang does not export (`:1351`), so `actions.ts` writes it again.
4. A value: a string as is; `undefined` leaves its line out; any other value, `null` included, through `JSON.stringify`; a value for which `JSON.stringify` throws or returns `undefined` leaves its line out.

The text is at most 16,000 UTF-16 code units, its JavaScript `length`, which is what zod's `.max` counts; that is the maximum of `ChatActionInput.text`. A longer text is not sent, and the line under the fence reads "Not sent: the action's text is over 16,000 characters". A typed prompt has no maximum: `promptText` rejects only blank text (`bundles/desktop/chat/src/client/api/threads-api.ts:103-108`), and the runtime's schemas set none (`bundles/runtime/runtime/src/contracts/threads.ts:595-629`). The limit applies only to text that the model and the UI compose.

An action that sends nothing shows why in the line under the fence, and is not reported at the click: D18 reports a fence once, at its first `closed` or `unterminated` render ([D18](openui.md#d18-validation-feedback-u19), B15).

- An empty message (1): "Not sent: the action has no message", also when parameter or value lines would follow.
- `open_url`: the URL, as text, under the fence. The conversation's check reports each statement that calls `@OpenUrl` at the fence's report ([D29](#the-conversations-check-and-map)).
- Any other type: "Not sent: action type <type> is not supported".

#### When an action works

Decided by U26.

- Only on the **latest revision** of its identity (from the fold, [D4](openui.md#d4-the-program-reducer)), when that fence is **`closed`**, in a **main Thread**. Otherwise the fence's wrapper is `inert` and a line under it says why:
  - an older revision: "Actions work in the latest version of this UI";
  - `streaming`: "Actions work once the UI is complete";
  - `unterminated`: "Actions are off: this UI was cut off before it was complete". Such a fence never closes ([D2](openui.md#d2-fence-key-states-and-the-end-of-answer-signal)), so U26 keeps its actions off for good; the agent learns of the cut-off fence from D18's report;
  - an agent Thread: "Actions are off in a subagent's thread: only the main thread takes the reader's messages". A subagent's Thread refuses every reader input (`bundles/runtime/runtime/src/host/domain/service.ts:1180,1222`).
- So a click never sends a choice from a UI the agent has since replaced, and react-lang's own rule for forms while streaming (react-lang 1.0.2 `dist/index.d.mts:43-44`) applies to every control.

#### The route: `chat.send/v1` 1.0.0 → 1.1.0, `sendAction`

The `openui` client cannot reach chat's store, and `chat.send/v1.send` sends only the composer's held draft (`bundles/desktop/chat/src/client/services/send.ts:54-74`). The chat gains one method beside it (`bundles/desktop/chat/src/contracts/index.ts:591-635`):

```ts
interface ChatActionInput {
  readonly projectId: string; // min 1
  readonly threadId: string; // min 1
  /** The program identity (D3): a written identity or an anonymous `_<n>`. */
  readonly program: string; // ^(?:[a-z][a-z0-9-]{0,63}|_[1-9][0-9]{0,8})$
  /** The text above: not blank, a `refine` of `text.trim().length > 0`, so the text is sent unchanged; at most 16,000 UTF-16 code units, `.max(16_000)`. */
  readonly text: string;
}
interface ChatActionResult {
  readonly status: 'accepted' | 'refused';
}
interface ChatSend {
  send(input: ChatSendInput, call?: CallArg): Promise<ChatSendResult>;
  sendAction(input: ChatActionInput, call?: CallArg): Promise<ChatActionResult>;
}
```

`chatSendMethods.sendAction` has strict zod schemas for both; the manifest provides `chat.send/v1@1.1.0` (`bundles/desktop/chat/manifest.json:14`). `sendAction` takes the composer's route for a typed message without touching the composer. The route moves out of the hook, where it lives today (`bundles/desktop/chat/src/client/hooks/use-thread-chat.ts:93-116`), into one chat domain function that the hook and `sendAction` both call:

```ts
// bundles/desktop/chat/src/client/domain/send-route.ts
interface SendRoutePorts {
  /** Steers the running prompt `promptId` with the message; true when it was taken (`steered` or `queued`). */
  steer(promptId: string): Promise<boolean>;
  /** The Thread's queue, with `empty` as Terms defines it. */
  queue(): Promise<{ readonly paused: boolean; readonly empty: boolean }>;
  /** True when the queue was resumed. */
  resumeQueue(): Promise<boolean>;
  /** Starts a prompt with the message; true when it was taken. */
  prompt(): Promise<boolean>;
}

/** The composer's route for one message; false when the message was not taken. Never rejects. */
function routeSend(
  activePromptId: string | undefined,
  ports: SendRoutePorts,
): Promise<boolean>;
```

1. With an `activePromptId`: `steer(activePromptId)` is the result.
2. Otherwise: `queue()`; when it is `paused` and `empty`, `resumeQueue()`, and `false` ends the route with `false`. Then `prompt()` is the result.
3. A port that rejects ends the route with `false`.

**The composer's ports.** `useThreadChat` (`bundles/desktop/chat/src/client/hooks/use-thread-chat.ts:93-116`) builds them per message, from the Thread's `threadChatsStore` slice and its `useThreadQueue` query (`:75`):

- `steer(promptId)`: `threadChatsStore.getState().steer(thread.id, text, { promptId, interrupt })`;
- `queue()`: `{ paused: queue.data?.paused === true, empty: queueItems(queue.data).length === 0 }`, the test the hook makes today (`:95`);
- `resumeQueue()`: awaits `queue.resumeAsync()` and gives `true`;
- `prompt()`: `threadChatsStore.getState().prompt(thread.id, text)`.

The hook's `prompt(text)` calls `routeSend(undefined, ports)` with `interrupt` false, and its `steer(text, interrupt)` calls `routeSend(activePromptId, ports)`. That is today's behavior, and the composer's plain send keeps calling `steer` while a prompt runs (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/send-prompt.tsx:154-161`).

**`sendAction`.** `ChatSendDependencies` (`bundles/desktop/chat/src/client/services/send.ts:31-40`) gains `threads: Pick<ChatThreadsApi, 'get' | 'steer' | 'queue' | 'resumeQueue' | 'prompt'>`, which is `threadsApi` in the window's dependencies (`:42-50`), and `createChatSend` (`:77-86`) provides `sendAction` through a new exported `sendUiAction(input, dependencies)`:

1. It reads the Thread with `threads.get(threadId)` (`threads-api.ts:201-207`). `undefined`, a rejection, a Thread whose `projectId` is not `input.projectId` (`bundles/desktop/chat/src/client/domain/workspace.ts:19`), or `origin === 'agent'` answers `refused` before any other call, which keeps the route from resuming that Thread's queue (the runtime refuses the input itself, `service.ts:1178-1180,1220-1222`).
2. It calls `routeSend` with the Thread's `activePromptId` and these ports, each over `uiActionEnvelope(text, program)`:
   - `steer(promptId)`: `threads.steer(threadId, envelope, { promptId })`, with no interrupt. It resolves only with `steered` or `queued` and throws on any other answer (`threads-api.ts:237-257`), so a resolution is `true`;
   - `queue()`: `threads.queue(threadId)` (`:327-332`), with `empty` from `queueItems`;
   - `resumeQueue()`: `threads.resumeQueue(threadId)`, which resolves only with `resumed` and throws on any other `ResumeResult` status (`:405-412`; `bundles/runtime/runtime/src/contracts/model.ts:302-310`), so a resolution is `true`;
   - `prompt()`: `threads.prompt(threadId, envelope)`, which resolves with a receipt only when the runtime answers `accepted` and throws otherwise (`:223-235`), so a resolution is `true`.
3. It answers `accepted` when the route gives `true`, and `refused` when it gives `false`.

The question form's answer follows the same route on the host ([D22](#answer)).

`sendAction` calls the host API directly, not `threadChatsStore`, so it never writes the store's single pending turn or `sending` flag (`bundles/desktop/chat/src/client/domain/thread-chats.ts:344-360`, `bundles/desktop/chat/src/client/stores/thread-chats.ts:298-313`), never flushes the composer stack (`stores/thread-chats.ts:356-366`), and never touches the draft. A send from the composer and an action can run at the same time without overwriting each other. The action's turn appears in the transcript when the log echoes it; the line under the fence shows "Sending…" only until `sendAction` settles ([Double sends](#double-sends)).

#### Marked origin: the `<ui-action>` envelope

In `bundles/desktop/chat/src/client/domain/prompt-envelope.ts`:

- `uiActionEnvelope(text, program)` returns `<ui-action program="release">`, a newline, the text through `bodyText`, a newline and `</ui-action>`; the attribute goes through `attributeText` (`:39-44`).
- `ui-action` joins `ENVELOPE_ELEMENTS` (`:27-28`), so a body can never close the element.
- `readEnvelope` (`:318-388`), which every reader of a stored prompt goes through, also reads a text that is exactly one `<ui-action program="…">` element, after the `<user-request>` wrapper it already strips (`:321-322`): `message` is the body through `bodyFrom`, `comments` is `[]`, `commentsPart` is `''`, and a new field `action` is `{ program }`, with the attribute through `attributeFrom` (`:46`). A text with anything before or after the element, or with a second `\n</ui-action>` inside it, is not an envelope, as for `<message>` (`:371-385`). `ParsedPromptEnvelope` (`:236-240`) gains `action?: { readonly program: string }`, and `parsePromptEnvelope` (`:394-401`) passes it on. So `promptMessage`, `promptSummary` and `queueRowText` (`bundles/desktop/chat/src/client/domain/queue.ts:157-166`) show the text as the prompt's words.
- `previewSummary` (`:455-466`) also reads a preview that starts with `<ui-action`: its first test becomes `/^<(?:comments|message|user-request)>|^<ui-action\b/`, and its body pattern `/<(?:message|ui-action\b[^>]*)>\s?([\s\S]*?)(?:\s?<\/(?:message|ui-action)>|$)/`.
- `withPromptMessage` (`:474-477`), used only when the reader edits a queued prompt (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/edit-queue-prompt.tsx:155`), gives a UI-action prompt `joined('', messagePart(words))`, a `<message>`: the reader wrote the new words, so the mark goes. A rewind sends the reader's edited text as typed (`stores/thread-chats.ts:419-424`), so a rewound UI-action prompt is a plain prompt too.
- The runtime wraps every user prompt in `<user-request>` (`bundles/runtime/default/src/host/envelope.ts:28-56`). Its own list of tags (`:3-9`) names only the five outer envelopes, whose closing tags it defuses in the body (`:11,52`). `<message>`, `<comments>` and `<ui-action>` are chat's inner parts, which that list does not name and the runtime does not read, so it does not change. A `</user-request>` in an action's text becomes `<\/user-request>` there, so it cannot close the request.

**In the transcript.** The projected user turn gains `action?: { readonly program: string }`, and the user-turn node draws a caption above the words: "Sent from the UI · release".

- `UserTurn` (`bundles/desktop/chat/src/client/domain/projector.ts:65-95`, beside `instruction` at `:82`) gains the field. The `Draft` user variant (`:290-302`) does not: `sendAction` writes no draft, so no draft carries an action.
- `readInput` sets it from `parsePromptEnvelope(input.text)?.action` for a `user` source (`bundles/desktop/chat/src/client/domain/projector-input.ts:46-132`).
- `insert-thread-turn-nodes.tsx` (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/insert-thread-turn-nodes.tsx:186-192`) passes `turn.action` to `$createUserTurnNode`, which takes it as a new last parameter (`bundles/desktop/chat/src/client/components/organisms/conversation/nodes/user-turn-node.tsx:211-230`).
- `UserTurnNode` keeps it in `__action`, through its constructor (`:76-98`), `clone` (`:100-111`), `exportJSON` (`:183-195`) and `importJSON` (`:197-209`), with `action?: { program: string }` in `SerializedUserTurnNode` (`:32-42`). Like `accepted`, it is fixed per block (`:54-57`), so `updateDOM` (`:136-142`) does not change it.
- `createDOM` (`:118-127`) sets `data-ui-action` to the program on the block, and chat's `bundles/desktop/chat/src/client/styles.css` draws the caption with `.conversation-scroll [data-lexical-editor] > [data-ui-action]::before { content: 'Sent from the UI · ' attr(data-ui-action); display: block; font-size: 0.75rem; color: var(--muted-foreground); }`. A user turn's avatar is its `::after` (`styles.css:233`), so `::before` is free; the caption is not text of the editor, so copying the turn copies the words only.

**To the agent.** Two texts tell the model what the envelope is:

- The `<ui-action>` rule of the `openui` skill's `doricRules`, whose text [D17](openui.md#d17-instructions-the-skills-u13-concept-q3) states.
- The default system prompt. Its line `bundles/runtime/default/src/host/prompts/system.md:24` reads "- In a <user-request>, the request is the text in <message>. A plain-text input is the request as written." A `<ui-action>` has no `<message>` and is not plain text, so the line becomes:

  ```text
  - In a <user-request>, the request is the text in <message>, or in <ui-action> when the reader clicked a control of a UI you drew. A plain-text input is the request as written.
  ```

  It reaches every Thread, whatever the setting: with the setting off no new `<ui-action>` arrives, and one already in a Thread's history is still described correctly. No test reads `system.md`'s text (`bundles/runtime/default/tests/support/prompts.ts:5-19` holds its own), and `default` keeps version 2.3.0, as the last change to `system.md` (`f4ecf378`) kept it.

#### Double sends

- From the click until `sendAction` settles, and for at least 500 ms, the fence's wrapper has `inert` and `aria-busy="true"` and the line under it reads "Sending…". `inert` keeps every control of the fence from taking a click or focus, so a double click sends once even when the host answers within the double-click interval.
- The `onAction` handler sets its in-flight flag before its first `await`, so a second event in the same task is dropped.
- `accepted` clears the line. `refused` shows "Not sent: the thread did not take the message", and the fence works again.
- A rejected `sendAction`, such as an `invalid_input` from its schemas or any other contract error, shows "Not sent: " and the error's `message`, or `String(error)` for a value that is not an `Error`, cut to 300 characters. The in-flight flag, `inert` and `aria-busy` are released as after `refused`, at the earliest 500 ms after the click, and the fence works again. Nothing is reported (D18).
- The guard is per element and window: one Thread open in two windows can have one action in flight in each.

#### P1's mitigations, after U18, U21 and U22

| Mitigation (concept P1)                       | Now                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No send from the frame                        | Kept: papercraft fences, which run in the frame, have no actions (U22). Conversation fences run no repository code (D7). |
| Rate limit, one open proposal per canvas node | Replaced by one action in flight per fence, and actions only on the latest closed revision.                              |
| Marked origin                                 | Kept: the `<ui-action>` envelope for the agent, the caption in the transcript.                                           |
| Prompt injection                              | Accepted by the user (U21); see [R24](#risks).                                                                           |

#### Alternatives

- _A proposal item on the composer's stack, edited and sent with the composer's send._ Rejected by the user on 2026-11-03 (U21): every action took two steps, against OpenUI's model.
- _An editable area under the fence._ Rejected: a second draft beside the composer's.
- _Send through `threadChatsStore`, as the composer does_, with the pending turn drawn at once. Rejected: the store holds one pending turn and one `sending` flag per Thread, which an action and a typed send would overwrite in each other; the composer stack would flush into the action's prompt.
- _Send from the `openui` host through `runtime.threads/v1`, as the question form's answer does (D22)._ Rejected: an action records nothing, so the host would add a call and a second implementation of the route for no state; the answer goes through the host only because it records `openui.answered/v1` under the prompt that took it.
- _Keep the route inside `useThreadChat` and write it again in `sendAction`_ (version 5). Rejected: two copies of one rule in the chat, which can drift apart.
- _Send the whole store outside a form, as react-lang gives it_ (version 6). Rejected: it carries every form and field of the program, which the reader did not submit with that button, and has no size bound.
- _Report an action's errors at the click._ Rejected: D18 reports a fence once (openui.md B15); a second report would need a second rule in the host.
- _Keep actions live on every revision, with the revision in the envelope._ Rejected: the agent would receive a choice from a UI it has since replaced, and the revision number does not tell it what that UI said.
- _Mark the origin with an attribute on `<message>`._ Rejected: the parser reads `<message>` with no attributes (`prompt-envelope.ts:373-382`), so every reader of the envelope would have to change.

### D21. The question form

#### Decision

The conversation built-ins take their fields from `ask`'s input schemas (`bundles/features/threads/src/contracts/index.ts:39-85`), copied with the answer schema (`:97-103`) into `bundles/features/openui/src/contracts/questions.ts` (D22). From stage 2 these copies are the source of the limits for questions; `threads` keeps its own for `ask` until stage 4 removes them (D30), and C9 checks that both give the same JSON Schema while both exist. OpenUI Lang arguments are positional, in the order of the props object's keys ([OpenUI Lang syntax](https://www.openui.com/docs/openui-lang/syntax)), so the definitions in `bundles/features/openui/src/contracts/builtins.ts` list their keys explicitly:

| Built-in      | Arguments, in order                                                                                             | Source of each field                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `AskOption`   | `label` (≤ 120), `description?` (≤ 300), `recommended?` (boolean)                                               | `askOptionSchema` (`threads/src/contracts/index.ts:39-45`)          |
| `AskQuestion` | `id` (≤ 64), `question` (≤ 500), `options` (2–6 `AskOption`), `multiSelect?` (boolean), `allowOther?` (boolean) | `askQuestionSchema` (`:53-67`), with `options` as `AskOption` refs  |
| `AskForm`     | `questions` (1–5 `AskQuestion`), `context?` (≤ 1,000)                                                           | `askInputSchema` (`:74-85`), with `questions` as `AskQuestion` refs |

`AskForm`'s description: "Questions the reader must answer before you continue. Must be the root of its own fence." The counts of options and questions and the uniqueness of ids and labels are checked once, by `askInputSchema`, after the parsed root is mapped to `AskInput`.

The example the skill teaches, with each positional argument named:

````text
```openui-lang db-choice
root = AskForm([q1], "The service needs a database.")
q1 = AskQuestion("db", "Which database?", [pg, lite], false, true)
pg = AskOption("Postgres", "Relational, already used by billing", true)
lite = AskOption("SQLite", "One file, no server")
```
````

- `AskQuestion("db", "Which database?", [pg, lite], false, true)`: `id` `db`, `question`, `options`, `multiSelect` false (one choice), `allowOther` true (a free answer is accepted).
- `AskOption("Postgres", "…", true)`: `label`, `description`, `recommended` true.

#### A question fence is a whole program

A fence whose first completed line that is not blank matches `^root\s*=\s*AskForm\(` is a question fence ([D4](openui.md#d4-the-program-reducer)): the fold gives it an anonymous identity, never merges it with an earlier revision and never uses it as a base. A question is therefore always exactly the fence the reader sees. A fence that calls `AskForm` on any other line is not a question fence.

#### Drawing

`AskForm`'s component (`bundles/features/openui/src/client/question/ask-form.tsx`, in the chunk) draws `AskQuestions`, which draws `Settled` for a settled state. Stage 2 copies them, and does not move them:

- `bundles/features/threads/src/client/ask.tsx:39-326` (`MessageCircleCheckIcon`, `frame`, `AskQuestionsProps`, `Settled` and `AskQuestions`; not `ASK_TAG`, `:36-37`) → `bundles/features/openui/src/client/question/ask.tsx`, with the three props below and the imports those lines use, of those at `ask.tsx:7-34`: `Button` from `desktop/ui/button`, `cn` from `desktop/ui/utils`, the five icons and `createLucideIcon` from `lucide-react`, `useState` from `react`, `type AskQuestion` from `../../contracts/index.js`, and `OTHER`, `type Picks` and `summary` from `./picks.js`. As today it exports `AskQuestions` and `AskQuestionsProps` only; `Settled` stays unexported, and every settled state is drawn through `AskQuestions` with `answered` or `superseded` (`:146-147`);
- the picks helpers, `OTHER`, `Picks`, `filled`, `summary`, `toAnswers` and `fromAnswers` (`bundles/features/threads/src/client/domain/ask.ts:123-184`) → `bundles/features/openui/src/client/question/picks.ts`, unchanged but for their one import, `type AskAnswer, type AskQuestion` from `../../contracts/index.js` (today from `threads`' contracts, `domain/ask.ts:6-11`), which the build turns into `openui/contracts` (`packages/bundle/src/build/parts.ts:168-175`);
- `bundles/features/threads/stories/ask.stories.tsx` → `bundles/features/openui/stories/ask.stories.tsx`, with the title `OpenUI/Molecules/Ask`, and `bundles/features/threads/.storybook/preview.tsx` → `bundles/features/openui/.storybook/preview.tsx`, with its comment naming the `openui` bundle; it imports `desktop/ui/theme.css` and `../src/client/styles.css`, as `threads`' does.

`threads` keeps its files, which `<threads-ask>` still uses while `ask` serves earlier questions, until stage 4 (D30). `AskBlock`, `questionBlock`, `QuestionBlock`, `askProjector` and `rereadsStatus` are not copied: they belong to `threads.asked/v1` rows. The components are built from `desktop/ui` and `lucide-react` (`ask.tsx:8-21,43-52`), which `openui`'s `package.json` lists in `dependencies` as `threads`' does (`bundles/features/threads/package.json:19`), and from Tailwind utilities that the `openui` client's own sheet generates ([D29](#css)), so `ask`'s look is kept (U12).

The copy's props, beside today's (`ask.tsx:61-83`, unchanged); with all three at their defaults it renders the markup `threads`' copy renders (C9):

```ts
interface AskQuestionsProps {
  // ...today's props
  /** The heading `Settled` shows when `answered` is not set. Default "Superseded". */
  readonly settledHeading?: string;
  /** Disables every option row, the free answer, Back, Next and Send. Default false. */
  readonly disabled?: boolean;
  /** A line in the place and style of the send error (`ask.tsx:289-293`), shown while the error is not. Default none. */
  readonly note?: string;
}
```

`Settled` takes `heading` and shows `answered ? 'Answered' : heading` (today `answered ? 'Answered' : 'Superseded'`, `ask.tsx:86-118`); `AskQuestions` passes `settledHeading` to it.

**Reading the question.** The component ignores the props `Renderer` passes it and reads the question from the fence's own program, through `questionOf(revision.program)` (`bundles/features/openui/src/client/question/ask-input.ts`, in the chunk). The table below, the conversation's check (D29) and supersession use this one reading:

```ts
interface QuestionRead {
  /** The root as `AskInput`, when the mapped root passes `askInputSchema`. */
  readonly input?: AskInput;
  /** Otherwise, the first zod issue's message. */
  readonly issue?: string;
  /** The entries of the root's `questions` that pass `askQuestionSchema`, in order. */
  readonly questions: readonly AskQuestion[];
}

function questionOf(program: string): QuestionRead;
```

- It parses `program` with `createParser(library.toJSONSchema(), library.root).parse(program)`, as D29's check does, and maps the parsed `root`.
- An element node (`ElementNode`, lang-core 1.0.2 `dist/index.d.mts:158-176`) whose `typeName` is `AskForm` becomes `{ questions, context }` from its `props`, each `AskQuestion` node `{ id, question, options, multiSelect, allowOther }`, and each `AskOption` node `{ label, description, recommended }`. A prop whose value is `undefined` is left out. Any other value, a node of another type and a `null` root included, is kept as it is, so the schema rejects it.
- `input` and `issue` come from `askInputSchema.safeParse` of the mapped root; `questions` from `askQuestionSchema.safeParse` of each mapped entry of its `questions`, when that is an array.

The component reads the fence from the chunk's fence context (D29) and decides in this order. A settled state is `AskQuestions` with `superseded` and the heading given as `settledHeading`, so it shows the numbered questions and no controls:

| Case                                                                                             | Drawn                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not a question fence                                                                             | the notice "A question must be the root of its own fence"; the conversation's check reports it (D29)                                                                                                                                                                                                                                                                                              |
| `ChatFenceView.origin` is `agent` ([D1](openui.md#d1-the-fence-in-the-chat-a-new-chat-contract)) | settled, with the heading "Not asked: only the main thread can ask the reader." and `input.questions`, else `questions`; no answers. The check reports `ask`'s refusal text (`bundles/features/threads/src/host/tools/ask.ts:16-17`)                                                                                                                                                              |
| `streaming`                                                                                      | with at least one entry in `questions`: `AskQuestions` with them, `disabled`, and the note "Writing the question…"; with none: the note alone, as `<p className="text-xs text-muted-foreground">`, since `AskQuestions` draws nothing without a question (`ask.tsx:149-150`). react-lang also disables forms while streaming (react-lang 1.0.2 `dist/index.d.mts:43-44`). Nothing is read or sent |
| `unterminated`                                                                                   | settled, with the heading "Not asked: the question was cut off" and `questions`, which may be none. The fence never closes (D2), so it is never answerable; D18 reports the cut-off fence                                                                                                                                                                                                         |
| `closed`, no `input`                                                                             | an error block with `issue`; the check reports it                                                                                                                                                                                                                                                                                                                                                 |
| `closed`, valid, before the first `status` read finishes                                         | nothing, as `AskBlock` draws nothing today (`ask.tsx:369`)                                                                                                                                                                                                                                                                                                                                        |
| `closed`, `answered`                                                                             | `AskQuestions` with `answered` set to `fromAnswers(answers)`: "Answered" with the answers                                                                                                                                                                                                                                                                                                         |
| `closed`, `pending`, superseded                                                                  | settled, with the heading "Replaced by a later question"                                                                                                                                                                                                                                                                                                                                          |
| `closed`, `pending`                                                                              | `AskQuestions` with `input`'s questions and context, and controls                                                                                                                                                                                                                                                                                                                                 |

- **Superseded.** A question fence is superseded when a later fence of `ChatFenceView.fences` is a `closed` question fence whose `questionOf` reading has `input`, and this one is not answered. A later question that is still streaming, was cut off or fails `askInputSchema` supersedes nothing: none of them can be answered (above), so the reader always keeps the last question that can be. The entry computes it once the chunk has loaded (D29). The host does not.
- **Reading the state.** The component calls `services.use(OpenuiQuestionsV1, { projectId, threadId }).status({ promptId: fence.promptId, questions })` when the fence is `closed` and valid, and again each time the entry's `watchAnswers({ projectId, threadId, promptId }, listener)` calls it. A read that finishes after a newer one is ignored and a failed read reads `pending`, as `AskBlock` does today (`ask.tsx:345-369`); the picks and the step survive a re-read.
- **The rule for reading again.** `rereadsAnswer(event, target)` (`bundles/features/openui/src/client/answer-changes.ts`) is true for an event of the target's Project and Thread that is an `openui.answered/v1` row whose payload's `questionPromptId` is `target.promptId`, or a row whose payload `type` is `history.truncated`, the marker a rewind writes (`bundles/desktop/chat/src/client/domain/projector.ts:1101-1127`), because a rewind can remove an answered row ([D22](#durable-across-replay-and-rewind)). It replaces `rereadsStatus` (`bundles/features/threads/src/client/domain/ask.ts:185-203`). `noticeThreadUpdate` and the set of watches are today's (`bundles/features/threads/src/client/ask-changes.ts:23-60`), with this rule.
- **Sending.** Send calls `answer({ promptId, questions, answers: toAnswers(questions.questions, picks) })` with the same scope; a returned state replaces the read one, and a rejection shows "Could not send. Try again." with the picks kept, as today (`ask.tsx:69-75,166-176`).

#### Alternatives

- _Patchable question fences._ Rejected: the answer would have to name a merged program the reader never saw as one fence, and supersession would miss a patch that changes one question but not the root.
- _Draw question fences without `Renderer`, from lang-core's parse only._ Rejected: the shell has `Renderer` for every other conversation fence, so one path draws all of them.
- _Move the components in stage 2_ (version 6). Rejected: `<threads-ask>` still draws earlier questions until stage 4 removes it, and it needs them.
- _A drawing path for question fences in a frame, under P2_ (version 5). Rejected: it designs for P2, which U18 rejected; if the user ever chooses P2 to contain [R26](#risks), this document gets a revision first.

### D22. The question service: durable state and the main-Thread rule

#### Ownership

All of `ask` lives in `threads` today, and no other bundle refers to it. A question is now a conversation fence, so stage 2 gives the `openui` bundle its own question service, UI and tests ([D27](openui.md#d27-the-openui-bundle)), copied from `threads` with the changes this document states, and `threads` loses `ask` and its copies in stage 4 (D30).

#### Contract

`openui.questions/v1@1.0.0` (host), both methods `expose: 'desktop'`; the manifest's `desktopScope` gains `"openui.questions/v1": ["projectId", "threadId"]`. `threads` declares `["projectId", "threadId", "promptId"]` for `threads.ask/v1` (`bundles/features/threads/manifest.json:25-27`), because its `answer` appends under the call's prompt (`bundles/features/threads/src/host/ask.ts:52-58`); `openui.questions/v1` takes the question's prompt in its input and appends under the prompt that took the answers, through a scope of its own (step 7 below), so the call carries no prompt. The refs, schemas and method specs are in `bundles/features/openui/src/contracts/questions.ts`:

```ts
interface QuestionRef {
  /** The prompt that wrote the question fence: the first part of its key (D2). */
  readonly promptId: string;
  /** The questions as the app parsed them from the closed fence (D21). */
  readonly questions: AskInput; // askInputSchema, copied from threads
}
interface QuestionAnswerInput extends QuestionRef {
  readonly answers: readonly AskAnswer[]; // askAnswerSchema, copied from threads
}
type QuestionState =
  | { readonly state: 'pending' }
  | { readonly state: 'answered'; readonly answers: readonly AskAnswer[] };

interface Questions {
  status(input: QuestionRef, call?: CallArg): Promise<QuestionState>;
  answer(input: QuestionAnswerInput, call?: CallArg): Promise<QuestionState>;
}
```

**A question is its prompt and its digest**: `promptId`, which the app sends, and the SHA-256, in hex, of `JSON.stringify` of `questions` after `askInputSchema` parses it (its keys in schema order), which the host computes; the app never sends the digest. So the id does not depend on how the chat splits turns (D2), an id cannot name one fence while the questions come from another, and the same questions asked again by a later prompt are a new question with no answer, as each `ask` call, which writes a new `askId`, is today (`bundles/features/threads/src/host/tools/ask.ts:44`). Two fences of one prompt with the same questions are one question.

**Event** `openui.answered/v1@1.0.0`, defined with `defineEvent` as `threads.answered/v1` is (`bundles/features/threads/src/contracts/index.ts:226-231`): `z.object({ questionPromptId: z.string().min(1), digest: z.string().regex(/^[0-9a-f]{64}$/), answers: z.array(askAnswerSchema) }).strict()`. The host registers it with `services.use(EventsV1).register(answeredEvent)` at activation, whatever the setting, as `threads` registers its events (`bundles/features/threads/src/host/index.ts:35-38`), and the client claims it with a projector that draws nothing ([D29](#the-element)), so a log that holds it never shows a generic block, also after the setting is turned off.

#### `status`

1. The call's scope must hold `projectId` and `threadId`; otherwise `invalid_scope` with "openui.questions/v1 needs a call scope with a project and a Thread.", as `ask`'s `readScope` answers (`bundles/features/threads/src/host/ask.ts:34-49`).
2. It reads the log with `runtime.threads/v1.threadEvents({ id: threadId, afterSequence: 0 }, call)` and keeps the rows of the scope's Project and Thread, as `recordedAsk` does (`ask.ts:117-140`). It answers `answered` with the answers of the first `openui.answered/v1` row whose `questionPromptId` and `digest` match, skipping a row that fails the event's schema, as `ask`'s fold does (`ask.ts:84-114`); else `pending`. A rejected read rejects `status` with that error, as `recordedAsk` lets it.

`questions` that fail `askInputSchema` reach neither method: the contract layer parses an input with the method's schema and answers `invalid_input` before the provider runs (`packages/bundle/src/runtime/dispatch.ts:171-185`; for a call from a window, `packages/bundle/src/runtime/envelope/link.ts:810-818`). So both methods compute the digest from parsed questions. `status` reads no Thread record: the element draws an agent Thread's block from `ChatFenceView.origin` (D21) and never calls `answer` there.

#### `answer`

Steps 1 and 2 run as the call arrives; the call then joins its question's queue, so calls for one question (prompt and digest) run one at a time, as `ask` chains its calls per `askId` (`ask.ts:279-292`):

1. The scope, as in `status` step 1.
2. The digest of the parsed `questions`; the queue's key is the `promptId`, a newline and the digest.
3. Read the log as `status` does. `answered` already: return it unchanged (the first answer is final, `ask.ts:317-319`).
4. Check the answers against the questions with `ask`'s checks (`ask.ts:154-199`); a failure is `invalid_input`.
5. Read the Thread with `runtime.threads/v1.thread(threadId, call)` (`bundles/runtime/runtime/src/contracts/threads.ts:349`). `undefined`, a Thread whose `projectId` is not the scope's, and an agent Thread (`origin` `agent`, `bundles/runtime/runtime/src/contracts/model.ts:160-172`) are `unavailable`, with nothing sent, resumed or written; the element never offers controls in an agent Thread (D21).
6. Send `formatAnswers(questions, answers)` as the next user request by D20's route, against `runtime.threads/v1` (`threads.ts:349-390,454-455`): with the Thread's `activePromptId`, `steer({ id, prompt, promptId: activePromptId })`; otherwise `queue(id)`, and when the queue is paused and empty ([Terms](#terms)), `resumeQueue(id)` first, then `prompt({ id, prompt })`. A steer that answers `steered` or `queued`, or a prompt that answers `accepted`, carries the `promptId` that took the answers (`model.ts:268-278`, `threads.ts:119-125`). Any other status, a `queue(id)` that answers `undefined`, and a `resumeQueue` status other than `resumed` (`model.ts:302-310`) are `unavailable` and write nothing. This is `routeSend` (D20) written against the host API, because a host cannot import chat's client code (bundles keep structural copies of chat's contracts, `bundles/features/threads/src/client/chat-contract.ts:1-4`); C3 and C5 run the same cases against both. Today's `ask` steers into the question's prompt when none runs and does not resume a paused queue (`ask.ts:247-274`); with this route an answer and an action reach a paused Thread the same way.
7. Append `openui.answered/v1` with the question's `promptId` as `questionPromptId` under the `promptId` that took the answers, through `services.use(EventsV1, { projectId, threadId, promptId })` (a scope per use, `packages/bundle/src/contracts/context.ts:24`). Return `answered`.

Every call to `runtime.threads/v1` and `events/v1` passes the method's `call` on, as `ask` does (`ask.ts:125,255,263,328`).

**Failures.** Every `unavailable` has `ask`'s message, "The Thread did not take the answers." (`ask.ts:236-241`), and one of two `details`:

- `{ status }` for an answer the route did not take: `'missing'` for a Thread that is `undefined` or of another Project, and for a `queue` that answers `undefined`; `'forbidden'` for an agent Thread, the status the runtime gives a reader's input there (`threads.ts:119-125`); otherwise the status the runtime answered, of the steer, the resume or the prompt (`model.ts:268-278,302-310`).
- `{ reason }` when `thread`, `steer`, `queue`, `resumeQueue` or `prompt` rejects: the error's `message`, or `String(error)` for a value that is not an `Error`, as `send` does today (`ask.ts:265-269`).

A rejected log read (step 3) or append (step 7) rejects `answer` with that error. A rejected append leaves the answers delivered and no row, as a host stop does (below).

A host stop between steps 6 and 7 leaves the answers delivered and no row, so the question reads `pending` and a second answer can be sent. `ask` has the same order today (send, then append, `ask.ts:316-335`); the alternative order would record answers the Thread never received.

The answer text, from `formatAnswers` (`ask.ts:201-234`), for the example of D21 with Postgres chosen:

```text
Answers to your questions:

1. Which database?
   Postgres
```

A skipped question reads `(skipped)`; several values are joined with `; `.

#### Durable across replay and rewind

The question is the fence in the log; the answer is the `openui.answered/v1` row, naming the question's prompt and digest, under the prompt that took the answers. Replay and a reload read the same rows.

**A rewind works by log position.** A rewind of prompt P removes every row from P's first row on, whatever prompt wrote it (`bundles/runtime/runtime/src/host/store/threads.ts:830-840`). Call the answered row A. A is itself a row of the prompt that took the answers, so that prompt's first row is A or comes before it. Therefore:

- a rewind of the prompt that took the answers removes A, and the question reads `pending` again (U27);
- a rewind of any other prompt whose first row comes before A removes A too: a prompt that ran between the question and the answer, and the question's own prompt, whose rewind also removes the fence;
- a rewind of a prompt whose first row comes after A leaves A, and the question reads `answered`.

U27 names the first case. The second follows from the same rule of the runtime; it is a clarification of U27, not a change. A window learns of a rewind from the `history.truncated` row it writes, on which the block reads `status` again (D21).

**Copied from `threads` with their behavior unchanged:** the answer checks (`bundles/features/threads/src/host/ask.ts:154-199`) and `formatAnswers` (`:201-234`) into `bundles/features/openui/src/host/questions.ts`, and the schemas (D21) into `openui/contracts`. The views and the live refresh are copied with the changes D21 states. `threads` keeps its copies until stage 4 (D30).

**"End your turn".** Today it is the `ask` tool's result text, "The questions are shown to the user. End your turn now without further tool calls; the answers arrive as the next user request." (`bundles/features/threads/src/host/tools/ask.ts:13-14`). A fence has no tool result, so the rule moves to the `openui` skill ([D17](openui.md#d17-instructions-the-skills-u13-concept-q3)).

#### Alternatives

- _The fence key as the question's id._ Rejected: the key's `turnSequence` follows the chat's turn rules (D2), which the question's id has no need to depend on; the prompt and the digest identify the question without them.
- _The digest alone as the question's id_ (version 5). Rejected: the same questions asked again in a later task would read `answered` with the old answers and draw no controls, while the agent, which ended its turn, waits for answers that never come.
- _Refuse an agent Thread in `status`, with a `refused` state_ (version 5). Rejected: the element draws that block from `ChatFenceView.origin` (D21) and never asks the host, and `answer` already stops an agent Thread before sending.
- _The host checks the questions against the log, and computes supersession._ Rejected: no host reads fences ([D4](openui.md#d4-the-program-reducer)); the app that drew the question is the app that sends the reader's messages anyway (D20).
- _`openui.answered/v1` under the question's prompt_, as `threads.answered/v1` is today. Rejected: when the answers were queued as a new prompt, a rewind of that prompt would leave the question answered with no answers in the log.
- _Keep the service in `threads`, and have the `openui` element call a revised `threads.ask/v1`._ Rejected: one fence would need two bundles, the input changes anyway, and `threads` loses the tool in stage 4.
- _Keep `threads.asked/v1` as the question's record._ Rejected: only a host that reads fences could write it, and the question is already in the log as the fence.

### D29. The conversation renderer in the app

#### The element

At activation, the `openui` client (`bundles/features/openui/src/client/index.ts`):

- defines `<openui-fence>` with `ui/v1.define`, from `defineReactElement<{ view?: unknown }>({ props: ['view'], render: FenceShell, wrap: () => StrictMode })` (`packages/desktop/src/react-element.ts:10-36`), as `threads` defines `<threads-ask>` (`bundles/features/threads/src/client/ask.tsx:407-427`, `bundles/features/threads/src/client/index.ts:32`);
- registers `chat.views/v1.registerFenceRenderer({ tag: 'openui-lang', elementTag: 'openui-fence' })` ([D1](openui.md#d1-the-fence-in-the-chat-a-new-chat-contract)) while `openui.setting/v1.watch` reports `true` ([D24](openui.md#d24-the-setting-and-rollback)), and disposes it when it reports `false`;
- registers, whatever the setting, `chat.views/v1.registerProjector(answersProjector)`, where `answersProjector` is `{ eventTypes: ['openui.answered/v1'], initial: () => null, reduce: (state) => ({ state, blocks: [] }) }` (`bundles/features/openui/src/client/answers-projector.ts`). The chat turns every versioned type that no projector claims into a generic payload block (`bundles/desktop/chat/src/client/domain/external-blocks.ts:5-7,100-115`), as `threads` avoids for its own rows (`bundles/features/threads/src/client/index.ts:39-51`). A `registration_conflict` is caught, as `threads` catches it there;
- registers `noticeThreadUpdate` (`bundles/features/openui/src/client/answer-changes.ts`) on `chat.hooks/v1.onThreadUpdateHook`, through `services.use(HooksV1).whenAvailable(ChatHooksV1, …)`, as `threads` does (`bundles/features/threads/src/client/index.ts:55-58`).

`chat.views/v1` and `chat.hooks/v1` are reached through `whenAvailable`, so the manifest does not require `chat.hooks/v1`, as `threads`' does not (`bundles/features/threads/manifest.json:14-23`). The client's structural copies of `chat.views/v1` 1.1.0 (`registerFenceRenderer`, `registerProjector`, `ChatFence`, `ChatFenceView`, `ProjectorSpec`, `ChatThreadEvent`), `chat.send/v1` 1.1.0 (`sendAction`, `ChatActionInput`, `ChatActionResult`) and `chat.hooks/v1` 1.1.0 (`onThreadUpdateHook`, `ThreadUpdateInput`) are in `bundles/features/openui/src/client/chat-contract.ts`, as `threads` keeps its own (`bundles/features/threads/src/client/chat-contract.ts:1-4`).

`FenceShell`, in the entry, reads `view` as a `ChatFenceView`. `fence-element.tsx` exports `createFenceShell(loader: ChunkLoader)`, and `index.ts` defines the element with `createFenceShell(chunkLoader)`, so a test gives it a fake chunk. `folds.ts` holds the loader:

```ts
/** The chunk's exports, as a type only: the entry bundles none of its code. */
export type RendererChunk = typeof import('./chunks/renderer.js');

export interface ChunkLoader {
  /** Starts the import at the first call and returns that promise from then on; a rejected import is never retried. */
  load(): Promise<RendererChunk>;
  /** Once `load` has resolved: the chunk, and the window's `ProgramFolds`, made with the chunk's `mergeStatements` and `isQuestionLine`. */
  loaded():
    | { readonly chunk: RendererChunk; readonly folds: ProgramFolds }
    | undefined;
}

export function createChunkLoader(
  importChunk: () => Promise<RendererChunk>,
): ChunkLoader;

/** The window's loader: its importer appends the chunk's `<link rel="stylesheet">` once, then imports the chunk. */
export const chunkLoader: ChunkLoader;

/** D21's first-line test, which the fold calls (D4). */
export const isQuestionLine: (line: string) => boolean;
```

`FenceShell` calls `loader.load()` at its first render and draws, in this order:

1. **No revision.** A fence with no completed line that is not blank has no revision ([D4](openui.md#d4-the-program-reducer)); `FenceShell` reads that from `fence.body` and `fence.state` with D4's rule, without the fold. It draws the fence's source as the chat's code block would, with the line "Writing…", or with D2's footer instead when the fence is `unterminated`.
2. **Load failed.** "The UI renderer did not load: <message>" beside the source (below).
3. **Not loaded yet.** The source with the line "Drawing…".
4. **Loaded.** It holds the fold of the Thread and `openui-lang` until it disconnects (D4), reads the fence's `ProgramRevision`, and renders the chunk's `ConversationFence` with:
   - `latest`: no later fence of `view.fences` has a revision of the same identity;
   - `superseded`: the revision is a question, and a later fence of `view.fences` is `closed`, has a revision that is a question, and has `chunk.questionOf(revision.program).input` set (D21). The readings are computed once per `view.fences` list, in a `useMemo`.

`ConversationFence`, in the chunk:

- mounts `Renderer` (react-lang 1.0.2 `dist/index.d.mts:38-79`) with `response` (the text of [D5](openui.md#d5-progressive-merge-of-patches-p4)), `library` (the conversation library of [D7](openui.md#d7-render-hosts-and-routing), built with `defineQuestionBuiltins` from `openui/contracts` and react-lang's `defineComponent`, [D17](openui.md#d17-instructions-the-skills-u13-concept-q3)), `isStreaming`, `onAction` (D20), `onError` and `publishObservability={false}` ([D23](openui.md#d23-telemetry-u8)); the main-thread cost of one root per fence, with many fences mounted, is part of [R26](#risks);
- provides the fence context (`question/fence-context.ts`) around `Renderer`: `view`, `revision`, `superseded`, `services` and `watchAnswers`, which `AskForm`'s component reads (D21);
- wraps `Renderer` in an error boundary; a crash outside OpenUI's own `render-error` handling shows "This UI failed to draw" with the message, and is reported as a `render-error`;
- makes one reporter with `createErrorReporter` ([D18](openui.md#d18-validation-feedback-u19)) per key and revision, with the check and map below and `send` calling `services.use(OpenuiProgramsV1, { projectId, threadId }).reportErrors(input)`;
- shows the fence's errors in the card below (U49);
- fills the width of the answer column, with no canvas, pan or zoom; its height follows its content;
- unterminated: the footer of [D2](openui.md#d2-fence-key-states-and-the-end-of-answer-signal).

**Keys.** The chat's fence node keeps keys inside the fence: as `<threads-ask>`'s section stops keydown propagation (`bundles/features/threads/src/client/ask.tsx:178-184`), the node stops it for the whole element ([D1](openui.md#d1-the-fence-in-the-chat-a-new-chat-contract), `openui.md` B4), so Backspace, Delete, the arrows and Enter typed in react-ui's `Input`, `TextArea` or `Select` reach the control and never the chat's Lexical editor. Popovers that Radix portals to `document.body` are outside the editor.

#### The reader's error card

Stage 5 (U49) replaces the list under the fence (`bundles/features/openui/src/client/chunks/renderer.ts:174-188`, lines of `code statementId: message`) with D18's card ([openui.md](openui.md#d18-validation-feedback-u19), "The reader's card"):

- **Its lines** are `shownErrors({ mergeFailed: revision.mergeFailed === true, owned: programCheck(revision), rendered: errors })`, where `errors` is the last list `onError` gave (`renderer.ts:105,111-112`) and `programCheck` is the first part of the conversation's check ([below](#the-conversations-check-and-map)). `ConversationFence` computes them in a `useMemo` on `streaming`, `revision` and `errors`. So the reader also sees the check's results, which only the agent saw before: `Query` and `Mutation`, `@OpenUrl`, and an `AskForm` off the root.
- **The question part of the check is left out**: D21's form already draws the agent-Thread block and, for a `closed` question fence with no `input`, the error block with `issue` ([D21](#drawing)), so the card would repeat them.
- **When.** The card is drawn when the fence is `closed` or `unterminated` and the list has a line, where the list was, after the renderer and before the actions line and D2's footer. A `streaming` fence draws no card. The footer "Sent to the agent." is drawn while `reporter.sent()` is true. The conversation has no canvas, so it has no "Nothing to draw" notice: a fence that draws nothing shows the card alone.
- **A crash** outside OpenUI's handling keeps its alert "This UI failed to draw" (`renderer.ts:168-172`); it is not in `onError`'s list, so the card does not repeat it.
- **The component** is `ErrorsCard` in `bundles/features/openui/src/client/chunks/errors-card.ts`, written with `createElement` as the chunk is (`renderer.ts:140-200`), with `CircleAlertIcon` from `lucide-react` and `data-testid="openui-fence-errors"`. Only the chunk imports it, so C13's import split holds.

#### Entry and chunk

The chunk is its own esbuild build, so a module that the entry and the chunk both import exists twice (Terms). The split is fixed:

| Build                 | Modules, under `bundles/features/openui/src/client/`                                                                                                                                                     | Module-level state                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entry                 | `index.ts`, `fence-element.tsx` (`FenceShell`), `folds.ts`, `answer-changes.ts`, `answers-projector.ts`, `settings.ts` ([D24](openui.md#d24-the-setting-and-rollback)), `chat-contract.ts`               | `folds.ts`: `chunkLoader`, which holds the chunk's load promise and the `ProgramFolds`, created at the first load with the chunk's `mergeStatements` and `folds.ts`' own `isQuestionLine`; `answer-changes.ts`: the set of watches |
| chunk                 | `chunks/renderer.ts`, `library.ts`, `check.ts`, `actions.ts`, `question/fence-context.ts`, `question/ask-input.ts`, `question/ask-form.tsx`, `question/ask.tsx`, `question/picks.ts`, `chat-contract.ts` | `question/fence-context.ts`: the React context                                                                                                                                                                                     |
| both, once per window | `openui/contracts`, an import-map specifier: identity, the fold, the error types and reporter, the built-in definitions, the question schemas and refs                                                   | none                                                                                                                                                                                                                               |

- `chat-contract.ts` is the one module both builds bundle. It holds refs, types and a hook definition, and no state; refs and hooks are matched by their contract ID (`bundles/features/threads/src/client/chat-contract.ts:69-71`), so two copies behave as one.
- The React context stays in the chunk, where both its provider and its reader are. It does not go to `openui/contracts`: the contracts entry also runs in the host (`packages/bundle/README.md:18-20`), and no bundle's contracts import React today.
- The fold runs in the entry, but its merge comes from the chunk, so the entry bundles no OpenUI package; until the chunk loads, the element draws the source and needs no fold.
- `isQuestionLine(line)` is `/^root\s*=\s*AskForm\(/.test(line)` (D21), in `folds.ts`; the chunk does not export it.
- C13 checks the split. It counts `import` and `export … from` statements that carry values; `import type` statements and `typeof import(…)` type queries are erased by esbuild and are not counted.

`chunks/renderer.ts` exports exactly:

```ts
export interface AnswerTarget {
  readonly projectId: string;
  readonly threadId: string;
  /** The prompt that wrote the question fence. */
  readonly promptId: string;
}

/** Calls `listener` on each live row `rereadsAnswer` accepts for `target`; returns the release. */
export type WatchAnswers = (
  target: AnswerTarget,
  listener: () => void,
) => () => void;

export interface ConversationFenceProps {
  readonly view: ChatFenceView; // D1
  /** The fence's revision from the fold (D4); the entry renders this component only once there is one. */
  readonly revision: ProgramRevision;
  /** No later fence of `view.fences` has a revision of the same identity. */
  readonly latest: boolean;
  /** A question fence, unanswered or not, with a later `closed` question fence in `view.fences` whose question passes `askInputSchema` (D21); the component draws it superseded only while `status` is `pending`. */
  readonly superseded: boolean;
  /** The element's services: `chat.send/v1`, `openui.questions/v1`, `openui.programs/v1`. */
  readonly services: Services;
  /** The entry's `watchAnswers` (`answer-changes.ts`). */
  readonly watchAnswers: WatchAnswers;
}

export function ConversationFence(props: ConversationFenceProps): ReactNode;

/** lang-core's merge, as react-lang re-exports it (react-lang 1.0.2 `dist/index.mjs:1351`), for the entry's fold. */
export { mergeStatements } from '@openuidev/react-lang';

/** D21's reading of a question fence's program, for the entry's `superseded`. */
export { questionOf, type QuestionRead } from '../question/ask-input.js';
```

#### The conversation's check and map

`check.ts` holds the conversation's `check` and `map` for `createErrorReporter` ([D18](openui.md#d18-validation-feedback-u19); [D7](openui.md#d7-render-hosts-and-routing) names them). One statement per line is assumed, as in D5, so a statement's name is the identifier before `=` on its line.

`check.ts` exports `programCheck(revision)`, which returns items 1 to 3 below, and `questionCheck(view, revision)`, which returns items 4 and 5; `check` returns `[...programCheck(revision), ...questionCheck(view, revision)]`, so what the reporter sends does not change. The card lists `programCheck`'s results only ([above](#the-readers-error-card)). The items, in this order, each message cut to 300 characters:

1. Each statement in `queryStatements` and `mutationStatements` of `createParser(library.toJSONSchema(), library.root).parse(program)` (react-lang 1.0.2 exports `createParser`, `dist/index.mjs:1351`; `ParseResult`, lang-core 1.0.2 `dist/index.d.mts:333-355`): `{ code: 'tool-not-found', statementId, message: 'Query and Mutation are not available; write the data as literals.' }`.
2. Each statement whose line contains `@OpenUrl(`: `{ code: 'runtime-error', statementId, message: 'OpenUrl is disabled; write the link as text' }`.
3. When the program has a line that calls `AskForm(` and the fence is not a question fence: `{ code: 'runtime-error', statementId: <that line's name>, message: 'A question must be the root of its own fence: write root = AskForm(…) as its first line.' }`.
4. For a question fence in an agent Thread: `{ code: 'runtime-error', statementId: 'root', message: <ask's REFUSED text> }` (`bundles/features/threads/src/host/tools/ask.ts:16-17`).
5. For a `closed` question fence whose `questionOf` reading has no `input` (D21): `{ code: 'runtime-error', statementId: 'root', message: 'Invalid question: ' + issue }`.

`map(error)` gives `{ code: error.code, statementId: error.statementId, message }`, where `message` is OpenUI's `error.message`, followed for `unknown-component` by one space and D7's hint "Repository components and Export exist only in papercraft fences.", cut to 300 characters. The conversation runs no repository code (D7), so OpenUI's message is the shell's own text and is kept, unlike a frame error's (D18).

**`Modal` is drawn inline (U28).** react-ui's library includes `Modal`, which opens a dialog over the window. The conversation library overrides it through `library.extend` (lang-core 1.0.2 `dist/index.d.mts:624-640`) with a component that draws its title and children inside the fence, in a bordered block, when its open state is true. So no model-written UI covers the composer, the sidebar or another answer. Popovers of `Select` and `DatePicker` stay anchored to their trigger inside the fence.

#### Loading on demand

`Renderer`, `openuiLibrary`, the question form and their dependencies are a client chunk, `bundles/features/openui/src/client/chunks/renderer.ts`, loaded by `folds.ts` at the first fence of a window. Until it loads, the element shows the fence's source as the chat's code block would, with a "Drawing…" line. The concept measured the renderer plus `openuiLibrary` at 3.0 MB of minified JS, 873 KB gzipped, with React external (concept [R3](../features/papercraft.md#risks)); the layered sheet is 363,233 bytes ([D31](openui.md#d31-the-built-in-library-and-dorics-tokens)).

- Client parts are one ES module today, `client/index.js`, plus frames and workers (`packages/bundle/src/build/parts.ts:347-363,392-419`). `packages/bundle` gains **client chunks**:
  - `buildParts` builds each `src/client/chunks/<name>.ts`, found by `entriesOf` (`parts.ts:280-289`) in file-name order, inside its `if (hasClient)` block after the workers (`:347-389`): through `buildScript` with `platform: 'browser'`, `external: clientExternals` (`packages/bundle/src/build/externals.ts:10-25`) and `partPlugin` with `part: 'client'`, `forbidden: forbiddenInClient` (`parts.ts:82-87`) and `external: clientExternals`, as the client entry is, into `client/chunks/<name>.js`, labelled `client chunk <name>`. A chunk without a client entry is not built.
  - The CSS esbuild extracts from a chunk's imports stays beside it as `client/chunks/<name>.css`; unlike the entry's (`:365-368`), it is not merged into `client/styles.css`.
  - `BuiltParts` gains `readonly chunks?: readonly string[]`, the `client/chunks/<name>.js` paths, set when there is at least one, as `frames` is (`:45-46,417-421`).
  - Stale chunks need no `rm` of their own: `buildParts` removes `dist/client` whenever the bundle has a client entry or sheet (`:339-341`), and builds chunks only then. Frames have their own `rm` (`:397`) because they are built without a client entry.
  - Every file under `client/` is distributed to the desktop (`packages/bundle/src/loader/distribution.ts:24-30`), so the protocol serves the chunk; `distributionParts` names fixed paths only (`:139-150`), so the window's bundle loader loads only `client/index.js`, never a chunk.
  - A chunk is a browser build, so it takes [D23](openui.md#d23-telemetry-u8)'s `define` of `process.env.NODE_ENV` as `"production"`: in the renderer chunk, react-lang does not import `@openuidev/devtools` or mount OpenUI's Inspect widget, and does not publish the library to `globalThis` (react-lang 1.0.2 `dist/index.mjs:19-44,47-87`). C16 and C17 test it.
- The entry imports it with `import(new URL('./chunks/renderer.js', import.meta.url).href)`, once per window, and adds one `<link rel="stylesheet">` for its CSS. React and zod come from the window's import map, so the chunk shares the window's single React (`externals.ts:1-4`).
- **When it fails to load**, every waiting element shows "The UI renderer did not load: <message>" beside the fence's source, with no retry. A window stays pinned to its bundle generation and nothing reloads it (`app/desktop/doric/src/platform/app.ts:1081-1084`), and the protocol serves the files of a retained generation under versioned URLs (`app/desktop/doric/src/platform/protocol/import-map.ts:40-44`, `handler.ts:210`), so an update during the session does not remove the chunk; no other cause has been measured. A new window imports it again. A question stays readable as source, and the reader can answer in prose.

#### CSS

Two sheets:

- **The client's sheet**, `bundles/features/openui/src/client/styles.css`, holds the Tailwind utilities of the question form and the element. `buildStyles` compiles it like every bundle's client sheet (`packages/bundle/src/build/parts.ts:238-263,306,424-434`), and the window loads it with the entry. Its lines are those of `threads`' sheet (`bundles/features/threads/src/client/styles.css:1-20`): `@import 'tailwindcss/utilities.css' layer(utilities);`, `@reference 'desktop/ui/tailwind.css';`, `@source './';` and the same four `@source` lines for `packages/desktop/src` and the layout, chat and settings windows. `@source './'` covers `question/` and `chunks/`, so the classes of the chunk's components are generated before the chunk loads, and they stay generated after stage 4 removes `threads`' copy.
- **The chunk's CSS** is react-ui's layered sheet and Doric's token sheet ([D31](openui.md#d31-the-built-in-library-and-dorics-tokens)), with the layer order `@layer openui, openui-doric;` stated first.

- Cascade layers rank in the order they are first declared, a later layer above an earlier one, and unlayered styles above all layers ([MDN, `@layer`](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer)). The app's sheets, which declare its own layers, load with the window; the chunk's `<link>` is appended later. So `openui` and `openui-doric` rank above the app's layers, and react-ui's rules win over Tailwind's base styles on react-ui's elements; the app's unlayered styles still win over both.
- react-ui's rules match only `.openui-*` classes and attributes, and set variables on `:root` (D31). Portaled popovers carry the same classes, so they are styled where they are mounted.
- The one keyframe without the prefix, `fadeIn`, is kept as is: layers do not scope keyframe names, and no Doric source defines `fadeIn` (D31). The `openui` README records the name as taken; a collision is part of [R26](#risks).

#### CSP

The shell policy does not change (`app/desktop/doric/src/platform/protocol/csp.ts:13-26`):

- `script-src 'self'` covers the chunk, which is served from the bundle's own directory on `doric://app`; the packaged policy has no `'unsafe-eval'`, so the renderer is checked in a packaged build before the user accepts stage 2;
- `style-src 'self' 'unsafe-inline'` covers the `<link>` and any style react-ui sets inline;
- `img-src 'self' data:` blocks remote images; the packaged policy's `connect-src 'none'` blocks any request, while the development policy allows `'self'` and the dev server's WebSocket (`csp.ts:22,36-40`);
- a link inside the UI cannot navigate the window or open one: the navigation guard prevents both (`app/desktop/doric/src/platform/windows/navigation-guard.ts:36-48`).

The protections that let the shell draw model-written UI are stated once, in [D7](openui.md#d7-render-hosts-and-routing).

#### Alternatives

- _esbuild's own code splitting for the client entry_, with `splitting: true` and a dynamic `import()`, and no `src/client/chunks/` convention. Rejected: U20 chose a client-chunk kind; splitting needs `outdir` instead of the client build's `outfile` (`packages/bundle/src/build/parts.ts:201-213,350`), which changes the output of every bundle's client; and esbuild documents code splitting as work in progress, with a known ordering issue for imports across chunks (https://esbuild.github.io/api/#splitting).
- _Retry a failed chunk load with a new URL_ (version 5). Rejected: the cause it named, an update during the session, cannot remove the chunk of a pinned window (above).
- _Load the renderer with the client entry._ Rejected: every window would fetch and evaluate 3.0 MB at start, also in Threads with no fence; the lazy chunk keeps window start as it is.
- _A frame per conversation fence_ (P2). Rejected by U18; it stays the option if the shell's isolation fails in use ([R26](#risks)).
- _A shadow root per fence for CSS isolation._ Rejected: Radix portals popovers, menus and dialogs to `document.body` (concept R14), outside the shadow root, where the sheet would not apply.
- _Keep react-ui's `Modal`._ Rejected: a model-written dialog over the window could draw a control that looks like the app's own (R32).
- _The fence context in `openui/contracts`, so that both builds share one object._ Rejected: the contracts entry also runs in the host, and no bundle's contracts import React; the context's provider and reader are both in the chunk anyway.
- _Rename `fadeIn` in a build step._ Rejected: the step would exist for a collision no Doric source has; it stays the option if a collision appears ([R26](#risks)).

**Confirmed** by the user (U20): loading at a window's first fence; preloading at idle stays the option if the first fence draws late in use.

### Error feedback

[D18](openui.md#d18-validation-feedback-u19) applies with the `openui` bundle as owner: the chunk reports, once per fence, what `onError` gave through the conversation's map and the results of its check ([D29](#the-conversations-check-and-map)); the host delivers them in the same turn, as a steer of the running prompt, or as a new prompt after it, within D18's bounds (U50). The reader sees them in the card ([D29](#the-readers-error-card)). Actions report nothing at the click (D20). A repository component or `Export` in a conversation fence gets [D7](openui.md#d7-render-hosts-and-routing)'s hint.

### D30. Removing `ask`

- **Stage 3** (U41). With the setting on, the `openui` host calls `threads.ask/v1.withholdTool()` and keeps the `Disposable` while it stays on ([D24](openui.md#d24-the-setting-and-rollback)). The tool leaves the model's list; `threads.ask/v1`'s service, events and `<threads-ask>` stay, so earlier questions still draw and answer.
- **Stage 4.** `threads` removes the `ask` tool, `threads.ask/v1` (with `withholdTool`), `askProjector`, `<threads-ask>`, the registration of `threads.asked/v1` and `threads.answered/v1`, and their tests and story; `openui` drops its optional dependency on `threads.ask/v1`.
- **Old questions.** `threads` registers `oldAskProjector` (`bundles/features/threads/src/client/old-asks.ts`): `{ eventTypes: ['threads.asked/v1', 'threads.answered/v1'], initial: () => null, reduce: (state) => ({ state, blocks: [] }) }`, with the two types written as literals, since the contracts that defined them are gone. So the old rows are not drawn as generic payload blocks (`bundles/desktop/chat/src/client/domain/external-blocks.ts:5-7`). Old conversations lose their question blocks; the answers stay in the user turns, as text (U29).
- **What else `threads` loses in stage 4.** Its contracts entry held only `ask` (`bundles/features/threads/src/contracts/index.ts:39-230`) and no other bundle imports it, so `src/contracts/index.ts`, the `./contracts` export of `package.json` and the `src/contracts/**/*.ts` lines of `tsconfig.client.json:17` and `tsconfig.spec.json:15` go. The client keeps `chat-contract.ts` without `ChatHooksV1` and `ThreadUpdateInput`, which only the live refresh used. The manifest drops `events/v1` and `hooks/v1` from `requires`, which only `ask` used (`bundles/features/threads/src/host/index.ts:35-38`, `bundles/features/threads/src/client/index.ts:55-58`), and `desktopScope`.
- The model-facing mentions of `ask` change in stage 3 ([Stage 3](openui.md#stage-3-the-default)).

## Phases

The stages, their gates and the shared parts are in [openui.md](openui.md#phases). This document's part:

| Stage | Lands                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | D20, D21, D22 and D29 behind the setting: the `openui-fence` element, the chunk and `packages/bundle`'s client chunks, the question built-ins and service, `chat.send/v1.sendAction`, the `<ui-action>` envelope and the default system prompt's line for it; the projector of `openui.answered/v1`, whatever the setting |
| 3     | D30's first part: `ask` withheld while the setting is on                                                                                                                                                                                                                                                                  |
| 4     | D30's second part: `ask`, `threads.ask/v1` and `<threads-ask>` removed; the no-block projector for old events                                                                                                                                                                                                             |

| Bundle                                                    | Stage 2                                                                                                                                                                                                              | Stage 3                                                                 | Stage 4                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `openui` (new: 1.0.0, 1.1.0 in stage 3, 2.0.0 in stage 4) | the `openui-fence` element and the chunk (D29); the question built-ins, and `AskQuestions` and `Settled` copied from `threads` (D21); `openui.questions/v1` and `openui.answered/v1` (D22); the action handler (D20) | the `withholdTool` call ([D24](openui.md#d24-the-setting-and-rollback)) | its optional dependency on `threads.ask/v1`                                                                                |
| `chat`                                                    | `chat.send/v1` 1.1.0 `sendAction`; `routeSend`, which the composer's hook also calls; the `<ui-action>` envelope; the user turn's `action` caption (D20)                                                             | —                                                                       | —                                                                                                                          |
| `default` (stays 2.3.0)                                   | one line of `system.md` names `<ui-action>` (D20)                                                                                                                                                                    | —                                                                       | —                                                                                                                          |
| `threads` (1.1.0 → 1.2.0 in stage 3 → 2.0.0 in stage 4)   | a test of its `AskQuestions` against the shared markup fixture (C9)                                                                                                                                                  | `threads.ask/v1` 1.2.0 `withholdTool`                                   | `ask`, `threads.ask/v1`, its events' registration, its UI and its contracts entry; a no-block projector for the old events |
| `packages/bundle`                                         | client chunks (D29)                                                                                                                                                                                                  | —                                                                       | —                                                                                                                          |

**Stage 5 (U49–U51)**, with [openui.md](openui.md#stage-5-fixes-after-use-u49u51): the card of [D29](#the-readers-error-card) and the split of the check land in step 1 of stage 5, with test C18. U50 and U51 change nothing in this document's files: the host side is D18's, and the skill rules are D17's.

## Files to change

This document's decisions only; [openui.md](openui.md#files-to-change) lists the shared ones. `openui` paths are under `bundles/features/openui/`, and `chat` paths under `bundles/desktop/chat/`.

| File                                                                                                                                                                                                                                                                                                                                           | Change                                                                                                                                                                                                                                                         | Stage |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/bundle/src/build/parts.ts`, `packages/bundle/tests/parts.test.ts`                                                                                                                                                                                                                                                                    | D29: client chunks built from `src/client/chunks/*.ts`, their CSS beside them, listed as `BuiltParts.chunks`; C16                                                                                                                                              | 2     |
| `packages/bundle/tests/distribution.test.ts`                                                                                                                                                                                                                                                                                                   | C16: `distributionParts` names no chunk, and the distribution lists the chunk's files                                                                                                                                                                          | 2     |
| `openui` `src/client/index.ts` (new)                                                                                                                                                                                                                                                                                                           | D29: defines `<openui-fence>`; registers the fence renderer while the setting is on, and `answersProjector` and `noticeThreadUpdate` whatever the setting                                                                                                      | 2     |
| `openui` `src/client/fence-element.tsx`, `src/client/folds.ts` (new)                                                                                                                                                                                                                                                                           | D29: `createFenceShell`: the source before the chunk and without a revision, the load failure, `latest` and `superseded`; `RendererChunk`, `ChunkLoader`, `createChunkLoader`, `chunkLoader` with the stylesheet link, the `ProgramFolds` and `isQuestionLine` | 2     |
| `openui` `src/client/answer-changes.ts`, `src/client/answers-projector.ts` (new)                                                                                                                                                                                                                                                               | D21, D29: `noticeThreadUpdate`, `watchAnswers`, `rereadsAnswer`; the projector of `openui.answered/v1`                                                                                                                                                         | 2     |
| `openui` `src/client/chat-contract.ts` (new)                                                                                                                                                                                                                                                                                                   | D29: the structural copies of `chat.views/v1`, `chat.send/v1` and `chat.hooks/v1`                                                                                                                                                                              | 2     |
| `openui` `src/client/chunks/renderer.ts`, `src/client/library.ts`, `src/client/check.ts` (new)                                                                                                                                                                                                                                                 | D29: `ConversationFence` and the chunk's exports; the conversation library with `defineQuestionBuiltins` and the `Modal` override; the conversation's check and map                                                                                            | 2     |
| `openui` `src/client/actions.ts` (new)                                                                                                                                                                                                                                                                                                         | D20: the action text, when an action works, the in-flight guard, the lines under the fence                                                                                                                                                                     | 2     |
| `openui` `src/client/question/fence-context.ts`, `src/client/question/ask-form.tsx` (new)                                                                                                                                                                                                                                                      | D21: the fence context; `AskForm`'s component                                                                                                                                                                                                                  | 2     |
| `openui` `src/client/question/ask-input.ts` (new)                                                                                                                                                                                                                                                                                              | D21: `QuestionRead` and `questionOf`                                                                                                                                                                                                                           | 2     |
| `openui` `src/client/question/ask.tsx`, `src/client/question/picks.ts`, `stories/ask.stories.tsx`, `.storybook/preview.tsx` (copied from `threads`)                                                                                                                                                                                            | D21: `AskQuestions` and `Settled` with `settledHeading`, `disabled` and `note`; the picks helpers; the stories and their preview harness                                                                                                                       | 2     |
| `openui` `src/client/styles.css` (new)                                                                                                                                                                                                                                                                                                         | D29: the client's Tailwind sheet                                                                                                                                                                                                                               | 2     |
| `openui` `src/contracts/questions.ts` (new), `src/contracts/index.ts`                                                                                                                                                                                                                                                                          | D22: the copied schemas, `OpenuiQuestionsV1` and its method specs, `answeredEvent`                                                                                                                                                                             | 2     |
| `openui` `src/host/questions.ts` (new), `src/host/index.ts`                                                                                                                                                                                                                                                                                    | D22: `status`, `answer`, the digest, the route of D20 against `runtime.threads/v1`, the copied checks and `formatAnswers`; the event's registration                                                                                                            | 2     |
| `openui` `manifest.json`                                                                                                                                                                                                                                                                                                                       | provides `openui.questions/v1@1.0.0` and `openui.answered/v1@1.0.0`; requires `chat.send/v1@^1.1.0` and `events/v1@^1.0.0`; `desktopScope` gains `"openui.questions/v1": ["projectId", "threadId"]` beside openui.md's entry                                   | 2     |
| `openui` `package.json`                                                                                                                                                                                                                                                                                                                        | `dependencies`: `lucide-react` `^0.544.0`, as `threads` has it (`bundles/features/threads/package.json:19`); `devDependencies`: `threads` (C9's schema case) and `happy-dom` `20.8.9`, as `threads` has it                                                     | 2     |
| `openui` `project.json`                                                                                                                                                                                                                                                                                                                        | the `test` target's `dependsOn` is `["build", "^build"]`, as `threads`' is (`bundles/features/threads/project.json:32`), so C17 reads the built chunk                                                                                                          | 2     |
| `openui` `tests/questions.test.ts`, `tests/client-split.test.ts`, `tests/client-chunk.test.ts`, `tests/client/actions.test.ts`, `tests/client/ask-form.test.ts`, `tests/client/answer-changes.test.ts`, `tests/client/fence-element.test.ts`, `tests/client/ask-markup.test.ts`, `tests/fixtures/ask-markup.json` (new)                        | [Test plan](#test-plan)                                                                                                                                                                                                                                        | 2     |
| `bundles/features/threads/tests/client/ask-markup.test.ts` (new)                                                                                                                                                                                                                                                                               | C9                                                                                                                                                                                                                                                             | 2     |
| `chat` `src/contracts/index.ts`, `manifest.json`                                                                                                                                                                                                                                                                                               | D20: `ChatActionInput`, `ChatActionResult`, `sendAction`; `chat.send/v1@1.1.0`. The bundle's version goes from 1.5.1 to 1.6.0 once, in openui.md's row, for all of stage 2's chat changes                                                                      | 2     |
| `chat` `src/client/services/send.ts`                                                                                                                                                                                                                                                                                                           | D20: `ChatSendDependencies.threads`, `sendUiAction`, `sendAction`                                                                                                                                                                                              | 2     |
| `chat` `src/client/domain/send-route.ts` (new), `src/client/hooks/use-thread-chat.ts`                                                                                                                                                                                                                                                          | D20: `routeSend`; the hook's ports                                                                                                                                                                                                                             | 2     |
| `chat` `src/client/domain/prompt-envelope.ts`                                                                                                                                                                                                                                                                                                  | D20: `uiActionEnvelope`, `ui-action` in `ENVELOPE_ELEMENTS`, `readEnvelope`, `ParsedPromptEnvelope.action`, `previewSummary`                                                                                                                                   | 2     |
| `chat` `src/client/domain/projector-input.ts`, `src/client/domain/projector.ts`                                                                                                                                                                                                                                                                | D20: the user turn's `action`                                                                                                                                                                                                                                  | 2     |
| `chat` `src/client/components/organisms/conversation/nodes/user-turn-node.tsx`, `src/client/components/organisms/conversation/plugins/insert-thread-turn-nodes.tsx`, `src/client/styles.css`                                                                                                                                                   | D20: the caption                                                                                                                                                                                                                                               | 2     |
| `bundles/runtime/default/src/host/prompts/system.md`                                                                                                                                                                                                                                                                                           | D20: line 24 names `<ui-action>`, with the text D20 gives                                                                                                                                                                                                      | 2     |
| `chat` `tests/send.test.ts`, `tests/send-route.test.ts` (new), `tests/prompt-envelope.test.ts`, `tests/prompt-readback.test.ts`, `tests/client/composer.test.ts`, `tests/client/conversation-nodes.test.ts`                                                                                                                                    | [Test plan](#test-plan)                                                                                                                                                                                                                                        | 2     |
| `openui` `src/host/index.ts`, `manifest.json`, `tests/setting.test.ts`                                                                                                                                                                                                                                                                         | D30: the `withholdTool` call; optional `threads.ask/v1@^1.2.0`; C10                                                                                                                                                                                            | 3     |
| `bundles/features/threads/src/host/ask.ts`, `src/host/tools/ask.ts`, `src/contracts/index.ts`, `src/client/ask.tsx`, `src/client/ask-changes.ts`, `src/client/domain/ask.ts`, `stories/ask.stories.tsx`, `tests/ask.test.ts`, `tests/ask-block.test.ts`, `tests/client/ask.test.ts`, `tests/client/ask-markup.test.ts`, `tests/support/ask.ts` | D30: deleted                                                                                                                                                                                                                                                   | 4     |
| `bundles/features/threads/src/host/index.ts`                                                                                                                                                                                                                                                                                                   | D30: no `askService`, no event registration, no `ask` in the tool list (`:16-44`)                                                                                                                                                                              | 4     |
| `bundles/features/threads/src/client/index.ts`, `src/client/old-asks.ts` (new), `src/client/chat-contract.ts`                                                                                                                                                                                                                                  | D30: no `<threads-ask>`, `askProjector` or live refresh; `oldAskProjector`; `ChatHooksV1` and `ThreadUpdateInput` removed                                                                                                                                      | 4     |
| `bundles/features/threads/manifest.json`, `package.json`, `tsconfig.client.json`, `tsconfig.spec.json`                                                                                                                                                                                                                                         | D30: version 2.0.0; no `provides`, no `events/v1` or `hooks/v1`, no `desktopScope`; no `./contracts` export or contracts sources                                                                                                                               | 4     |
| `bundles/features/threads/tests/threads.test.ts`, `tests/old-asks.test.ts` (new), `tests/client/support/window.ts`                                                                                                                                                                                                                             | C11, C12; `askRemote` and its use removed (`window.ts:185-189,407`)                                                                                                                                                                                            | 4     |
| `app/backend/doric-host/tests/bridge-exposure.snapshot.json`                                                                                                                                                                                                                                                                                   | the `threads.ask/v1` entry (`:114`) removed                                                                                                                                                                                                                    | 4     |
| `openui` `manifest.json`, `src/host/index.ts`                                                                                                                                                                                                                                                                                                  | D30: the optional dependency and the call removed                                                                                                                                                                                                              | 4     |
| `openui` `package.json`, `tests/questions.test.ts`                                                                                                                                                                                                                                                                                             | the `threads` devDependency and C9's schema case removed                                                                                                                                                                                                       | 4     |

**Stage 5 (U49).**

- `bundles/features/openui/src/client/chunks/renderer.ts`: the card in place of the list (`:174-188`), its lines from `shownErrors` of `openui/contracts`, its footer from `reporter.sent()`.
- `bundles/features/openui/src/client/chunks/errors-card.ts` (new): `ErrorsCard`, D18's markup.
- `bundles/features/openui/src/client/check.ts`: `programCheck` and `questionCheck`; `check` gives the same result.
- `bundles/features/openui/tests/client/fence-element.test.ts`: C18.

## Test plan

Tests follow `.agents/skills/behavioral-testing/SKILL.md`. `openui` client tests run in happy-dom, as `threads`' client tests do.

### Stage 2

- **C1** (`openui` `tests/client/actions.test.ts`): the "Tag it" event of D20, with `formState` `{ release: { version: { value: '1.4.0', componentType: 'Input' } } }`, gives the text shown there; the same event with `formName` `release` and a whole store that holds no `release` key, but another form and a `$filter`, gives `Tag the release` alone; `context` adds its line; a card's event with `params` `{ itemIndex: 0, itemId: 'pg', itemHeaderTitle: 'Postgres' }` gives those three lines in that order, after the `context` line when there is one; an `EditableTable` "Save Changes" event gives its one `<table>.<table>:` line with the rows as JSON; an event outside a form whose `formState` holds `$filter`, another form and a field outside a form gives only the `$filter` line; the values `undefined`, `null`, `3` and a function give no line, `null`, `3` and no line; a `Button` with no action gives its label; an empty message (also with value lines), an `open_url` event, an unknown type and a text of 16,001 UTF-16 code units each give no send and their line under the fence, and a text of exactly 16,000 is sent.
- **C2** (`openui` `tests/client/actions.test.ts`): an action on a `streaming` fence, on an `unterminated` fence, on an older revision and in an agent Thread does not send and shows its line; two events in one task send once; a second click within 500 ms of an accepted send does not send; a `sendAction` that rejects with a `ContractError` shows "Not sent: " and its message, reports nothing, and the fence takes the next click once 500 ms have passed.
- **C3** (`chat` `tests/send-route.test.ts`, `tests/send.test.ts`, `tests/client/composer.test.ts`):
  - `routeSend`, with fake ports: it steers an active prompt; prompts when none runs; resumes a paused, empty queue first; does not resume a paused queue that holds only a `resumable` prompt, nor one with items; gives `false` when `resumeQueue` gives `false` and when a port rejects.
  - `sendUiAction`, with a fake `threads`: the same cases through `steer`, `queue`, `resumeQueue` and `prompt`, with the envelope as the prompt; a Thread with `origin` `agent`, a Thread of another Project, and a `get` that gives `undefined` answer `refused` with no other call; a `prompt` or a `resumeQueue` that throws answers `refused`; the composer's draft, stack and pending turn are unchanged after an accepted send.
  - `sendAction` through `chat.send/v1` in a window: a text of 16,001 UTF-16 code units, a text of spaces and the program `Release` each reject with `invalid_input` and call no `threads` method; a text with leading and trailing blank lines reaches `prompt` unchanged inside the envelope.
  - In a window, through the composer and its fake `runtime.threads/v1` (`composer.test.ts:1155-1226`): the existing steer tests still pass (Cmd+Enter steers with no `interrupt`, Escape with `interrupt: true`); a send while the queue is paused and holds no `current`, `resumable` or items calls `resumeQueue` and then `prompt`; with a paused queue that holds a `resumable` prompt it calls `prompt` and not `resumeQueue`; when `resumeQueue` answers `busy`, it calls no `prompt` and the composer keeps the words.
- **C4** (`chat` `tests/prompt-envelope.test.ts`, `tests/prompt-readback.test.ts`, `tests/client/conversation-nodes.test.ts`): `uiActionEnvelope` round-trips through `parsePromptEnvelope` with `action.program` and `comments: []`; a body holding `</ui-action>` stays one element; a text with words after `</ui-action>` is not an envelope; `previewSummary` and `queueRowText` show the body; `withPromptMessage` on a UI-action prompt gives a `<message>` and no `<ui-action>`; the user turn of a UI-action prompt has `action`, its block carries `data-ui-action`, and an `exportJSON` and `importJSON` round trip keeps it.
- **C5** (`openui` `tests/questions.test.ts`, through `openui.questions/v1` and a fake `runtime.threads/v1`): a call whose scope lacks `projectId` or `threadId` is `invalid_scope` for both methods, before any read; invalid `questions` are `invalid_input` for both methods, from the contract layer; in an agent Thread, `answer` is `unavailable` with `{ status: 'forbidden' }` and nothing is sent, resumed or written; a Thread that is `undefined` or of another Project is `unavailable` with `{ status: 'missing' }`; answers that fail `ask`'s checks are `invalid_input`; a valid answer steers the running prompt, or with none prompts, after resuming a paused, empty queue and without resuming a paused queue that holds a `resumable` prompt, and writes `openui.answered/v1` with `questionPromptId` and the digest under the prompt that took it; a second answer returns the first; two calls for one question at once send once; a refused steer or prompt, a `queue` that gives `undefined` and a `resumeQueue` that answers `busy` are `unavailable` with the runtime's status in `details` and write nothing; a `steer`, `prompt` or `thread` that rejects is `unavailable` with `{ reason }` holding the error's message; a rejected `threadEvents` or append rejects with that error; each runtime and events call carries the method's call.
- **C6** (`openui` `tests/questions.test.ts`, with a fake log that applies the runtime's rewind rule, every row from the rewound prompt's first row on removed): `status` is `answered` after replay of the same log; a rewind of the prompt that took the answers, of a prompt that ran between the question and the answer, and of the question's prompt each give `pending`; a rewind of a prompt whose first row comes after the answered row leaves it `answered`; the same questions in fences of two prompts are two questions, and answering the first leaves the second `pending`; two fences of one prompt with the same questions share the answer.
- **C7** (`openui` `tests/client/ask-form.test.ts`, with a fake `openui.questions/v1`): each row of D21's table draws what it states, in its order: not a question fence, an agent Thread, `streaming` with its controls disabled and the note, `streaming` before any question has parsed with the note alone, `unterminated` with only the questions that pass `askQuestionSchema`, an invalid question with its `issue`, answered, superseded and pending; `questionOf` maps a valid program to the `AskInput` of D21's example, gives `issue` for a question with one option and for a root that is not `AskForm`, and keeps in `questions` only the entries that pass; Send calls `answer` with `toAnswers`; a rejected `answer` shows "Could not send. Try again." with the picks kept; the check gives cases 3 to 5 of D29's check.
- **C8** (`openui` `tests/client/fence-element.test.ts`, with `createFenceShell` over a fake `ChunkLoader`): before the import settles, a fence with a completed line shows its source with "Drawing…"; a fence with no completed line shows its source with "Writing…", before and after the load, and an `unterminated` one D2's footer; `latest` is false for an earlier revision of an identity and true for its last; a question is `superseded` by a later `closed`, valid question, and not by a later streaming, cut-off or invalid one; a failed chunk import shows "The UI renderer did not load" with its message beside the source, and no second import; a `Modal` with open state true draws inside the element, with nothing added to `document.body`; a render crash shows "This UI failed to draw" and reports `render-error` once; a fence that calls `Query` reports one `tool-not-found` with the hint; an `unknown-component` error's message ends with D7's hint; `answersProjector` gives no block for an `openui.answered/v1` row, also while the setting is off.
- **C9** (`openui` `tests/client/ask-markup.test.ts`, `bundles/features/threads/tests/client/ask-markup.test.ts`, `openui` `tests/questions.test.ts`): `openui` `tests/fixtures/ask-markup.json` holds the props of the 12 states of `threads`' stories (`bundles/features/threads/stories/ask.stories.tsx`, the `states` list that `AllStates` draws) with the `innerHTML` each renders; each bundle's test renders its own `AskQuestions` with each state's props and a no-op `onSend`, and compares the markup. `threads`' test writes the fixture when `ASK_MARKUP_UPDATE=1` is set, and compares otherwise. `z.toJSONSchema` of `openui`'s `askInputSchema` and `askAnswerSchema` equals that of `threads`'.
- **C13** (`openui` `tests/client-split.test.ts`): the relative imports reachable from `src/client/index.ts` and from `src/client/chunks/renderer.ts`, read from the sources, share only `src/client/chat-contract.ts`; no module under `src/contracts` imports `react`.
- **C14** (`openui` `tests/client/answer-changes.test.ts`): `rereadsAnswer` accepts an `openui.answered/v1` row of the target's prompt and a `history.truncated` row of the target's Thread, and rejects a row of another prompt, of another Thread and of another type; `noticeThreadUpdate` calls each matching watch once, and calls the others when one throws; a released watch is not called.
- **C15** (`chat` `tests/client/conversation-nodes.test.ts`, with a fence renderer whose element holds an `<input>`): Backspace, Delete, the arrows and Enter typed in the input reach it, and the turn's text is unchanged.
- **C16** (`packages/bundle` `tests/parts.test.ts`, `tests/distribution.test.ts`, real esbuild): a bundle with a client entry and `src/client/chunks/a.ts` and `b.ts`, where `a.ts` imports a CSS file, `react` and the bundle's own contracts, gives `chunks: ['client/chunks/a.js', 'client/chunks/b.js']`, `client/chunks/a.css` beside `a.js`, `client/styles.css` without `a.ts`'s CSS, and `react` and `demo/contracts` left external in `a.js`; a chunk that imports `desktop/client` fails with `PartBuildError`; a chunk file left in `dist/client/chunks/` by an earlier build is gone after the next; a chunk without a client entry is not built; a chunk that reads `process.env.NODE_ENV` and, when it is `"development"`, dynamically imports a fixture package gets `"production"` in both build modes and does not hold the package's code (D23, B21); `distributionParts` over a distribution that lists `client/chunks/a.js` gives the same parts as without it, and the distribution lists the chunk's files.
- **C17** (`openui` `tests/client-chunk.test.ts`, over `dist/client/chunks/renderer.js` from the production build the `test` target depends on): the chunk imports nothing from `@openuidev/devtools`, and holds neither the string `data-openui-devtools-auto-mount` nor any `process.env.NODE_ENV` or `process.env["NODE_ENV"]`, so react-lang's dev-tools mount and library publishing were folded away (D23); the entry `dist/client/index.js` holds no `@openuidev/` import.

### Stage 3

- **C10** (`openui` `tests/setting.test.ts`): with the setting on, the `withholdTool` disposable is live; turning the setting off disposes it and `ask` is listed again.

### Stage 4

- **C11** (`bundles/features/threads/tests/threads.test.ts`): `ask` is not among the registered tools (the list at `:47` loses it), and `threads.ask/v1` is not provided.
- **C12** (`bundles/features/threads/tests/old-asks.test.ts`): `oldAskProjector` claims exactly `threads.asked/v1` and `threads.answered/v1`, and gives no block for a row of either.

### Stage 5

- **C18** (`openui` `tests/client/fence-element.test.ts`, rendering `ConversationFence` with a fake `openui.programs/v1`): a `closed` fence with a `Query` statement `data` and a statement `card` that calls a component the library does not have draws one card, `section[aria-label="Program errors"][data-testid="openui-fence-errors"]` with the classes of D18's markup, whose header reads "2 errors"; its first line is `data: ` in a `font-mono` span followed by "Query and Mutation are not available; write the data as literals.", its second is `card: ` followed by OpenUI's `unknown-component` message; no line holds a code; the footer "Sent to the agent." is drawn once `reportErrors` was called. A fence with one error reads "1 error". The same program while `streaming` draws no card, and a `closed` fence with no error draws none. A question fence in an agent Thread draws D21's block and no card line with ask's refusal text.

## Alternatives considered

Alternatives specific to one decision are under that decision; the shared ones are in [openui.md](openui.md#alternatives-considered).

- **Keep `ask` beside the question form.** Rejected by U12.

## Risks

Risk numbers do not repeat across the three documents; this one uses R13, R19, R24, R26, R27, R32 and R33.

- **R13 Actions.** Covered by D20's mitigations table.
- **R19 Removing `ask`.** Prompts, skills and workflows that call `ask` stop working until they change. Mitigation: stage 3 ships only when the user accepts it ([Phases](openui.md#phases)), and the stage 3 text changes ([Stage 3](openui.md#stage-3-the-default)).
- **R24 UI-originated prompts.** After one click, text the model wrote becomes the reader's message: a button's label can differ from its message, and the message can repeat text the model read from a file, a page or a tool result, including injected instructions. **Accepted by the user (U21)**, as the one statement of this risk. What remains: the `<ui-action>` envelope and the skill's rule tell the agent the text is its own; the transcript shows the exact text with the caption; actions work only on the latest closed revision (D20). Whether models follow the skill's rule is not measured.
- **R26 The app realm.** A react-ui component that crashes, leaks a style or blocks the main thread affects the conversation, not a frame. Mitigation: the error boundary and the layered sheet (D29). If a leak or the cost of many roots shows in use, the options are a build step that renames the leaking selector or keyframe, or drawing conversation fences in a frame (P2); the user decides. This is the one statement of this risk; [openui.md](openui.md#risks) links here.
- **R27 Double sends.** A double click or a repeated event could send the same action twice. Mitigation: D20's double-send rules.
- **R32 UI drawn over the app.** A model-written dialog could cover the composer and draw a control that looks like the app's. Mitigation: `Modal` draws inside the fence (D29); popovers stay anchored to their trigger inside the fence.
- **R33 The chunk fails to load.** Questions and UI would not draw. Mitigation: the error state (D29); the source stays readable, and a new window loads the chunk again.
- **Rollback.**
  - _The setting turned off._ A pending question fence is a code block, and the reader answers in prose; the agent's prompt ended after the question, so it waits for the next user request either way ([R28](openui.md#risks)). `answersProjector` stays registered (D29), so answered rows draw nothing.
  - _A release without the `openui` bundle, before stage 2 or with it left out of the composition._ No projector claims `openui.answered/v1`, so the chat draws each answered row as one generic block with the event's type and payload: `questionPromptId`, `digest` and the answers (`bundles/desktop/chat/src/client/domain/external-blocks.ts:100-115`). Accepted: nothing is lost, the answers also stay in the user turn as text, and the row is drawn again as nothing once `openui` returns. Fences are code blocks, as with the setting off.
  - _`chat` below 1.6.0._ Its `readEnvelope` reads no `<ui-action>` (`bundles/desktop/chat/src/client/domain/prompt-envelope.ts:318-388`), so a prompt an action sent shows its stored text, `<ui-action program="…">`, the body and `</ui-action>`, with no caption. Accepted: the reader's words stay readable, and the Thread's history, which the runtime keeps as sent, does not change.
- **Security.** A conversation program runs no code (D7). Question answers are checked by the host against the questions it receives (D22). Actions are refused in agent Threads and in a Thread of another Project (D20), and an action's text is at most 16,000 UTF-16 code units and carries no form the reader did not submit (D20). The renderer chunk ships without OpenUI's dev tools (D23, C17).
- **Scale.** One action in flight per fence per window; one React root per mounted fence (R26); `status` reads the Thread log once per question block on mount, on each answered row of its prompt and on each rewind, as `ask` reads it on mount and on each row that can change it today (`bundles/features/threads/src/client/domain/ask.ts:185-203`), and no Thread record.

## Open questions

Questions 1 to 5 were answered by the user on 2026-11-03 and question 6 on 2026-11-04; each keeps its number and names the decision that closed it.

1. **D30, old asks.** Closed by U29: old `threads.asked/v1` rows draw nothing in stage 4; the answers stay as user text.
2. **D20, actions only on the latest closed revision in a main Thread.** Closed by U26, which narrows U21: a click on an older revision, a streaming fence or a subagent's UI does nothing and says why.
3. **D22, the answered row under the prompt that took the answers.** Closed by U27: a rewind of that prompt makes the question pending again; today's `ask` keeps it answered.
4. **D29, `Modal` drawn inline.** Closed by U28: no model-written dialog over the window.
5. **Concept Q9, `@OpenUrl`.** Closed by U29: disabled in stages 2–4; the URL is shown as text.
6. **Goals, "`ask`'s look is kept": the check.** Closed by U43: by markup, not pixels (C9). Each of the 12 story states renders the same `innerHTML` with `openui`'s copy as with `threads`', over the same Tailwind sheet lines (D29). The repository has no screenshot harness (no `toHaveScreenshot` or image-snapshot use), and equal markup over equal CSS draws the same.

## Docs to update

Listed here, not edited by this document. Each is updated in the stage named.

- **[docs/features/papercraft.md](../features/papercraft.md).** The Evolution entry of each stage, per [openui.md](openui.md#docs-to-update).
- **[GROUNDING.md](../../GROUNDING.md).** The `threads` paragraph's `ask` sentences (`GROUNDING.md:987-1013`): removed in stage 4; the question form is described in the `openui` paragraph ([openui.md](openui.md#docs-to-update)).
- **[bundles/features/threads/README.md](../../bundles/features/threads/README.md)** (`:3-11,17-26,55-56,68-127,142-161,167`): the `ask` tool, `threads.ask/v1`, its events and `<threads-ask>` removed in stage 4; stage 3 adds `threads.ask/v1` 1.2.0 `withholdTool` and notes that `ask` leaves the tool list when the setting is on.
- **[app/backend/doric-host/README.md](../../app/backend/doric-host/README.md)** (`:162-165`): `ask` and `threads.ask/v1` removed in stage 4.
- **`bundles/features/openui/README.md`**: the conversation renderer, the entry and chunk split and why the React context stays in the chunk, the client's two sheets, the question form, actions and their text, the reserved keyframe name `fadeIn` (stage 2).
- **[bundles/desktop/chat/README.md](../../bundles/desktop/chat/README.md)**: `chat.send/v1.sendAction` and the `<ui-action>` envelope beside `<comments>` and `<message>` (stage 2).
- **[packages/bundle/README.md](../../packages/bundle/README.md)**: client chunks beside client frames (`:91-92`): where they are built from, their CSS, `BuiltParts.chunks`, and that the loader never loads one; in stage 2.
- **[bundles/runtime/default/README.md](../../bundles/runtime/default/README.md)** (`:224-232`): the system prompt also describes the chat's `<ui-action>` part, in stage 2.
- **[docs/architecture/bundles/implementation-decisions.md](../architecture/bundles/implementation-decisions.md)**: the stage 4 record names the end of `ask`, whose records are `:1238-1250,1292-1298`.
- **Stage 5 (U49–U51).** [docs/features/generative-ui.md](../features/generative-ui.md): "Errors" (`:21,32`) says that errors reach the agent in the same turn or as a new prompt, and that the reader sees them in a card; an Evolution entry dated when stage 5 lands. `bundles/features/openui/README.md`: the card, beside the error delivery that [openui.md](openui.md#docs-to-update) lists.

## Revisions

- **Version 11 (2026-11-06).** Follows [openui.md](openui.md) version 17 and records the conversation's part of U49–U51 as stage 5; no review gates were requested. D29: "The reader's error card", D18's card in place of the list under the fence, with `programCheck`'s results and without the question part of the check; the check is split into `programCheck` and `questionCheck`, with `check` unchanged. Error feedback: errors arrive in the same turn or as a new prompt (U50). New: C18, Phases and Files to change for stage 5, and Docs to update for stage 5. U19 is marked as changed by U50.
- **Version 10 (2026-11-06).** Status of the feature docs set to `implemented`, and [generative-ui.md](../features/generative-ui.md) linked as this concept's feature doc. No decision changes.
- **Version 9 (2026-11-05).** Follows [openui.md](openui.md) version 15 and records U48: the spike and its measurements are dropped, and each stage ships when the user accepts it; no D-decision changes. Goals: the three rows that cited measures name their decisions and the user's acceptance. The Spike column of the decision table, D29's "spike-dependent" note and the stage 1 row of Phases are removed; D29's notes, the P2 alternatives of D21 and D29, R19, R26 and Scale cite no measure, and the options a measure would have triggered stay as risk notes.
- **Version 8 (2026-11-04).** Answers the repeated stage 4 Readiness and Codebase reviews and links D29 to [openui.md](openui.md) version 8's D23; no U-decision or Goal changes. D20: the action text for a form the store holds no values for (only the message), for `params` beyond `context` (react-ui's cards spread the picked item's fields there), for an empty message, and the limit counted in UTF-16 code units with a `refine`; `sendUiAction` refuses a Thread of another Project; a rejected `sendAction` shows its message and frees the fence; "Sending…" lasts until `sendAction` settles; the `Draft` variant gains no `action`; the runtime's envelope list cited from `envelope.ts` and left unchanged; the default system prompt's line 24 names `<ui-action>`, with its text; the skill's rule linked to D17 instead of repeated. D21: `questionOf` reads a question once for the table, the check and supersession; only a later closed, valid question supersedes; a streaming question with nothing parsed draws the note alone; every settled state goes through `AskQuestions`; the copy's line range, imports, `lucide-react` dependency and Storybook preview. D22: the scope check, a missing or foreign Thread, rejected runtime calls, the message and details of `unavailable`, the `call` passed on, invalid questions rejected by the contract layer, and the digest computed before the call joins its question's queue; `desktopScope` explained against `threads`'. D29: `createFenceShell`, `ChunkLoader` and the order `FenceShell` draws in; client chunks' build, CSS, `BuiltParts.chunks`, stale files, distribution and D23's define; the CSP sentence corrected. Rollback by code, without `openui` or with an older `chat`, is stated. Tests: C1–C3, C5, C7 and C8 extended; C16 (client chunks) and C17 (no dev tools in the renderer chunk) added. Line references corrected (Terms, D22's event and `status`, react-lang's action paths, `composer.test.ts`, `styles.css`).
- **Version 7 (2026-11-04).** Answers the stage 4 Readiness and Codebase reviews. D20: the action text from react-lang's real `formState` (fields unwrapped, named `<form>.<field>`, only `$variables` outside a form, a rule for `undefined` and unwritable values), a 16,000-character limit, action errors shown under the fence and `@OpenUrl` reported by the check; actions off on an unterminated fence; `routeSend`'s ports return booleans and the queue port reports `empty` (no `current`, `resumable` or items), the composer's ports and `sendAction`'s dependencies are stated; the envelope is read in `readEnvelope`, and `withPromptMessage` is the queued-prompt edit path; the caption's path through the node, its serialization and a CSS rule. D21: the components are copied, not moved, with `settledHeading`, `disabled` and `note`; the table of what each state draws, the unterminated question included; the rule for reading the state again, on the prompt's answered rows and on a rewind. D22: the event's schema and registration, the `desktopScope` entry, the queue and resume statuses on the host, and the rewind rule by log position, a clarification of U27. D29: the entry and chunk split, the chunk's exports, the fence context in the chunk, the conversation's check and map, the projector that claims `openui.answered/v1`, the keys, the client's Tailwind sheet. D30: what `threads` loses in stage 4, its contracts entry included. Files to change and Test plan: all stage 4 files; new C13 (the split), C14 (reading again) and C15 (keys); C3 adds window tests of the composer; C9 compares markup; U43 (2026-11-04) accepts the markup check and closes open question 6. No other U-decision changes.
- **Version 6 (2026-11-03).** Records U41 (`ask` withheld in stage 3) for D30. Answers the stage 3 Scope review. D22: a question is identified by its prompt and its digest, so the same questions asked again are a new question; the event carries `questionPromptId`; `QuestionState` loses `refused` and `status` reads no Thread record; the answer is sent by D20's route, which now resumes a paused, empty queue as an action does. D20: the composer's route moves into one chat function, `routeSend`, which the hook and `sendAction` call. D21: the question path under the P2 fallback is removed; a P2 choice sends this document back for a revision. D29: no retry of a failed chunk load; esbuild's code splitting is weighed and rejected. No U-decision changes; U41 keeps D30 as written.
- **Version 5 (2026-11-03).** Records the user's answers to version 4's questions: U26 (actions only on the latest closed revision in a main Thread; narrows U21), U27 (a rewind reopens an answered question), U28 (`Modal` drawn inline) and U29 (old asks draw nothing; `@OpenUrl` disabled in stages 2–4), and U23 for D18 and U38 for the non-goal on local state. All open questions are closed in place; D20, D22, D29 and D30 cite their decision. No design change.
- **Version 4 (2026-11-03).** Answers the stage 2 reviews (Comprehension, Critique, Structural, Style). Adds Goals, Terms, Phases, Files to change and Test plan; decisions in numeric order with `####` headings. D21: a question fence is a whole program, never patched; a later question fence supersedes it; argument orders in a table; an agent Thread's block and its error; the P2 fallback for questions. D22: the host takes the questions the app parsed and keys the answer by their digest, no longer checks the log or computes supersession, and writes `openui.answered/v1` under the prompt that took the answers. D20: the program side and the exact text; actions only on the latest closed revision in a main Thread; `sendAction` calls the host API directly instead of the chat store, so no `flush: false`; the envelope names the program only; double sends also blocked for 500 ms; the agent rule names the reader's values. D29: `Modal` drawn inline, a load-failure state with Retry, the layer mechanism, and no keyframe rename. New risks R32 and R33; R24 is the one statement of the accepted risk.
- **Version 3 (2026-11-03).** Records U22 (no actions in papercraft fences): D20 is now the only place where actions exist, and P1's table no longer marks D6 as pending.
- **Version 2 (2026-11-03).** Records the user's decisions U20 (D7, D27 and D29 confirmed) and U21. D20 is rewritten: an action sends on click as the reader's next message, through the chat's own send path (a steer while a prompt runs, else a prompt), with the new `chat.send/v1.sendAction`, the `<ui-action>` envelope, the transcript caption and one action in flight per fence. The composer-stack proposal became a rejected alternative, and prompt injection through button text an accepted risk (R24).
- **Version 1 (2026-11-03).** Split from [papercraft-openui.md](papercraft-openui.md), by the user's request for one design document per concept. With U18, conversation fences render in the app: new D29 (the renderer in the app, a lazy chunk, CSS layers, the shell CSP); D21 draws the question form through `Renderer` with `AskQuestions` and `Settled`; D22 moves the question service to the `openui` bundle (`openui.questions/v1`, `openui.answered/v1`); new D30 (removing `ask`).
