# tool-okf

Provider-neutral, read-only search over Open Knowledge Format bundles stored at
`<workspace>/.agents/bundles`.

## Use

`createTool` returns a tool definition over the sandbox that contains the
workspace. Register it with `tools/v1`, or bind it and take its agent-loop tool
directly:

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

The `bundle` and `limit` fields are optional. Without `bundle`, the tool
searches every top-level bundle. Results contain concept metadata and bounded
Markdown content ordered by deterministic lexical relevance.

## Safety and bounds

The tool never writes files, accesses the network, follows symlinks, or reads
outside the fixed bundle root. Reserved `index.md` and `log.md` files are not
treated as concepts.

A query contains at most 32 normalized terms, one call lists at most 10,000
concepts, each concept contributes at most 200,000 searchable characters, and
output is capped. Malformed concepts are skipped and reported in the result
count.

## Development

```console
npx nx build tool-okf
npx nx test tool-okf
```
