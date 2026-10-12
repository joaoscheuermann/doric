# Git bundle

`git` gives Doric structured, non-interactive Git capabilities. Its build
writes `bundles/features/git/dist`, which `doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/git` for the Direct host to load at startup.

## Capabilities

The routable `git` tool executes `git` with an argument array inside the
sandbox. It does not invoke a shell, it runs in the thread's current working
directory by default, it keeps the working directory under the sandbox root,
and it bounds captured stdout and stderr. A relative `working_directory`
resolves against that working directory. Authentication must be provided by the
runtime; credentials do not belong in tool arguments. The tool reaches the
working directory through `runtime.workspace/v1` and the sandbox through
`runtime.lease/v1`, and registers itself with `tools/v1` (not always
available).

Focused skills cover:

- cloning;
- commit preparation;
- conflict resolution;
- rebasing;
- remote synchronization;
- linked worktrees.

Skills live in `src/skills/<name>/SKILL.md` and are registered in lexical
folder order.

## Change the bundle

1. Update the tool in `src/host/tools/git.ts` or add a skill at
   `src/skills/<name>/SKILL.md`.
2. Keep each skill's `allowed-tools` references local to this bundle.
3. Declare every contract the host part uses in `manifest.json` `requires`.
4. Build and test; the build validates the manifest and skills and
   dry-activates the host part.

## Development

```console
npx nx build bundle-git
npx nx typecheck bundle-git
npx nx test bundle-git
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
