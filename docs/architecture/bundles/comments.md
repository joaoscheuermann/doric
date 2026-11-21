> Record (2026-11-20). This document is kept as a record and does not describe current behavior; the living description is [docs/features/comments.md](../../features/comments.md).

# Comments

**Status:** partially implemented. Part of the [bundle architecture](../bundles.md); the documentation remains the contract of the current implementation. Already in place: the `comments` bundle (`bundles/features/comments`) with `comments/v1` (`add`, `list`, `resolve`), the `comments.added/v1` and `comments.resolved/v1` events in the Thread log and the validation of the four anchor forms; `list` and `resolve` fold these events from the log (`runtime.threads/v1.threadEvents`), with no state in the process, in the scope of the call (the Thread, or every Thread of the Project when the call names only the Project); the composer stack (`chat.composer/v1`), the note confirmed on the papercraft canvas itself before it enters the stack, sending the stack outside the composer (`chat.send/v1`, `Cmd/Ctrl+Enter`), the flush after the prompt is accepted — which returns to the stack the item whose write failed —, the prompt in an XML envelope (`<comments>` and `<message>`) that carries the stack's comments above the user's words, the `commentId` chosen by whoever comments and the replies (`inReplyTo`), the `comment_reply` tool with which the agent replies and resolves, and the comment threads with a state (`done`, `await`, `open`) that the `chat` projects; and the papercraft (target `artifact`) and conversation (target `message`, anchor `range`) consumers. The open decisions below remain open, except those marked as decided.

## Summary

A comment is an **anchored annotation** on a **target**: anything addressable in the app — a revision of a [papercraft](../../features/papercraft.md) program, a message of the conversation, a file and a line, the output of a terminal, an element of a preview. The user points at the spot, writes what they want different, and the agent reads it as an instruction.

This document is the **spec of the concept**, and not of those who use it: [papercraft](../../features/papercraft.md) is the first consumer (a comment on an element of a program drawn on the canvas), the conversation is the second (a comment on a message of the agent), and any future feature that needs comments on anything implements them through here. What the target's owner provides is the **meaning of the anchor** and the drawing of the pin; what the registry provides is the identity, the durable event, the reading and the draft.

Four rules shape the rest of the document:

- **A comment always has an anchor.** Without an anchor it is not a comment — it is a message, and the message already exists: it is the prompt.
- **The comment is durable and can be rebuilt.** It becomes an event of the log, and the replay rebuilds it as it rebuilds any node.
- **The comment opens a thread.** The agent replies to the comment — saying what changed or asking what it did not understand — and the thread ends resolved; the reply is another comment, linked to the first, and not a loose message.
- **A comment never authorizes.** It guides; the decision to act is the agent's, and Doric is YOLO by default: the agent goes straight ahead and the comment corrects the course.

## The target

The comment does not know what it comments on. It carries a **target reference**, and the target's owner is the one who interprets it:

| Field       | What it is                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `kind`      | The type of the target, declared by the owning bundle: `papercraft-program`, `message`, `file`, … |
| `id`        | The identity of the target within the type                                                        |
| `revision?` | The revision of the target, when it has revisions (a program revision, a file version)            |
| `anchor`    | Where in the target the comment anchors (below)                                                   |

The registry **does not interpret** the target: it stores it, validates the schema and forwards it. The one that knows that `revision` means something and that the anchor points to an element is the bundle that owns the `kind` — the same design that makes the `chat` host a block without knowing its type.

A target that exists outside a Thread (a file of the Project, for example) is still a target: the comment is written in the scope of the call, like any durable event.

## The anchor

A loose comment ("this button is wrong") forces the agent to guess what the user is referring to. The anchor solves this, and it has four forms:

| Form       | What it stores                                                   | Where it originates                                    |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `source`   | The pair of file and line, like `src/components/Checkout.tsx:42` | The source stamp that the target applies at build time |
| `selector` | A selector of the target, when the stamp is not the spot         | The derived structure that the owner maintains         |
| `point`    | A position in the target, with the nearest element               | A click on empty space                                 |
| `range`    | A range in the text of the target                                | A selection of text in a message or in a document      |

The source stamp is the strongest form when a target applies it; today no target applies it. Papercraft uses `selector`: the anchor of a program element is the name of the statement that draws it, and that is what makes the comment count as an instruction to change the program, and not as a description.

The anchor is resolved against the **derived structure** of the target, not against a pixel position: a click on empty space still finds the nearest element, and the hit-test stays correct under pan and zoom. The one that resolves it is the target's owner; the registry never looks inside the anchor.

**The anchor ages.** It names a revision; when the next revision changes the stamped line, the old comment keeps pointing at what it saw, and it is the agent that reconciles ("line 42 from before"). What to do in that case is an open decision (item 1).

## The `comments/v1` contract

Host service provided by the `comments` bundle, cardinality `one` like the others. The methods that a window calls declare `desktopScope` with `['projectId', 'threadId', 'promptId']` and `expose: 'desktop'`, like `resources/v1` and `screen.views/v1`.

| Method    | What it does                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | Writes `comments.added/v1` with the target, the anchor and the text, and returns the identity of the comment; accepts `commentId` and `inReplyTo` |
| `list`    | Returns the comments of a target (or of a `kind`), in log order                                                                                   |
| `resolve` | Marks a comment as attended, writing `comments.resolved/v1`                                                                                       |

`add` accepts a `commentId` chosen by the caller (`/^[A-Za-z0-9_-]{1,128}$/`), idempotent per Thread: writing the same id again returns the comment that already exists. That is how the id that the prompt names to the agent (`comment-<uuid>`, the id of the stack item) is the id of the event. `inReplyTo` points to another comment **of the same Thread** and is normalized to the **root**: the thread is flat, and every reply points to the first comment. A root that does not exist in the Thread rejects the call.

The bundle also registers the `comment_reply` tool (order 1800, always available, no skill), and for that reason now requires `tools/v1`. The input is `{ comment_id, text, resolve? }`; the tool looks the comment up in the Thread of the call, normalizes to the root and writes the reply with `author: "agent"`, the target of the root and `inReplyTo` pointing to it. With `resolve`, it also writes `comments.resolved/v1` on the root. The output is `{ commentId, inReplyTo, resolved }`.

Events, declared in `contracts/` with `defineEvent` and registered with `events/v1` on activation, in the sink that the `runtime` already registers (`scopeKeys` `['projectId', 'threadId', 'promptId']` in the stream `runtime.thread.events/{threadId}`, `bundles/runtime/runtime/src/contracts/events.ts:28-32`):

| Event                  | Payload (summary)                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `comments.added/v1`    | `commentId`, `target` (`kind`, `id`, `revision?`, `anchor`), `text`, `author?`, `inReplyTo?` |
| `comments.resolved/v1` | `commentId`, `resolved`                                                                      |

A comment is **immutable**: editing a sent comment is a new event (open decision, item 4).

## Two records, one owner

The comment has a single gesture — the send — and two records, because the durable log and the provider's history are separate contracts ([events and nodes](./events-and-nodes.md)):

1. **The event** `comments.added/v1` — durable, replayable, drawn as a pin on the target and present in the transcript, with the prompt. It is the memory of the comment.
2. **The prompt** — the only channel that wakes the agent, sent through `runtime.threads/v1.prompt({ id, prompt })`, the same path as the conversation's composer (`bundles/desktop/chat/src/client/api/threads-api.ts:32`), in an XML envelope ([below](#the-prompt-the-xml-envelope)).

Both are born from the same send. A comment that is never sent **does not become an event**: while it is a draft, it is not in the log.

The owner is a single one, and it is the target's: it draws the element in the stack, resolves the anchor and registers the `flush` that turns the draft into an event. The `chat` does not know what a comment is — it knows what an **item of the composer stack** is.

## The draft and the composer stack

The text of the prompt and the stack of comments are **a single state**, and it lives in the main process, in a host service — `chat.composer/v1` —, with a `desktop` part of the `chat` providing it, in the same design as `history`.

- **Keyed by `(projectId, threadId)`**, and every window reads and subscribes: `read({ threadId })` for the snapshot and `watch(threadId, listener)` for the deltas, in the format of `runtime.threads/v1.watchThread` — snapshot first, then the live items, with `StreamListener<T>`.
- **Survives navigation** and is the same in any window: today the draft lives only in the `threadChatsStore` of the window that wrote it (`bundles/desktop/chat/src/client/stores/thread-chats.ts`), so a second window opens the conversation empty.
- **The stack item is generic**: `{ id, kind, elementTag, data, author, note }`. The `chat` resolves the `elementTag` as it resolves a conversation block, and the `flush()` that the owner registers for its `kind` is what the send calls. The `id` of the item is `comment-<uuid>` and becomes the `commentId` of the event (`addItem` accepts an optional `id`, and the item returned to the stack keeps it); the convention for `data` is `{ target, pin?, inReplyTo?, refs?: { title?, source? } }`. That is how two different consumers — the papercraft preview and a message of the conversation — use the same stack, with the same element and the same gesture.

The flush runs **after** the host accepts the prompt: a refused send returns the words to the editor and the stack stays where it is. It writes `commentId` and `inReplyTo` **in stack order**, and a reply waits while its root is still a draft (the root is written first, or the reply goes back to the stack). The events enter the log in the order in which they were written, and the block is born anchored by the `sequence` right below the user's turn.

## Where the comment appears

| Place                       | What it shows                                                                                                                   | Who draws          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| The stack above the prompt  | One line per comment (`chat-comment-line`), with avatar, `↩` on replies, author, the editable note, the anchor and the `[pino]` | The `chat`         |
| The user's turn             | The same lines, above the text that the user wrote; clicking opens the thread in the most recent preview                        | The `chat`         |
| The agent's reply           | Reply blocks at the point of the agent's turn where the `comment_reply` happened, grouped                                       | The `chat`         |
| The target                  | The pin with the state of the thread, or the outline at the anchored spot; the comment control shows the count                  | The target's owner |
| The line of code, in a diff | The comment indicator on the line, as Antigravity does                                                                          | The target's owner |

The target's owner decides **where the note is written**. On a canvas target, like the [papercraft](./papercraft/README.md#o-node-da-conversa) preview, it is on the target itself, as in Figma: the click opens a field next to the pin, and only **confirming** the note (`Enter` or ↑) adds the line to the stack, already with it — an empty field that loses focus, or one canceled with `Esc`, never touches the stack. On a text target, like the agent's message, the click becomes a line in the stack and the note is written there. In both cases the confirmed line is a **draft**: editing or removing it in the stack changes the target, and vice versa, because it is a single item; and the comment and the user's request travel together in the same send.

The send is the composer's. `Cmd/Ctrl+Enter` has one owner per window: in the conversation it is the `chat.send-prompt/v1` command of the `chat`, the same send as the composer's, with the focus wherever it is (a target with a note not yet confirmed confirms it when the send asks, through the DOM event `doric:prompt-send`). The canvas window, which has no prompt, sends the stack with `Cmd/Ctrl+Enter` (`papercraft.send/v1`) or with the `Enviar ao agente` button, through the client service `chat.send/v1`: the same path as the send button — the lines of the stack with the anchors in the prompt, the flush only after acceptance and the items whose write failed back on the stack —, without the words of the editor.

The line of the stack is the `chat`'s for **every** `kind`, and the note is edited **in the line itself**, with no popover or buttons: the field is a `contenteditable` next to the avatar, and the keyboard is the stack's — ↑/↓ move between the notes and the prompt, `Enter` goes to the next one, `Esc` goes back to the prompt, `Cmd/Ctrl+Backspace` deletes the line (as do `Backspace`/`Delete` on an empty note) and `Cmd/Ctrl+Enter` sends. The events of the stack are isolated from Lexical, which does not see them as edits of the prompt.

### Threads, states and the agent's replies

The `chat` projects `comments.added/v1` and `comments.resolved/v1` (both claimed by its built-in projection) into **threads**: the root, the replies in log order and the state, which is derived:

| State   | When                                                                        |
| ------- | --------------------------------------------------------------------------- |
| `done`  | The root was resolved (`comments.resolved/v1`)                              |
| `await` | The last message of the thread is the agent's: the reply waits for the user |
| `open`  | The user spoke last, or no one has replied yet                              |

The agent's replies appear at the point of the agent's turn where they happened, as collapsible lines in the style of the tools (`Replied to [n]` with the excerpt of the comment and, at the end, the **comment pin** — the drop of the canvas (`desktop/ui/comment-pin`, in three sizes; the line uses the small one), numbered, in the color of the state: open, waiting or resolved). The line comes closed when the thread is resolved and open in the other states, and the reader's choice prevails. The line of a successful `comment_reply` in the list of tools is hidden, because the reply line already shows it. Clicking the pin does **not** jump to the canvas: it opens a popover with the thread (the messages, with avatar and author) and, in its header, the button that leads to the comment on the canvas. In the user's turn, the comment line does not draw the state (it is only read out to screen readers); clicking the line leads to the most recent preview of the target, with the thread open.

The comment lines of the user's turn and the button in the header of the pin popover — the one that leads to the comment on the canvas — dispatch the DOM event `doric:comment-thread-open` (bubbles, `composed`, `detail: { commentId, target }`, with the id of the **root** and its target), which the target's owner listens to in order to open the thread on the target itself. In papercraft only the canvases whose `kind` and `id` are those of the target respond: a conversation node opens the pin popover only when the requested `revision` is its own, or, without `revision`, when it draws the most recent revision; the canvas window opens the thread on the revision that is on screen, because every revision shows every thread. The external blocks of the conversation carry `data-chat-block-id`. The canvas window is another document and does not receive the DOM event of the `chat`: opening the pin from the conversation is a known limitation of that window.

### The prompt: the XML envelope

The text that the agent reads is assembled by the `chat` on **every** send (the editor's and that of `chat.send/v1`):

```xml
<comments>
<target kind="papercraft-program" id="checkout" revision="2" title="checkout">
<comment id="comment-…" pin="1" anchor="header" element="CardHeader">aumenta o respiro</comment>
<comment id="comment-…" in-reply-to="comment-…" pin="1" anchor="header" element="CardHeader">e o botão também</comment>
</target>
</comments>
<message>
palavras do usuário
</message>
```

The papercraft drafts carry `refs: { title: <identidade> }`, without `source`, and the anchor of a program element is the name of its statement, with the component in `element`. Each empty part is omitted (only comments, or only words, is already a whole prompt; a prompt of words only remains plain text). A comment carries `id`, `in-reply-to` (on replies), `pin` and the anchor in attributes — `anchor` with `arquivo:linha`, selector or position, plus `element`, `near` (the element nearest to a point) or `quote` (the excerpt of a range) —, and the note as the body. The attribute values are escaped and, in the bodies, the closing tags of the envelope's elements are neutralized (`<\/message>`), so that the user's text does not close the structure. The `runtime` (`bundles/runtime/default`) wraps the whole prompt in `<user-request>`, so the `chat` never writes that element; the system prompt explains the envelope and tells the agent to reply to each comment with `comment_reply`.

**Reading back is a single rule.** The log stores this text, so every place of the `chat` that shows a stored prompt as "the user's words" reads the body of `<message>`: the user's turn, the lines and the editing of the queue, the pending turn and the markers of the rail. Editing a queued prompt keeps the comment block (`withPromptMessage` swaps only the body of `<message>`), and a prompt in plain text, like that of older conversations, is read as it is.

## A comment does not authorize

A comment **guides**, and nothing more:

- Commenting asks for a change and feeds the next revision of the target. The agent responds by publishing a new revision — which is the conversation working — and **replies to the comment** with `comment_reply`, resolving it when it has attended to it.
- The agent **does not wait** for a comment to act: in Doric it goes straight ahead, and the comment corrects the course. A comment that arrives after the implementation counts as a request for an adjustment, not as a veto.
- There is no "approve comment": the model has no approval state, and since the removal of artifacts (2026-11-06) Doric has no revision approval.

## Who uses it today

| Consumer                                   | Target                                         | Anchor                                         |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| [Papercraft](../../features/papercraft.md) | The revision of a `papercraft-program` program | The statement of an element or a free position |
| The conversation                           | A message of the agent                         | A range in the text of the message             |

Papercraft is the consumer with the complete design (the anchor by statement, the pin, the button with the count, the stack). The second use — commenting on the agent's reply — is another `kind` on the same stack, with the same element and the same `flush`, and exists to prove that the concept does not belong to papercraft.

## Antigravity as a reference

| In Antigravity                                                 | In Doric                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Comment per line, with an indicator on the commented line      | `source` anchor with file and line, and the indicator on the line                    |
| Feedback sent back to the conversation when closing the viewer | The flush of the send: the durable event and the prompt together                     |
| Comment on the plan, before the agent edits                    | Comment on any target, with the agent going straight ahead and correcting the course |
| Comment as a co-steering mechanism                             | The same, and it is the only role of the comment: it never authorizes                |

What is **not** copied: the comment tied to a single surface. Here the comment is durable and anchored, so it appears on the target, in the transcript and in any window — and it serves both the agent and whoever reads the conversation later.

## Open decisions

1. **Stale anchor.** What the target does when the next revision changes the spot: keep the old anchor (and let the agent reconcile), remap through the derived structure, or mark the comment as orphaned on the screen.
2. **Comment during a prompt in progress.** The queue of `runtime.threads/v1` accepts it; it remains to decide whether the stack queues or waits (decision 7 of [papercraft](./papercraft/README.md#decisões-em-aberto)).
3. **Comment without a prompt.** Today the comment only becomes an event in the flush of the send; it remains to decide whether a comment can be written on its own, without waking the agent.
4. **Edit and delete.** Editing a draft is free; what to do with a comment already sent — another event, a removal event, or immutable.
5. **Decided: `resolve`.** "Attended" is a state of the **thread** (of the root), marked by `comments/v1.resolve` — the user, through the popover of the pin, or the agent, with `resolve` on the `comment_reply` — and projected as `done`; reopening is another `resolve` with `resolved: false`. Whether the state also applies per target remains open.
6. **Who the author is.** The comment stores the author (`agent` in the replies of the tool; the avatar of the stack uses the jdenticon of the name); it remains to decide how this relates to the user of the Project.
7. **Notification and resumption.** Whether a pending comment appears outside the conversation, as `notifications` does with the end of a prompt.
8. **Target without a Thread.** A comment on a target that does not belong to a conversation (a file of the Project, an old revision) needs a scope other than `projectId`/`threadId`/`promptId`.
9. **Persistence of the draft beyond the process.** Whether the stack survives the closing of the app, in a cache record like that of `history`, and whether the text of the editor syncs on every keystroke or in short batches (decision 14 of [papercraft](./papercraft/README.md#decisões-em-aberto)).
10. **One stack, several windows.** It remains to decide what a window does when the prompt is sent in another: the stack empties for all of them and the editor of the others is cleared (decision 15 of [papercraft](./papercraft/README.md#decisões-em-aberto)).

## References

- [Reviewing artifacts](https://antigravity.google/docs/cli/artifacts) (Antigravity CLI): the comment per line, the indicator on the line and the sending of the feedback back to the conversation.
- [Implementation plan](https://antigravity.google/docs/implementation-plan) (Antigravity): commenting on the plan to redirect the agent before it edits.
- [Artifacts](https://antigravity.google/docs/artifacts) (Antigravity): asynchronous collaboration and review at milestones.
- [Artifacts](./artifacts.md): the target with revisions, the revision policy and the decision to go straight ahead.
- [Papercraft](../../features/papercraft.md): the first consumer — the anchor by statement, the pin and the stack.
- [Events and nodes](./events-and-nodes.md): the durable log, the projectors and the conversation nodes.
- [The chat bundle](./chat.md): `chat.views/v1`, the renderers and the composer service.
- [Default](../../../bundles/runtime/default/README.md): the input envelope (`<user-request>` and the others) in which the prompt reaches the model.
- [Generic storage and history](./storage.md): the local cache per bundle, the precedent of `history`.
- [Contexts and capabilities](./contexts.md): the `call` with `scope`, which is what ties the comment to the Project, the Thread and the prompt.
