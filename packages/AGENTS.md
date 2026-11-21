# Packages Instructions

Apply these rules to every package under `packages/<name>/`, after the root
[`AGENTS.md`](../AGENTS.md).

## Function

- Keep `packages/` to workspace libraries, one per folder `packages/<name>/`,
  each holding a generic primitive or a platform responsibility.
- Put a concept a bundle owns (a Project, a Thread, a prompt, Git, settings,
  credential semantics, a feature's UI) in that bundle under `bundles/`, never
  in a package: the `Host` facade types, for one, are declared only in
  [`bundles/runtime/runtime/src/contracts/tool-host/`](../bundles/runtime/runtime/src/contracts/tool-host/index.ts).
- Put a command-line tool under `tools/`, never under `packages/`.
- Never import a bundle's package (`<id>` or any `<id>/…` subpath) from a
  package: the `core` check of `npm run lint:test` fails on such an import in
  a package's `src/`
  ([`tests/support/boundaries.mjs`](../tests/support/boundaries.mjs)).

## Rules

Add a feature to a package in these steps, in one change:

1. Read the package's `README.md` for what its code does before adding to it.
2. Put the code under `src/`, in the folder that holds the package's code of
   the same kind (`src/lib/` in most packages), never outside `src/`: each
   package's `tsconfig.lib.json` compiles only `src/` into `dist/`. Write `.ts`
   files only, except in `desktop`, the one package whose configs compile
   `.tsx`.
3. When the feature adds a subpath, export it from the index file its
   `exports` entry points at, and add that entry as
   [Names and exports](#names-and-exports) requires.
4. Add its tests under `tests/` as `<subject>.test.ts`, written for
   `node --test` with `node:test` and `node:assert/strict`. Import the
   package's own code by relative path under `../src/` with the `.js`
   extension; in `desktop`, a test may also import the package's own
   `desktop/ui/*` entries, as
   [`desktop/tests/button.test.ts`](desktop/tests/button.test.ts) does.
5. Put a test only in a folder whose compiled files the `test` target of the
   package's `project.json` runs: most targets run `tests/*.test.ts`;
   `desktop` runs `tests/`, `tests/client/`, `tests/reads/` and
   `tests/identity/`; `okf` runs only the files its target names
   ([`okf/project.json`](okf/project.json)). When a test goes elsewhere, or
   into `okf`, extend that target in the same change; otherwise it never runs.
6. Put a test that runs a pool or a sandbox end to end as
   `tests/<subject>.e2e.ts`, only in a package with an `e2e` target
   (`docker-sandbox`, `firecracker-sandbox`, `sandpool`), whose
   `tsconfig.e2e.json` compiles it.
7. Update the package's `README.md`, its complete overview, in the same
   change: its public interface (exports and subpaths), its behavior, its data
   shapes, its side effects, its configuration, its limits and its errors.
   Also update each feature doc in `docs/features/` that describes the
   feature, and each document of `docs/architecture/` that describes the
   export or behavior the change touches; for an entry of `desktop`, its row
   in
   [The entry points of `packages/desktop`](../docs/architecture/bundles/platform-packages.md#the-entry-points-of-packagesdesktop).

### Names and exports

- Give a new package one name for its folder, the `name` of its
  `package.json` and the `name` of its `project.json`: that name is its Nx
  project name and its import specifier.
- Write every entry of `exports` that points at a module with four
  conditions: `@org/source` pointing at the source file under `src/`, and
  `types`, `import` and `default` pointing at its output under `dist/`, as
  [`tool/package.json`](tool/package.json) does; in `okf`, whose
  `tsconfig.lib.json` sets `rootDir` to `.`, point them under `dist/src/`
  ([`okf/package.json`](okf/package.json)). The workspace resolves
  `@org/source` through the `customConditions` of
  [`tsconfig.base.json`](../tsconfig.base.json), so a module entry without it
  is not found from source.
- Export `./package.json`, and every CSS or JSON asset, as a plain path
  string (`"./ui/theme.css": "./src/styles/theme.css"` in
  [`desktop/package.json`](desktop/package.json)).

### Dependencies

- Declare a workspace package a package imports under `dependencies` of its
  `package.json`, at the exact version of that package's own `package.json`
  (`"tool": "0.0.1"` in [`agent/package.json`](agent/package.json)).
- When a test imports a workspace package, add
  `{ "path": "../<dependency>/tsconfig.lib.json" }` by hand to the
  `references` of the package's `tsconfig.spec.json`, and of its
  `tsconfig.e2e.json` for an e2e test, as
  [`sandpool/tsconfig.e2e.json`](sandpool/tsconfig.e2e.json) does:
  `npx nx sync` does not write them, and they make the test compile against
  that package's built declarations, as its `tsconfig.lib.json` does.

### Reuse

- Use the package that owns a shared helper, through its public entry, before
  writing a second version of it:
  - `tool`: the JSON predicates `isRecord`, `isJsonValue` and `asJsonObject`
    ([`tool/src/lib/utils/json.ts`](tool/src/lib/utils/json.ts)).
  - `sandbox`: shell quoting (`quote`) and process plumbing
    (`captureProcessOutput`, `processTerminationScript`)
    ([`sandbox/src/lib/process.ts`](sandbox/src/lib/process.ts)).
  - `llms`: the reasoning-effort vocabulary `reasoningEfforts`,
    `ReasoningEffort` and `isReasoningEffort`
    ([`llms/src/lib/types/provider.ts`](llms/src/lib/types/provider.ts)).
  - `bundle/contracts`: the call-scope bounds `callScopeSchema`,
    `scopeKeyPattern`, `SCOPE_MAX_KEYS` and `SCOPE_MAX_VALUE`
    ([`bundle/src/contracts/call.ts`](bundle/src/contracts/call.ts)); a
    contract that carries a scope must use them, never limits of its own.
- Keep `config` and `oauth` dependent on no workspace package: `config` keeps
  its own `isRecord` and `ReasoningEffort` union
  ([`config/src/lib/utils/object.ts`](config/src/lib/utils/object.ts),
  [`config/src/lib/types/config.ts`](config/src/lib/types/config.ts)), and
  `oauth` its own `asRecord`, `stringField`, `numberField` and
  `diagnosticExcerpt`
  ([`oauth/src/lib/utils/json.ts`](oauth/src/lib/utils/json.ts)).
- Keep the two copies of `createFetchTransport`, in `llms` and `oauth`
  ([`llms/src/lib/http.ts`](llms/src/lib/http.ts),
  [`oauth/src/lib/http.ts`](oauth/src/lib/http.ts)); extract it into one
  package only in the change that gives it a third consumer.
- Never merge `excerpt` of `tool` (300 characters, marker `...`) with
  `diagnosticExcerpt` of `llms` (2048) or `oauth` (500), both with the marker
  `...[truncated]`: they differ in limit and marker.

### Components of `desktop`

- Put only shadcn components in `desktop/src/components/<name>.tsx`: `desktop:test`
  runs
  [`desktop/scripts/verify-provenance.mjs`](desktop/scripts/verify-provenance.mjs),
  which fails on a component file `desktop/tests/fixtures/provenance.json`
  does not list and on any difference from its recorded origin.
- Add a shadcn component in these steps, in one change:
  1. Run `npx shadcn@4.21.0 add <name> -c packages/desktop`, which writes it
     with [`desktop/components.json`](desktop/components.json). Decline every
     prompt to overwrite an existing file, and run `npm install` when the CLI
     adds a dependency.
  2. Format it with the repository's Prettier, and record it by hand as an
     entry of `files` in `provenance.json`:
     `"components/<name>.tsx": { "origin": "registry", "sha256": "<hash>" }`,
     with the SHA-256 of that formatted output without a leading
     `'use client'` line.
  3. Rewrite its imports to relative `.js` paths: `@/components/<x>` to
     `./<x>.js` and `@/hooks/use-mobile` to `../hooks/use-mobile.js`.
- Change a shadcn component only through a patch added to the
  `registryPatches` or `rendererPatches` of `verify-provenance.mjs` and
  described in `desktop/PROVENANCE.md`, never by hand alone.
- Never change `desktop/src/lib/utils.ts` or `desktop/src/hooks/use-mobile.ts`:
  the provenance check holds them to their recorded origin too.
- Put every other component of `desktop/ui` in `desktop/src/<name>.tsx`, or in
  a folder `desktop/src/<area>/` with an `index.ts`, and add its
  `./ui/<name>` entry to `exports` of
  [`desktop/package.json`](desktop/package.json); never put it in
  `src/components/`, which the `./ui/*` entry and the provenance check hold
  for shadcn files.

### Stories

- Keep a package's story harness at `.storybook/preview.tsx` of the package,
  in Storybook's `Preview` shape (a default export with `decorators`):
  papercraft resolves a preview's harness from the nearest directory up,
  preferring `.storybook/` to `.papercraft/`
  ([`harness.ts`](../bundles/features/papercraft/src/host/harness.ts)). In
  `desktop`, import the package's own `src/styles/theme.css` there, as
  [`desktop/.storybook/preview.tsx`](desktop/.storybook/preview.tsx) does,
  and wire no portal container: with none, an overlay portals into the
  document body, which in a preview is its frame's body
  ([`portal-container.tsx`](desktop/src/portal-container.tsx)).
- Put stories only under `stories/`, as CSF files named `<file>.stories.tsx`
  at the path of the source file under `src/`
  (`src/panels/tab-strip.tsx` → `stories/panels/tab-strip.stories.tsx`), and
  shared fixtures under `stories/support/`. Never put a story in `src/`: the
  build would emit it, and in `src/components/` the provenance check fails on
  it.
- Import no `@storybook/*` package in a story or a harness: Storybook is not
  installed. Reach the shared components through `desktop/ui/*`, never by a
  relative path into `src/`, and seed stores and providers with fixtures,
  never with a live host.
- Keep every story and harness inside the `include` of the package's
  `tsconfig.spec.json`, which the `test` target compiles
  ([`desktop/tsconfig.spec.json`](desktop/tsconfig.spec.json)).

### Commands that need an environment

- Run `npx nx run docker-sandbox:e2e` after a change to `docker-sandbox`'s
  `src/` or e2e tests, only where a Docker daemon is reachable: it provisions
  real containers.
- Run `npx nx run firecracker-sandbox:e2e` after a change to
  `firecracker-sandbox`'s `src/` or e2e tests, only on a host that passes the
  preflight the `firecracker-sandbox` README lists under
  [`preflightFirecrackerHost`](firecracker-sandbox/README.md#preflightfirecrackerhostconfig):
  the target runs it first and fails without such a host.
- Never run `npx nx run llms:conformance-live` unless the user asks for it: it
  makes paid calls to OpenRouter, and runs only with `OPENROUTER_API_KEY` set
  and the argument `-- --yes-paid-conformance`
  ([`llms/scripts/conformance-live.mjs`](llms/scripts/conformance-live.mjs)).

## Verify

Run each command from the repository root, with the package's folder name in
place of `<name>` (`npx nx show projects` lists them):

```sh
npx nx run <name>:typecheck
npx nx run <name>:test
npx nx run <name>:build
```

- `typecheck`: run it after any change under `src/`.
- `test`: run it after any change under `src/` or `tests/`, and in `desktop`
  also under `stories/`, `.storybook/` or `scripts/`; run a package's tests
  only through this target, which compiles `tsconfig.spec.json` into
  `dist-tests/`. A test resolves every other workspace package to its
  `dist/`. The targets of `agent`, `bundle`, `llms`, `messages` and `storage`
  build the package's dependencies first, and those of `desktop` and `okf`
  build the package itself, with its dependencies, first; in every other
  package, run the `build` target of each workspace dependency the change
  touches before this target.
- `build`: run it after a change to `package.json`, a `tsconfig*.json` file or
  a public export, since the packages that depend on it build against its
  `dist/`.
- `npm run lint:test`: run it after adding an import to a package's `src/`.
- `npx nx sync:check`: run it after a change to a package's `package.json`
  dependencies or after adding a package.
- `npx nx run sandpool:e2e`: run it after a change to `sandpool`'s `src/` or
  e2e tests.
- `npx nx run victor:benchmark`: run it after a change to `victor`'s
  [`lexical.ts`](victor/src/lib/lexical.ts),
  [`vector.ts`](victor/src/lib/vector.ts) or
  [`hybrid.ts`](victor/src/lib/hybrid.ts), and compare its figures with a
  baseline built before the change:

  ```sh
  # before the change
  npx nx run victor:build
  rm -rf packages/victor/dist-tests/baseline && cp -r packages/victor/dist packages/victor/dist-tests/baseline
  # after the change: the baseline, then the change
  npx nx run victor:benchmark -- packages/victor/dist-tests/baseline/index.js
  npx nx run victor:benchmark
  ```

## Generated files

- The `references` of each package's `tsconfig.json` and `tsconfig.lib.json`,
  and each package's entry in the root `tsconfig.json`: do not edit them by
  hand; run `npx nx sync`.
- `package-lock.json`: do not edit it by hand; run `npm install` after a
  change to a package's `package.json` dependencies.
- `desktop/src/styles/tokens.css`: do not edit it by hand; edit
  `desktop/src/tokens/tokens.ts` and run `npx nx run desktop:build`, whose
  [`build-tokens.mjs`](desktop/scripts/build-tokens.mjs) writes it.
- The entries of `desktop/tests/fixtures/provenance.json` already recorded:
  do not edit them by hand; run
  `node packages/desktop/scripts/verify-provenance.mjs --record-registry <dir>`
  with the shadcn CLI's formatted output of every `registry` file in `<dir>`,
  or `--record <commit>` for the `renderer` entries.
