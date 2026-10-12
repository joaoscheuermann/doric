# Files bundle

`files` gives the Doric agent its workspace tools. Its build writes
`bundles/features/files/dist`, which `doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/files`.

## Capabilities

The host part registers these always-available tools with `tools/v1`, in this
order:

- `cwd` — report or move the thread's working directory;
- `edit`, `write` — change files inside the sandbox workspace;
- `find`, `grep`, `tree` — discover and inspect workspace content;
- `terminal` — run shell commands in the sandbox with bounded results;
- `web` — make bounded web requests.

`cwd` reports and moves the calling thread's working directory, and every other
relative path in this bundle resolves against it at call time. A move is refused
unless the path names a directory inside the workspace root.

The tools reach the working directory through `runtime.workspace/v1` and the
Project sandbox through `runtime.lease/v1`, both in `requires`. `terminal`
runs tracked commands through `terminal/v1` when a provider serves the prompt;
without one it runs a plain foreground command in the sandbox and refuses
background and PTY commands.

`goal-directed-tool-use` is the baseline skill. Additional focused skills cover
workspace discovery, search and inspection, dependency tracing, file changes,
shell execution, failure diagnosis, validation, web research, and
evidence-grounded synthesis. Skills live in `src/skills/<NN>-<name>/SKILL.md`;
the loader registers them in lexical folder order, so the two-digit prefixes
fix their order in the system prompt.

## Change the bundle

1. Add or update a tool in `src/host/tools/` with `defineTool` from `tool`
   (`execute(payload, call, services)`), and register it in
   `src/host/index.ts`.
2. Add or update a skill at `src/skills/<NN>-<name>/SKILL.md`. Its YAML
   frontmatter must declare `name` and `description`, may set
   `alwaysAvailable`, and `allowed-tools` may reference tools from this bundle
   only.
3. Declare every contract the host part uses in `manifest.json` `requires`.
4. Build and test the bundle; the build validates the manifest and skills and
   dry-activates the host part.

## Development

```console
npx nx build bundle-files
npx nx typecheck bundle-files
npx nx test bundle-files
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
