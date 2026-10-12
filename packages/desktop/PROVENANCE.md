# Provenance of the vendored components

`src/components/*.tsx` and `src/hooks/use-mobile.ts` are the shadcn/ui files
that `app/doric-renderer` vendored with the shadcn CLI and edited locally.
`src/lib/utils.ts` is the renderer's `utility/utils.ts`. They were copied from
commit `20775a6`, not regenerated.

`scripts/verify-provenance.mjs` checks this. `desktop:test` runs it. For each
file, it undoes the import rewrites and the patches below and compares the
result with the SHA-256 that `tests/fixtures/provenance.json` records for the
renderer file. Any other difference fails, and so does a component file the
record does not list. To refresh the record from git, run
`node scripts/verify-provenance.mjs --record <commit>`.

## Why the files were not regenerated

The design asked for `npx shadcn@4.21.0 add --all` (the lockfile's CLI) with
`components.json`. That command was run on 2026-10-09 into a scratch directory.
The current registry no longer reproduces the vendored files. Even after
formatting, every one of the 34 components differs. Some examples:

- imports are reordered;
- `cn` comes from `'cn'` instead of `@/lib/utils`;
- `button.tsx` hovers with `hover:bg-primary/80`;
- `sidebar.tsx` drops the `menu-sub-item` group classes;
- `sonner.tsx` depends on `next-themes`;
- `use-mobile.ts` is written differently.

Regenerating would therefore change ARIA and visuals the app relies on (risk R3).
The `--all` set would also add 27 components the app does not use, along with
their libraries: `recharts`, `react-day-picker`, `embla-carousel-react`,
`input-otp`, `vaul`, `@shadcn/react` and `next-themes`.

So only the 34 files the renderer vendored are kept. To add a component later,
run the CLI against this package (`npx shadcn@4.21.0 add <name> -c
packages/desktop`), rewrite its imports as described below, and add it to
the record.

## Import rewrites

Imports are relative (`.js`) so that every consumer resolves them the same way.
That includes the renderer's webpack, where `@/` already names the renderer's
own `src`, the platform's esbuild and Node.

| Renderer import          | desktop/ui import        |
| ------------------------ | ------------------------ |
| `@/components/ui/<name>` | `./<name>.js`            |
| `@/utility/utils`        | `../lib/utils.js`        |
| `@/hooks/use-mobile`     | `../hooks/use-mobile.js` |

`command.tsx`, `marker.tsx` and `toggle-group.tsx` import `cn` from `'cn'`, as
they already did.

## Local patches

These edits were made in the renderer before the copy, and the copy carries
them unchanged. They are part of the recorded hashes:

- `button.tsx`: the default variant hovers with
  `hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_12%)]`, and the
  secondary variant uses the 5 % mix (commit `5fac0ee`). `Comp` is renamed to
  `Component`.
- `sonner.tsx`: the `theme` defaults to `'dark'`, with lucide icons, the
  popover CSS variables and the `cn-toast` class, and no `next-themes`.
- `marker.tsx`: not a stock registry component. It is vendored locally.
- `sidebar.tsx`: keeps the `menu-sub-item` group classes.
- `use-mobile.ts`: the renderer's own formatting and names.

These edits were added in desktop/ui. `verify-provenance.mjs` undoes them before
it compares:

- `sonner.tsx`: also imports and re-exports `toast` from `sonner`
  (`export { Toaster, toast }`). Every `toast` call in a window then reaches the
  store that the window's `Toaster` reads, whichever platform chunk loaded it
  (stage 8, S8-21).
- `sidebar.tsx`: also defines and exports `SidebarScope`, the sidebar context
  without the wrapper element or the shortcut, for a bundle element that draws
  sidebar rows inside the layout's sidebar from its own React root (stage 10,
  WP-10N).

## Fonts

`assets/fonts/*.woff2`, `NotoSans-OFL.txt` and `IBMPlexMono-OFL.txt` are byte
copies of `app/doric-renderer/src/assets/fonts`. `src/styles/fonts.css` holds
the 12 `@font-face` rules from the renderer's `styles.css` (lines 5-169), with
the URLs rebased to `../../assets/fonts/`.
