# Provenance of the vendored components

`src/components/*.tsx`, `src/hooks/use-mobile.ts` and `src/lib/utils.ts` are
shadcn/ui files edited locally. Each comes from one of two origins, which
`tests/fixtures/provenance.json` records per file:

- **`renderer`**: the files `app/doric-renderer` vendored with the shadcn CLI
  (`radix-nova` style), copied from commit `20775a6`, not regenerated. They are
  the components that use no Radix primitive and that `base-nova` writes
  exactly as `radix-nova` does: `alert`, `empty`, `field`, `resizable`,
  `skeleton`, `sonner`, `table`, `textarea`, plus `hooks/use-mobile.ts` and
  `lib/utils.ts` (the renderer's `utility/utils.ts`).
- **`registry`**: the Base UI components. On 2026-10-17 the app replaced Radix
  with Base UI (`@base-ui/react`), and every component that used a Radix
  primitive, or that `base-nova` writes differently, was re-derived from the
  CLI's `base-nova` style, the Base UI flavour of the `radix-nova` style the
  renderer used: `alert-dialog`, `badge`, `breadcrumb`, `button`, `checkbox`,
  `collapsible`, `combobox`, `command`, `context-menu`, `dialog`,
  `dropdown-menu`, `input`, `input-group`, `kbd`, `label`, `marker`, `popover`,
  `progress`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `tabs`,
  `toggle`, `toggle-group` and `tooltip`. `switch` was added later from the
  same CLI and style.

`scripts/verify-provenance.mjs` checks this. `desktop:test` runs it. For each
file, it undoes the import rewrites and the patches below and compares the
result with the SHA-256 the record holds for the file's origin. Any other
difference fails, and so does a component file the record does not list.

## How the Base UI components were derived

The CLI was not run blindly: before the switch, the current `radix-nova`
output was compared with the renderer's files, formatted alike. Apart from
import order, `'use client'` and `cn` coming from `'cn'`, they differed only by
the local patches this file lists, so writing `base-nova` with the same patches
keeps the renderer's ARIA and visuals, in Base UI's API. To refresh the
`registry` entries:

1. In a scratch directory, copy `components.json` (style `base-nova`), a
   `tsconfig.json` mapping `@/*` to `./src/*`, and a `package.json` naming
   `react` and `react-dom`.
2. Run `npx shadcn@4.21.0 add <names> --yes --overwrite` there with the names
   above. It writes `src/components/<name>.tsx` (and installs their packages in
   the scratch directory).
3. Format them with the repository's Prettier
   (`npx prettier --config .prettierrc --ignore-path /dev/null --write`).
4. Run `node scripts/verify-provenance.mjs --record-registry <scratch>/src/components`.

The CLI writes a leading `'use client'` directive in some files and not in
others, though `components.json` sets `rsc: false`. Nothing in a window reads
it, so the vendored files drop it and the check ignores it on both sides.

`--record <commit>` rewrites the `renderer` entries from git, as before.

To add a component later, run the CLI against this package (`npx
shadcn@4.21.0 add <name> -c packages/desktop`), rewrite its imports as
described below, and add it to the record as a `registry` file.

## Import rewrites

Imports are relative (`.js`) so that every consumer resolves them the same way.
That includes the platform's esbuild and Node.

| Origin     | Source import            | desktop/ui import        |
| ---------- | ------------------------ | ------------------------ |
| `registry` | `@/components/<name>`    | `./<name>.js`            |
| `registry` | `@/hooks/use-mobile`     | `../hooks/use-mobile.js` |
| `renderer` | `@/components/ui/<name>` | `./<name>.js`            |
| `renderer` | `@/utility/utils`        | `../lib/utils.js`        |
| `renderer` | `@/hooks/use-mobile`     | `../hooks/use-mobile.js` |

The `registry` files import `cn` from `'cn'`, as the CLI writes them;
`lib/utils.ts` re-exports the same function.

## Local patches

Patches of the `renderer` files, made in the renderer before the copy and part
of the recorded hashes:

- `sonner.tsx`: the `theme` defaults to `'dark'`, with lucide icons, the
  popover CSS variables and the `cn-toast` class, and no `next-themes`.
- `use-mobile.ts`: the renderer's own formatting and names.

Patches added in desktop/ui, which `verify-provenance.mjs` undoes before it
compares:

- `sonner.tsx`: also imports and re-exports `toast` from `sonner`
  (`export { Toaster, toast }`). Every `toast` call in a window then reaches the
  store that the window's `Toaster` reads, whichever platform chunk loaded it
  (stage 8, S8-21).
- `sonner.tsx`: now defaults to Sonner's `system` theme so native notifications
  follow the operating system while the window remains open.
- `button.tsx`: the default variant hovers with
  `hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_12%)]`
  (commit `5fac0ee`; the secondary variant's 5 % mix is now the registry's
  own).
- `button.tsx`: also defines the `solid` variant, the composer's white control: a
  white fill with an icon that stays dark on it in either theme. Filling a
  primary button white would have meant turning the theme's `--primary` into
  white, which every other primary surface reads.
- `sidebar.tsx`: keeps the `menu-sub-item` group classes on the menu action, so
  it also shows on hover and focus inside a sub-item.
- `sidebar.tsx`: also defines and exports `SidebarScope`, the sidebar context
  without the wrapper element or the shortcut, for a bundle element that draws
  sidebar rows inside the layout's sidebar from its own React root (stage 10,
  WP-10N).
- `scroll-area.tsx`: drops the registry's `import * as React from 'react'`,
  which the file never reads (`noUnusedLocals`).
- `alert-dialog.tsx`, `combobox.tsx`, `context-menu.tsx`, `dialog.tsx`,
  `dropdown-menu.tsx`, `popover.tsx`, `select.tsx`, `sheet.tsx` and
  `tooltip.tsx`: each portal passes `container={usePortalContainer()}` (read
  into a `container` constant), imported from `../portal-container.js`, so
  overlays land in the container a `PortalContainerProvider` names (a
  Papercraft preview's shadow root). The exported `*Portal` wrappers pass it
  before their spread props, so a caller's own `container` still wins.

## Fonts

`assets/fonts/*.woff2`, `NotoSans-OFL.txt` and `IBMPlexMono-OFL.txt` are byte
copies of `app/desktop/doric-renderer/src/assets/fonts`. `src/styles/fonts.css` holds
the 12 `@font-face` rules from the renderer's `styles.css` (lines 5-169), with
the URLs rebased to `../../assets/fonts/`.

## Papermache visual tokens

`src/tokens/tokens.ts` maps the theme values from the local Papermache capture
`app.paper.design/assets/index-DtkxL5QJ.css` (2026-10-07, theme block around
lines 109-250) into Doric's existing semantic tokens. The `--paper-*` variables
preserve values used directly by the adapted dashboard and tabs: root and panel
surfaces, two panel highlights, separators, controls, gray text levels, blue
focus, thumbnails, compact type sizes, radii, and the inset control shadow.
`src/styles/tokens.css` is generated from that source module by
`scripts/build-tokens.mjs`.

Papermache's macOS system font stack is used for interface text, with Doric's
licensed Noto Sans as fallback. IBM Plex Mono remains the code and conversation
face. Doric keeps its own Project colors. The shadcn `--ring` and `--destructive`
tokens retain stronger contrast where its focus ring and tinted destructive
button need it; `--paper-focus` and `--paper-red` carry Papermache's exact values
for surfaces that use their original treatment.
