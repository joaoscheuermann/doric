# Bundle Agent Instructions

Apply these rules to every bundle under `bundles/<group>/<id>/`, after the root
[`AGENTS.md`](../AGENTS.md) and before the bundle's own `AGENTS.md`. Read
[`docs/architecture/bundles/boundaries.md`](../docs/architecture/bundles/boundaries.md)
before a change that adds a contract, a slot, a dependency between bundles or
an entry of the exceptions file.

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
- Make every contract method and contribution that crosses a process take and
  return plain data: such a contribution names an element tag and gives props,
  its element answers with DOM events, and it passes no function, component or
  live object except a subscription listener. A method or contribution that
  stays in one process may take a function or a React element.
- Keep every boundary rule a machine can check as a test that CI runs, and
  record every standing violation as one entry of
  [`tests/boundary-exceptions.json`](../tests/boundary-exceptions.json).

## Imports

- Import another bundle's package only as exactly `<other>/contracts`; import
  `<other>/testing` only under `tests/` or `stories/`, and `<other>/package.json`
  only under `tests/`. Never import any other subpath, such as
  `<other>/contracts/<file>` or `<other>/host`.
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
  declaration.
- Never list a `doric.*` contract under `provides` or `requires`: the platform
  always provides it, and a use of it needs no declaration.
- Never list an id twice in one of `provides` and `requires`, and never list
  under `requires` or `optional` an id that no manifest provides.
- Remove every package from `dependencies` and `devDependencies` that no file
  of the bundle imports, but keep `tslib`, keep `react` in a bundle with a
  `.tsx` or `.jsx` file, and keep `@types/<m>` when `<m>` is `node` or a
  package the bundle imports (`@types/a__b` stands for `@a/b`).

## Contracts module

- Put the bundle's contract declarations, their types and its slot names in
  `src/contracts/`, exported from `src/contracts/index.ts`, which the package
  exports as `<id>/contracts`.
- Declare a contract only with the `define*` functions of `bundle/contracts`.
- Never import `src/host`, `src/desktop` or `src/client` from `src/contracts/`,
  and never import a Node built-in there: the window loads the module as
  `<id>/contracts` through its import map.
- In the bundle's own parts, import its contracts by relative path
  (`../contracts/index.js`); the build turns that import into `<id>/contracts`.

## Parts

- Export `activate` from the entry of every part the bundle has
  (`src/host/index.ts`, `src/desktop/index.ts` and `src/client/index.ts`), or
  the build fails.

### Host part

- Put the host part in `src/host/`.
- Keep every Markdown template the host part reads under `src/host/`, where the
  build copies it from.

### Desktop part

- Put the desktop part in `src/desktop/`.
- Never import `bundle`, `desktop` or any `desktop/*` subpath, `react`,
  `react-dom` or any of their subpaths, `@base-ui/react` or any of its
  subpaths, `lexical` or `@lexical/*` from a desktop part: its build fails on
  them.

### Client part

- Put the client part in `src/client/`, with its stylesheet in
  `src/client/styles.css`.
- Never import `bundle`, `bundle/runtime`, `desktop`, `desktop/client` or any
  `desktop/client/*` subpath from a client part: its build fails on them.
- Import React, `react-dom`, `@base-ui/react`, Lexical, `desktop/ui/*`, `zod`,
  `bundle/contracts` and every `<id>/contracts` only by their package
  specifiers, so that the window keeps one instance of each; never copy them
  into a bundle.
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
  `@lexical/*`), or any `<id>/contracts`: the build fails on them.
- Take a shadcn primitive from `desktop/ui/<name>`, and take `toast` only from
  `desktop/ui/sonner`, so that a window has one toast store.
- Bind persistent work to the services the part's `activate` receives, never
  to the services an element receives: an element's services are disposed
  with the element.
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
  matches no finding fails the check.

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
- `package-lock.json`: do not edit it by hand; run `npm install` after a change
  to a bundle's `package.json` dependencies.
