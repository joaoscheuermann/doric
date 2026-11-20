# Bundle boundaries

- Status: living document. It describes the boundary rules between the platform and the bundles, and their checks, as implemented on 2026-11-20.

## Summary

Eleven rules, M1 to M11, keep the bundles apart from one another and from the platform. Four of them, M2, M3, M6 and M9, and the rule on a bundle's dependencies, are held by six machine checks that run in CI as one test file, [`tests/boundaries.test.mjs`](../../../tests/boundaries.test.mjs), over the finders of [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs). M11 is the rule that every check is a test and every standing violation an entry of [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json), with the document that keeps it; the file lists none. The other six rules, M1, M4, M5, M7, M8 and M10, are held in review.

The rules are written as instructions for agents in [`bundles/AGENTS.md`](../../../bundles/AGENTS.md). This document explains the mechanism behind them: what each check reads and reports, how the exceptions file is compared with the findings, how a bundle's parts are built and what its `package.json` lists.

## The platform and what it never knows

The platform is `packages/bundle`, `packages/storage`, `packages/desktop`, `app/desktop/doric`, `app/desktop/doric-renderer`, `app/desktop/doric-platform` and the kernel `app/backend/doric-host`. It installs bundles, composes providers, routes calls, and runs processes, windows and IPC.

The platform never imports a bundle. No file under `packages/<name>/src/` or `app/<group>/<name>/src/` that is not a test imports a bundle's package; only tests may, and the `core` check holds this ([`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs)). The platform therefore has no access to a bundle's types, methods or storage formats: it reaches a bundle through contract ids, manifests and the data a call carries. The keys of a call's scope belong to the bundles that read them, and `windowKey` is the one key the platform reserves and fills ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)). The core, which provides the base contracts, names no `projectId`, `threadId` or `promptId` among the scope keys a window may send to it (its manifest has no `desktopScope`), and its sources do not write the route `'/settings'` ([`core/manifest.json`](../../../bundles/foundation/core/manifest.json), [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs)).

The mechanisms the platform provides, by name, with the file that declares each and the document that describes it:

| Mechanism                                                               | Declared in                                                             | Document                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Call scope and the call envelope                                        | [`call.ts`](../../../packages/bundle/src/contracts/call.ts)             | [Services and channels](services-and-channels.md)               |
| Work holds and generations                                              | [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)     | [Process isolation](process-isolation.md)                       |
| Lifecycle hooks (`doric.app.hooks/v1`)                                  | [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)     | [Hooks](hooks.md)                                               |
| Startup records (`doric.startup/v1`)                                    | [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)     | [Observability](observability.md)                               |
| Composition data (`resident`, `required`, `alternatives`)               | [`composition.ts`](../../../packages/bundle/src/runtime/composition.ts) | [Composition and distribution](composition-and-distribution.md) |
| Optional contracts (`optional` in the manifest)                         | [`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)       | [Manifest](manifest.md)                                         |
| Native handles (`doric.network/v1`)                                     | [`network.ts`](../../../packages/bundle/src/contracts/network.ts)       | [Services and channels](services-and-channels.md)               |
| Desktop exposure                                                        | [`exposure.ts`](../../../packages/bundle/src/runtime/exposure.ts)       | [Services and channels](services-and-channels.md)               |
| Event sinks (`events/v1`)                                               | [`events.ts`](../../../packages/bundle/src/contracts/basic/events.ts)   | [Events and nodes](events-and-nodes.md)                         |
| The system browser and windows (`doric.browser/v1`, `doric.windows/v1`) | [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)     | [Windows](windows.md)                                           |

## The rules

| Rule                                  | What it asks                                                                                                                                                                                                                                                                                                     | How it is held                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 One function**                   | A bundle's manifest `description` states one function, and every contract, slot, route and tool it provides serves it.                                                                                                                                                                                           | Review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M2 Contracts only**                 | A bundle reaches another bundle only through what that bundle publishes: its contracts, imported from `<id>/contracts`; in tests and stories also `<id>/testing`, and in tests `<id>/package.json`.                                                                                                              | The `imports` check. A client part's build leaves every `<id>/contracts` to the window and fails on the platform modules a part may not import ([`parts.ts`](../../../packages/bundle/src/build/parts.ts), [`externals.ts`](../../../packages/bundle/src/build/externals.ts)).                                                                                                                                                                                                                                                     |
| **M3 One direction**                  | Every edge between bundles runs the right way: where bundle B contributes into bundle A, A does not name B. The edges form no cycle.                                                                                                                                                                             | The `declared` check makes every edge visible in the manifests, and the `cycles` check finds a cycle among them. At run time `services.use` and `hooks.use` refuse a contract the manifest does not list with `undeclared_requirement` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)), and the catalog quarantines every member of a `requires` cycle with `dependency_cycle` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). Whether a lone edge runs the wrong way is decided in review. |
| **M4 Declared extension points**      | Every way to add something to a bundle is a contract it provides or a slot it declares. A set other bundles extend (tools with a drawing, icons, tab kinds, provider kinds, input sources, skill sources) is open: its members are registered, not enumerated.                                                   | Review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M5 Owners announce**                | A bundle registers its own tools, commands, routes, slot items and drawings from its own code. No bundle registers, opens or draws on behalf of another.                                                                                                                                                         | Review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M6 Base capabilities stay generic** | The platform declares the base contracts and the core provides them. Neither names a feature bundle's concept: no Project, Thread or prompt, no feature bundle's route.                                                                                                                                          | The `core` check, with its three assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **M7 Data has one owner**             | A record is read through a contract of the bundle that owns it. A bundle does not hand out another bundle's record types through its own contract. It may publish a view of another bundle's data: a type it declares itself, holding what its own function produces from that data.                             | Review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M8 Persistence by operations**      | A backend bundle exposes operations. No contract hands out a live client or connection.                                                                                                                                                                                                                          | Review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M9 One source for the bundle set**  | The bundles of a build are the manifests on disk. Every other list of bundles is derived from them, checked against them, or is a named deployment choice.                                                                                                                                                       | The `lists` check. The host's `build-bundles` target stages every `bundles/<group>/<id>` that holds a `manifest.json` ([`project.json`](../../../app/backend/doric-host/project.json), [`cli.ts`](../../../packages/bundle/src/build/cli.ts)).                                                                                                                                                                                                                                                                                     |
| **M10 Plain data in new contracts**   | A contract method a bundle adds takes and returns plain data: a contribution names an element tag and gives props, its element answers with DOM events, and it passes no function, component or live object except a subscription listener. A contract that moves between bundles is not reshaped for this rule. | Review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M11 Enforced or listed**            | Each rule a machine can check is a test CI runs. Each standing violation a check finds is one entry in the exceptions file, with the decision that keeps it.                                                                                                                                                     | The six checks and [the exceptions file](#the-exceptions-file).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A bundle's own dependencies follow one more rule, which the `dependencies` check and Biome hold together: its `package.json` lists every package it imports and no package it does not use ([What a bundle's `package.json` lists](#what-a-bundles-packagejson-lists)).

## The checks

`npm run lint:test` runs `node --test --test-concurrency=1 tests/lint.test.mjs tests/boundaries.test.mjs`, and CI runs it in the step "Test Biome configuration and bundle boundaries" ([`package.json`](../../../package.json), [`ci.yml`](../../../.github/workflows/ci.yml)). The two files run one after the other: the Biome tests of [`tests/lint.test.mjs`](../../../tests/lint.test.mjs) write fixture files into directories the boundary checks read, and remove them when each case ends.

The test reads the repository once into a snapshot ([`tests/boundaries.test.mjs`](../../../tests/boundaries.test.mjs)): the source files under `packages`, `app`, `tools` and `bundles`, the names of the workspace packages, the directory of each workspace package, every bundle's `manifest.json` and `package.json`, the host's `project.json` and `.Dockerfile`, and its `composition.json`. The finders in [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs) read nothing else. Five of them take the snapshot and return findings `{ check, bundle, target }`, unique and sorted by `bundle`, then `target`; `findCycles` also takes the listed edges and returns the cycles it finds, the listed edges not in the graph and those that break no cycle.

Two helpers of [`tests/support/workspace.mjs`](../../../tests/support/workspace.mjs) decide what a source file is and what it imports:

- `sourceFiles` takes the paths of one run of `git ls-files -z --cached --others --exclude-standard`, so tracked and untracked files count and ignored files do not. It keeps a path that ends in `.js`, `.jsx`, `.ts` or `.tsx`, with an optional `c` or `m` before the letters, that has no directory named `node_modules` or starting with `dist`, and that exists on disk. The file's own name is not tested, so `distribution.ts` is a source file.
- `importedModules` returns every specifier written between quotes in six forms: `from '…'`, `require('…')`, a bare `import '…'` at the start of a line, `import('…')`, `import.meta.resolve('…')` and `require.resolve('…')`. A dynamic import and a resolve call therefore count as an import. A specifier built at run time, or written as a template literal, is not read. Comments are read too: a specifier in a comment counts, for `imports`, `dependencies` and the second assertion of `core`, which call it on the file's text as it is.

| Check          | Rule | What it reads                                                                                          | What it reports                                                                                                                                                                |
| -------------- | ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `imports`      | M2   | Every source file                                                                                      | An import of a workspace package's `src/` path anywhere; in a bundle's `src`, `tests` or `stories`, an import of another bundle's package other than the paths it allows       |
| `declared`     | M3   | The bundles' `src` files, the contracts modules of the bundles and of `bundle`, and the manifests      | A contract id another bundle provides that a bundle uses and does not list; a manifest line under `requires` or `optional` whose id no manifest provides                       |
| `cycles`       | M3   | The manifests and a reviewed list of edges                                                             | A cycle among the bundles that the listed edges do not break; a listed edge that is not in the graph or breaks no cycle                                                        |
| `core`         | M6   | The core's `manifest.json` and sources, and the non-test sources of `packages/*/src` and `app/*/*/src` | A core `desktopScope` entry with `projectId`, `threadId` or `promptId`; a production import of a bundle's package from a platform package; `'/settings'` in the core's sources |
| `lists`        | M9   | The host's `project.json`, `.Dockerfile` and `composition.json`                                        | A build file that names a bundle; an id the composition names that has no manifest                                                                                             |
| `dependencies` | —    | Each bundle's `package.json` and the source files of its directory                                     | A package the bundle lists and does not use                                                                                                                                    |

### `imports`

Rule (1) covers every source file of the snapshot. A specifier that starts with `<name>/src/`, for the name of any workspace package, is a finding; `bundle` is the importing file's path and `target` the specifier. No entry of the exceptions file can excuse it: `isSourcePathImport` recognises such a finding by the `/` in its `bundle`, and the comparison reports it whether or not an entry lists it ([`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs)).

Rule (2) covers the files under `bundles/<group>/<id>/src/`, `tests/` and `stories/`. A specifier that is another bundle's package name, or starts with it and `/`, is a finding, except three exact paths:

| Path                   | Allowed in                   |
| ---------------------- | ---------------------------- |
| `<other>/contracts`    | `src`, `tests` and `stories` |
| `<other>/testing`      | `tests` and `stories`        |
| `<other>/package.json` | `tests`                      |

Any other subpath is a finding, `<other>/contracts/<file>` included. `bundle` is the importing bundle's id and `target` the specifier. A test that resolves `<other>/package.json` finds the other bundle's directory to load its built parts, as the client-test harnesses that open a window on built bundles do ([`chat/tests/client/support/window.ts`](../../../bundles/desktop/chat/tests/client/support/window.ts)).

### `declared`

The contract ids are the entries of every manifest's `provides`, without their `@version`; the providers of an id are the bundles that list it. Ids that start with `doric.` are skipped: the platform provides them and no manifest lists them.

Before anything is read, every comment line is blanked: a line whose first non-blank characters are `//`, `/*` or `*`. A comment after code on the same line stays.

A whole string literal is an id with the same quote character, `'`, `"` or a backtick, directly before and directly after it. The test matches the text, not JavaScript's string syntax, so an id in single quotes inside a template literal, such as a SQL string, is a literal of its own, and `'demo/v1.method'` is not a literal of `demo/v1`.

A symbol is the name of a statement that starts in column 0 with `export const <Name>`, in a file under a bundle's `src/contracts/` or under `packages/bundle/src/contracts/`. The statement runs to the next line that starts in column 0 with a letter, and the symbol stands for every contract id written in it as a whole string literal.

A use, in a file under a bundle's `src/`, is either a whole string literal of a contract id, or a name inside the braces of `import { … } from '<package>/contracts'` (or a subpath of it), where `<package>` is another bundle's package or `bundle` and the name is one of its symbols. A name written `type <Name>`, and every name of an `import type { … }`, is not a use; `<Name> as <Other>` counts as `<Name>`.

There are two kinds of finding, each with the bundle as `bundle` and the id as `target`:

- a use of an id the bundle neither provides nor lists under `requires` or `optional`. The core's uses of symbols from `bundle/contracts` are skipped, since the core provides the base contracts; its literal uses count;
- a line under `requires` or `optional` whose id no manifest provides and that does not start with `doric.`.

### `cycles`

The graph has one edge from each bundle to every other provider of each id in its `requires` and `optional`. For a contract that one bundle declares and others provide, the declarer's own line gives an edge from each provider to the declarer. Those contracts are the constant `declaredContracts`:

| Contract                   | Declared by |
| -------------------------- | ----------- |
| `executor/v1`              | `runtime`   |
| `sandbox/v1`               | `runtime`   |
| `default.skill-sources/v1` | `default`   |
| `files.decorations/v1`     | `files`     |

The entries of this check are a reviewed list of edges, each `{ bundle, target }` naming its two ends, which the test takes out of the graph before it looks for a cycle. It fails in three cases ([`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs)):

- the graph without the listed edges has a strongly connected component of more than one bundle; the failure names its bundles;
- a listed edge is not an edge of the graph;
- a listed edge breaks no cycle: in the graph without the other listed edges, its `target` cannot reach its `bundle`. An edge listed twice is reported the same way.

So the list always breaks every cycle and holds no edge that breaks none. The check does not ask for one entry per finding, as the other five do: an edge inside a cycle is not by itself a violation, and the review chooses which edge of a cycle runs the wrong way. The list is empty.

### `core`

Three assertions, one finding each:

1. Each `desktopScope` entry of the core whose list holds `projectId`, `threadId` or `promptId`: `bundle` is `core` and `target` is `<contract>:<key>`.
2. An import of a bundle's package, or a subpath of it, from a file under `packages/<name>/src/` or `app/<group>/<name>/src/` that is not a test. A test is a file with a directory segment named `tests` or `__tests__`, or a name that ends in `.test` or `.spec` and a script extension. `bundle` is the name of the package that holds the file and `target` the specifier.
3. The text `'/settings'`, in single quotes, in a file under `bundles/foundation/core/src/`, comment lines included: `bundle` is `core` and `target` the file.

### `lists`

The host's `project.json` and `.Dockerfile` are read line by line, comments included. A line names a bundle when it matches a written-out path, `bundles/<group>/<id>` not preceded by a word character, `.`, `/` or `-`, or a project name in double quotes, `"bundle-<id>"`, which is how every bundle's `project.json` is named. A file with one or more such lines is one finding, with `doric-host` as `bundle` and the file as `target`. Neither file names a bundle: `build-bundles` stages every bundle directory that holds a manifest (`stage <dest> --all bundles`), and the image builds through that target ([`project.json`](../../../app/backend/doric-host/project.json), [`.Dockerfile`](../../../app/backend/doric-host/.Dockerfile)).

In `composition.json`, every id under `core`, `enabled`, `resident` and `required.bundles`, every value of `providers`, and `default` and `options` of each entry of `alternatives` must be a bundle with a manifest on disk; an id without one is a finding with the id as `target` ([`composition.json`](../../../app/backend/doric-host/composition.json)).

### `dependencies`

Every name under `dependencies` and `devDependencies` of a bundle's `package.json` is checked. A package is used when one of five holds:

1. a source file of the bundle's directory, tests, stories and configuration files with a script extension included, has a specifier that is the package's name or starts with it and `/`;
2. it is `tslib`, whose imports the compiler adds under `importHelpers` ([`tsconfig.base.json`](../../../tsconfig.base.json));
3. it is `react` and the bundle has a `.tsx` or `.jsx` file, where the compiler adds the import of `react/jsx-runtime`;
4. it is `@types/<m>` and `<m>` is `node` or a package used by (1), where `a__b` stands for `@a/b`;
5. the pair is in the constant `dependencyExceptions`, with its reason. It holds one pair: `postgres` uses `@prisma/client`, which only the generated Prisma client imports, and that client is not tracked.

A listed package that is not used is a finding, with the bundle as `bundle` and the package as `target`. The check does not look at which of the two keys lists a package. The other half, a package a bundle imports and does not list, is Biome's rule `noUndeclaredDependencies`, which [`biome.json`](../../../biome.json) enables as an error for `bundles/**` and CI runs with `npm run lint`.

## The exceptions file

[`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json) is one object, `{ "violations": [ … ] }`. Each entry is `{ check, bundle, target, decision, until? }`:

- `check` is one of `imports`, `declared`, `cycles`, `core`, `lists` and `dependencies`; `bundle` and `target` match a finding of that check, and for `cycles` they are the two ends of the listed edge;
- `decision` is the repository path of the document that records why the violation stays;
- `until`, when known, names the change that removes the entry.

For the five checks other than `cycles`, `diffViolations` compares the findings with the entries, matching `check`, `bundle` and `target`, and the test fails when one of three lists is not empty ([`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs)):

- `unlisted`: a finding no entry matches, and every finding of rule (1) of `imports`;
- `stale`: an entry that matches no finding, an entry that tries to excuse rule (1) of `imports`, and an entry that repeats an earlier one;
- `undocumented`: an entry of any check, `cycles` included, whose `decision` is not a file in the repository.

The `cycles` entries are judged by the check itself, as [`cycles`](#cycles) says, and by the same `decision` rule. The file therefore always equals the violations the checks find: adding one is a visible line in a reviewed change, with the document that keeps it, and removing a violation fails the check until its entry goes in the same change. The file holds no entry: `{ "violations": [] }`.

## What a client part may import, and slot names

A client part runs in a window, whose import map holds the platform's modules and one `<id>/contracts` entry for each bundle of the window's generation that has a contracts module ([`import-map.ts`](../../../app/desktop/doric/src/platform/protocol/import-map.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The build leaves those specifiers external, so the window keeps one instance of each: `react`, `react-dom`, `@base-ui/react`, `desktop/ui` and `zod` with their subpaths, `lexical`, every `@lexical/*` package, `bundle/contracts` and every `<id>/contracts` ([`externals.ts`](../../../packages/bundle/src/build/externals.ts)). A relative import that resolves into the bundle's own `src/contracts/` becomes the external `<id>/contracts` ([`parts.ts`](../../../packages/bundle/src/build/parts.ts)).

The build fails on an import a part may not contain ([`parts.ts`](../../../packages/bundle/src/build/parts.ts)):

| Part                                  | Imports that fail the build                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop part (`src/desktop/`)         | `bundle`; `react`, `react-dom`, `@base-ui/react`, `lexical`, `@lexical/*` and `desktop`, with their subpaths                                                                                        |
| Client part (`src/client/`)           | `bundle`, `bundle/runtime`, `desktop`, `desktop/client` and its subpaths                                                                                                                            |
| Frame (`src/client/frames/<name>.ts`) | What a client part may not import, every subpath of `bundle` and `desktop`, and every window specifier outside the frame's own map; `zod` and the bundle's own contracts are bundled into the frame |

A value imported from `<id>/contracts` resolves only in a window whose generation holds that bundle; a type import is erased from the built part and loads with or without it. A bundle that lists a contract under `requires` is quarantined with `missing_dependency` when no enabled bundle provides it ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)), so its client part imports the contract's ref as a value. For a contract it lists under `optional`, it imports the types with `import type` and declares the ref by its id, `ref<Api>('<id>')`, as the terminal does for the chat's contracts ([`terminal/src/client/peers.ts`](../../../bundles/features/terminal/src/client/peers.ts)); the literal id is a use the `declared` check finds, so the manifest line stays.

A slot is a region name of `regions/v1` that its owner exports from its contracts module as a constant with no type annotation, so that its type is the literal: `export const SHELL_PANEL = 'shell.panel';` ([`layout/src/contracts/index.ts`](../../../bundles/desktop/layout/src/contracts/index.ts)). The owner uses the constant as a value in its own drawing, `useRegionItems(regions, SHELL_PANEL)` ([`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)). A bundle that fills the slot writes the name as a string literal checked against the constant through a type-only import, so it loads without the owner, and a misspelled name fails its client typecheck, a command of its `build` target ([`files/src/client/index.ts`](../../../bundles/features/files/src/client/index.ts)):

```ts
import type { SHELL_PANEL } from 'layout/contracts';

regions.add('shell.panel' satisfies typeof SHELL_PANEL, item);
```

The filler lists the owner in its `package.json`, which `tsc` and Biome's rule need for the type import. A test or a story may import a slot constant as a value.

## How a bundle's parts are built

A bundle is an Nx project named `bundle-<id>` with the tag `type:bundle`, and its `build` target depends on `^build`, so every workspace package its `package.json` lists builds first ([`terminal/project.json`](../../../bundles/features/terminal/project.json)). The target runs three commands in order:

1. `tsc --build tsconfig.json` emits `src` into `dist`, the contracts module included. A bundle with a client part excludes `src/client/**` there, or includes only `src/contracts/**`, as `chat` does ([`chat/tsconfig.json`](../../../bundles/desktop/chat/tsconfig.json)), and sets `"jsx": "react-jsx"` when the part has a `.tsx` file, because esbuild reads the `tsconfig.json` nearest the entry ([`terminal/tsconfig.json`](../../../bundles/features/terminal/tsconfig.json)).
2. `tsc -p tsconfig.client.json`, in a bundle with a client part, typechecks the client part, the contracts and the stories and emits nothing ([`terminal/tsconfig.client.json`](../../../bundles/features/terminal/tsconfig.client.json)).
3. `node packages/bundle/dist/build/cli.js build <bundleDir>` validates the manifest, copies the skills and the host part's Markdown templates, builds `src/desktop/index.ts` and `src/client/index.ts` with its stylesheet, workers and frames through esbuild, loads each built part (`host`, `desktop`, `client`), fails when one does not export `activate`, dry-activates it to record what it provides and checks the record against the manifest, then writes the JSON Schemas, `contracts.json` and the built `package.json` ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`parts.ts`](../../../packages/bundle/src/build/parts.ts)). A client part is loaded with a DOM shim installed, so it may touch the DOM at load only through `class … extends HTMLElement` ([`dom-shim.ts`](../../../packages/bundle/src/build/dom-shim.ts), [`cli.ts`](../../../packages/bundle/src/build/cli.ts)).

The `typecheck` target runs the same two `tsc` commands, the first emitting declarations only, and the `test` target compiles `tsconfig.spec.json` and, for client tests, `tsconfig.client-spec.json` into `dist-tests` and runs them with `node --test` ([`terminal/project.json`](../../../bundles/features/terminal/project.json)). The host's `build-bundles` target depends on the `build` of every project tagged `type:bundle` and stages them ([`doric-host/project.json`](../../../app/backend/doric-host/project.json)).

## What a bundle's `package.json` lists

- **Its name and exports.** The `name` equals the manifest's `id`. `exports` has `./package.json`, and `./contracts` when the bundle has a contracts module another bundle imports; the importer's built part resolves `<id>/contracts` through it. Each export points `@org/source` at the source and `types`, `import` and `default` at `dist` ([`terminal/package.json`](../../../bundles/features/terminal/package.json)). A bundle may export further subpaths: `./testing`, which another bundle may import only from its tests and stories, and `./host` (`terminal`, `claude`, `codex`, `openai`, `openrouter`) or `./kernel` (`host-config`, `transport`), which no other bundle may import; the `imports` check holds both.
- **Its dependencies.** Every package the bundle imports, and nothing else, as the `dependencies` check and Biome's rule hold. It lists each workspace package it imports at that package's version; every bundle's version is `0.0.1`. In a bundle with a host part, a package that only its client part, its stories or its tests use is under `devDependencies`, as `terminal` lists `desktop`, `react` and the bundles only its client part imports ([`terminal/package.json`](../../../bundles/features/terminal/package.json)); a bundle with a client part alone lists what its sources import under `dependencies` and what only its tests import under `devDependencies` ([`layout/package.json`](../../../bundles/desktop/layout/package.json)). Each line is also the Nx edge along which `^build` builds the other package first.
- **The lockfile.** CI and the host's image install with `npm ci` under npm 11.13.0, which fails when `package-lock.json` disagrees with a `package.json` of the workspace ([`ci.yml`](../../../.github/workflows/ci.yml), [`.Dockerfile`](../../../app/backend/doric-host/.Dockerfile)). A change to `dependencies` or `devDependencies`, or a new bundle, runs `npm install` with that npm and commits `package-lock.json`.
- **The references `nx sync` writes.** The `@nx/js/typescript` plugin of [`nx.json`](../../../nx.json) derives the `references` of each bundle's `tsconfig.json`, and the root [`tsconfig.json`](../../../tsconfig.json) entry of each bundle, from the `package.json` lines. A change to those lines runs `npx nx sync` and commits what it wrote; CI fails on a difference with `npx nx sync:check` ([`ci.yml`](../../../.github/workflows/ci.yml)).
- **The references written by hand.** `nx sync` reads a project's `tsconfig.json` and only six other names, such as `tsconfig.lib.json`, which no bundle has; it does not read `tsconfig.client.json`, `tsconfig.spec.json` or `tsconfig.client-spec.json`. Their `references` are written by hand: a platform package as `../../../packages/<name>` in the client config and as `../../../packages/<name>/tsconfig.lib.json` in the spec configs, and a bundle as its directory ([`terminal/tsconfig.client.json`](../../../bundles/features/terminal/tsconfig.client.json), [`terminal/tsconfig.client-spec.json`](../../../bundles/features/terminal/tsconfig.client-spec.json), [`terminal/tsconfig.spec.json`](../../../bundles/features/terminal/tsconfig.spec.json)). With a reference, `tsc` reads the declarations the referenced project emitted; without one, it reads that package's sources through the `@org/source` condition ([`tsconfig.base.json`](../../../tsconfig.base.json)). Both compile, and no tool checks these lists.

## Related documents

- [`bundles/AGENTS.md`](../../../bundles/AGENTS.md): the rules as instructions for agents.
- [Contracts](contracts.md): the `define*` family and the `contracts` entry point.
- [Manifest](manifest.md): `provides`, `requires` and `optional`.
- [Services and channels](services-and-channels.md): the call envelope and desktop exposure.
- [Composition and distribution](composition-and-distribution.md): `composition.json` and staging.
- [Platform packages](platform-packages.md): the shared packages bundles build on.
- [UI composition](ui-composition.md): regions and the slots bundles declare.
