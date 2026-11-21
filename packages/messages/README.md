# messages

An in-memory conversation history that is always ready to send to a model provider. It stores `ProviderMessage` entries from [`llms`](../llms/README.md), turns a completed provider result (`ProviderFinished`) into a replayable assistant message, and hands out array snapshots that callers cannot change by accident ([`messages.ts`](src/lib/messages.ts)).

Part of [Doric](../../README.md). Feature docs: [Context compaction](../../docs/features/context-compaction.md), [Default agent](../../docs/features/default-agent.md).

## Who uses it

- **Packages.** [`agent`](../agent/README.md) takes a `MessageStorage` as `AgentOptions.messages`: it pushes user messages, tool results (`role: 'tool'`, `toolCallId`, and `toolResultStatus` when a result is incomplete) and the assistant message it builds itself from each provider result, and reads `list()`, after the system prompt, to build each provider request ([`types/agent.ts`](../agent/src/lib/types/agent.ts), [`agent.ts`](../agent/src/lib/agent.ts)).
- **Bundles.** The [`default` runtime bundle](../../bundles/runtime/default/README.md) creates a storage per run from the stored history ([`executor.ts`](../../bundles/runtime/default/src/host/executor.ts)) and rewrites it with `replaceRange` when it compacts the history ([`compact.ts`](../../bundles/runtime/default/src/host/compact.ts)).
- **Apps.** None import it directly.

## Entry points

The package is named `messages`, is private and is an ES module ([`package.json`](package.json)). It has one entry point, `.`:

| Condition     | File                                              |
| ------------- | ------------------------------------------------- |
| `@org/source` | [`src/index.ts`](src/index.ts) (workspace source) |
| `types`       | `dist/index.d.ts`                                 |
| `import`      | `dist/index.js`                                   |
| `default`     | `dist/index.js`                                   |

`./package.json` is exported as well. [`src/index.ts`](src/index.ts) re-exports everything from [`src/lib/messages.ts`](src/lib/messages.ts). The package depends on `llms` (types only) and `tslib`.

## Public exports

All exports are in [`messages.ts`](src/lib/messages.ts).

```ts
import type { ProviderFinished, ProviderMessage } from 'llms';

type MessageStorageEntry = ProviderMessage | ProviderFinished;

interface MessageStorage {
  list(): readonly ProviderMessage[];
  push(entry: MessageStorageEntry): number;
  replaceRange(
    start: number,
    end: number,
    entries: readonly ProviderMessage[],
  ): void;
}

function createMessageStorage(
  initial?: readonly ProviderMessage[], // default: []
): MessageStorage;
```

| Export                           | Kind      | Purpose                                                                |
| -------------------------------- | --------- | ---------------------------------------------------------------------- |
| `MessageStorageEntry`            | type      | What `push` accepts: a provider message or a finished provider result. |
| `MessageStorage`                 | interface | The storage contract that `agent` and the runtime bundle depend on.    |
| `createMessageStorage(initial?)` | function  | Creates an in-memory `MessageStorage`.                                 |

`MessageStorage` is an interface, so a caller may pass any object with these three members wherever a `MessageStorage` is expected; `createMessageStorage` is the implementation this package ships.

## Behavior

The storage keeps one private array of `ProviderMessage` ([`messages.ts`](src/lib/messages.ts)).

### `createMessageStorage(initial = [])`

Copies `initial` into a new array. Adding to or removing from the caller's array afterwards does not change the storage. The copy is shallow: the message objects themselves are shared.

### `list()`

Returns a new array holding the stored messages in order. Changing the returned array does not change the storage, and each call returns a different array. The messages are the stored objects, not copies. The result can be passed as `ProviderRequest.messages` unchanged.

### `push(entry)`

Appends one message and returns the new number of stored messages.

- An entry is treated as a finished provider result when it has a `finishReason` property; otherwise it is stored as given, as a `ProviderMessage`.
- A finished result is stored as an assistant message:

  | Field       | Value                                                                                                                      |
  | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
  | `role`      | `'assistant'`                                                                                                              |
  | `content`   | `text` when it is non-empty; otherwise `refusal` when it is not `undefined` or `null`; otherwise `text` (the empty string) |
  | `toolCalls` | The result's `toolCalls`, only when the array is non-empty; the field is absent otherwise                                  |
  | `replay`    | The result's opaque `replay` items, whenever the result's `replay` is not `undefined` (an empty array is kept too)         |

  Every other field of the result — `finishReason`, `usage`, `reasoning`, `structured`, and `refusal` when `text` is non-empty — is not stored. The `llms` adapters send back the stored `replay` items their provider produced when they build the next request ([`llms`](../llms/README.md#replay)).

### `replaceRange(start, end, entries)`

For `0 ≤ start ≤ end`, replaces the messages at indexes `start` up to, but not including, `end` with `entries`, in place; other indexes follow the rule below. The next `list()` returns the rewritten history, so the next provider request carries the replacement. The runtime bundle uses it to apply a compaction between provider turns, replacing the whole stored history with the compacted one ([`compact.ts`](../../bundles/runtime/default/src/host/compact.ts)).

It calls `splice(start, end - start, ...entries)` on the stored array ([`messages.ts`](src/lib/messages.ts)). `start` follows `splice`: a negative `start` counts from the end and is clamped to 0, and a `start` past the end is clamped to the length. The number of messages removed is `end - start`, computed from the arguments as given, so a negative `end` does not count from the end. A count of zero or less removes nothing and inserts `entries` at `start`. A count past the end removes every message from `start` on. On `a b c d e`, `replaceRange(1, -1, [X])` gives `a X b c d e` and `replaceRange(-2, 2, [X])` gives `a b c X`.

### Example

```ts
import { createMessageStorage } from 'messages';
import type { ProviderFinished, ProviderRequest } from 'llms';

const messages = createMessageStorage([
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'Call the lookup tool.' },
]);

const finished: ProviderFinished = {
  text: 'I will call the lookup tool.',
  finishReason: 'tool_calls',
  toolCalls: [
    { id: 'call_1', name: 'lookup', arguments: '{"query":"doric"}', index: 0 },
  ],
};

messages.push(finished); // 3
messages.push({ role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' }); // 4

// Keep the system prompt, condense the rest into one message.
messages.replaceRange(1, 4, [
  { role: 'user', content: 'Summary: lookup ran.' },
]);

const request: ProviderRequest = {
  model: 'example-model',
  messages: messages.list(),
};
```

## Data, side effects and limits

- **Persistence.** None: the history lives only in memory, for the lifetime of the storage object. A caller that needs it later stores the result of `list()` itself.
- **Side effects.** None: no processes, network, files, timers or events.
- **Validation and errors.** The storage validates nothing and throws no error of its own. It does not check message roles, the pairing of tool calls with tool results, or the indexes given to `replaceRange`. An entry that has `finishReason` but lacks `text` or `toolCalls`, or an entry that is not an object, throws `TypeError` from the property access ([`messages.ts`](src/lib/messages.ts)).
- **Limits.** No limit of its own on the number or size of messages. `replaceRange` passes `entries` as `splice` arguments, so an `entries` array past the JavaScript engine's argument limit (about 10⁵ items in V8) throws `RangeError`.
- **Concurrency.** Synchronous; every call takes effect before it returns.

## Build and test

| Nx target   | What it runs                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`     | `tsc --build tsconfig.lib.json`, emitting `dist/` ([`tsconfig.lib.json`](tsconfig.lib.json))                                                                                                |
| `typecheck` | `tsc --build tsconfig.json --emitDeclarationOnly`                                                                                                                                           |
| `test`      | After building its dependencies, compiles [`tests/`](tests/messages.test.ts) with `tsconfig.spec.json` into `dist-tests/` and runs them with `node --test` ([`project.json`](project.json)) |

`project.json` declares only `test`. The `@nx/js/typescript` plugin infers `build` (after `^build`) and `typecheck` (after `build` and `^typecheck`), and adds `build-deps` and `watch-deps` ([`nx.json`](../../nx.json)).

```console
npx nx build messages
npx nx typecheck messages
npx nx test messages
```
