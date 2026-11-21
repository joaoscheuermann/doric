# tool-okf

`tool-okf` lets an agent look things up in a project's knowledge base before
reading source files. It provides `okf_search`, a provider-neutral, read-only
agent tool that searches Open Knowledge Format (OKF) bundles stored at
`<workspace>/.agents/bundles`, such as the project bundle the
[`okf`](../../packages/okf/README.md) package generates. Results come back
ranked, bounded and deterministic ([`okf.ts`](src/lib/okf.ts)), so the agent
gets the most relevant concepts without flooding its context.

The package exports the tool definition only. No bundle or application in this
repository imports `tool-okf` or registers `okf_search`; a caller that wants the
tool registers the definition itself.

Part of [Doric](../../README.md).

## Highlights

- **Read-only by construction.** No writes, no network access, no symbolic
  link followed inside the bundle root, and no path read that does not start
  with the bundle root ([`okf.ts`](src/lib/okf.ts)).
- **Deterministic ranking.** Lexical relevance over concept metadata and
  content, with a stable tie-break ([`okf.ts`](src/lib/okf.ts)).
- **Bounded output.** Limits on query terms, concepts listed, searchable
  characters, content per result and total output size
  ([`okf.ts`](src/lib/okf.ts)).
- **Runs in the workspace's sandbox.** Reads only through the injected
  [`sandbox`](../../packages/sandbox/README.md) session, which must provide a
  POSIX `sh` and `find` ([`okf.ts`](src/lib/okf.ts)).

## Usage

`createTool` returns a [`tool`](../../packages/tool/README.md) definition over
the sandbox that contains the workspace. Register it with `tools/v1` (see
[`tool`](../../packages/tool/README.md)), or bind it and take its agent-loop
tool directly:

```ts
import { createTool } from 'tool-okf';

// sandbox: a Sandbox holding /workspace; services and call are ignored by the handler
const search = createTool({ workspaceRoot: '/workspace', sandbox })
  .bind(services)
  .toTool(call);
const result = await search.execute({
  query: 'session persistence',
  bundle: 'project',
  limit: 5,
});

for (const concept of result.results) {
  console.log(concept.path, concept.description);
}
```

`toTool(call).execute` does not validate its input; only a call run through
the tool storage of [`tool`](../../packages/tool/README.md#tool-storage)
(`createToolStorage`) is checked against `input` first. On the direct path,
unknown fields are ignored, a numeric `limit` is clamped to 1–50 (a
fractional one admits the next whole number of results), and a non-numeric one
leaves only the 50 KiB bound ([`okf.ts`](src/lib/okf.ts)). A `query` or `bundle` that is not a string
throws a `TypeError`. The output is validated against `output` on both paths
([`tools.ts`](../../packages/tool/src/lib/tools.ts)).

## API

The package entry point is [`src/index.ts`](src/index.ts); everything it exports
is defined in [`okf.ts`](src/lib/okf.ts) and
[`types/okf.ts`](src/lib/types/okf.ts). There is no command-line interface.

| Export                               | Purpose                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `createTool(options)`                | Returns the `okf_search` tool definition, built with `defineTool` from `tool`.                                           |
| `input`, `output`                    | The tool's strict Zod input and output schemas.                                                                          |
| `OkfToolOptions`                     | `{ workspaceRoot: string; sandbox: Sandbox }`: the workspace path as the sandbox sees it, and the sandbox that holds it. |
| `OkfSearchOutput`, `OkfSearchResult` | The output type and the type of one result.                                                                              |

The definition has the name `okf_search`, no settings fields, the default
`strict: true` of `defineTool`, and this description
([`okf.ts`](src/lib/okf.ts)):

> Search Open Knowledge Format concepts under .agents/bundles. Returns bounded,
> deterministically ranked concept metadata and Markdown content without
> reading outside the bundle root.

The handler uses only the options given to `createTool`; it ignores the prompt
`Call` and the bound services.

### Input

The input object is strict: in tool storage, an unknown field fails validation
([`okf.ts`](src/lib/okf.ts)). Lengths count UTF-16 code units.

| Field    | Type    | Rule                                                                                         |
| -------- | ------- | -------------------------------------------------------------------------------------------- |
| `query`  | string  | Required; trimmed, 1 to 500 characters.                                                      |
| `bundle` | string  | Optional; trimmed, 1 to 255 characters. Without it, every bundle under the root is searched. |
| `limit`  | integer | Optional; 1 to 50. 10 when omitted.                                                          |

### Output

| Field       | Type                | Meaning                                                                     |
| ----------- | ------------------- | --------------------------------------------------------------------------- |
| `results`   | `OkfSearchResult[]` | The returned concepts, best first.                                          |
| `total`     | number              | How many concepts matched the query, returned or not.                       |
| `truncated` | boolean             | `true` when fewer results are returned than matched.                        |
| `skipped`   | number              | How many listed concept files could not be read or parsed.                  |
| `error`     | string, optional    | Why the search could not run; then `results` is empty and the counts are 0. |

Each `OkfSearchResult` has these fields; an optional field is absent, never
empty ([`okf.ts`](src/lib/okf.ts)):

| Field              | Type             | Source                                                                       |
| ------------------ | ---------------- | ---------------------------------------------------------------------------- |
| `bundle`           | string           | The first directory below `.agents/bundles`.                                 |
| `conceptId`        | string           | The path below the bundle directory, without `.md` (`api/users`).            |
| `path`             | string           | The path below `.agents/bundles` (`project/api/users.md`).                   |
| `type`             | string           | The front matter's `type`.                                                   |
| `title`            | string           | The front matter's `title`; else the last segment of `conceptId`.            |
| `description`      | string, optional | The front matter's `description`.                                            |
| `resource`         | string, optional | The front matter's `resource`.                                               |
| `tags`             | string[]         | The front matter's `tags`; empty when absent.                                |
| `timestamp`        | string, optional | The front matter's `timestamp`.                                              |
| `content`          | string           | The Markdown body after the front matter, trimmed, at most 4,000 characters. |
| `contentTruncated` | boolean          | `true` when the body is longer than the returned `content`.                  |
| `score`            | number           | The lexical relevance score (see [Ranking](#ranking)).                       |

## Bundle data

The tool reads the layout below and writes nothing
([`okf.ts`](src/lib/okf.ts)):

```text
<workspaceRoot>/.agents/bundles/
  <bundle>/            one directory per bundle, for example `project`
    index.md           reserved, never a concept
    log.md             reserved, never a concept
    <dir>/<name>.md    one concept per Markdown file, at any depth
```

- A concept is a regular file whose name ends in `.md`, at least one directory
  below `.agents/bundles`, and whose name is neither `index.md` nor `log.md` at
  any depth. A Markdown file directly in `.agents/bundles` is ignored.
- A concept file starts with a YAML front matter block: a line `---`, the YAML,
  and a closing line `---` (trailing spaces or tabs allowed on both lines). The
  YAML is parsed with `parse` of the [`yaml`](https://eemeli.org/yaml/) package
  (YAML 1.2, core schema), at most 50 aliases, and must be a mapping (an
  object that is not an array); an unquoted date or `yes` stays a string. A
  duplicate key makes the YAML invalid.
- The front matter must have a non-empty string `type`; any type value is
  accepted. `title`, `description`, `resource` and `timestamp` are kept when
  they are non-empty strings after trimming, and ignored otherwise. `tags` is
  kept when it is a list; each string item is trimmed, and non-string and
  empty items are dropped. Other keys are ignored.
- A listed file that cannot be read, has no front matter block, has invalid or
  non-mapping YAML, or has no `type` is skipped and counted in `skipped`;
  ignored and reserved files are not counted.

## Behavior

One call runs these steps in order ([`okf.ts`](src/lib/okf.ts)):

1. **Query.** The trimmed query is normalized with Unicode NFKC and lowercased
   (`en-US`); if the result is empty or longer than 500 characters (UTF-16 code
   units, as every character count in this README), the search
   stops with an error. The terms are the runs of letters and digits that may
   contain `_`, `.`, `:`, `/` or `-` inside them, deduplicated in order, and the
   first 32 are kept. A query with no term stops with an error.
2. **Target.** The bundle root is `<workspaceRoot>/.agents/bundles`. Without
   `bundle`, the target is the root. With it, the trimmed name must not be `.`
   or `..`, contain `/` or `\`, or be absolute, and the joined path must stay
   inside the root; otherwise the search stops with an error and reads nothing.
3. **Existence.**
   `sh -c 'if [ -d "$1" ]; then printf directory; elif [ -f "$1" ]; then printf file; elif [ -e "$1" ]; then printf other; else printf missing; fi' sh <target>`
   runs through `sandbox.exec` with the workspace root as working directory.
   The test follows symbolic links, so a target that is a link to a directory
   passes and then yields no concepts, because `find` does not descend into a
   link given as its start path. Any output other than `directory`, `file` or
   `other`, including that of a failed command, counts as missing. Anything but
   a directory stops the search with an error.
4. **Listing.** `find <target> -type f -name '*.md' -print` runs through
   `sandbox.exec` with the workspace root as working directory. `find` does not
   follow symbolic links, and `-type f` leaves out links to files, so no file
   reached through a link inside the target is read; a link among the parents
   of `.agents/bundles` is resolved by the sandbox like any path. A non-zero exit stops the search with an
   error carrying `find`'s stderr. The printed paths are normalized,
   deduplicated, filtered to concepts (see [Bundle data](#bundle-data)) and
   sorted. More than 10,000 concepts stop the search with an error.
5. **Loading.** Every concept is read with `sandbox.readFile`, all at once, and
   parsed. Of each body, the first 200,000 characters are kept for searching.
6. **Ranking.** Each concept is scored; concepts scoring 0 are dropped, and the
   rest are sorted (see [Ranking](#ranking)).
7. **Collecting.** Results are taken best first until `limit` results are taken
   or adding the UTF-8 size of the next result, serialized as JSON on its own,
   would bring the running total past 50 KiB; the first result that does not
   fit ends the collection.

### Ranking

The searched metadata fields and their weights are: `title` 8, the tags joined
by spaces 7, `description` 5, `type` 4, and `conceptId` with `resource` 3. Each
field and the searchable body are normalized as the query is
([`okf.ts`](src/lib/okf.ts)).

- **Terms.** Each query term adds the weight of the first metadata field, in
  the order above, that contains it as a substring; if no metadata field does,
  it adds 1 when the body contains it, else 0.
- **Phrase.** The whole normalized query adds 10 when any metadata field
  contains it, else 2 when the body contains it, else 0.
- **Order.** Higher score first; ties go to the lower `bundle`, then the lower
  `conceptId`, both compared by UTF-16 code units, so the same files and query
  always give the same order.

## Configuration

The tool reads no environment variable and no setting. Its only configuration
is `OkfToolOptions`: `workspaceRoot`, the workspace path as the sandbox sees it,
and `sandbox`, the session it runs `exec` and `readFile` on
([`types/okf.ts`](src/lib/types/okf.ts)). The bundle root and every limit are
constants of [`okf.ts`](src/lib/okf.ts).

## Limits

| Limit                          | Value              | When exceeded                                                                                                                                                                                               |
| ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query length                   | 500 characters     | Input validation fails in tool storage, or the normalized query is an error.                                                                                                                                |
| Query terms                    | 32                 | Later terms are ignored.                                                                                                                                                                                    |
| Results per call               | 50; 10 by default  | Input validation fails in tool storage; a direct `execute` clamps a numeric `limit` to 1–50 (a fractional one admits the next whole number of results), and a non-numeric one leaves only the 50 KiB bound. |
| Concepts listed per call       | 10,000             | Error; select a `bundle`.                                                                                                                                                                                   |
| Searchable body per concept    | 200,000 characters | The rest of the body is not searched; `contentTruncated` is `true`.                                                                                                                                         |
| Content per result             | 4,000 characters   | `content` is cut; `contentTruncated` is `true`.                                                                                                                                                             |
| Sum of serialized result sizes | 50 KiB (UTF-8)     | Collection stops; `truncated` is `true`.                                                                                                                                                                    |
| YAML aliases per front matter  | 50                 | The concept is skipped.                                                                                                                                                                                     |

The tool sets no timeout on `exec` or `readFile`, and reads all listed concepts
concurrently ([`okf.ts`](src/lib/okf.ts)).

## Errors

A search that cannot run returns, rather than throws, an output with empty
`results`, `total` 0, `truncated` `false`, `skipped` 0 and one of these
`error` messages ([`okf.ts`](src/lib/okf.ts)):

| `error`                                               | Cause                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `Query must contain between 1 and 500 characters.`    | The normalized query is empty or too long.                            |
| `Query must contain searchable letters or numbers.`   | The query has no term.                                                |
| `Invalid bundle name: <bundle>`                       | The bundle name is a path, `.`, `..`, or leaves the root.             |
| `OKF bundle not found: <bundle>`                      | The named bundle is not a directory, or the path test failed.         |
| `OKF bundle root not found: .agents/bundles`          | The root does not exist, or the path test failed (no `bundle` given). |
| `OKF bundle root is not a directory: .agents/bundles` | The root exists but is not a directory (no `bundle` given).           |
| `Unable to list OKF concepts: <stderr>`               | `find` exited with a non-zero code.                                   |
| `OKF search exceeds 10000 concepts; select a bundle.` | The target holds more than 10,000 concepts.                           |

A concept that cannot be read or parsed is skipped, not an error. Failures
outside the handler come from [`tool`](../../packages/tool/README.md): when the
call runs through the tool storage, input that fails the schema throws `ToolErrorObject` with code `invalid_payload`
before the handler runs. A rejected `sandbox.exec` makes the call throw: the
rejection is thrown as is on the direct path, and tool storage wraps it in a
`ToolErrorObject` with code `handler_failed`.

## Development

The `build` and `typecheck` targets are inferred by `@nx/js/typescript` from
[`tsconfig.lib.json`](tsconfig.lib.json); `build` writes `dist/`. The `test` target in
[`project.json`](project.json) compiles the sources and tests with
[`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/` and runs them with
`node --test`.

```console
npx nx run tool-okf:build
npx nx run tool-okf:typecheck
npx nx run tool-okf:test
```

The tests in [`okf.test.ts`](tests/okf.test.ts) write bundles into a temporary
directory and run the tool through
[`fake-sandbox.ts`](tests/fake-sandbox.ts), which maps the workspace root onto
that directory, implements the path test, `find` and `readFile`, and records
every file read.
They cover ranking, permissive YAML parsing and title derivation, skipping of
reserved and malformed files, rejection of bundle traversal, a symbolic link to a concept file that is never
read, a missing root, and the result and content bounds.
