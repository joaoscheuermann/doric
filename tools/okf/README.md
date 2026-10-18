# tool-okf

`tool-okf` lets an agent look things up in a project's knowledge base before
reading source files. It provides `okf_search`, a provider-neutral, read-only
agent tool that searches Open Knowledge Format bundles stored at
`<workspace>/.agents/bundles`, such as the project bundle the
[`okf`](../../packages/okf/README.md) package generates. Results come back
ranked, bounded and deterministic, so the agent gets the most relevant
concepts without flooding its context.

Part of [Doric](../../README.md).

## Highlights

- **Read-only by construction.** No writes, no network access, no symlink
  traversal, and nothing read outside the fixed bundle root.
- **Deterministic ranking.** Lexical relevance over concept metadata and
  content, with stable ordering.
- **Bounded output.** Limits on query terms, concepts scanned, searchable
  characters, content per result and total output size.
- **Works in any sandbox.** Reads through the injected
  [`sandbox`](../../packages/sandbox/README.md) that holds the workspace.

## Usage

`createTool` returns a tool definition over the sandbox that contains the
workspace. Register it with `tools/v1`, or bind it and take its agent-loop
tool directly:

```ts
import { createTool } from 'tool-okf';

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

## API

| Export                               | Purpose                                  |
| ------------------------------------ | ---------------------------------------- |
| `createTool(options)`                | The `okf_search` tool definition.        |
| `input`, `output`                    | The tool's Zod input and output schemas. |
| `OkfToolOptions`                     | `{ workspaceRoot, sandbox }`.            |
| `OkfSearchOutput`, `OkfSearchResult` | Output and per-result types.             |

### Input

| Field    | Notes                                                                 |
| -------- | --------------------------------------------------------------------- |
| `query`  | Required, 1 to 500 characters.                                        |
| `bundle` | Optional bundle name; without it, every top-level bundle is searched. |
| `limit`  | Optional, 1 to 50 results; 10 when omitted.                           |

### Output

`results` holds each concept's metadata (`bundle`, `conceptId`, `path`,
`type`, `title`, optional `description`, `resource` and `timestamp`, `tags`),
bounded Markdown `content` with a `contentTruncated` flag, and its `score`,
ordered by deterministic lexical relevance. `total`, `truncated` and `skipped`
describe the search, and `error` explains a search that could not run.

## Safety and bounds

The tool never writes files, accesses the network, follows symlinks, or reads
outside the fixed bundle root. Reserved `index.md` and `log.md` files are not
treated as concepts.

- A query contains at most 32 normalized terms.
- One call lists at most 10,000 concepts; above that, select a `bundle`.
- Each concept contributes at most 200,000 searchable characters.
- Each result carries at most 4,000 characters of content, and the output is
  capped at 50 KiB.
- Malformed concepts are skipped and reported in the `skipped` count.

## Development

```console
npx nx build tool-okf
npx nx typecheck tool-okf
npx nx test tool-okf
```
