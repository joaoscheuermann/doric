# Core bundle

`bundle-core` contains the baseline capabilities built into Doric. Its build
produces a runtime bundle at `agents/doric/dist/bundles/core`; Doric loads that
artifact through the `bundle` package.

## Capabilities

The bundle provides these always-available tools:

- `cwd` — report or move the thread's working directory;
- `edit`, `write` — change files inside the sandbox workspace;
- `find`, `grep`, `tree` — discover and inspect workspace content;
- `terminal` — run shell commands in the sandbox with bounded results;
- `web` — make bounded web requests.

`cwd` reports and moves the calling thread's working directory, and every other
relative path in this bundle resolves against it at call time. A move is refused
unless the path names a directory inside the workspace root.

`goal-directed-tool-use` is the baseline skill. Additional focused skills cover
workspace discovery, search and inspection, dependency tracing, file changes,
shell execution, failure diagnosis, validation, web research, and
evidence-grounded synthesis.

The authoritative resource order and availability flags are in
[`manifest.json`](manifest.json).

## Change the bundle

1. Add or update a tool in `tools/`. Each runtime module must default-export a
   `ToolFactory` created through the public `tool` package.
2. Add or update a skill at `skills/<name>/SKILL.md`. Its YAML frontmatter must
   declare `name` and `description`; `allowed-tools` may reference tools from
   this bundle only.
3. Declare the resource and its `alwaysAvailable` flag in `manifest.json`.
4. Build and test the bundle. Runtime resources are loaded as compiled `.js`,
   not TypeScript source.

## Development

```console
npx nx build bundle-core
npx nx typecheck bundle-core
npx nx test bundle-core
```

To rebuild every bundle used by the Direct host:

```console
npx nx run doric:build-bundles
```
