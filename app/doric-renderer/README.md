# Doric renderer

`doric-renderer` is the React, Tailwind CSS, Radix, and shadcn/ui surface loaded
by `doric-app`. Its compact sidebar creates, selects, renames, and deletes named
Projects and recursive Threads. The selected Thread owns a local text editor;
prompt submission is intentionally out of scope. The document starts with
shadcn's `.dark` theme before React renders, using the repository's warm
neutral and green-accent OKLCH palette.

The custom title bar keeps native macOS traffic lights visible and owns the
sidebar toggle. The sidebar uses shadcn's `Resizable` panel and can be collapsed
or dragged between its configured minimum and maximum widths.

The renderer has no direct network access to Doric. It uses the semantic
`window.doric` API exposed by the Electron preload boundary.

## Development

Use the combined Electron workflow from the repository root:

```console
npm run doric:dev
```

Run renderer checks directly with:

```console
npx nx run doric-renderer:typecheck
npx nx run doric-renderer:lint
npx nx run doric-renderer:test
npx nx build doric-renderer
```

Add or inspect components through the project-aware shadcn CLI:

```console
npx shadcn@latest info --json -c app/doric-renderer
npx shadcn@latest add COMPONENT -c app/doric-renderer
```
