# messages

A small in-memory conversation history that is always ready to send to a model
provider. It stores `ProviderMessage` entries from `llms`, turns completed
provider results into replayable assistant messages, and hands out snapshots
that callers cannot mutate by accident. Use it as the message storage an
`agent` reads and writes, or on its own when you assemble provider requests by
hand.

Part of [Doric](../../README.md).

## Highlights

- **Provider-ready.** `list()` returns messages you can pass straight to a
  `ProviderRequest`.
- **Normalizes provider turns.** Push a `ProviderFinished` result and it is
  stored as an assistant message with its tool calls and opaque replay items.
- **Snapshot isolation.** The initial array is copied and every `list()` call
  returns a new array.
- **History rewrites.** `replaceRange` swaps a span of messages in place, for
  example to compact history between provider turns.

## Usage

```ts
import { createMessageStorage } from 'messages';
import type { ProviderMessage, ProviderRequest } from 'llms';

const initial: readonly ProviderMessage[] = [
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'Summarize the current task.' },
];

const messages = createMessageStorage(initial);

messages.push({
  role: 'assistant',
  content: 'We need to update the README examples.',
});

const request: ProviderRequest = {
  model: 'example-model',
  messages: messages.list(),
};
```

## API

| Member                               | Behavior                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `createMessageStorage(initial?)`     | Creates storage, copying the optional initial messages.                  |
| `list()`                             | Returns a new array snapshot of the stored messages.                     |
| `push(entry)`                        | Stores a `ProviderMessage` or `ProviderFinished`; returns the new count. |
| `replaceRange(start, end, messages)` | Replaces `messages[start..end)` with the given messages in place.        |

`createMessageStorage` copies the initial array, and `list()` returns a new
array snapshot. Mutating the caller-owned initial array or a previous list
snapshot does not change stored history.

## Appending user and tool messages

```ts
import { createMessageStorage } from 'messages';

const messages = createMessageStorage();

messages.push({
  role: 'user',
  content: 'Look up the project status.',
});

messages.push({
  role: 'tool',
  toolCallId: 'call_1',
  content: '{"status":"ready"}',
});

const count = messages.push({
  role: 'assistant',
  content: 'The project is ready.',
});

console.log(count); // 3
console.log(messages.list());
```

`push()` returns the new message count after storing the entry.

## Normalizing provider results

Provider completion results can be pushed directly. The storage converts them
into replayable assistant messages and keeps tool calls when present.

```ts
import { createMessageStorage } from 'messages';
import type { ProviderFinished } from 'llms';

const messages = createMessageStorage([
  { role: 'user', content: 'Call the lookup tool.' },
]);

const finished: ProviderFinished = {
  text: 'I will call the lookup tool.',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"doric"}',
      index: 0,
    },
  ],
};

messages.push(finished);

console.log(messages.list());
// [
//   { role: 'user', content: 'Call the lookup tool.' },
//   {
//     role: 'assistant',
//     content: 'I will call the lookup tool.',
//     toolCalls: finished.toolCalls,
//   },
// ]
```

- Opaque `replay` items on the result are kept on the assistant message, so
  the provider can replay the turn exactly.
- Usage and reasoning metadata are intentionally not stored in replayable
  messages.
- If a provider returns empty text with a refusal, the refusal text becomes
  assistant content.

## Development

```console
npx nx build messages
npx nx typecheck messages
npx nx test messages
```
