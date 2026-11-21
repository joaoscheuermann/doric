# doric-renderer

Apply these rules to `app/desktop/doric-renderer/`. Follow the root
[`AGENTS.md`](../../../AGENTS.md) first; this file narrows it.

## Function

Keep this project to the window shell: the page every app window loads, its
bootstrap, its window-wide stylesheet and its dev server. Never add a
component, hook, store, page, region item or product logic to it: each belongs
to the bundle that draws it, under that bundle's `src/client/`, and follows
[`bundles/AGENTS.md`](../../../bundles/AGENTS.md).

## Rules

- Read [`README.md`](README.md) for what the shell does before adding to it.
- Accept only a change to the shell itself: its bootstrap
  ([`src/bootstrap.ts`](src/bootstrap.ts),
  [`src/scheme.ts`](src/scheme.ts)), its template
  ([`src/shell.html`](src/shell.html)), its window-wide stylesheet
  ([`src/styles.css`](src/styles.css)), its dev-server overlay filter
  ([`overlay-errors.js`](overlay-errors.js)), its build
  ([`webpack.config.js`](webpack.config.js),
  [`postcss.config.mjs`](postcss.config.mjs), [`.babelrc`](.babelrc),
  [`package.json`](package.json), [`project.json`](project.json), the
  `tsconfig*.json` files) or its tests (`tests/`).
- Start a window only through `bootstrapWindow` of `desktop/client` in
  [`src/bootstrap.ts`](src/bootstrap.ts); never open HTTP or Socket.IO from the
  shell, and never add a channel to the preload
  ([`app/desktop/doric/src/app/api/preload.ts`](../doric/src/app/api/preload.ts))
  for it: every host or desktop call is a contract call.
- Keep `.dark` on the window's `document.documentElement` driven only by
  `followScheme` in
  [`src/scheme.ts`](src/scheme.ts), and change its signature only together
  with its other caller,
  [`app/desktop/doric-e2e/tests/fixtures/shell-bootstrap.mjs`](../doric-e2e/tests/fixtures/shell-bootstrap.mjs).
- Keep the shell's URL prefix `/platform/shell@<version>/` in
  [`webpack.config.js`](webpack.config.js) and the icon's URL in
  [`src/shell.html`](src/shell.html) equal to `PLATFORM_ASSETS_VERSION` of
  [`packages/bundle/src/runtime/version.ts`](../../../packages/bundle/src/runtime/version.ts):
  main serves the shell only under that version
  ([`resources.ts`](../doric/src/platform/protocol/resources.ts)).
- Keep the dev server on port 4200; to change it, change these together: `port` and
  `webSocketURL` in [`webpack.config.js`](webpack.config.js),
  `DEFAULT_DEV_SERVER_ORIGIN` in
  [`dev-proxy.ts`](../doric/src/platform/protocol/dev-proxy.ts) (which
  `DORIC_RENDERER_DEV_URL` overrides at run time), and the `wait-on` of the
  `doric:dev` script in the root [`package.json`](../../../package.json).
- Keep [`overlay-errors.js`](overlay-errors.js) self-contained: the dev server
  sends `showsInOverlay` to the page as source text, so it must read nothing
  from outside its own body.
- Put in [`src/styles.css`](src/styles.css) only rules that apply to every
  page of every window (the `base` layer, `.chrome-bar` and the footer rule)
  and the utility set; put a rule that one bundle draws in that bundle's
  `src/client/styles.css`.
- Define no font face, token or preflight rule in
  [`src/styles.css`](src/styles.css), and set no weight on `body` or a heading
  there: they belong to the theme,
  [`packages/desktop/src/styles/theme.css`](../../../packages/desktop/src/styles/theme.css).
- Never weaken or override the footer rule of
  [`src/styles.css`](src/styles.css) (`font-weight: 400 !important` on
  `footer` and every `data-slot` ending in `-footer`, nested controls
  included): bundles rely on it.
- Keep the utility set in [`src/styles.css`](src/styles.css) generated from
  named sources only (`source(none)` with `@source` for this project's `src/`,
  `packages/desktop/src` and `bundles/*/*/src/client/**/*`), so that it holds
  every utility the theme and the bundles' sheets emit, in their order, wherever
  the build runs.
- Add every new module under `src/` to the `include` of
  [`tsconfig.app.json`](tsconfig.app.json), or `typecheck` never sees it.
- Cover a change to [`src/styles.css`](src/styles.css) or to how the sheets
  cascade with a case in
  [`tests/stylesheet.test.ts`](tests/stylesheet.test.ts), and a change to
  [`overlay-errors.js`](overlay-errors.js) with a case in
  [`tests/overlay-errors.test.ts`](tests/overlay-errors.test.ts), run as the
  page runs it.
- Cover a change to [`src/bootstrap.ts`](src/bootstrap.ts),
  [`src/scheme.ts`](src/scheme.ts), [`src/shell.html`](src/shell.html) or
  [`webpack.config.js`](webpack.config.js) with a case in
  [`app/desktop/doric-e2e/tests/`](../doric-e2e/tests/)
  ([`shell.test.ts`](../doric-e2e/tests/shell.test.ts) for the real shell,
  [`theme.test.ts`](../doric-e2e/tests/theme.test.ts) for the scheme), and run
  `npx nx run doric-app-e2e:e2e`, which builds this project first.
- Write a new test as a `tests/*.test.ts` file for `node --test`, and add it
  to the `include` of [`tsconfig.spec.json`](tsconfig.spec.json), or the
  `test` target never compiles it.
- Update [`README.md`](README.md) in the same change as any change to the
  shell's bootstrap, template, stylesheet, overlay filter or build, and update
  the feature doc [ui-redesign](../../../docs/features/ui-redesign.md) when the
  change touches the window's scheme or styles, and the architecture document
  [doric-protocol](../../../docs/architecture/bundles/doric-protocol.md) when
  it touches how main serves the shell, and the architecture document
  [window-appearance](../../../docs/architecture/bundles/window-appearance.md)
  when it touches `.chrome-bar`.

## Verify

Run each command from the repository root.

- `npx nx run doric-renderer:typecheck`: run it after any change under `src/`
  or to a `tsconfig*.json` file.
- `npx nx run doric-renderer:test`: run it after any change to
  `src/styles.css`, `overlay-errors.js` or `tests/`, to `tsconfig.app.json` or
  `tsconfig.spec.json`, to `packages/desktop/src/styles/theme.css`, or to the sheets the stylesheet
  test reads, `bundles/desktop/chat/src/client/styles.css` and
  `bundles/desktop/layout/src/client/styles.css`, and run the tests only
  through this target, which removes `dist-tests` first so that a deleted test
  never runs from stale output.
- `npx nx run doric-renderer:build`: run it after any change under `src/`,
  under `packages/desktop/src/` or under a bundle's `src/client/` (the
  utility set scans them), or to `webpack.config.js`, `postcss.config.mjs`,
  `.babelrc`, `package.json` or `project.json`.

## Generated files

- The `references` of `tsconfig.app.json`: do not edit them by hand; run
  `npx nx sync`.
