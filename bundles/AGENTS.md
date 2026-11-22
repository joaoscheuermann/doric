# Bundle Agent Instructions

Apply these rules to every bundle under `bundles/<group>/<id>/`, after the root
[`AGENTS.md`](../AGENTS.md) and before the bundle's own `AGENTS.md`. Read
[`docs/architecture/bundles/boundaries.md`](../docs/architecture/bundles/boundaries.md)
before a change that adds a contract, a slot, a dependency between bundles or
an entry of the exceptions file, and
[`docs/features/bundle-isolation.md`](../docs/features/bundle-isolation.md) for
the decisions behind the boundary rules before changing one of them.

## Boundaries

- Keep a bundle to the one function its manifest `description` states, and add
  a contract, slot, route or tool to it only when it serves that function.
- Reach another bundle only through what it publishes: its contracts, imported
  from `<id>/contracts`, in tests and stories also its `testing` entry, and in
  tests its `package.json`, as [Imports](#imports) allows.
- Keep every dependency pointing one way: when bundle B contributes into bundle
  A, A must not name B. The edges of `requires` and `optional` between bundles
  must form no cycle; each edge runs from the bundle that lists a contract to
  its provider, except for a contract that its declaring bundle lists (the
  `declaredContracts` of
  [`tests/support/boundaries.mjs`](../tests/support/boundaries.mjs)), whose
  edge runs from each provider to the declarer.
- Add every way to extend a bundle as a contract it provides or a slot it
  declares; register the members of an open set (tools with a drawing, icons,
  tab kinds, provider kinds, input sources, skill sources) and never enumerate
  them.
- Register a bundle's own tools, commands, routes, slot items and drawings from
  its own code; never register, open or draw anything on behalf of another
  bundle.
- Keep `core` generic: never give a `desktopScope` key of `core` a
  `projectId`, `threadId` or `promptId`, and never write the route
  `'/settings'` in `bundles/foundation/core/src/`.
- Read a record only through a contract of the bundle that owns it; never hand
  out another bundle's record type through your own contract, and publish a
  view of another bundle's data only as a type you declare that holds what
  your own function produces from that data.
- Expose persistence as operations; never hand out a live client or connection
  through a contract.
- Derive every list of bundles from the manifests on disk; never write a
  `bundles/<group>/<id>` path or a `"bundle-<id>"` name into a build file of
  `doric-host`, and never put an id with no manifest into its
  `composition.json`.
- Make every contract method you add take and return plain data, and every
  contribution you add to another bundle's surface name an element tag and give
  props, with its element answering with DOM events; pass no function,
  component or live object through either, except a subscription listener and
  the `Disposable` that ends a registration or subscription. Do not reshape an
  existing contract that only moves to another bundle to meet this rule. Read
  [Two rules for the content of a contract](../docs/architecture/bundles/contracts.md#two-rules-for-the-content-of-a-contract)
  before you add a contract method or contribution; no test checks this rule.
- Keep every boundary rule a machine can check as a test that CI runs, and
  record every standing violation as one entry of
  [`tests/boundary-exceptions.json`](../tests/boundary-exceptions.json).

## Imports

- Import another bundle's package only as exactly `<other>/contracts` or as
  `<other>/contracts/gen/<path>`, its generated code; import `<other>/testing`
  only under `tests/` or `stories/`, and `<other>/package.json` only under
  `tests/`. Never import any other subpath, such as `<other>/contracts/<file>`
  or `<other>/host` (spec §8 "Layout",
  [`grpc-processes.md`](../docs/designs/grpc-processes.md#8-contracts-in-proto)).
- Until phase 3, a client or desktopMain part imports neither
  `<other>/contracts/gen/*` nor its own generated code: its build externalizes
  only `bundle/contracts` and `*/contracts`, and turns its own
  `src/contracts/…` imports into `<id>/contracts`.
- Through phase 6 the zod `define*` contracts are the runtime truth and the
  `.proto` files the target shape. When you change a zod contract, also update
  its `.proto` and its row in
  `docs/designs/grpc-processes/contract-inventory.md`; the inventory test
  checks only ids and rows.
- Never add an entry of the exceptions file for an import of a workspace
  package's `src/` path: no entry can excuse it.
- Apply these rules to a dynamic `import()` and to a resolve call as to a
  static import.
- Import a slot name of another bundle with `import type` only, and write the
  slot as a literal checked against it
  (`'shell.panel' satisfies typeof SHELL_PANEL`).
- Write relative imports with their `.js` extension.

## Manifest and package

- Make the `id` of `manifest.json` equal the `name` of the bundle's
  `package.json`.
- Write each `provides` entry as `<id>@<version>`, with an exact version whose
  major equals the `/v<major>` of the id.
- Provide, define or register every `provides` entry during `activate` of one
  of the bundle's parts, and list in `provides` every contract a part
  provides, defines or registers; never record the same contract twice in one
  environment.
- List under `requires`, as `<id>@<range>`, every contract the bundle's
  activation depends on, with a range that admits only the major of the id;
  list under `optional`, as the bare id, every contract the bundle uses only
  when it is present.
- Declare there every contract id the bundle does not provide that `src/`
  writes as a whole string literal, or imports as a value symbol from
  `<other>/contracts` or `bundle/contracts`; an `import type` needs no
  declaration, and the `core` bundle declares only the ids it writes as
  literals, not those of the symbols it imports from `bundle/contracts`
  (`findDeclared` in
  [`tests/support/boundaries.mjs`](../tests/support/boundaries.mjs)).
- Never list a `doric.*` contract under `provides` or `requires`: the platform
  always provides it, and a use of it needs no declaration.
- Never list an id twice in one of `provides` and `requires`, and never list
  under `requires` or `optional` an id that no manifest provides.
- Raise `engines.doric` to the platform version that first has a shared module
  the bundle imports statically or a platform contract it cannot work without:
  the catalog quarantines a bundle whose range the platform does not meet
  ([`catalog.ts`](../packages/bundle/src/runtime/catalog.ts)). Reach a platform
  contract the bundle can do without through `services.whenAvailable`, and load
  a `desktop/ui` module it can do without with a dynamic `import()`
  ([Versioning](../docs/architecture/bundles/versioning.md)).
- List in `package.json` every package a file of the bundle imports, another
  bundle and every workspace package at its version (`0.0.1` for a bundle):
  under `devDependencies` when only its tests or stories import it, and
  otherwise under `dependencies`, or under `devDependencies` when only the
  client part of a bundle with a host part imports it, as
  [`terminal/package.json`](features/terminal/package.json) does; the boundary
  check does not check which key a package is under
  ([`tests/support/boundaries.mjs`](../tests/support/boundaries.mjs)).
  `npm run lint` fails on an undeclared import
  (`noUndeclaredDependencies` in [`biome.json`](../biome.json)), and each line
  is the edge along which `^build` builds that package first.
- Remove every package from `dependencies` and `devDependencies` that no file
  of the bundle imports, but keep `tslib`, keep `react` in a bundle with a
  `.tsx` or `.jsx` file, and keep `@types/<m>` when `<m>` is `node` or a
  package the bundle imports (`@types/a__b` stands for `@a/b`).

## Contracts module

- Put the bundle's contract declarations, their types and its slot names in
  `src/contracts/`, exported from `src/contracts/index.ts`, which the package
  exports as `<id>/contracts`.
- Declare a contract only with `ref` and the `define*` functions of
  `bundle/contracts`.
- Never import `src/host`, `src/desktop` or `src/client` from `src/contracts/`,
  and never import a Node built-in there: the window loads the module as
  `<id>/contracts` through its import map
  ([`import-map.ts`](../app/desktop/doric/src/platform/protocol/import-map.ts)).
- In the bundle's own parts, import its contracts by relative path
  (`../contracts/index.js`); in a desktop or client part the build turns that
  import into `<id>/contracts`
  ([`parts.ts`](../packages/bundle/src/build/parts.ts)).

## Parts

- Export `activate` from the entry of every part the bundle has
  (`src/host/index.ts`, `src/desktop/index.ts` and `src/client/index.ts`), or
  the build fails ([`cli.ts`](../packages/bundle/src/build/cli.ts)).
- When a feature gives a bundle a part it does not have, add the part's
  configuration as
  [How a bundle's parts are built](../docs/architecture/bundles/boundaries.md#how-a-bundles-parts-are-built)
  states: for a client part, exclude `src/client/**` from `tsconfig.json`, add
  `tsconfig.client.json` and run `tsc -p tsconfig.client.json` in the `build`
  and `typecheck` targets of `project.json`, as
  [`account/project.json`](desktop/account/project.json) does, and set
  `"jsx": "react-jsx"` in `tsconfig.json` when the part has a `.tsx` file.
- Put each skill the bundle ships in `src/skills/<name>/SKILL.md`, with only the
  frontmatter keys [`skills.ts`](../packages/bundle/src/loader/skills.ts)
  accepts, and an `order` no other skill in the repository holds
  (`grep -rn '^order:' bundles/*/*/src`): skills are sorted across bundles by
  `order`, and a tie falls back to registration order
  ([`core/src/host/skills.ts`](foundation/core/src/host/skills.ts)). The build
  rejects a `SKILL.md` whose frontmatter is invalid
  ([`cli.ts`](../packages/bundle/src/build/cli.ts)).

### Host part

- Put the host part in `src/host/`.
- Keep every Markdown template the host part reads under `src/host/`, where the
  build copies it from.

### Desktop part

- Put the desktop part in `src/desktop/`.
- Never import `bundle`, `desktop` or any `desktop/*` subpath, `react`,
  `react-dom` or any of their subpaths, `@base-ui/react` or any of its
  subpaths, `lexical` or `@lexical/*` from a desktop part: its build fails on
  them ([`parts.ts`](../packages/bundle/src/build/parts.ts)).

### Client part

- Put the client part in `src/client/`, with its stylesheet in
  `src/client/styles.css`, and never write `@theme` in that stylesheet: the
  build fails on it ([`parts.ts`](../packages/bundle/src/build/parts.ts)).
- Never import `bundle`, `bundle/runtime`, `desktop`, `desktop/client` or any
  `desktop/client/*` subpath from a client part: its build fails on them
  ([`parts.ts`](../packages/bundle/src/build/parts.ts)).
- Import React, `react-dom`, `@base-ui/react`, Lexical, `desktop/ui/*`, `zod`,
  `bundle/contracts` and every `<id>/contracts` only by their package
  specifiers, so that the window keeps one instance of each through its import
  map ([`import-map.ts`](../app/desktop/doric/src/platform/protocol/import-map.ts));
  never copy them into a bundle.
- Put a web worker in `src/client/workers/<name>.ts`: the build bundles
  everything it imports into it, with nothing external, since a worker runs
  outside the window's import map. Put a module the client part imports on
  demand in `src/client/chunks/<name>.ts`. The build builds workers and chunks
  only when the bundle has `src/client/index.ts`
  ([`parts.ts`](../packages/bundle/src/build/parts.ts)).
- Touch the DOM at module load only through `class … extends HTMLElement`, and
  load a heavy DOM library (Monaco, xterm) with a dynamic `import()` inside a
  component.
- In a frame (`src/client/frames/<name>.ts`), import only `react`,
  `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`,
  `react-dom/client`, `@base-ui/react` and its subpaths as externals, and
  import the bundle's own contracts by relative path, so that the build
  bundles them into the frame, as it bundles `zod`. Never import from a frame
  `bundle`, `desktop` or any of their subpaths, any other package of the
  window's import map (another subpath of `react` or `react-dom`, `lexical`,
  `@lexical/*`), or any `<id>/contracts`: the build fails on them
  ([`parts.ts`](../packages/bundle/src/build/parts.ts)).
- Keep a bundle's story harness at `.storybook/preview.tsx` and import
  `desktop/ui/theme.css` there, as
  [`account/.storybook/preview.tsx`](desktop/account/.storybook/preview.tsx)
  does, and wire no portal container there.
- Put the bundle's stories under `stories/`, never in `src/`, as CSF files
  named `<name>.stories.tsx`; a story need not sit at the path of a source
  file. Put the fixtures that stories share under `stories/support/`; a test
  may import them from there.
- Import no `@storybook/*` package in a story or a harness, take shared
  components from `desktop/ui/*`, and seed stores and providers with
  fixtures, never with a live host, as the
  [Stories](../packages/AGENTS.md#stories) rules of `packages/AGENTS.md`
  require.
- Keep every story inside the `include` of `tsconfig.client.json`, which the
  `typecheck` target compiles
  ([`account/project.json`](desktop/account/project.json)).
- Take a shadcn primitive from `desktop/ui/<name>`, and take `toast` only from
  `desktop/ui/sonner`, so that a window has one toast store.
- Bind persistent work to the services the part's `activate` receives, never
  to the services an element receives: an element's services are disposed
  with the element
  ([`elements.ts`](../packages/desktop/src/client/elements.ts)).
- Keep all footer text, nested controls included, at `font-weight: 400` through
  the footer rule of `app/desktop/doric-renderer/src/styles.css`: mark a
  footer with a semantic `footer` element or a `data-slot` ending in
  `-footer`, and add no per-control weight inside it.
- Reach weight 400 for labels and titles and 300 for running text only through
  the components of `desktop/ui` and the theme's root weight; add no
  per-control weight for them.

## Exceptions

- Add an entry to
  [`tests/boundary-exceptions.json`](../tests/boundary-exceptions.json) only
  for a violation that must stay, as one item of `violations` with `check`,
  `bundle`, `target`, `decision` (the repository path of an existing document
  that records why it stays) and, when known, `until`.
- For a `cycles` entry, set `bundle` and `target` to the two ends of the edge
  that breaks the cycle.
- Remove an entry in the change that removes its violation: an entry that
  matches no finding fails the check (`diffViolations` in
  [`tests/support/boundaries.mjs`](../tests/support/boundaries.mjs)).

## Tests

- Put a bundle's tests in its `tests/` folder as `*.test.ts` files written for
  `node --test`, and keep them DOM-free; put a test that needs a window in
  `tests/client/`, booting `happy-dom`.
- Put a test only in a folder whose compiled files the `test` target of the
  bundle's `project.json` runs. When a bundle gets its first test in another
  folder, such as its first test under `tests/client/`, extend that target to
  compile and run the folder's tests; otherwise the target never runs them.
- Exercise a part's services in a unit test through `createTestServices` from
  `bundle/testing`.

## Features and README

- Add a feature to a bundle in these steps, in one change:
  1. Read the `README.md` in the bundle's directory for what it does, and the
     README of each bundle whose contract or slot the feature uses, for that
     contract's full shape; the `define*` family and the platform's basic
     contracts are in [Contracts](../docs/architecture/bundles/contracts.md).
  2. Declare each contract and slot name the feature adds in `src/contracts/`,
     as [Contracts module](#contracts-module) requires, and list under
     `provides` of `manifest.json` each contract that a part of the bundle
     provides, defines or registers, as
     [Manifest and package](#manifest-and-package) requires. When the feature
     adds a member to a contract the bundle already provides (a method, an
     output field, an optional input field or an error code), raise the minor
     of that contract's `provides` entry and of the manifest's `version`, and
     raise to that minor the `requires` range of each bundle that uses the new
     member; when it removes or renames a member, adds a required field or
     changes a meaning, declare a new contract with the next `/v<major>` id,
     keep providing the earlier major while any manifest still requires it,
     and raise the major of the manifest's `version`. When the feature adds a
     new contract or a contribution to another bundle's contract or slot,
     raise the minor of the manifest's `version`; a fix with no change of
     schema raises its patch
     ([Versioning](../docs/architecture/bundles/versioning.md)).
  3. List under `requires`, or under `optional` when the feature works without
     it, each contract the feature reaches with `services.use`,
     `services.whenAvailable` or `hooks.use` that the bundle does not provide,
     as [Manifest and package](#manifest-and-package) requires; `services.use`
     or `hooks.use` of an unlisted one throws `undeclared_requirement`
     ([`services.ts`](../packages/bundle/src/runtime/services.ts)).
  4. Give each method a window calls `expose: 'desktop'` in its
     `defineMethod`, and no other method: a window reaches only exposed
     methods and gets `unavailable` for the rest
     ([`exposure.ts`](../packages/bundle/src/runtime/exposure.ts),
     [`dispatcher.ts`](../app/desktop/doric/src/platform/bridge/dispatcher.ts)).
     List under `desktopScope` of `manifest.json`, for that contract, each
     scope key (such as `projectId`, `threadId` or `promptId`) the window
     sends: the desktop refuses a call whose scope holds an unlisted key with
     `invalid_input`
     ([`dispatcher.ts`](../app/desktop/doric/src/platform/bridge/dispatcher.ts)).
     Never list `windowKey`: the platform sets it and the manifest schema
     refuses it ([`manifest.ts`](../packages/bundle/src/runtime/manifest.ts)).
  5. Put the feature's code in the part that runs it: `src/host/` for work in
     the host, `src/desktop/` for work in the desktop's `desktopMain` process,
     and `src/client/` for what a window draws
     ([`activate.ts`](../packages/bundle/src/loader/activate.ts),
     [`parts.ts`](../packages/bundle/src/build/parts.ts),
     [manifest](../docs/architecture/bundles/manifest.md)), as
     [Parts](#parts) requires.
  6. Add, as [Tests](#tests) requires, a test for each contract method, hook,
     tool, command and element the feature adds, through its public
     interface: a part's services through `createTestServices`, an element in
     `tests/client/` under `happy-dom`; follow the root
     [Testing](../AGENTS.md#testing) rule.
  7. Update the bundle's `README.md`, and each feature doc in `docs/features/`
     that describes the feature when one exists.
- In a bundle's own `AGENTS.md`, state only the steps of adding a feature that
  are specific to that bundle.
- Keep a bundle's `README.md` its complete overview: its public interface
  (contracts, manifest, exports, routes, tools, events), its behavior and
  logic, its data shapes and persistence, its side effects, its configuration,
  its limits, its errors and failure behavior, and how it is built and tested.
  Update it in every change to the bundle's interface, behavior or data.

## Verify

Run each command from the repository root.

- `npm run lint:test`: run it after every change the root
  [`AGENTS.md`](../AGENTS.md) names for it, and also after a change to a
  contracts module, to a contract id written in `src/`, or to
  `tests/boundary-exceptions.json`.
- `npx nx sync:check`: run it after a change to a bundle's `package.json`
  dependencies or after adding a bundle.
- `npx nx run-many -t typecheck test build --projects=tag:type:bundle --parallel=1`:
  run it after a change to a contracts module or to the `provides` of a
  manifest, since other bundles build against them.

## Generated files

- The `references` of each bundle's `tsconfig.json`, and the root
  `tsconfig.json` entry of each bundle: do not edit them by hand; run
  `npx nx sync`.
- `package-lock.json`: do not edit it by hand; run `npm install` with npm
  11.13.0, the version CI installs
  ([`ci.yml`](../.github/workflows/ci.yml)), after a change to a bundle's
  `package.json` dependencies.
