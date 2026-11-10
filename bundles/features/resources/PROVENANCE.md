# Provenance of the cloud glyphs

`src/client/monitor/cloud-glyphs.ts` holds two glyphs of the Doric-UI Figma
file, drawn by the connection badge as CSS masks (UR24,
`docs/designs/ui-redesign.md` §2.7). No shared icon module holds them.

- Figma file key: `ITniMiH6BnZHhuX6NkJhqP`.
- Export: the Figma MCP's `download_assets` with `defaultFormat: 'svg'`, one
  call per node, on 2026-11-09.
- Edit: every `fill` attribute value is set to `#000` (a mask reads only
  alpha):

  ```js
  svg.replace(/(\s)fill="[^"]*"/g, '$1fill="#000"');
  ```

  Before it, two changes that the export forced:

  - The whitespace-only line breaks between tags, and the trailing one, are
    removed (`svg.replace(/>\s*\n\s*</g, '><').trimEnd()`), so the value fits
    a single-quoted literal.
  - The export draws two rectangles from outside the node: the canvas
    background (`<rect width="24" height="24" fill="#1E1E1E"/>`) and the
    `Icons / lucide` frame's background
    (`<rect x="…" y="-232" width="1200" height="296" rx="8" fill="#1C1A17"/>`).
    Both are removed. Neither belongs to the node (its only child is the
    `Vector`), and once set to `#000` they would make the mask an opaque
    square. No `<mask>` or `<clipPath>` is present in either export.

  Nothing else changes.

- Each value is written between single quotes with no escape, so the
  module's literal is the value byte for byte.

| Export               | Node     | Figma name     | Source SHA-256                                                     | Bytes | Stored SHA-256                                                     | Length |
| -------------------- | -------- | -------------- | ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------ | ------ |
| `CLOUD_FILL_SVG`     | `179:32` | cloud-fill     | `36b22f1d3243363df2186bf65d01e9610311b7127218ff0d17011536e28dcda0` | 930   | `5b04477000013b9690997b8076864b926310d9cc6dd9ea0e73234412cbff9621` | 800    |
| `CLOUD_OFF_FILL_SVG` | `179:45` | cloud-off-fill | `783e9469ea204fdde6fa83617e7ac681c5d146024a2aa08093bdc0d6119a4333` | 1239  | `e0aacfd717fa52d28e530b4eb066d9917941e19aa608ae17dcbd036f44d0c8a3` | 1099   |

"Source" is the SVG text `download_assets` returned (SHA-256 and byte count of
its UTF-8). "Stored" is the edited value in `cloud-glyphs.ts` (SHA-256 of its
UTF-8, and its JavaScript `length`). To check the module:

```sh
node -e "const s=require('fs').readFileSync('bundles/features/resources/src/client/monitor/cloud-glyphs.ts','utf8');for(const m of s.matchAll(/export const (\w+) =\s*'([^']*)'/g))console.log(m[1],require('crypto').createHash('sha256').update(m[2]).digest('hex'),m[2].length)"
```

To refresh a glyph, export it again, repeat the edit, and replace the value,
the date and its row in one change.
