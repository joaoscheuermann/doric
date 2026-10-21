# Chat bundle

`chat` is the conversation with your agent. You read its answers, reasoning,
tool calls, file diffs and terminal output as they stream in, and you write the
next prompt in the same document, at the end of the transcript. While the agent
works you can steer it, queue follow-ups, pause or stop it, and comment on any
part of an answer before you send.

It is a desktop bundle with a client part (the conversation and the composer
controls) and a desktop part (the composer draft, shared by every window),
loaded by the `bundle` platform. See the [main README](../../../README.md) for
Doric as a whole and [`packages/bundle`](../../../packages/bundle/README.md)
for how bundles work.

## What it provides

- **UI:**
  - `<chat-view>`, the conversation, at
    `/projects/:projectId/threads/:threadId`, a child route of the
    [`layout`](../layout/README.md) bundle's `/`;
  - `<chat-composer>`, the send, stop, resume and save controls, a
    `layout.footer` item (order 40) present with or without a Thread. On an
    agent Thread — one an agent spawned — it draws the reader's three levers
    instead: pause the run, continue the prompt it left unfinished, or retry
    the last one (`domain/agent-control.ts`);
  - `<chat-thread-panel>`, a conversation with its own footer, which the layout
    uses for a child Thread's tab;
  - `<chat-readonly-markdown text>`, the conversation's read-only Markdown for
    another bundle's block element;
  - `<chat-block>`, the fallback for a block no renderer claims: its type, id,
    time and payload as JSON.
- **Contracts:** `chat.views/v1`, `chat.lexical/v1`, `chat.hooks/v1` and
  `chat.send/v1` (client), and `chat.composer/v1` (desktopMain).
- **Block type:** `chat.delegated-input/v1`, another Thread's instruction or
  result, which the `threads` bundle draws.

## The conversation

- **One editable document.** The whole transcript is a single Lexical editor.
  The caret moves through your turns, the agent's answers and the prompt as
  text; a reasoning run, a tool call or an activity summary is one stop you
  open or close with Enter, and the footer under a turn — the time it was last
  written, with its author kept for a screen reader — is skipped, while the
  turn's avatar is drawn in the column's left gutter.
- **What the agent did, in place.** Answers render as Markdown with their
  markers kept. Reasoning and tool calls open while they run and fold once
  they settle. `edit` and `write` calls render as a unified diff with
  `+added / −removed` counts, and a `terminal` call shows its command and its
  live output. A background command's result, a paused or resumed prompt, a
  history compaction and a failure each get their own row.
- **Steer while it runs.** `Cmd/Ctrl+Enter` sends; while a prompt runs it
  steers the prompt at its next safe point. `Tab` queues the words for after
  it, `Escape` with words aborts the current step and steers, and `Escape`
  without words, or `Ctrl+C` with nothing selected, stops it.
- **A queue you can edit.** Queued prompts sit above the input; you can edit
  or remove one before it runs, and resume a paused queue from the footer.
- **Comments before the prompt.** Select text in an agent message and start
  typing: the comment opens right after the paragraph or list item your
  selection ends in, its words stay highlighted, and one paragraph can hold
  several. Comments from chat and from other bundles (Papercraft previews)
  stack inside the prompt, above your words, as cards showing the passage in
  its paragraph with an arrow that goes to it, and go out with the next send
  as a `<comments>` block before your `<message>`. The agent's `comment_reply`
  answers show as rows of its turn, with a pin coloured by the thread's state.
- **Find your place.** A rail on the right edge has one handle per prompt,
  queued receipt and subthread result; hovering one previews its words.

History is durable on the host and replayed, never invented locally: chat
watches each opened Thread through `runtime.threads/v1` and treats its copy as
a view. When the [`history`](../history/README.md) bundle is present, its
local snapshot draws the conversation first and chat feeds it every applied
batch.

## Extension points

| Contract           | Where       | What another bundle can do                                                                                                         | Used by                              |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `chat.views/v1`    | client      | `registerProjector` for event types the built-in projection does not claim, and `registerRenderer` for the element of a block type | `artifacts`, `papercraft`, `threads` |
| `chat.hooks/v1`    | client      | observe `onMountHook`, `onUnmountHook`, `onSandboxActivityHook` and `onThreadUpdateHook`; transform `onBeforeRenderBlockHook`      | `files`, `notifications`             |
| `chat.composer/v1` | desktopMain | read and watch a Thread's draft, add or remove stack items, and `registerFlush` for the comment kind it owns                       | `papercraft`                         |
| `chat.send/v1`     | client      | send a Thread's held draft now, exactly as the composer does                                                                       | `papercraft`                         |
| `chat.lexical/v1`  | client      | add Lexical nodes and extensions to the conversation editor                                                                        | none outside chat today              |

- A projector is pure: replay and rewind run it again over the same events. A
  second claim on an event type fails with `registration_conflict`.
- `chat.lexical/v1` freezes when the window's first conversation editor is
  created; later registrations fail with `frozen`.
- `onThreadUpdateHook` reports every live event of a held Thread as it arrives,
  before the 100 ms flush, and every `updated` record; chat does not await it.
- A card inside the conversation can dispatch a `chat:intent` DOM event; chat
  runs it as `commands/v1.execute(command, input)` and shows a failure as a
  toast.

## The composer draft

`chat.composer/v1` runs in the desktop main process and keeps each Thread's
draft text and comment stack, keyed by `(projectId, threadId)`, so every window
shows the same draft. A send through `chat.send/v1` or the composer:

1. builds the prompt envelope from the stack and the text;
2. asks the host through `runtime.threads/v1`;
3. only after the host accepts, runs each item kind's flush, writes the
   comments through `comments/v1` and clears the draft in every window;
4. puts an item whose write failed back on the stack. A refused send leaves the
   draft where it was.

A window writes the prompt's text to the draft 300 ms after the last keystroke,
and a note's edits 150 ms after the last one. A note edit still waiting goes at
once when the note loses the focus, before a send reads the stack, and when the
window stops showing the Thread. Removing the comment drops the waiting edit.

Chat owns the `message` kind (a comment on agent text) and registers its flush
from its own desktop part; any other kind's owner does the same from its
desktop part, as Papercraft does.

## Dependencies

- **Required:** `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1`,
  `commands/v1`, `runtime.threads/v1`, `comments/v1` and `chat.composer/v1`.
- **Optional:** `history.snapshots/v1`, and `terminal/v1` or
  `runtime.terminals/v1` for live terminal output. Without them the
  conversation still works.

## Design

The original design, in Portuguese, is in
[`docs/architecture/bundles/chat.md`](../../../docs/architecture/bundles/chat.md);
the composer's stack is described in
[`comments.md`](../../../docs/architecture/bundles/comments.md). The code is the
reference where they differ.

## Development

```console
npx nx build bundle-chat
npx nx typecheck bundle-chat
npx nx test bundle-chat
```

`tests/*.test.ts` are DOM-free; `tests/client/*.test.ts` boot a happy-dom window
with the built core and chat parts. Stories under `stories/` are CSF3, and
`.storybook/preview.tsx` is the harness that wraps them. The build writes
`bundles/desktop/chat/dist`, which `doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/chat`. To rebuild and stage every bundle
used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
