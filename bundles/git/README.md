# Git bundle

`bundle-git` gives Doric structured, non-interactive Git capabilities. Its
build produces `agents/doric/dist/bundles/git`, which the Direct host loads at
startup.

## Capabilities

The routable `git` tool executes `git` with an argument array inside the
sandbox. It does not invoke a shell, it runs in the thread's current working
directory by default, it keeps the working directory under the sandbox root,
and it bounds captured stdout and stderr. A relative `working_directory`
resolves against that working directory. Authentication must be provided by the
runtime; credentials do not belong in tool arguments.

Focused skills cover:

- cloning;
- commit preparation;
- conflict resolution;
- rebasing;
- remote synchronization;
- linked worktrees.

The authoritative resource order and availability flags are in
[`manifest.json`](manifest.json).

## Change the bundle

1. Update the tool in `tools/git.ts` or add a skill at
   `skills/<name>/SKILL.md`.
2. Keep each skill's `allowed-tools` references local to this bundle.
3. Update `manifest.json` when resources or their ordering change.
4. Build and test; the runtime loader accepts compiled `.js` tools only.

## Development

```console
npx nx build bundle-git
npx nx typecheck bundle-git
npx nx test bundle-git
```

To rebuild every bundle used by the Direct host:

```console
npx nx run doric:build-bundles
```
