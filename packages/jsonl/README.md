# jsonl

Append and read [JSON Lines](https://jsonlines.org/) files with streams. Appends
are queued so records land in call order, and reads stream the file line by
line, so large logs never need to fit in memory. Use it for event logs, traces,
or any append-only record of JSON values.

Part of [Doric](../../README.md).

## Highlights

- **Ordered appends.** Concurrent `append` calls are written in call order; a
  failed write does not block the ones queued after it.
- **Streaming reads.** `read()` is an async iterable that parses one line at a
  time.
- **Precise parse errors.** A bad line throws `JsonlParseError` with the file
  path, line number, and line text.
- **No dependencies.** Built on `node:fs` and `node:readline`.

## Usage

```ts
import { jsonl } from 'jsonl';

const file = jsonl('path/to/events.jsonl');

await file.append({ type: 'started' });
await file.append({ type: 'finished', ok: true });
await file.close();

for await (const record of file.read()) {
  console.log(record);
}
```

## API

`jsonl(path)` returns a `JsonlFile` handle:

| Member          | Behavior                                                         |
| --------------- | ---------------------------------------------------------------- |
| `path`          | The file path the handle was created with.                       |
| `append(value)` | Serializes one JSON value followed by a newline, in append mode. |
| `read()`        | Streams the file line by line and yields parsed values.          |
| `close()`       | Waits for pending appends, then closes the append stream.        |

- The append stream opens lazily on the first `append` and reopens after
  `close()` or a write error.
- `append` throws a `TypeError` for a value `JSON.stringify` cannot serialize.
- Every line must hold one JSON value; an empty or malformed line, or one that
  parses to a non-finite number, throws `JsonlParseError`.
- Values are typed as `JsonlValue`: JSON primitives, arrays, and objects.

## Development

```console
npx nx build jsonl
npx nx typecheck jsonl
npx nx test jsonl
```
