# jsonl

Append and read [JSON Lines](https://jsonlines.org/) files with Node streams.
Appends from one handle are queued, so records land in the file in call order;
reads stream the file line by line, so a large log never has to fit in memory.
It suits event logs, traces and any append-only record of JSON values.

The package is a Node library with no dependency beyond `node:fs`,
`node:readline` and `tslib`. No bundle, application or other package imports it;
any Node code in the workspace can.

Part of [Doric](../../README.md).

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

## Entry point

[`package.json`](package.json) names the package `jsonl` (private, ES module)
and has two `exports` entries: `./package.json`, which exposes the manifest,
and `.`. Under the `@org/source` condition (listed in `customConditions` of
[`tsconfig.base.json`](../../tsconfig.base.json)) `.` resolves to
[`src/index.ts`](src/index.ts), so workspace code compiles against the source;
otherwise (`types`, `import`, `default`) to the built `dist/index.d.ts` and
`dist/index.js`, which the top-level `main`, `module` and `types` fields also
name. The entry point re-exports everything [`src/lib/jsonl.ts`](src/lib/jsonl.ts) exports.

## Exports

| Export            | Kind      | Signature                                                                             | Defined in                                                         |
| ----------------- | --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `jsonl`           | function  | `jsonl(path: string): JsonlFile`                                                      | [`src/lib/jsonl.ts`](src/lib/jsonl.ts)                             |
| `JsonlFile`       | interface | `{ readonly path: string; append; read; close }` (see below)                          | [`src/lib/types/jsonl.ts`](src/lib/types/jsonl.ts)                 |
| `JsonlValue`      | type      | `JsonlPrimitive \| JsonlArray \| JsonlObject`                                         | [`src/lib/types/jsonl.ts`](src/lib/types/jsonl.ts)                 |
| `JsonlPrimitive`  | type      | `string \| number \| boolean \| null`                                                 | [`src/lib/types/jsonl.ts`](src/lib/types/jsonl.ts)                 |
| `JsonlArray`      | type      | `readonly JsonlValue[]`                                                               | [`src/lib/types/jsonl.ts`](src/lib/types/jsonl.ts)                 |
| `JsonlObject`     | interface | `{ readonly [key: string]: JsonlValue }`                                              | [`src/lib/types/jsonl.ts`](src/lib/types/jsonl.ts)                 |
| `JsonlParseError` | class     | `new JsonlParseError(path: string, lineNumber: number, line: string, cause: unknown)` | [`src/lib/classes/parse-error.ts`](src/lib/classes/parse-error.ts) |

The types are exported with `export type` and do not exist at runtime.

`JsonlFile` has these members ([`src/lib/types/jsonl.ts`](src/lib/types/jsonl.ts)):

| Member                                     | Behavior                                                    |
| ------------------------------------------ | ----------------------------------------------------------- |
| `readonly path: string`                    | The path the handle was created with, unchanged.            |
| `append(value: JsonlValue): Promise<void>` | Writes one value as one line, after every earlier `append`. |
| `read(): AsyncIterable<JsonlValue>`        | Streams the file and yields one parsed value per line.      |
| `close(): Promise<void>`                   | Waits for queued appends, then ends the append stream.      |

## Behavior

### Creating a handle

`jsonl(path)` opens nothing: it returns a handle that holds the path, a queue of
pending appends and, once the first `append` runs, one write stream
([`src/lib/jsonl.ts`](src/lib/jsonl.ts)). The path is passed to `node:fs` as
given, so a relative path resolves against the process's working directory.
Each call returns an independent handle; two handles on the same file have
separate queues and streams, and nothing orders their writes or locks the file
between them or between processes.

### Appending

`append(value)` serializes the value with `JSON.stringify` and adds a `\n`
([`src/lib/utils/line.ts`](src/lib/utils/line.ts)). Serialization happens at
the call, before queueing, so a value that cannot be serialized makes `append`
throw synchronously instead of returning a rejected promise:

- a value for which `JSON.stringify` returns `undefined` throws
  `TypeError('JSONL values must be JSON serializable.')`;
- a value `JSON.stringify` itself refuses (a cycle, a `BigInt`) throws the
  `TypeError` `JSON.stringify` raises.

`JSON.stringify` rules apply otherwise: a non-finite number is written as
`null`, and an object property whose value is `undefined` is left out.

The line then joins the handle's queue: it is written after the write of the
previous `append` settles, whether that write succeeded or failed, so a failed
write never blocks the ones queued after it ([`src/lib/jsonl.ts`](src/lib/jsonl.ts)).
Each line is one `write` call on the stream, and the returned promise resolves
when that write completes, or rejects with the stream's error.

The write stream opens lazily, on the first write, with `createWriteStream(path,
{ encoding: 'utf8', flags: 'a' })`: the file is created when missing and always
appended to. A missing parent directory is not created: the write rejects with
the `node:fs` error (`ENOENT`), and the write stream also emits that error as an
`'error'` event with no listener, which Node raises as an uncaught exception.
The stream has an `'error'` listener only while a write or `close()` is in
progress ([`src/lib/jsonl.ts`](src/lib/jsonl.ts)). After a write error the handle drops the
stream, and the next `append` opens a new one. After `close()`, the next
`append` also opens a new stream.

### Reading

Each call to `read()` returns a new async generator, which can be iterated
once ([`src/lib/jsonl.ts`](src/lib/jsonl.ts)). Each generator opens its own
read stream (`utf8`) when iteration starts and splits it with `node:readline` (`crlfDelay: Infinity`, so
`\r\n` counts as one line break). A trailing newline at the end of the file
yields no extra line. Reading is independent of the handle's append queue: it
sees what has been written to the file when the stream reads it, and does not
wait for pending appends.

Each line is parsed with `JSON.parse` and checked to be a `JsonlValue`: `null`,
a string, a boolean, a finite number, or an array or object whose members are
all such values ([`src/lib/utils/line.ts`](src/lib/utils/line.ts),
[`src/lib/utils/value.ts`](src/lib/utils/value.ts)). A line that fails either
step ends the iteration by throwing a `JsonlParseError`; this includes an empty
or whitespace-only line and a number that parses to infinity (such as `1e999`).
Values before the bad line have already been yielded.

When iteration ends — at the last line, on an error, or when the caller stops
early with `break` or `return` — the readline interface is closed and the read
stream destroyed. A file that cannot be opened (for example `ENOENT`) makes the
iteration reject with the `node:fs` error, not a `JsonlParseError`.

### Closing

`close()` waits for the queue as it stands when `close()` is called, then ends
the write stream and resolves on its `finish` event, or rejects on its `error`
event ([`src/lib/jsonl.ts`](src/lib/jsonl.ts)). If the last queued `append`
failed, `close()` rejects with that append's error, and so does every later
`close()` until another `append` is queued. Otherwise, with no open stream
(nothing appended since the handle was created or last closed), it resolves
once the queue settles.
Until `close()` runs, the handle keeps the file descriptor open.

## Errors

| Error             | Raised by                 | When                                                                                                                                                                                                                         |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TypeError`       | `append`, synchronously   | The value cannot be serialized as JSON.                                                                                                                                                                                      |
| `node:fs` errors  | `append`, `close`, `read` | The file or its directory cannot be opened, written or read ([`src/lib/jsonl.ts`](src/lib/jsonl.ts)); when the parent directory is missing, the error is also raised as an uncaught exception (see [Appending](#appending)). |
| `JsonlParseError` | iteration of `read()`     | A line is not exactly one JSON value.                                                                                                                                                                                        |

`JsonlParseError` extends `SyntaxError`
([`src/lib/classes/parse-error.ts`](src/lib/classes/parse-error.ts)):

- `name` is `'JsonlParseError'`;
- `message` is `` `Invalid JSONL at ${path}:${lineNumber}` ``;
- `readonly path: string` is the handle's path, `readonly lineNumber: number`
  the 1-based line number, `readonly line: string` the line text without its
  line break;
- `cause` is the `SyntaxError` from `JSON.parse`, or
  `TypeError('Parsed line is not a JSON value.')` when the line parses to a value
  that is not a `JsonlValue`.

It sets its prototype to the constructing class, so `instanceof JsonlParseError`
holds for it and for subclasses.

## Configuration and limits

There are no options or environment variables. Encoding is always UTF-8 and the
write mode always append. Ordering holds only among the appends of one handle
([`src/lib/jsonl.ts`](src/lib/jsonl.ts)). A line is held in memory whole while
it is parsed, so on the read side the limit is the size of the largest line, not
of the file. On the append side, each serialized line stays in memory until it
is written, and the queue has no bound, so appends that are not awaited hold all
their pending lines in memory ([`src/lib/jsonl.ts`](src/lib/jsonl.ts)).

## Build and test

| Target      | What it does                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`     | Compiles `src/` with [`tsconfig.lib.json`](tsconfig.lib.json) into `dist/` (inferred by `@nx/js/typescript` in [`nx.json`](../../nx.json))                |
| `typecheck` | Type-checks the project (inferred by `@nx/js/typescript`)                                                                                                 |
| `test`      | Compiles `src/` and `tests/` with [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/`, then runs `node --test` ([`project.json`](project.json)) |

```console
npx nx build jsonl
npx nx typecheck jsonl
npx nx test jsonl
```

The tests are in [`tests/jsonl.test.ts`](tests/jsonl.test.ts): one line per
append, call order under concurrent appends, streamed reads, and the line
context of `JsonlParseError`.
