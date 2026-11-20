# chat

`chat` is the conversation with an agent in one Thread. The reader reads the
agent's answers, reasoning and tool calls as they stream in, and writes the next
prompt in the same document, at the end of the transcript. While the agent works
the reader steers it, queues follow-ups, pauses or stops it, and comments on any
part of an answer before the next send. Other bundles draw their own events,
tools, input sources and fences inside the conversation through the chat's
extension points; the chat names none of them.

It is a desktop bundle with a client part (the conversation, the footer controls
and the Thread tabs) and a desktop part (the composer draft, one state shared by
every window). The [main README](../../../README.md) describes Doric as a whole,
and [`packages/bundle`](../../../packages/bundle/README.md) how a bundle is
built, loaded and activated.

The flow across bundles is described in the feature docs
[Conversation](../../../docs/features/conversation.md),
[Generative UI](../../../docs/features/generative-ui.md),
[Papercraft](../../../docs/features/papercraft.md),
[Per-thread model](../../../docs/features/per-thread-model.md),
[Error messages](../../../docs/features/error-messages.md),
[Thread archive](../../../docs/features/thread-archive.md),
[Terminal](../../../docs/features/terminal.md),
[Files](../../../docs/features/files.md),
[Git](../../../docs/features/git.md),
[Settings](../../../docs/features/settings.md) and
[UI redesign](../../../docs/features/ui-redesign.md). This README is the
bundle's complete description.

## Manifest

[`manifest.json`](manifest.json):

| Field          | Value                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | `chat`, version `2.0.0`, engine `doric ^1.10.0`                                                                                                                                                                                                                    |
| `description`  | "The conversation: transcript, composer and the execution picker."                                                                                                                                                                                                 |
| `provides`     | `chat.views/v1@1.2.0`, `chat.lexical/v1@1.0.0`, `chat.hooks/v2@2.0.0`, `chat.composer/v1@1.0.0`, `chat.send/v1@1.1.0`, `chat.send-prompt/v1@1.0.0`                                                                                                                 |
| `requires`     | `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `commands/v1`, `menus/v1` (each `^1.0.0`), `runtime.threads/v1@^1.8.0`, `runtime.attachments/v1@^1.0.0`, `runtime.records/v1@^1.0.0`, `comments/v1@^1.0.0`, `chat.composer/v1@^1.0.0`, `layout.tabs/v2@^2.0.0` |
| `optional`     | `history.snapshots/v1`, `models/v1`, `comments.added/v1`, `comments.resolved/v1`, `runtime.prompt-finished/v1`, `workspace.hooks/v1`, `settings.models/v1`, `workspace.selection/v1`                                                                               |
| `desktopScope` | `chat.composer/v1`: `projectId`, `threadId`, `promptId`                                                                                                                                                                                                            |

The client part requires its own `chat.composer/v1`, which the desktop part
provides. `comments.added/v1`, `comments.resolved/v1` and
`runtime.prompt-finished/v1` are event types of the Thread's log that the
built-in projection reads.

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts), exported as
  `chat/contracts`): every name listed under
  [Exports of `chat/contracts`](#exports-of-chatcontracts). It imports no React.
- **Client** ([`src/client/index.ts`](src/client/index.ts)): on activation it
  defines the `chat.hooks/v2` hooks through `hooks/v1`; provides
  `chat.views/v1`, `chat.lexical/v1` and `chat.send/v1`; defines the seven
  elements; registers the route; adds the `composer` footer item; registers the
  command `chat.send-prompt/v1` with its keybinding; adds the `execution`
  footer item while `settings.models/v1` is available; follows
  `workspace.selection/v1`, `history.snapshots/v1` and `models/v1` while they
  are available; and starts the sandbox-activity, Thread-tab and Thread-view
  watchers. Deactivation disposes all of it and closes every Thread watch the
  window holds, except the keybinding: `menus/v1.addKeybinding` answers
  `Promise<void>` with nothing to dispose, so the binding outlives the
  deactivation.
- **Desktop** ([`src/desktop/index.ts`](src/desktop/index.ts)): provides
  `chat.composer/v1` over an in-memory state and registers the flush of the
  `message` comment kind.

The client part's code is layered in `src/client/`: `views/` (the content of
`<chat-view>` and `<chat-composer>`), `elements/` (the custom elements),
`components/{molecules,organisms}/`, `hooks/`, `stores/` (Zustand stores),
`queries/` (the TanStack Query client and keys), `domain/` (the pure rules:
projection, turns, queue, envelope), `utility/`, `api/` (adapters over the
host's and sibling bundles' contracts) and `services/` (the chat's own contract
providers and activation watchers).

## Contracts provided

### `chat.views/v1` (client, 1.2.0)

How another bundle draws inside the conversation
([`src/client/services/views.ts`](src/client/services/views.ts)). Every method
takes an optional `call` and returns a `Disposable`; disposing twice is
harmless, and a registration that arrives or is disposed while a transcript is
shown redraws it at once.

```ts
interface ChatViews {
  registerProjector(spec: ProjectorSpec, call?): Disposable;
  registerRenderer(spec: RendererSpec, call?): Disposable;
  registerFenceRenderer(spec: FenceRendererSpec, call?): Disposable;
  watchFences(
    input: { projectId: string; threadId: string; tag: string },
    listener: StreamListener<readonly ChatFence[]>,
    call?,
  ): Disposable;
  registerToolRenderer(spec: ToolRendererSpec, call?): Disposable;
  registerInputRenderer(spec: InputRendererSpec, call?): Disposable;
}

interface ChatThreadEvent {
  projectId: string;
  threadId: string;
  promptId: string;
  sequence: number;
  type: string;
  event: unknown;
  createdAt: string;
}
interface ChatBlock {
  id: string;
  type: string;
  promptId: string;
  sequence: number;
  data: unknown;
}
interface ProjectorSpec<S = unknown> {
  eventTypes: readonly string[];
  initial(): S;
  reduce(
    state: S,
    event: ChatThreadEvent,
  ): { state: S; blocks: readonly ChatBlock[] };
}
interface RendererSpec {
  blockType: string;
  elementTag: string;
} // both non-empty
interface FenceRendererSpec {
  tag: string;
  elementTag: string;
} // tag: /^[^\s`~]{1,64}$/
interface ToolRendererSpec {
  toolName: string;
  elementTag?: string;
  standalone?: boolean;
  openByDefault?: boolean;
}
interface InputRendererSpec {
  source: string;
  elementTag: string;
}
// source: /^(?:bundle:\S+|(?!user$|bundle$)[a-z][a-z0-9_-]*)$/
```

- **`registerProjector`** claims exact event types. The built-in projection owns
  every type that is not a versioned bundle event (one that matches
  `/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\/v[1-9][0-9]*$/`),
  `comments.added/v1`, `comments.resolved/v1`, and the qualified aliases of the
  runtime's durable events (`legacyEventTypes` of `runtime/contracts`, such as
  `runtime.prompt-finished/v1`)
  ([`src/client/domain/external-blocks.ts`](src/client/domain/external-blocks.ts)).
  A claim on one of those, or on a type another projector holds, fails with
  `registration_conflict` (`details: { eventType, owner }`, owner `chat` for the
  built-in projection). A spec without `eventTypes`, `initial` and `reduce`
  fails with `invalid_input`. A projector is pure: on every batch each
  projector runs from `initial()` over the Thread's whole event list, so replay
  and rewind run it again; one that throws on an event keeps its previous state
  and adds nothing for that event. Blocks are ordered by `sequence`, then by the
  order produced, and a block that reads the same as before keeps its identity.
- A versioned event type that no projector claims becomes one block per event:
  type `chat.generic`, id `event:<sequence>`, data
  `{ eventType, createdAt, payload }`.
- **`registerRenderer`** names the element that draws a block type. A second
  renderer of a type fails with `registration_conflict`
  (`details: { blockType, owner }`), and an `elementTag` that `ui/v1` has not
  defined with `invalid_input`. A block with no renderer is drawn by
  `<chat-block>`. The element is created through `ui/v1` with the property
  `block`, a `RenderBlock`: `{ id, type, promptId, sequence, data, actions }`,
  `actions: { id, label }[]`
  ([`src/client/components/organisms/conversation/nodes/chat-block-node.tsx`](src/client/components/organisms/conversation/nodes/chat-block-node.tsx)).
- **`registerFenceRenderer`**: while it lives, every fence of `tag` in an agent
  turn (an opener whose info string's first word is `tag`) is drawn as one
  `elementTag` element per fence key instead of a code block, created through
  `ui/v1` with the property `view`, and kept across streaming flushes. A second
  renderer of a tag fails with `registration_conflict`; a spec that fails its
  schema, or an element `ui/v1` has not defined, with `invalid_input`.

  ```ts
  interface ChatFence {
    key: string; // `${promptId}/${turnSequence}/${index}`, unique within its tag
    projectId: string;
    threadId: string;
    promptId: string;
    turnSequence: number; // sequence of the first event of the turn
    index: number; // 0-based among the fences of this tag in the turn
    info: string; // the opener line after its backticks or tildes, trimmed
    body: string; // lines between opener and closer (or turn end), joined by "\n"
    state: 'streaming' | 'closed' | 'unterminated';
  }
  interface ChatFenceView {
    fence: ChatFence;
    origin: 'user' | 'agent'; // the Thread's origin; 'user' when it has none
    fences: readonly ChatFence[]; // every fence of the tag in the Thread, in order
  }
  ```

  A fence is `closed` when its closer line exists; `streaming` when it has none,
  its turn is the transcript's last turn that is not queued, and its prompt has
  no settled status; `unterminated` otherwise. A key never changes while its
  turn streams, and the state moves only from `streaming` to `closed` or
  `unterminated`. The fence lines are read with `fenceMarker`, `fenceInfo` and
  `closesFence` of `runtime/contracts`, the rules the host and `openui` use too
  ([`src/client/domain/fences.ts`](src/client/domain/fences.ts)).

- **`watchFences`** streams one Thread's fences of a tag, computed by the same
  projection, to a surface outside the conversation: the whole list at once,
  then the whole list again after each flush that changes a key, a state or a
  body ([`src/client/services/fence-watches.ts`](src/client/services/fence-watches.ts)).
  It gives `[]` once for an unknown or deleted Thread or one of another Project,
  `[]` while no fence renderer of the tag is registered in the window, and `[]`
  when the Thread is deleted. An input that fails its schema is
  `invalid_input`. It holds its own Thread watch, so the conversation store's
  Threads and recency do not change because of it.
- **`registerToolRenderer`**: every call of `toolName` is drawn by one
  `elementTag` element per call, or by the chat's generic row when no element is
  given. `standalone: true` takes the call out of the activity group;
  `openByDefault: true` keeps its block open until the reader closes it. A tool
  with no registration is the generic row inside the activity group, closed by
  default ([`src/client/domain/tool-drawing.ts`](src/client/domain/tool-drawing.ts),
  [`src/client/domain/drawn-turns.ts`](src/client/domain/drawn-turns.ts),
  [`src/client/components/molecules/tool-item.tsx`](src/client/components/molecules/tool-item.tsx)).

  ```ts
  interface ChatToolView {
    projectId: string;
    threadId: string;
    promptId: string;
    key: string; // `${promptId}/${callId}`, stable and unique in the Thread
    name: string; // the tool's name
    args: string; // one-line JSON of the call's payload
    result?: string; // the finished call's serialized output
    error?: ErrorInfo; // whole, only when status is 'failed'
    status: 'running' | 'finished' | 'failed'; // moves only from 'running'
    chosen: boolean | null; // the reader's open/closed choice; null until chosen
    focused: boolean; // whether the caret rests on the block
  }
  ```

  `ErrorInfo` is the platform's reading of an error (`desktop/reads`):
  `{ code: string; provider?: string; status?: number; message: string; retryable?: boolean; causes: readonly ErrorCause[]; at?: string }`,
  with `ErrorCause = { code?; provider?; status?; retryable?; message }`,
  the causes outermost first and at most 7, `at` an ISO 8601 time.

  The chat sets `view` before the element connects and again, as a new object,
  whenever a field changes; the element is not created again while its call is
  shown.

- **`registerInputRenderer`**: every prompt of `source` (an input source kind
  other than `user`; `bundle:<bundle id>` for a bundle's instructions) is drawn
  by one `elementTag` element with `view`:

  ```ts
  interface ChatInputView {
    projectId: string;
    threadId: string;
    promptId: string;
    source: {
      kind: string;
      threadId?: string;
      terminalId?: string;
      bundleId?: string;
      reason?: string;
    };
    text: string; // the prompt's text as the log holds it, framing included
    chosen: boolean | null;
    focused: boolean;
  }
  ```

  It wins over a `chat.delegated-input/v1` renderer for the same prompt. Without
  a registration a prompt is drawn by the chat's own drawing of its source, or
  as plain text.

- A tool or input element reports the reader's open/close choice with one
  bubbling, composed `CustomEvent` `chat-block-chosen` (`CHAT_BLOCK_CHOSEN_EVENT`,
  detail `{ chosen: boolean }`); the chat keeps it, sets `view` again and stops
  the event at the element's frame. An element may define `toggle(): void`,
  which the conversation's toggle key calls and which must answer with the same
  event; without it the toggle key applies the generic rule (the opposite of what
  the block shows by default)
  ([`src/client/components/molecules/view-element.tsx`](src/client/components/molecules/view-element.tsx)).
- A second tool or input registration of a name or source fails with
  `registration_conflict` (`details` name the owner; the first wins). A spec that
  fails its schema, or an element `ui/v1` has not defined, fails with
  `invalid_input`. Disposing disposes the elements through `ui/v1`.

### `chat.lexical/v1` (client, 1.0.0)

```ts
interface ChatLexical {
  registerNodes(nodes: readonly Klass<LexicalNode>[], call?): Disposable;
  registerExtension(extension: AnyLexicalExtension, call?): Disposable;
}
```

Adds Lexical node classes and extensions to the conversation editor
([`src/client/services/lexical.ts`](src/client/services/lexical.ts)). The lists
freeze when the window's first conversation editor is created; a later
registration fails with `frozen`, and a disposal after the freeze leaves the
frozen lists as they are. A value that is not an array of classes, or an
extension without a string `name`, fails with `invalid_input`.

### `chat.hooks/v2` (client, 2.0.0)

Defined through `hooks/v1` ([`src/contracts/index.ts`](src/contracts/index.ts));
the chat never awaits an observer, and an observer's failure never fails the
conversation.

| Hook                      | Kind      | Input                                                                                                                                     | When                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onMountHook`             | observe   | `{ projectId, threadId }`                                                                                                                 | A conversation opens on a Thread ([`src/client/hooks/use-mount-hooks.ts`](src/client/hooks/use-mount-hooks.ts))                                                                                                                                                                                                                                                              |
| `onUnmountHook`           | observe   | `{ projectId, threadId }`                                                                                                                 | It closes or moves to another Thread                                                                                                                                                                                                                                                                                                                                         |
| `onBeforeRenderBlockHook` | transform | `RenderBlock` (`{ id, type, promptId, sequence, data, actions }`)                                                                         | Once per block a registered projector produces and per generic block, before it is drawn; the answer's `data` and `actions` replace the block's, and until it answers, or when it fails, the block is drawn as projected ([`src/client/hooks/use-external-blocks.ts`](src/client/hooks/use-external-blocks.ts))                                                              |
| `onSandboxActivityHook`   | observe   | `{ projectId }`                                                                                                                           | Once per Project per store change, when the chat starts to hold a Thread, a held Thread's working directory changes, or its state changes to anything but `running`; never after a finished tool call ([`src/client/domain/project-refresh.ts`](src/client/domain/project-refresh.ts), [`src/client/services/sandbox-activity.ts`](src/client/services/sandbox-activity.ts)) |
| `onThreadUpdateHook`      | observe   | `{ projectId, threadId, threadName, update }`, `update`: `{ kind: 'event', event: ThreadEvent }` or `{ kind: 'updated', thread: Thread }` | Every live event of a held Thread as it arrives, before the 100 ms flush, and every `updated` record; never a snapshot or history ([`src/client/stores/thread-chats.ts`](src/client/stores/thread-chats.ts))                                                                                                                                                                 |

A bundle that wants a refresh after its own tool observes `onThreadUpdateHook`.

### `chat.composer/v1` (desktopMain, 1.0.0)

The draft every window shares: each Thread's draft text and comment stack
([`src/desktop/composer-service.ts`](src/desktop/composer-service.ts),
[`src/desktop/composer-state.ts`](src/desktop/composer-state.ts)). The state is
keyed by `(projectId, threadId)`, with `projectId` read from the call's scope,
and is held in the main process's memory only: nothing writes it to disk.

```ts
interface ChatComposer {
  read(input: { threadId: string }, call?): Promise<ComposerSnapshot>;
  watch(
    threadId: string,
    listener: StreamListener<ComposerWatchItem>,
    call?,
  ): Disposable;
  setText(input: { threadId: string; text: string }, call?): Promise<void>;
  addItem(input: ComposerAddInput, call?): Promise<ComposerItem>;
  updateNote(
    input: { threadId: string; id: string; note: string },
    call?,
  ): Promise<void>;
  removeItem(input: { threadId: string; id: string }, call?): Promise<void>;
  flush(
    input: { threadId: string; promptId: string },
    call?,
  ): Promise<readonly ComposerFlushed[]>;
  registerFlush(
    input: { kind: string; flush: ComposerFlush },
    call?,
  ): Disposable;
}

interface ComposerItem {
  id: string; // `comment-<uuid>`; also the id of the comment it becomes
  kind: string; // the comment kind, declared by the bundle that owns it
  elementTag: string; // the element that draws its line; `chat-comment-line` is the chat's
  data: unknown; // the owner's payload; the chat reads only ComposerItemData
  author?: string;
  note: string;
}
interface ComposerItemData {
  target: CommentTarget; // from comments/contracts
  pin?: number; // the number the owner's surface shows
  inReplyTo?: string; // the root a reply continues
  refs?: { title?: string; source?: string }; // what the prompt names the target by
}
interface ComposerSnapshot {
  threadId: string;
  text: string;
  items: readonly ComposerItem[];
}
type ComposerWatchItem =
  | { kind: 'snapshot'; threadId: string; text: string; items: ComposerItem[] }
  | { kind: 'text'; threadId: string; text: string }
  | { kind: 'added' | 'updated'; threadId: string; item: ComposerItem }
  | { kind: 'removed'; threadId: string; id: string };
interface ComposerAddInput {
  threadId: string;
  id?: string;
  kind: string;
  elementTag: string;
  data?: unknown;
  author?: string;
  note?: string;
}
type ComposerCommentWrite = CommentAddInput & {
  commentId?: string;
  inReplyTo?: string;
};
type ComposerFlush = (
  item: ComposerItem,
  context: ComposerFlushContext,
) => Promise<readonly ComposerCommentWrite[]>;
interface ComposerFlushContext {
  projectId?: string;
  threadId: string;
  promptId: string;
}
interface ComposerFlushed {
  item: ComposerItem;
  writes: readonly ComposerCommentWrite[];
}
```

- `read` answers an empty draft for a Thread never written. `watch` sends the
  `snapshot` first, then every delta; a listener that throws is logged and
  never stops the others or the write.
- `addItem` assigns `comment-<uuid>` unless the input brings an `id` with the
  `comment-` prefix that the stack does not hold. An item with no `author` gets
  the platform's fixed reader name (`READER_NAME`, re-exported from
  `desktop/ui/identity`); `note` defaults to `''`. `updateNote` and `removeItem`
  of an unknown item do nothing.
- `flush` walks the stack in order and runs the flush each item's kind
  registered. An item leaves the stack only when its flush answers at least one
  write. An item whose kind has no flush, whose flush answers none, or which
  replies to a root that stays on the stack, stays. A flush that throws rejects
  the call and leaves the whole stack as it was. Each item that left is
  announced as `removed`.
- `registerFlush` fails with `registration_conflict` for a kind that already
  has a flush. It carries a function, so it serves callers in the main process
  only: every method but `registerFlush` is exposed to windows
  (`expose: 'desktop'`).
- The chat owns the kind `message` (`MESSAGE_KIND`), a comment on an agent
  message, and registers its flush from its desktop part: an item with a
  non-blank note and a `data.target` with string `kind` and `id` and an object
  `anchor` answers one write
  `{ target, text, commentId: item.id, inReplyTo?, author? }`, where `text` is
  the trimmed note; any other item answers none
  ([`src/desktop/message-flush.ts`](src/desktop/message-flush.ts)). Another
  kind's owner registers its flush from its own desktop part.

### `chat.send/v1` (client, 1.1.0)

```ts
interface ChatSend {
  send(
    input: { projectId: string; threadId: string },
    call?,
  ): Promise<{ status: 'accepted' | 'empty' | 'refused' }>;
  sendAction(
    input: ChatActionInput,
    call?,
  ): Promise<{ status: 'accepted' | 'refused' }>;
}
interface ChatActionInput {
  projectId: string;
  threadId: string;
  program: string; // /^(?:[a-z][a-z0-9-]{0,63}|_[1-9][0-9]{0,8})$/
  text: string; // not blank, at most 16,000 UTF-16 code units, sent unchanged
}
```

([`src/client/services/send.ts`](src/client/services/send.ts))

- `send` sends a Thread's held draft exactly as the composer does, from any
  window: it pushes this window's waiting note edits, reads the draft from
  `chat.composer/v1`, builds the [prompt envelope](#the-prompt-envelope), and
  answers `empty` when the envelope is empty. Otherwise it sends it as a new
  prompt through the window's Thread store; `refused` leaves the draft and the
  stack where they were. After acceptance it flushes the stack (see
  [Sending](#sending)) and clears the draft text in every window. `projectId`
  and `threadId` must be non-empty strings and no other key is allowed; an
  input that fails this schema rejects with `invalid_input`.
- `sendAction` sends one click on a control of a UI the agent drew as the
  reader's next message: the text in `<ui-action program="…">` by the
  composer's route (a steer of the running prompt; else, when the queue is
  paused and empty, a resume of the queue first, then a new prompt). It answers
  `refused`, with nothing sent or resumed, for an unknown Thread, a Thread of
  another Project or an agent's Thread (`origin: 'agent'`), and when the route
  fails ([`src/client/domain/send-route.ts`](src/client/domain/send-route.ts)).
  It never touches the draft, the stack or the store's pending turn. An input
  that fails the schema rejects with `invalid_input`.

### `chat.send-prompt/v1` (command, 1.0.0)

A client command, input `{}`, bound to `CmdOrCtrl+Enter` through `menus/v1`
while the route is the conversation's, so the chord has one owner wherever the
focus is ([`src/client/services/send-command.ts`](src/client/services/send-command.ts)).
It sends for the Thread whose conversation holds the focus (the nearest
`data-chat-thread` attribute, across shadow roots), else the Thread the route
names, else nothing. Before reading the stack it dispatches `doric:prompt-send`
(`PROMPT_SEND_EVENT`) on the document with detail
`{ threadId, waitUntil(pending: Promise<unknown>) }`: a surface holding an
unconfirmed note confirms it and hands the promise to `waitUntil`. The command
pushes the waiting note edits, waits for every promise to settle, reads the
stack back, and then makes the composer's send for that Thread.

### Elements, route, slot items

Defined through `ui/v1` ([`src/client/elements/chat-elements.tsx`](src/client/elements/chat-elements.tsx)):

| Element                    | Props                   | What it draws                                                                                                                                                                                                                      |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<chat-view>`              | `projectId`, `threadId` | The conversation; nothing until the Thread's record is known ([`src/client/views/chat-view.tsx`](src/client/views/chat-view.tsx))                                                                                                  |
| `<chat-composer>`          | none                    | The footer controls for the selected Thread ([`src/client/views/chat-composer.tsx`](src/client/views/chat-composer.tsx))                                                                                                           |
| `<chat-thread-panel>`      | `projectId`, `threadId` | A conversation with its own floating footer, the content of a Thread tab ([`src/client/views/chat-view.tsx`](src/client/views/chat-view.tsx))                                                                                      |
| `<chat-block>`             | `block`                 | The fallback for a block no renderer claims: its type, id, time and payload as JSON ([`src/client/components/molecules/generic-block.tsx`](src/client/components/molecules/generic-block.tsx))                                     |
| `<chat-readonly-markdown>` | `text`                  | The conversation's read-only Markdown, for another bundle's block element ([`src/client/components/organisms/conversation/readonly-markdown.tsx`](src/client/components/organisms/conversation/readonly-markdown.tsx))             |
| `<chat-thread-tab-icon>`   | `projectId`, `threadId` | The mark of the Thread `runtime.records/v1` describes: a dashed bubble for an Untitled Thread, else its kind's mark ([`src/client/components/molecules/thread-tab-icon.tsx`](src/client/components/molecules/thread-tab-icon.tsx)) |
| `<chat-execution-picker>`  | none                    | The selected Thread's model and reasoning effort ([`src/client/components/organisms/execution-picker.tsx`](src/client/components/organisms/execution-picker.tsx))                                                                  |

- Route `/projects/:projectId/threads/:threadId`, a child of `/`, creates
  `<chat-view>` with the path's parameters
  ([`src/client/domain/thread-route.ts`](src/client/domain/thread-route.ts)).
- Slot `shell.conversation.footer` of [`layout`](../layout/README.md): the item
  `{ id: 'composer', tag: 'chat-composer', order: 40 }`, always, and
  `{ id: 'execution', tag: 'chat-execution-picker', order: 20 }` while a
  provider of `settings.models/v1` is available.

### Block types, DOM events and constants

All exported from `chat/contracts` ([`src/contracts/index.ts`](src/contracts/index.ts)):

- `DELEGATED_INPUT_BLOCK = 'chat.delegated-input/v1'`: another Thread's
  instruction or result in this one. Its renderer's element receives
  `block: { type, id, data: { promptId, input: DelegatedInput } }`, with
  `DelegatedInput = { kind: 'parent' | 'result'; threadId; status?; text }`
  (`text` is the sender's words with the host's envelope removed), and
  implements `ChatBlockElement` (`block`, `focused`, `toggle()`, read-only
  `chosen`). Without a renderer the chat draws it itself
  ([`src/client/domain/delegated.ts`](src/client/domain/delegated.ts),
  [`src/client/components/organisms/conversation/nodes/delegated-turn-node.tsx`](src/client/components/organisms/conversation/nodes/delegated-turn-node.tsx)).
- `CHAT_INTENT_EVENT = 'chat:intent'`, detail `{ command: string; input?: unknown }`:
  a card inside the conversation dispatches it; the chat stops it and runs
  `commands/v1.execute(command, input)`, and shows a failure as an error toast
  with the id `chat-intent-<command>`, so repeated failures replace each other
  ([`src/client/components/organisms/intent-dispatcher.tsx`](src/client/components/organisms/intent-dispatcher.tsx)).
- `COMMENT_THREAD_OPEN_EVENT = 'doric:comment-thread-open'`, detail
  `{ commentId, target }` (the target without `revision`, so the latest
  drawing of the target answers): bubbles from a sent comment's line or a reply
  row's state glyph when the reader asks to open the comment's thread; the
  bundle that draws the target opens it
  ([`src/client/utility/comment-thread.ts`](src/client/utility/comment-thread.ts)).

### Exports of `chat/contracts`

Every export of [`src/contracts/index.ts`](src/contracts/index.ts), by kind;
the shapes not given here are in the contract sections above.

- **References:** `ChatViewsV1 = ref<ChatViews>('chat.views/v1')`,
  `ChatLexicalV1 = ref<ChatLexical>('chat.lexical/v1')`,
  `ChatComposerV1 = ref<ChatComposer>('chat.composer/v1')`,
  `ChatSendV1 = ref<ChatSend>('chat.send/v1')`, and
  `ChatHooksV2 = defineHooks('chat.hooks/v2', { … })` with the five hooks of
  [`chat.hooks/v2`](#chathooksv2-client-200).
- **Schemas (zod):** `rendererSpecSchema`, `fenceTagSchema`,
  `fenceRendererSpecSchema`, `watchFencesInputSchema`, `toolRendererSpecSchema`,
  `inputRendererSpecSchema` (the rules given with `chat.views/v1`), and
  `renderBlockSchema`, the strict object
  `{ id: string, type: string, promptId: string, sequence: number, data: unknown, actions: { id: string, label: string }[] }`
  (`RenderBlock` is its output type).
- **Method tables:** `chatComposerMethods` (input and output schema of each
  `chat.composer/v1` method; `expose: 'desktop'` on all but `registerFlush`)
  and `chatSendMethods` (input and output schema of `send` and `sendAction`).
- **Types of `chat.views/v1`:** `ChatViews`, `ChatThreadEvent`, `ChatBlock`,
  `ProjectorSpec`, `RendererSpec`, `FenceRendererSpec`, `ChatFence`,
  `ChatFenceView`, `ToolRendererSpec`, `ChatToolView`, `InputRendererSpec`,
  `ChatInputView`, `ChatBlockChosenDetail` (`{ chosen: boolean }`).
- **Types of `chat.lexical/v1` and `chat.hooks/v2`:** `ChatLexical`,
  `RenderBlock`, `ThreadUpdateNotice`
  (`{ kind: 'event'; event: ThreadEvent } | { kind: 'updated'; thread: Thread }`,
  types of `runtime/contracts`) and `ThreadUpdateInput`
  (`{ projectId; threadId; threadName; update: ThreadUpdateNotice }`).
- **Types of `chat.composer/v1`:** `ChatComposer`, `ComposerItem`,
  `ComposerItemData`, `ComposerSnapshot`, `ComposerWatchItem`,
  `ComposerAddInput`, `ComposerCommentWrite`, `ComposerFlush`,
  `ComposerFlushContext`, `ComposerFlushed`, and the method inputs
  `ComposerReadInput` (`{ threadId }`), `ComposerTextInput`
  (`{ threadId; text }`), `ComposerNoteInput` (`{ threadId; id; note }`),
  `ComposerRemoveInput` (`{ threadId; id }`), `ComposerFlushInput`
  (`{ threadId; promptId }`) and `ComposerFlushRegistration`
  (`{ kind; flush: ComposerFlush }`).
- **Types of `chat.send/v1`:** `ChatSend`, `ChatSendInput`
  (`{ projectId; threadId }`), `ChatSendResult`
  (`{ status: 'accepted' | 'empty' | 'refused' }`), `ChatActionInput` and
  `ChatActionResult` (`{ status: 'accepted' | 'refused' }`).
- **Block and element types:** `DelegatedInput`, `DelegatedInputBlock`
  (`{ type: 'chat.delegated-input/v1'; id; data: { promptId; input: DelegatedInput } }`),
  `ChatBlockElement`, `TurnComment`
  (`{ commentId; target: unknown; text; author?; inReplyTo? }`), and the
  re-export `CommentTarget` of `comments/contracts`.
- **Event details:** `ChatIntentDetail` (`{ command: string; input?: unknown }`),
  `PromptSendDetail` (`{ threadId; waitUntil(pending: Promise<unknown>): void }`)
  and `CommentThreadOpenDetail` (`{ commentId: string; target: unknown }`).
- **Constants:**
  - `CHAT_BLOCK_CHOSEN_EVENT = 'chat-block-chosen'`
  - `CHAT_INTENT_EVENT = 'chat:intent'`
  - `COMMENT_THREAD_OPEN_EVENT = 'doric:comment-thread-open'`
  - `PROMPT_SEND_EVENT = 'doric:prompt-send'`
  - `SEND_PROMPT_COMMAND = 'chat.send-prompt/v1'`
  - `DELEGATED_INPUT_BLOCK = 'chat.delegated-input/v1'`
  - `COMMENTS_ADDED_EVENT = 'comments.added/v1'`
  - `COMMENTS_RESOLVED_EVENT = 'comments.resolved/v1'`
  - `MESSAGE_KIND = 'message'`
  - `CHAT_COMMENT_LINE_TAG = 'chat-comment-line'`
  - `COMPOSER_ITEM_ID_PREFIX = 'comment-'`
  - `READER_NAME`, re-exported from `desktop/ui/identity`: the platform's fixed
    name of the reader.
- **Function:** `turnCommentFrom(payload: unknown): TurnComment | undefined`
  reads a `comments.added/v1` payload: it answers `undefined` unless
  `commentId` is a non-empty string, `target` is present and `text` is a
  string, and keeps `author` when it is a string and `inReplyTo` when it is a
  non-empty string.

## Contracts used

| Contract                                                          | What for                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/v1`                                                        | Defining `chat.hooks/v2` ([`src/client/index.ts`](src/client/index.ts)); observing `workspace.hooks/v1` ([`src/client/services/thread-tabs.ts`](src/client/services/thread-tabs.ts))                                                                                                                                                                                                                                               |
| `ui/v1`, `navigation/v1`, `regions/v1`, `commands/v1`, `menus/v1` | Elements, the route, the footer items, the send command and its keybinding ([`src/client/index.ts`](src/client/index.ts)), running `chat:intent` commands ([`src/client/components/organisms/intent-dispatcher.tsx`](src/client/components/organisms/intent-dispatcher.tsx))                                                                                                                                                       |
| `runtime.threads/v1`                                              | `thread`, `watchThread`, `prompt`, `steer`, `rewind`, `resume`, `retry`, `pause`, `queue`, `queuedPrompt`, `editQueued`, `removeQueued`, `resumeQueue`, `setThreadExecution` ([`src/client/api/threads-api.ts`](src/client/api/threads-api.ts), [`src/client/api/thread-watch.ts`](src/client/api/thread-watch.ts))                                                                                                                |
| `runtime.attachments/v1`                                          | Storing a pasted or dropped image and reading it back ([`src/client/api/attachments-api.ts`](src/client/api/attachments-api.ts))                                                                                                                                                                                                                                                                                                   |
| `runtime.records/v1`                                              | Thread records for `<chat-view>`, the tab icon, the tab titles, the picker; one `view` per Thread on screen ([`src/client/hooks/use-workspace.ts`](src/client/hooks/use-workspace.ts), [`src/client/elements/chat-elements.tsx`](src/client/elements/chat-elements.tsx), [`src/client/services/thread-tabs.ts`](src/client/services/thread-tabs.ts), [`src/client/services/thread-views.ts`](src/client/services/thread-views.ts)) |
| `comments/v1`                                                     | Writing the comment writes a flush answers ([`src/client/api/composer.ts`](src/client/api/composer.ts))                                                                                                                                                                                                                                                                                                                            |
| `chat.composer/v1`                                                | The shared draft, from the client part ([`src/client/api/composer.ts`](src/client/api/composer.ts))                                                                                                                                                                                                                                                                                                                                |
| `layout.tabs/v2`                                                  | Opening, retitling and closing Thread tabs; reading the selected tab ([`src/client/services/thread-tabs.ts`](src/client/services/thread-tabs.ts), [`src/client/services/thread-views.ts`](src/client/services/thread-views.ts))                                                                                                                                                                                                    |
| `history.snapshots/v1` (optional)                                 | Reading a Thread's cached snapshot before subscribing, and writing every applied batch ([`src/client/api/history.ts`](src/client/api/history.ts), [`src/client/api/history-contract.ts`](src/client/api/history-contract.ts))                                                                                                                                                                                                      |
| `models/v1` (optional)                                            | The icon of the model that answered a turn ([`src/client/api/model-icons.ts`](src/client/api/model-icons.ts))                                                                                                                                                                                                                                                                                                                      |
| `settings.models/v1` (optional)                                   | Everything the execution picker shows and the execution each choice yields ([`src/client/api/settings-models.ts`](src/client/api/settings-models.ts))                                                                                                                                                                                                                                                                              |
| `workspace.selection/v1` (optional)                               | The selected Thread, for the composer, the picker and `<chat-view>`'s record ([`src/client/api/workspace-selection.ts`](src/client/api/workspace-selection.ts))                                                                                                                                                                                                                                                                    |
| `workspace.hooks/v1` (optional)                                   | `onOpenThreadHook`, which opens a Thread tab ([`src/client/api/workspace-hooks.ts`](src/client/api/workspace-hooks.ts))                                                                                                                                                                                                                                                                                                            |
| `doric.connection/v1` (platform)                                  | Resubscribing a Thread watch when the connection is back ([`src/client/api/thread-watch.ts`](src/client/api/thread-watch.ts))                                                                                                                                                                                                                                                                                                      |

The optional `workspace` contracts are reached through structural copies in
`src/client/api/`, and `settings.models/v1` and `history.snapshots/v1` through
a reference of their id with type-only imports, so a composition without those
bundles still loads the chat. Without them the conversation still works: no
picker without `settings`, no Thread tab and no selection without `workspace`,
no cached first draw without `history`, and no model icon without `models/v1`.

## The conversation

- **History.** A Thread's history is its durable event log on the host; the
  window's Thread store treats its copy as a view
  ([`src/client/stores/thread-chats.ts`](src/client/stores/thread-chats.ts),
  [`src/client/domain/thread-chats.ts`](src/client/domain/thread-chats.ts)).
  Opening a Thread reads its cached snapshot from `history.snapshots/v1` (none
  without it), draws it, and subscribes through `runtime.threads/v1.watchThread`
  after the snapshot's last sequence, or from the start. The store holds at
  most 20 Threads, each with its own watch, and drops the least recently viewed;
  a held Thread is only shown again, with nothing replayed. A deleted Thread
  stays deleted. Live events reach the projection in flushes of at most 100 ms
  per Thread, the first of a burst at once; other updates land at once; every
  applied batch is written to the history cache. A lost bridge or host
  generation ends a watch silently, and the watch resubscribes from its cursor
  when `doric.connection/v1` reports `connected`
  ([`src/client/api/thread-watch.ts`](src/client/api/thread-watch.ts)).
- **The record.** `<chat-view>` opens on the record `runtime.records/v1` holds,
  kept current, while a `workspace.selection/v1` provider answers; without one
  it asks the host for the Thread once per Thread
  ([`src/client/hooks/use-thread-record.ts`](src/client/hooks/use-thread-record.ts)).
  Another Thread is a new editor.
- **One editable document.** The transcript is one Lexical editor
  ([`src/client/components/organisms/conversation/index.tsx`](src/client/components/organisms/conversation/index.tsx)).
  Every block but the prompt is read-only. The caret moves through turns and
  answers as text; a reasoning run, a tool call or an activity summary is one
  stop that Enter opens or closes; the footer under a turn (the time it was
  last written, with its author for a screen reader) is skipped; the turn's
  avatar sits in the column's left gutter
  ([`src/client/components/organisms/conversation/plugins/caret-navigation.tsx`](src/client/components/organisms/conversation/plugins/caret-navigation.tsx)).
- **The projection.** The built-in projector turns the log into turns: the
  reader's turns, other sources' inputs, answers (Markdown with their markers
  kept), reasoning, tool calls, activity summaries, queue receipts, lifecycle
  rows for a paused or resumed prompt, compactions, failures and the agent's
  comment replies ([`src/client/domain/projector.ts`](src/client/domain/projector.ts),
  [`src/client/domain/prompt-lifecycle.ts`](src/client/domain/prompt-lifecycle.ts)).
  Reasoning and tool calls are open while they run and fold once settled; a
  live standalone call does not fold the steps before it. A queue receipt ends
  no turn. A failure row, a failed tool call and a failed compaction draw the
  shared error notice (`desktop/ui/error-notice`) with its code, Copy details
  and the cause chain; the last prompt's failure offers Retry while it can be
  retried
  ([`src/client/components/organisms/conversation/nodes/failure-turn-node.tsx`](src/client/components/organisms/conversation/nodes/failure-turn-node.tsx)).
  A prompt from a terminal is recognised by its source kind `terminal`, never
  by its text ([`src/client/domain/projector-input.ts`](src/client/domain/projector-input.ts)).
- **The agent's comment replies.** A `comment_reply` call that has not failed
  is drawn as a row of the agent's reply block, not as a tool row, with a pin
  coloured by the comment thread's state (`done`, `await` or `open`, folded from
  `comments.added/v1` and `comments.resolved/v1`)
  ([`src/client/domain/comment-threads.ts`](src/client/domain/comment-threads.ts)).
- **Pending turns.** A sent prompt appears at once as a pending turn, drawn
  dimmed, until the log holds it; the comments it carries are drawn as sent
  until the log holds them ([`src/client/domain/pending-turns.ts`](src/client/domain/pending-turns.ts)).
- **Keys.** `Cmd/Ctrl+Enter` sends; while a prompt runs it steers it at its next
  safe point. With a prompt running, `Tab` queues the words for after it,
  `Escape` with words aborts the current step and steers, and `Escape` without
  words, or `Ctrl+C` with nothing selected, stops it
  ([`src/client/components/organisms/conversation/plugins/send-prompt.tsx`](src/client/components/organisms/conversation/plugins/send-prompt.tsx)).
  A refused send puts the reader's words back while the prompt is empty.
- **The queue.** Queued prompts sit above the input; the reader edits or removes
  one before it runs, and resumes a paused queue from the footer
  ([`src/client/components/organisms/thread-queue.tsx`](src/client/components/organisms/thread-queue.tsx),
  [`src/client/domain/queue.ts`](src/client/domain/queue.ts),
  [`src/client/components/organisms/conversation/plugins/edit-queue-prompt.tsx`](src/client/components/organisms/conversation/plugins/edit-queue-prompt.tsx)).
- **Images.** A pasted or dropped image is stored first through
  `runtime.attachments/v1` (at most 5 MiB, `ATTACHMENT_MAX_BYTES` of
  `runtime/contracts`), then becomes a line `![name](doric-attachment:sha256-…)`
  of the prompt, drawn as the image; the window shows it as a `data:` URL
  ([`src/client/components/organisms/conversation/plugins/attach-images.tsx`](src/client/components/organisms/conversation/plugins/attach-images.tsx),
  [`src/client/components/organisms/conversation/nodes/attachment-image-node.tsx`](src/client/components/organisms/conversation/nodes/attachment-image-node.tsx)).
- **Comments before the prompt.** Selecting text in an agent message and
  typing opens a `message` comment right after the paragraph or list item the
  selection ends in, with its words highlighted
  ([`src/client/components/organisms/conversation/plugins/comment-selection.tsx`](src/client/components/organisms/conversation/plugins/comment-selection.tsx)).
  Every stack item, the chat's and other bundles', is drawn inside the prompt
  above the reader's words, as a card with the passage and an arrow that goes
  to it ([`src/client/components/organisms/composer-stack.tsx`](src/client/components/organisms/composer-stack.tsx)).
- **The trail.** A rail left of the conversation has one handle per prompt of
  the reader's that the host accepted, then a "Go to the end" bar; hovering a
  handle previews its words
  ([`src/client/components/molecules/thread-nav-rail.tsx`](src/client/components/molecules/thread-nav-rail.tsx),
  [`src/client/domain/thread-nav.ts`](src/client/domain/thread-nav.ts)).
- **Agent Threads.** On a Thread an agent spawned, the footer draws three
  levers instead of the composer: pause the run, continue the prompt it left
  unfinished (or resume its queue), or retry the last prompt
  ([`src/client/domain/agent-control.ts`](src/client/domain/agent-control.ts),
  [`src/client/components/organisms/agent-thread-controls.tsx`](src/client/components/organisms/agent-thread-controls.tsx)).

## The prompt envelope

Every send carries one text ([`src/client/domain/prompt-envelope.ts`](src/client/domain/prompt-envelope.ts)):

```
<comments>
<target kind="artifact" id="art_123" revision="2" title="Checkout" source="…">
<comment id="comment-…" in-reply-to="…" pin="1" anchor="src/Checkout.tsx:14" element="h2">note</comment>
</target>
</comments>
<message>
the reader's words
</message>
```

- `<comments>` holds the stack items with a non-blank note, grouped by target
  (`kind`, `id`, `revision`) in first-appearance order; `title` and `source`
  come from the first item's `refs`. A comment that names no target stands
  outside any `<target>`. The anchor attributes follow the anchor's form:
  `source` gives `anchor="path:line"` and `element`; `selector` gives the
  selector and `element`; `point` gives `anchor="point x,y"` and `near`;
  `range` gives `anchor="range"` and `quote`, the selected text cut to 200
  characters.
- `<message>` holds the trimmed words. Either part is left out when empty; an
  empty envelope means nothing to send. Attribute values are escaped, and a
  body's closing tags of the envelope elements are neutralised, and restored
  when read back.
- A UI action is `<ui-action program="…">` around its text.
- Every surface that shows a stored prompt reads it back through
  `parsePromptEnvelope` and `promptMessage`; a prompt that is not exactly an
  envelope is shown as written.

## Sending

- The composer's send, `chat.send/v1.send` and the send command all build the
  envelope from the words and the stack and send it through the window's Thread
  store, which holds the words as a pending turn and answers whether the host
  accepted ([`src/client/stores/thread-chats.ts`](src/client/stores/thread-chats.ts)).
- Only after acceptance, with the prompt's id, the sending window calls
  `chat.composer/v1.flush` and performs each answered write through
  `comments/v1.add`, in the scope of the accepted prompt, so the comment events
  land in that prompt's log. An item whose write fails is logged and put back
  on the stack under the same id; the writes are idempotent on that id
  ([`src/client/api/composer.ts`](src/client/api/composer.ts)).
- A refused send flushes nothing: the stack and the draft stay as they were.
- A window writes the prompt's text to the draft 300 ms after the last
  keystroke
  ([`src/client/components/organisms/conversation/plugins/composer-draft.tsx`](src/client/components/organisms/conversation/plugins/composer-draft.tsx)),
  and a note's edits 150 ms after the last one; a waiting note edit goes at once
  when the note loses the focus, before a send reads the stack, and when the
  window stops showing the Thread; removing the comment drops it
  ([`src/client/stores/composer-stack.ts`](src/client/stores/composer-stack.ts)).

## Thread tabs and the Threads on screen

- When `workspace.hooks/v1.onOpenThreadHook` fires, the chat opens through
  `layout.tabs/v2`
  `{ id: 'thread:<id>', title, tag: 'chat-thread-panel', iconTag: 'chat-thread-tab-icon', openBottom: true, props: { projectId, threadId } }`,
  titled with the Thread's name, or "Untitled"
  ([`src/client/services/thread-tabs.ts`](src/client/services/thread-tabs.ts)).
  On every change of `runtime.records/v1`, for each tab it opened: a tab whose
  Project's Threads are loading or not described is left as it is; a Thread
  missing from its described Project closes its tab in every owner; a changed
  name retitles it in every owner. A failed open, retitle or close is logged with
  `console.error('Doric: …')`.
- The chat holds one `runtime.records/v1` `view` per Thread on screen: the
  route's Thread, and the Thread of the selected tab when its id is
  `thread:<threadId>` ([`src/client/domain/thread-views.ts`](src/client/domain/thread-views.ts),
  [`src/client/services/thread-views.ts`](src/client/services/thread-views.ts)).
  On each change of the route, the tabs or the records it takes the new views
  before disposing the old ones. Without a records provider it holds none.

## The execution picker

([`src/client/components/organisms/execution-picker.tsx`](src/client/components/organisms/execution-picker.tsx))

- Everything it shows (the models grouped by provider with their icons, the
  efforts the shown model accepts) and the execution each choice yields come
  from `settings.models/v1`: `view(stored)`, `subscribe`, `reload`. The stored
  execution is the selected Thread's `providerId`, `model` and `effort` from
  `runtime.records/v1`. A choice writes
  `runtime.threads/v1.setThreadExecution({ id, ...execution })`; the picker
  never writes the workspace default.
- A refused write shows an inline, announced notice, only while its Thread is
  selected: "Model not accepted" (`invalid_execution`), "Thread not found"
  (`thread_not_found`), or a Retry of the same write for an unavailable host. A
  failed configuration read shows "Settings not loaded" with a Retry that calls
  `reload`.
- With no Thread selected (always without `workspace`), it shows the workspace
  default, locked, titled "New threads start on the workspace default. Change it
  in Settings."

## Styling

[`src/client/styles.css`](src/client/styles.css) holds the conversation's own
rules: the Lexical placeholder, the conversation scroll and trail, the
queue-edit surface and the `editor-*` Markdown theme.

- `<chat-view>` reads `--shell-conversation-footer-height`, the height of a
  footer floating over its conversation's bottom, set by its host on an
  ancestor; unset it is 0. The conversation's vertical scrollbar ends that far
  above the bottom, and the scroll viewport's `scroll-padding-bottom` is that
  height.
- `.conversation-scroll` sets `isolation: isolate`, so the transcript's layers
  paint inside the scroll root and a footer later in tree order paints over them
  with no `z-index`.
- `<chat-thread-panel>` sets `--shell-conversation-footer-height: 2.75rem` and
  draws its footer (`data-slot="chat-thread-footer"`) as a 44 px band floating
  over its conversation: 8 px over and under a 28 px row, the background at 70 %
  with a 2 px backdrop blur ([`src/client/views/chat-view.tsx`](src/client/views/chat-view.tsx)).
- A scroll area narrower than 48rem widens the column's left padding to 2.5rem
  and its top padding to 1rem ([`src/client/styles.css`](src/client/styles.css)).
- Known limits: the caret of a prompt being typed can stop under a floating
  footer, and a wheel over the footer's band does not scroll the conversation.

## Errors and failure behavior

- Contract errors are those listed with each contract above:
  `registration_conflict`, `invalid_input`, `frozen`; the client's helpers fail
  with `unavailable` when the chat part is not active
  ([`src/client/services/chat-services.ts`](src/client/services/chat-services.ts)).
- A host call fails with a `ClientError` that keeps the host's code and message;
  a code other than `internal` is kept with the host error as its cause
  ([`src/client/api/threads-api.ts`](src/client/api/threads-api.ts)).
- The chat's error catalog
  ([`src/client/domain/error-catalog.ts`](src/client/domain/error-catalog.ts))
  is passed to every `ErrorNotice` and `toastError` the chat draws, and wins
  over the shared entries for a code both list. An entry without an
  explanation shows the error's own message. Where a surface names a fallback
  code, it is the code shown when the error carries none; the other codes come
  from the host's errors and show on whichever surface reports them.

| Code                           | Title                 | Retryable | Explanation                                                                                                       | Surface                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt_failed`                | Prompt failed         | yes       | the error's message                                                                                               | Failure row's notice ([`nodes/failure-turn-node.tsx`](src/client/components/organisms/conversation/nodes/failure-turn-node.tsx))                                                                                                                                                                        |
| `tool_failed`                  | Tool failed           | no        | the error's message                                                                                               | Generic tool row's notice ([`molecules/tool-item.tsx`](src/client/components/molecules/tool-item.tsx))                                                                                                                                                                                                  |
| `resume_exhausted`             | Execution stopped     | yes       | The host restarted three times during this prompt, so the work may be incomplete; retry to send the prompt again. | Host error, warning tone                                                                                                                                                                                                                                                                                |
| `thread_execution_unavailable` | Model unavailable     | no        | the error's message                                                                                               | Host error                                                                                                                                                                                                                                                                                              |
| `summarizer_failed`            | Compaction failed     | no        | Earlier messages could not be summarized.                                                                         | Compaction row's notice ([`nodes/compaction-turn-node.tsx`](src/client/components/organisms/conversation/nodes/compaction-turn-node.tsx))                                                                                                                                                               |
| `unsafe_boundary`              | Compaction skipped    | no        | No safe point was found to summarize earlier messages.                                                            | Compaction row's notice                                                                                                                                                                                                                                                                                 |
| `queue_paused`                 | Execution paused      | yes       | the error's message                                                                                               | Queue notice ([`organisms/thread-queue.tsx`](src/client/components/organisms/thread-queue.tsx))                                                                                                                                                                                                         |
| `queue_refresh_failed`         | Queue not refreshed   | yes       | the error's message                                                                                               | Queue notice                                                                                                                                                                                                                                                                                            |
| `send_failed`                  | Prompt not sent       | no        | the error's message                                                                                               | Toast `thread-send-<threadId>` ([`conversation/index.tsx`](src/client/components/organisms/conversation/index.tsx))                                                                                                                                                                                     |
| `stop_failed`                  | Could not stop        | no        | the error's message                                                                                               | Toast `thread-stop-<threadId>` ([`hooks/use-thread-stop.ts`](src/client/hooks/use-thread-stop.ts))                                                                                                                                                                                                      |
| `queue_action_failed`          | Queue not updated     | no        | the error's message                                                                                               | Toast `thread-queue-<threadId>` ([`hooks/use-thread-queue.ts`](src/client/hooks/use-thread-queue.ts))                                                                                                                                                                                                   |
| `queue_edit_failed`            | Prompt not edited     | no        | the error's message                                                                                               | Toast `queue-edit-<threadId>` ([`plugins/edit-queue-prompt.tsx`](src/client/components/organisms/conversation/plugins/edit-queue-prompt.tsx)); inline notice in the queued prompt's edit node ([`nodes/prompt-edit-node.tsx`](src/client/components/organisms/conversation/nodes/prompt-edit-node.tsx)) |
| `command_failed`               | Action failed         | no        | the error's message                                                                                               | Toast `chat-intent-<command>` ([`organisms/intent-dispatcher.tsx`](src/client/components/organisms/intent-dispatcher.tsx))                                                                                                                                                                              |
| `attach_failed`                | Image not attached    | no        | the error's message                                                                                               | Toast `attach-image-<threadId>-<name>` ([`plugins/attach-images.tsx`](src/client/components/organisms/conversation/plugins/attach-images.tsx))                                                                                                                                                          |
| `invalid_execution`            | Model not accepted    | no        | the error's message                                                                                               | Execution picker's inline notice ([`organisms/execution-picker.tsx`](src/client/components/organisms/execution-picker.tsx))                                                                                                                                                                             |
| `thread_not_found`             | Thread not found      | no        | the error's message                                                                                               | Execution picker's inline notice                                                                                                                                                                                                                                                                        |
| `config_read_failed`           | Settings not loaded   | yes       | the error's message                                                                                               | Execution picker's inline notice                                                                                                                                                                                                                                                                        |
| `auth_failed`                  | Sign-in rejected      | no        | {provider} refused the credentials; check the provider in Settings.                                               | Host error                                                                                                                                                                                                                                                                                              |
| `auth_missing`                 | Credentials missing   | no        | {provider} needs a credential; add one in Settings.                                                               | Host error                                                                                                                                                                                                                                                                                              |
| `auth_ambiguous`               | Credentials ambiguous | no        | More than one credential matches {provider}; keep one in Settings.                                                | Host error                                                                                                                                                                                                                                                                                              |

- An unreachable composer service answers an empty draft and writes nothing;
  the conversation keeps working. A failing observer, hook execution, history
  write or projector never fails the conversation.

## Limits

- 20 Threads held per window; 100 ms per-Thread flush of live events.
- `sendAction` text: 16,000 UTF-16 code units. Fence tag: 1–64 characters.
- Image attachment: 5 MiB. A `range` comment quotes at most 200 characters.
- Draft text written 300 ms, a note 150 ms, after the last edit.
- The composer draft lives in the main process's memory and does not survive a
  restart of the app.

## Configuration

The bundle reads no setting of its own. The model and effort come from
`settings.models/v1`, and the reader's name is the platform's `READER_NAME`.

## Build and test

```console
npx nx run bundle-chat:typecheck
npx nx run bundle-chat:test
npx nx run bundle-chat:build
```

- `build` emits `src/contracts/` to `dist/contracts/` with `tsc --build`
  (`tsconfig.json`), type-checks `src/`, `stories/` and `.storybook/`
  (`tsconfig.client.json`, which emits nothing), then bundles the desktop and
  client parts and the contract schemas into `dist/` with the `bundle` CLI
  ([`project.json`](project.json)). `typecheck` emits only the contracts'
  declarations, type-checks the same sources, and also checks `src/desktop/`
  with `tsconfig.parts.json`. `npx nx run doric-host:build-bundles` stages
  every bundle for the Doric host.
- `test` builds first, then compiles `tests/` into `dist-tests/` (removed
  first) and runs it under `node --test`. `tests/*.test.ts` are DOM-free unit
  tests of the domain rules, the stores, the services and the desktop part
  (`tests/support/desktop.ts` activates the built desktop part);
  `tests/client/*.test.ts` boot one happy-dom window with the built core and
  chat client parts and a fake host (`tests/client/support/window.ts`).
- Stories under `stories/` are CSF3, wrapped by `.storybook/preview.tsx`. No
  target runs them: `typecheck` and `build` only type-check them.
