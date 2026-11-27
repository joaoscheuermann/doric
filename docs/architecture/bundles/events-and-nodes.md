# Durable events and the nodes of a conversation

- Status: living document. It describes durable events and the nodes of a conversation as implemented on 2026-11-20.

## Summary

A durable event is one row of an append-only stream. A bundle that owns an event type declares it with `defineEvent`, registers it in `events/v1`, and appends it with a payload its schema accepts; the provider of `events/v1` validates the payload, redacts it, writes it to the stream that the one registered **event sink** names, and then fires `core.event-hooks/v1.onEventAppendedHook` ([`basic/events.ts`](../../../packages/bundle/src/contracts/basic/events.ts), `core/src/host/events/facade.ts`). The core knows no stream name and no scope key: the `runtime` registers the sink, so every appended event lands in the log of one Thread, `runtime.thread.events/<threadId>`, beside the events the runtime writes itself ([`runtime/src/contracts/events.ts`](../../../bundles/runtime/runtime/src/contracts/events.ts)).

A conversation turns that log into what the reader sees. The `chat` bundle projects the events into turns and blocks and draws them as Lexical nodes; other bundles take part through `chat.views/v1`, which lets them project their own event types, draw a block type, draw the calls of a tool, and draw the prompts of an input source ([`chat/src/client/services/views.ts`](../../../bundles/desktop/chat/src/client/services/views.ts)). The history the executor sends to the model is a separate record, kept by the runtime beside the log.

## Who owns what

| Role             | Bundle                             | What it does                                                                                                                                   |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider         | `core` (host)                      | Provides `events/v1` and defines `core.event-hooks/v1`; keeps the registered types and the sink; validates, redacts and commits each row       |
| Sink owner       | `runtime`                          | Registers the one sink: rows keyed by `projectId`, `threadId`, `promptId`, in the stream `runtime.thread.events/{threadId}`                    |
| Event owner      | `comments`, `openui`, `papercraft` | Declares its event types, lists them under `provides`, registers them on activation and appends them                                           |
| Thread log owner | `runtime`                          | Writes its own events to the same stream directly, folds the rows others append into the Thread, and publishes every event to the conversation |
| Conversation     | `chat` (client)                    | Projects the log into turns and blocks, and serves `chat.views/v1` so that other bundles project and draw their part                           |

The shipped event types appended through `events/v1` are `comments.added/v1` and `comments.resolved/v1` ([`comments/src/contracts/index.ts`](../../../bundles/features/comments/src/contracts/index.ts)), `openui.answered/v1` ([`openui/src/contracts/questions.ts`](../../../bundles/features/openui/src/contracts/questions.ts)) and `papercraft.cwd/v1` ([`papercraft/src/contracts/cwd.ts`](../../../bundles/features/papercraft/src/contracts/cwd.ts)). The `runtime` registers `runtime.prompt-finished/v1` ([`runtime/src/host/routed.ts`](../../../bundles/runtime/runtime/src/host/routed.ts)) and appends nothing through `events/v1`: it writes every event of its own, `prompt.finished` among them, through its Thread store (see [The Thread log](#the-thread-log)).

## The contract `events/v1`

`events/v1` is a service contract of cardinality `one`, available in the `host` environment only ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)). The `core` bundle provides it, version 1.0.0, from its host part (`core/src/host/index.ts`, [`manifest.json`](../../../bundles/foundation/core/manifest.json)), and persists the rows through `storage/v1`. A bundle reaches it with `services.use(EventsV1)`, where `EventsV1` comes from `bundle/contracts`, and lists `events/v1@^1.0.0` under `requires`. The interface ([`basic/events.ts`](../../../packages/bundle/src/contracts/basic/events.ts)):

```ts
interface Events {
  register(definition: EventDefinition): Disposable;
  sink(spec: EventSinkSpec): Disposable;
  append<D extends EventDefinition>(
    definition: D,
    payload: z.input<D['payload']>,
    call?: CallArg,
  ): Promise<void>;
}

interface EventSinkSpec {
  readonly scopeKeys: readonly string[]; // the call-scope keys a row carries, in row order
  readonly stream: string; // a stream id with a `{key}` placeholder per scope key
  readonly scopeDescription?: string; // what a call must carry, named in `invalid_scope`
}
```

Its errors are `ContractError`s with these codes ([`basic/events.ts`](../../../packages/bundle/src/contracts/basic/events.ts), `facade.ts`):

| Code                    | When                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unknown_event`         | `append` of a type no bundle registered in the caller's generation                                                                                                                                                             |
| `invalid_scope`         | `append` when no sink is registered, or when the call's scope lacks a key the sink names                                                                                                                                       |
| `not_owner`             | `register` of a type outside the caller's namespace; `append` by a bundle other than the type's owner; `sink` or `append` that would write a stream another bundle owns                                                        |
| `undeclared_provide`    | `register` of a type the caller's manifest does not list under `provides`                                                                                                                                                      |
| `invalid_input`         | A payload the registered schema refuses; a payload schema that declares `type`; a sink spec that breaks its schema                                                                                                             |
| `registration_conflict` | A second registration of the same type, or a second sink, while the first is live (see [Generations](#generations))                                                                                                            |
| `invalid_stream`        | `sink` of a stream template, or `append` of a filled stream, that is not of the form `<owner>.<family>/<key>`, the key non-empty and without whitespace ([`storage/src/streams.ts`](../../../packages/storage/src/streams.ts)) |

The principal of the platform, `doric`, passes the namespace and `provides` checks of `register`, the type-owner check of `append` and the stream check of `sink`: it may register any type, register a sink with a template for any stream and append any type ([`core/src/shared/state.ts`](../../../bundles/foundation/core/src/shared/state.ts), `facade.ts`). It does not pass the row check of `append` (step 4 of [Appending an event](#appending-an-event)): a sink is usable only when the owner of each filled stream is the bundle that registered the sink, so a sink that `doric` registers for another bundle's stream accepts no row.

## Declaring an event type

`defineEvent({ type, payload })` returns an `EventDefinition`: `type` is a contract id, `<owner>.<name>/v<major>`, and `payload` a zod object schema. An id that starts with `doric.` is refused, because those ids belong to the platform ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)). The owner exports the definition from its `contracts` entry point, lists the type with its full version under `provides`, and registers it in the `activate` of its host part. `papercraft` does all three ([`papercraft/src/contracts/cwd.ts`](../../../bundles/features/papercraft/src/contracts/cwd.ts), [`papercraft/src/host/service.ts`](../../../bundles/features/papercraft/src/host/service.ts), [`papercraft/manifest.json`](../../../bundles/features/papercraft/manifest.json)):

```ts
// papercraft, src/contracts/cwd.ts
export const cwdEvent = defineEvent({
  type: 'papercraft.cwd/v1',
  payload: z.object({ cwd: z.string().min(1) }).strict(),
});

// papercraft, src/host/index.ts, in activate
services.use(EventsV1).register(cwdEvent);
```

```json
{
  "id": "papercraft",
  "provides": ["papercraft.cwd/v1@1.0.0"],
  "requires": ["events/v1@^1.0.0"]
}
```

The excerpt shows `id`, the one `provides` line and the one `requires` line that concern the event; the full manifest and its rules are in [Manifest](manifest.md).

`register` checks the owner the way every definition of the core is checked: the namespace of the type, the part before its first `.` or `/`, must be the calling bundle, and the type must be listed under the caller's `provides`; otherwise `not_owner` or `undeclared_provide` ([`core/src/shared/state.ts`](../../../bundles/foundation/core/src/shared/state.ts)). In the host process, `register` refuses with `invalid_input` a payload schema whose shape declares `type`, because the stored body puts the event's type under that key. The body is built as `{ type, ...payload }`, so an open payload (`z.looseObject`, as the `comments` events) that carries its own `type` key replaces the event's type in the body; the row's own `type` column keeps the registered type (`facade.ts`). The schema may be closed (`.strict()`, as `papercraft.cwd/v1`) or open (`z.looseObject`, as the `comments` events). The type carries the major; a change of the payload follows [Versioning](versioning.md). A bundle that reads another bundle's event type, for example to project it, lists the type under `requires` or `optional`, as `chat` lists `comments.added/v1`, `comments.resolved/v1` and `runtime.prompt-finished/v1` ([`chat/manifest.json`](../../../bundles/desktop/chat/manifest.json)); the boundary checks hold every bundle to it ([Boundaries](boundaries.md)).

### Definitions from another process

A bundle whose part runs in a generation process registers and appends through the kernel's `events/v1`, and its definition crosses the process boundary as data: the event's type and the JSON Schema of the payload's input, derived from the zod schema in the bundle's process. The kernel rebuilds it as a mirror definition, `defineEvent` with an empty open object (`z.looseObject({})`) refined by a check against that JSON Schema ([`envelope/values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). The provider then sees no shape, so the refusal of a payload schema that declares `type` does not apply; and it validates the payload by the JSON Schema alone, so a zod transform or default of the original schema does not run and the payload is stored as sent. Registrations are kept by generation, as below.

### Generations

The registry of types and the sink are partitioned by generation, as every registry of the core is ([`registry.ts`](../../../bundles/foundation/core/src/host/events/registry.ts), [`sinks.ts`](../../../bundles/foundation/core/src/host/events/sinks.ts), [`core/src/shared/partition.ts`](../../../bundles/foundation/core/src/shared/partition.ts)). A registration made by a call of generation 0, the kernel partition, is seen by every generation and collides with every live registration; a registration made in generation `n` is seen in `n` only and collides with the kernel partition and with generation `n`. The same owner may thus register the same type, and the same sink, once per generation, and disposing one generation's registration never removes another's. A read made by a kernel call sees the kernel partition and the active generation, which it reads from `doric.catalog/v1`. Generations are described in [Process isolation](process-isolation.md).

## The event sink

`events/v1` writes to one stream template, the sink, registered once by the bundle that owns the stream ([`basic/events.ts`](../../../packages/bundle/src/contracts/basic/events.ts), [`sinks.ts`](../../../bundles/foundation/core/src/host/events/sinks.ts)):

- `scopeKeys` are 1 to 16 keys (the scope's maximum), each matching the scope-key grammar of [`call.ts`](../../../packages/bundle/src/contracts/call.ts), with no duplicate. They are the keys every row carries, in the order given.
- `stream` is 1 to 256 characters. Each `{key}` placeholder must name one of `scopeKeys`; a placeholder that names another key fails the spec with `invalid_input`.
- `scopeDescription`, optional, is 1 to 256 characters.
- On `sink`, the provider fills each placeholder with a sample value and parses the result as a stream id: its owner, the segment before the first `.`, must be the calling bundle, or the call is refused with `not_owner`.
- A second sink that collides with a live one is `registration_conflict`. Disposing the returned `Disposable` removes the sink; an `append` with no sink is `invalid_scope`.

The `runtime` registers the sink when its host part activates, tracked by `context.registrations` ([`runtime/src/host/routed.ts`](../../../bundles/runtime/runtime/src/host/routed.ts)). Its spec, `threadEventSink`, shown with the stream resolved: the code builds it from the constant `threadEventsStreamPrefix`, `runtime.thread.events/` ([`runtime/src/contracts/events.ts`](../../../bundles/runtime/runtime/src/contracts/events.ts), [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts)):

```ts
export const threadEventSink: EventSinkSpec = Object.freeze({
  scopeKeys: Object.freeze(['projectId', 'threadId', 'promptId']),
  stream: 'runtime.thread.events/{threadId}',
  scopeDescription: 'a project, a Thread and a prompt',
});
```

So an event appended through `events/v1` needs a call scoped to a Project, a Thread and a prompt, and lands in that Thread's log. The core holds none of these names: they reach it only through the sink.

## Appending an event

The owner appends with the definition, the payload and the call of the operation in progress. The call's `scope` is what the sink reads, so the owner either passes a call that carries the scope or obtains a stub bound to one with `services.use(EventsV1, scope)`. `openui` does both when the reader answers a question ([`openui/src/host/questions.ts`](../../../bundles/features/openui/src/host/questions.ts)):

```ts
await services
  .use(EventsV1, { ...scope, promptId })
  .append(
    answeredEvent,
    { questionPromptId: input.promptId, digest, answers: [...input.answers] },
    call,
  );
```

When a stub bound with `services.use(EventsV1, scope)` is also given a call, the call's scope is merged under the bound one: a key both carry takes the bound value ([`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)). A scope holds at most 16 keys and each value at most 512 characters ([`contracts/call.ts`](../../../packages/bundle/src/contracts/call.ts)). The `caller` that `events/v1` sees is the bundle that calls `append`, not the bundle that called it; how `scope`, `signal` and `trace` pass from one call to the next is in [Contexts](contexts.md).

On `append`, the provider of the core (`facade.ts`):

1. finds the registered type as the call's generation sees it, else `unknown_event`;
2. refuses a caller other than the type's owner, with `not_owner`;
3. takes the sink, else `invalid_scope`, and refuses a call whose scope lacks one of its `scopeKeys`, with `invalid_scope`, whose message names the sink's `scopeDescription` or, without one, its keys joined by commas;
4. fills the stream template from the call's scope and parses the result, refusing a stream that is not a valid stream id (an empty key, or whitespace in a scope value) with `invalid_stream`, and refusing the row with `not_owner` when the owner of that stream is not the bundle that registered the sink, since a placeholder value could change the owner segment; this check has no exception for `doric`;
5. parses the payload with the registered schema, else `invalid_input` with the issues;
6. builds the body `{ type, ...payload }`, replaces every secret value that `secrets/v1.redactions` lists for the call, and makes every string storable: U+0000 and unpaired surrogates become U+FFFD ([`core/src/shared/redact.ts`](../../../bundles/foundation/core/src/shared/redact.ts));
7. commits one row through `storage/v1.commit`, appended to the stream: the sink's scope keys in their order, then `type`, then `event`, the body;
8. after the commit, fires `core.event-hooks/v1.onEventAppendedHook({ stream, type })` without waiting for it and drops any rejection, so a hook never fails an append.

A refused append writes nothing. The row's sequence and `createdAt` belong to the stream entry, as `storage/v1` assigns them ([Storage](storage.md)). An event carries no secret value: what the redaction list names is replaced before the write.

### `core.event-hooks/v1`

The core declares `core.event-hooks/v1` with one hook, `onEventAppendedHook`, of kind `observe`, whose input is `{ stream, type }`, strict ([`core/src/contracts/hooks.ts`](../../../bundles/foundation/core/src/contracts/hooks.ts)). The core defines it in `hooks/v1` when its host part activates; a host without a catalog, as in a unit test, cannot define it, and its appends then tell no one (`core/src/host/index.ts`). The input names where the row went and nothing of its scope: the observer reads the stream itself. How hooks are declared, fired and observed is in [Hooks and the app's lifecycle](hooks.md).

## The Thread log

Each Thread has one stream, `runtime.thread.events/<threadId>`. Each entry's value is `{ projectId, threadId, promptId, type, event }`, strict, with `event` an object; the stream entry adds its `sequence` and `createdAt` ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts)). The rows `events/v1` writes have this shape because the runtime's sink names those three keys in that order.

Two writers share the stream:

- **The runtime** writes the events of a prompt's life (`prompt.accepted`, `prompt.started`, `prompt.finished` and the others) and, through the executor's prompt session, the events of a run, directly through `storage/v1`, in the same commit as the Thread document that folds them ([`runtime/src/host/store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts), [`runtime/src/contracts/executor.ts`](../../../bundles/runtime/runtime/src/contracts/executor.ts)). These types carry no version and are not registered in `events/v1`; the list is in the [runtime's README](../../../bundles/runtime/runtime/README.md#event-streams).
- **Other bundles** append their registered types through `events/v1`, without the runtime. The Thread document then lags the stream until the runtime catches up.

The runtime registers its `onEventAppendedHook` handler through `hooks/v1` when its host part activates, over the generated input schema of `core.event-hooks/v1`, and lists `core.event-hooks/v1@^1.0.0` under `requires` ([`runtime/src/host/service.ts`](../../../bundles/runtime/runtime/src/host/service.ts), [`runtime/manifest.json`](../../../bundles/runtime/runtime/manifest.json)). For a stream of a Thread it runs `catchUp` on that Thread: in one commit serialized with the runtime's own commits on the Thread, it folds the entries after the document's `lastSequence` into the document and, once the commit lands, publishes them, so each appended event is folded and published exactly once and in sequence order ([`runtime/src/host/appends.ts`](../../../bundles/runtime/runtime/src/host/appends.ts), [`runtime/src/host/store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)). A runtime commit that meets such an append first folds it in its own `sequence_conflict` retry. Clients read the stream through the host's public API: REST `GET /threads/:id/events?afterSequence=N` answers `{ events, lastSequence }` with the events after that sequence, and a socket subscribed to a Thread on the Socket.IO namespace `/threads` receives each published event after the last sequence it holds, as `agent:event` ([`src/host/api/operations/threads.ts`](../../../bundles/foundation/transport/src/host/api/operations/threads.ts), [`transport/src/host/process/watch.ts`](../../../bundles/foundation/transport/src/host/process/watch.ts), [host README](../../../app/backend/doric-host/README.md)). What the Thread document holds and how the log is served to clients is in [Projects and Threads](../../features/projects-and-threads.md).

A bundle that needs its own events back reads the Thread's log. `comments` rebuilds a Thread's comments by folding its `comments.added/v1` and `comments.resolved/v1` rows in log order, and skips a row its schema refuses ([`comments/src/host/comments.ts`](../../../bundles/features/comments/src/host/comments.ts), [comments README](../../../bundles/features/comments/README.md)); `papercraft` binds a fence to the `cwd` of the last `papercraft.cwd/v1` event below the fence's turn ([`papercraft/src/contracts/cwd.ts`](../../../bundles/features/papercraft/src/contracts/cwd.ts), [papercraft README](../../../bundles/features/papercraft/README.md)).

`runtime.prompt-finished/v1` is the versioned name of the runtime's `prompt.finished` event: its payload is `{ status: 'completed' | 'failed' | 'cancelled', text, source, reason?: 'queue_removed' }`, open, and the stored rows keep the type `prompt.finished`. `legacyEventTypes` in `runtime/contracts` maps each stored type that has a versioned name to that name, and holds this one pair; `qualifiedType` reads it ([`runtime/src/contracts/events.ts`](../../../bundles/runtime/runtime/src/contracts/events.ts), [runtime README](../../../bundles/runtime/runtime/README.md)). A bundle that observes the end of a prompt lists the versioned name under `requires` or `optional`.

## The provider history

What the model receives is not the event log. The executor, the provider of `executor/v1` (`default` in the shipped composition), keeps its own state per Thread: opaque, versioned by a `format`, and split into named parts. The runtime gives each run a prompt session whose `history` is a `HistoryReader` (`format`, `read(part)`), and the executor saves a `HistoryPatch` (`format`, `parts`) through `session.record({ history, event })`, which saves the history, then appends the event to the log and publishes it; the runtime redacts and sanitizes each part. Before `prompt.started` the runtime asks the executor for a `checkpoint`, and on a rewind for the truncated state; the executor declares the formats it reads with `formats()` ([`runtime/src/contracts/executor.ts`](../../../bundles/runtime/runtime/src/contracts/executor.ts), [`default/src/host/executor.ts`](../../../bundles/runtime/default/src/host/executor.ts)). The runtime stores the state as the storage type `runtime.history/v1` and never reads its format ([runtime README](../../../bundles/runtime/runtime/README.md)). A run that resumes after a restart reads this history, not the log.

## The nodes of a conversation

The conversation lives in the `client` part of `chat`. It receives a Thread's events as `ChatThreadEvent`s, `{ projectId, threadId, promptId, sequence, type, event, createdAt }`, and draws them in a Lexical editor, one node per block ([`chat/src/contracts/index.ts`](../../../bundles/desktop/chat/src/contracts/index.ts)). How the transcript, the composer and the trail behave for the reader is in [The conversation](../../features/conversation.md); the full contract of `chat.views/v1`, version 1.2.0, is in the [chat README](../../../bundles/desktop/chat/README.md).

### Projection: from events to blocks

Every event type falls to exactly one projection ([`chat/src/client/domain/external-blocks.ts`](../../../bundles/desktop/chat/src/client/domain/external-blocks.ts)):

- **The built-in projection** of `chat` claims every type that is not of the form `<owner>.<name>/v<major>` (the runtime's own types and the executor's), the versioned names `legacyEventTypes` lists, and `comments.added/v1` and `comments.resolved/v1`, which it draws inside the turns. It turns these events into turns: the reader's prompts, the agent's text and thinking, tool calls, the lifecycle markers ([`chat/src/client/domain/projector.ts`](../../../bundles/desktop/chat/src/client/domain/projector.ts)).
- **A registered projector** claims the versioned types it lists. `registerProjector({ eventTypes, initial, reduce })` refuses, with `registration_conflict`, a type the built-in projection claims or another projector holds ([`views.ts`](../../../bundles/desktop/chat/src/client/services/views.ts)). A projector is pure: on every batch the chat runs each projector from `initial()` over the Thread's whole event list, so replay and rewind need nothing else; a projector whose `initial()` throws is skipped for that batch, so its types draw nothing, and a projector that throws on an event keeps its previous state and adds no block for that event. Each block is `{ id, type, promptId, sequence, data }`; the blocks are ordered by `sequence`, then by the order projectors produced them, and a block whose content did not change keeps its identity across batches.
- **Any other versioned type** becomes one generic block per event, of type `chat.generic`, whose data is the event's type, its `createdAt` and its payload. The element `<chat-block>` draws it as the type, the block id (`event:<sequence>`), the time and the payload as JSON ([`chat/src/client/components/molecules/generic-block.tsx`](../../../bundles/desktop/chat/src/client/components/molecules/generic-block.tsx)).

The projectors the shipped bundles register: `openui` projects `openui.answered/v1` and `papercraft` projects `papercraft.cwd/v1`. `papercraft` also claims `artifacts.created/v1`, `artifacts.revised/v1`, `artifacts.applied/v1` and `artifacts.approved/v1`, and `threads` claims `threads.asked/v1` and `threads.answered/v1`, each with a projector that gives no block, so stored rows of those types draw nothing instead of a generic block. A bundle whose registration conflicts skips it, and the projection registered first stands ([`openui/src/client/index.ts`](../../../bundles/features/openui/src/client/index.ts), [`papercraft/src/client/index.ts`](../../../bundles/features/papercraft/src/client/index.ts), [`papercraft/src/client/old-artifacts.ts`](../../../bundles/features/papercraft/src/client/old-artifacts.ts), [`threads/src/client/index.ts`](../../../bundles/features/threads/src/client/index.ts), [`threads/src/client/old-asks.ts`](../../../bundles/features/threads/src/client/old-asks.ts)). Projection runs on the client only, over events already validated and stored; it runs no hook and no effect, so drawing a Thread again repeats nothing that happened when its events were appended.

### Drawing: from blocks to nodes

Each kind of turn is a Lexical node of `chat`: the user turn, the agent turn, the thinking turn, the tool turn, the activity group, the lifecycle row, the delegated turn and the others, named in [`chat/src/client/domain/conversation-nodes.ts`](../../../bundles/desktop/chat/src/client/domain/conversation-nodes.ts). A block of a projector is drawn by one `DecoratorNode`, `ChatBlockNode`, which hosts the element registered for the block's type, else `<chat-block>` ([`chat/src/client/components/organisms/conversation/nodes/chat-block-node.tsx`](../../../bundles/desktop/chat/src/client/components/organisms/conversation/nodes/chat-block-node.tsx), [`chat/src/client/hooks/use-external-blocks.ts`](../../../bundles/desktop/chat/src/client/hooks/use-external-blocks.ts)). A bundle never adds a node class for an ordinary block: it draws with a custom element, defined through `ui/v1` ([UI composition](ui-composition.md)).

Besides `registerProjector`, `chat.views/v1` has four registrations that draw and one read. Each registration refuses, with `invalid_input`, an element tag `ui/v1` has not defined, refuses a second registration of the same key with `registration_conflict` (the first one wins), returns a `Disposable`, and redraws the shown transcripts at once on registration and on dispose ([`views.ts`](../../../bundles/desktop/chat/src/client/services/views.ts)):

| Method                                                                         | Key        | What it draws                                                                                                      |
| ------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `registerRenderer({ blockType, elementTag })`                                  | Block type | Every block of that type; a block type with no renderer is drawn by `<chat-block>`                                 |
| `registerFenceRenderer({ tag, elementTag })`                                   | Fence tag  | Each fence of that tag in an agent turn, as one element per fence instead of a code block                          |
| `registerToolRenderer({ toolName, elementTag?, standalone?, openByDefault? })` | Tool name  | Every call of that tool; with no element, the chat's generic row draws it                                          |
| `registerInputRenderer({ source, elementTag })`                                | Source     | Every prompt of that input source                                                                                  |
| `watchFences({ projectId, threadId, tag }, listener)`                          | None       | Nothing: it gives a surface outside the conversation the Thread's fences of a tag, computed by the same projection |

The element receives a `view` property, set before it connects and set again, as a new object, whenever a field changes. An element that can be opened and closed reports the reader's choice with the bubbling event `chat-block-chosen` and may define `toggle()` for the conversation's toggle key ([`chat/src/contracts/index.ts`](../../../bundles/desktop/chat/src/contracts/index.ts)). Before a block is drawn, `chat` fires `chat.hooks/v2.onBeforeRenderBlockHook`, through which bundles add actions to it ([`chat/src/client/hooks/use-external-blocks.ts`](../../../bundles/desktop/chat/src/client/hooks/use-external-blocks.ts), [Hooks and the app's lifecycle](hooks.md)). Node classes and editor extensions that a bundle needs for a special editing behavior are registered through `chat.lexical/v1` (`registerNodes`, `registerExtension`) until the window's first conversation editor exists; after that a registration is refused as `frozen` ([`chat/src/client/services/lexical.ts`](../../../bundles/desktop/chat/src/client/services/lexical.ts)).

### Who draws a tool call

A tool call is drawn by `chat` unless a bundle registered the tool's name with `registerToolRenderer` ([`chat/src/client/domain/tool-drawing.ts`](../../../bundles/desktop/chat/src/client/domain/tool-drawing.ts)). Without a registration the call is the chat's generic row, inside the activity group, closed by default. A registration answers the three facts whole: the element (or the generic row when `elementTag` is absent), whether the call is a block of its own outside the activity group (`standalone`), and whether its block stays open until the reader closes it (`openByDefault`); it replaces every drawing fact the chat has for that name. The element's `view` is a `ChatToolView`: `projectId`, `threadId`, `promptId`, `key` (`<promptId>/<callId>`, stable for the call's life), `name`, `args` (one-line JSON), `result` once finished, `error` when failed, `status` (`running`, then `finished` or `failed`), `chosen` and `focused`.

The registrations of the shipped bundles, each made in the bundle's client part through `whenAvailable(ChatViewsV1, …)`, so that the bundle runs without `chat`:

| Tool           | Bundle     | Element             | `standalone` | `openByDefault` | Source                                                                                       |
| -------------- | ---------- | ------------------- | ------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `load_skill`   | `default`  | The skill-call card | Yes          | No              | [`default/src/client/index.ts`](../../../bundles/runtime/default/src/client/index.ts)        |
| `edit`         | `files`    | The edit card       | Yes          | Yes             | [`files/src/client/chat/views.ts`](../../../bundles/features/files/src/client/chat/views.ts) |
| `write`        | `files`    | The edit card       | Yes          | Yes             | [`files/src/client/chat/views.ts`](../../../bundles/features/files/src/client/chat/views.ts) |
| `view-image`   | `files`    | The generic row     | No           | Yes             | [`files/src/client/chat/views.ts`](../../../bundles/features/files/src/client/chat/views.ts) |
| `terminal`     | `terminal` | The terminal call   | No           | No              | [`terminal/src/client/index.ts`](../../../bundles/features/terminal/src/client/index.ts)     |
| `thread-spawn` | `threads`  | The spawn card      | Yes          | No              | [`threads/src/client/index.ts`](../../../bundles/features/threads/src/client/index.ts)       |

Every other tool, the tools of `git`, `web` and `mcp` among them, is drawn by the chat's generic row.

### Who draws a prompt

A prompt's block depends on its input source ([`chat/src/client/domain/tool-drawing.ts`](../../../bundles/desktop/chat/src/client/domain/tool-drawing.ts), [`chat/src/client/domain/drawn-turns.ts`](../../../bundles/desktop/chat/src/client/domain/drawn-turns.ts)):

- A prompt of the source `user` is always drawn by `chat`, as the reader's turn; `user` cannot be registered.
- A prompt of any other source is drawn by the element registered for its source key with `registerInputRenderer`: the source's kind, or `bundle:<bundle id>` for the kind `bundle` (a bare `bundle` and a bundle with no id cannot be registered). The element's `view` is a `ChatInputView`: `projectId`, `threadId`, `promptId`, `source`, `text` as the log holds it, `chosen` and `focused`. The shipped registration is `terminal`'s, for the source `terminal`, the result of a background terminal ([`terminal/src/client/index.ts`](../../../bundles/features/terminal/src/client/index.ts)).
- An input from another Thread, a delegated instruction or a child's result, with no input renderer for its source, is the block type `chat.delegated-input/v1`, which `threads` draws with its delegated-turn element through `registerRenderer`; without that registration `chat` draws it itself ([`threads/src/client/index.ts`](../../../bundles/features/threads/src/client/index.ts), [`chat/src/client/components/organisms/conversation/nodes/delegated-turn-node.tsx`](../../../bundles/desktop/chat/src/client/components/organisms/conversation/nodes/delegated-turn-node.tsx)). An input renderer takes precedence over this block renderer for the same prompt ([`insert-thread-turn-nodes.tsx`](../../../bundles/desktop/chat/src/client/components/organisms/conversation/plugins/insert-thread-turn-nodes.tsx)).
- Any other prompt is drawn by `chat` as a user turn with its text. A bundle's instruction wears the author line `<bundle id> · <reason>` beside the agent's mark; a prompt of the source `terminal` and another Thread's input wear no name ([`chat/src/client/domain/conversation-sync.ts`](../../../bundles/desktop/chat/src/client/domain/conversation-sync.ts)). In the input queue and a queued receipt, a prompt of the source `terminal` shows a terminal icon and any other source but `user` a bot icon ([`chat/src/client/components/molecules/prompt-author.tsx`](../../../bundles/desktop/chat/src/client/components/molecules/prompt-author.tsx)).

## Replacing the provider of `events/v1`

`events/v1` has no `doric.` prefix, so another bundle may provide it; a composition chooses it under `providers`, and the chosen provider becomes part of the foundation, which activates before the core. A foundation bundle that lists a contract under `requires` is quarantined with `foundation_requires`, except that a replacement of `events/v1`, `settings/v1` or `models/v1` may require `storage.backend/v1` and `secrets.backend/v1` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). The other rules of replacement are the ones [Hooks and the app's lifecycle](hooks.md#replacing-the-provider-of-hooksv1) states for `hooks/v1`. The `runtime` registers its sink and the other bundles their types with whichever provider is active.

A replacement does not take over `core.event-hooks/v1`: the core defines it when it activates, `hooks/v1.define` refuses a bundle that does not list the contract under `provides` with `not_owner`, and a second definer in the same generation with `registration_conflict` ([`core/src/shared/hooks.ts`](../../../bundles/foundation/core/src/shared/hooks.ts)). Without `onEventAppendedHook`, the runtime runs no `catchUp`: a row another bundle appends reaches the Thread document and the conversation only with the runtime's next commit on that Thread, in that commit's `sequence_conflict` retry ([`runtime/src/host/store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)). A replacement that keeps the Thread log intact reproduces the row of step 7 (the sink's scope keys in their order, then `type` and `event`), the redaction and storable text of step 6, and the stream-owner check of step 4.

## Related documents

- [Contracts](contracts.md): `defineEvent` and the rest of the `define*` family.
- [Manifest](manifest.md): `provides`, `requires` and `optional`, and the build's check that each registered event type is listed.
- [Boundaries](boundaries.md): the checks that hold a bundle to the contracts it lists.
- [Versioning](versioning.md): how an event type takes a minor or a major.
- [Storage](storage.md): `storage/v1`, streams, sequences and commits.
- [Contexts](contexts.md): the `call`, its `scope`, and the `caller` of each hop.
- [Hooks and the app's lifecycle](hooks.md): `core.event-hooks/v1`, `chat.hooks/v2` and how hooks run.
- [Process isolation](process-isolation.md): generations.
- [UI composition](ui-composition.md): custom elements defined through `ui/v1`.
- [Projects and Threads](../../features/projects-and-threads.md) and [The conversation](../../features/conversation.md): the Thread log and the transcript as features.
- READMEs of the bundles named here: [core](../../../bundles/foundation/core/README.md), [runtime](../../../bundles/runtime/runtime/README.md), [chat](../../../bundles/desktop/chat/README.md), [comments](../../../bundles/features/comments/README.md), [openui](../../../bundles/features/openui/README.md), [papercraft](../../../bundles/features/papercraft/README.md), [threads](../../../bundles/features/threads/README.md), [files](../../../bundles/features/files/README.md), [terminal](../../../bundles/features/terminal/README.md), [default](../../../bundles/runtime/default/README.md).
