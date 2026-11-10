# Provenance of the bundled splash assets

The splash page (`src/splash-page`) ships files that were not written in this
repository. Each is recorded here with its origin and how it was prepared
(HC-008). This file is not copied into the build.

## `src/splash-page/art-shaded.webp`

The splash art's shaded fallback (§4.5, S32): the picture the art pane shows
whenever the live shader does not run.

- Source: Figma file `ITniMiH6BnZHhuX6NkJhqP` (Doric UI), node `302:22439`
  ("Photo", the art pane of `layout/Splash` `State=Connecting`, `302:22437`),
  which draws the photograph `ken-nagata-M1mNrZ3t7bI-unsplash` through the
  shader effect "Bitmap orgânico".
- Export: the Figma MCP `download_assets` render of the node, PNG at scale 2,
  on 2026-11-09: 600×970 px, 1 008 478 bytes, SHA-256
  `826b0af9e7f037648281e18e12ef88ae45daeec5accd4c2f62ded0e00d2016a4`.
- Conversion, lossless (the decoded pixels equal the PNG's), with ImageMagick
  6.9.11-60:

  ```sh
  convert art-302-22439@2x.png -define webp:lossless=true \
    -define webp:method=6 -quality 100 art-shaded.webp
  ```

- Result: 600×970 px WebP, 679 388 bytes, SHA-256
  `3eb39ad319cfe646e7d32ed110f70d7cd6562741158c5c9e440248c823e24a40`.

## The splash photographs (`src/splash-page/photo-*.jpg`)

The photographs the live art shades, one picked per launch (§4.5, S33). All
three are under the Unsplash License (<https://unsplash.com/license>), which
allows copying, modifying and distributing them, commercially included,
without permission or attribution.

License check, 2026-11-09: the Unsplash photo pages answered HTTP 401 to this
sandbox (a bot check) as they did to the spec's reader. Each photograph was
downloaded without an account through the page's free Download endpoint
(`https://unsplash.com/photos/<id>/download?force=true`), which redirected to
`images.unsplash.com/photo-…` (Unsplash+ photographs are served from
`plus.unsplash.com` and need a subscription), and Unsplash's search listing
describes each as "Download this free HD photo". The phase 4.5 pull request
asks the user to confirm the license on each page (UR23).

Each is center-cropped to the largest 373:539 box (the aspect of Figma layer
`302:22443`, 372.067×538.276) and resized to 746×1078 (2× that layer), metadata
stripped, with ImageMagick 6.9.11-60:

```sh
convert <original> -gravity center -crop <w>x<h>+0+0 +repage \
  -resize 746x1078! -quality <q> -strip photo-<id>.jpg
```

The quality is 80 unless the result exceeds 160 000 bytes; then it is the
highest quality, in steps of 5, that fits (S33).

### `photo-M1mNrZ3t7bI.jpg`

- Photograph: `M1mNrZ3t7bI`, "a tall stone structure with many columns" (the
  Parthenon), by Ken Nagata (`@denshaotoko93`),
  <https://unsplash.com/photos/a-tall-stone-structure-with-many-columns-M1mNrZ3t7bI>.
  It is the photograph of Figma layer `302:22443`
  (`ken-nagata-M1mNrZ3t7bI-unsplash`).
- Source: Figma file `ITniMiH6BnZHhuX6NkJhqP`, the Figma MCP `download_assets`
  `rawImages` of node `302:22439`, 2026-11-09: 2731×4096 JPEG, 9 303 199 bytes,
  SHA-256 `8834b384bd47a2b61b5fa9cc9cee719ca6f625d5dd63568388e03d2c128b3867`.
- Crop box `2731x3946`; quality 75 (80 gave 171 763 bytes).
- Result: 746×1078 JPEG, 148 922 bytes, SHA-256
  `ba0078a3804eed91f755abc26e2bbf59b9f27d8eb3222c7f208f9dc4ba8da2fe`.

### `photo-ycojSfbMZQc.jpg`

- Photograph: `ycojSfbMZQc`, "a group of statues on the side of a building"
  (Athens), by Ken Nagata (`@denshaotoko93`),
  <https://unsplash.com/photos/a-group-of-statues-on-the-side-of-a-building-ycojSfbMZQc>.
- Download: the original size, 2026-11-09
  (`ken-nagata-ycojSfbMZQc-unsplash.jpg`): 4160×6240 JPEG, 5 179 970 bytes,
  SHA-256 `9895be24443b140eb1399faf5fadd79ce95c2523a26d86950ade48e9099cb6df`.
- Crop box `4160x6011`; quality 70 (80 gave 200 219 bytes, 75 gave 175 249).
- Result: 746×1078 JPEG, 158 803 bytes, SHA-256
  `eaa27090aa3d7b7e4f21b63fdc0fa0fd1f4be081a96bcdd19ae178d18ececc51`.

### `photo-yEsyprCZcEY.jpg`

- Photograph: `yEsyprCZcEY`, "Temple of Hephaestus with columns", by Matheus
  Oliveira (`@matheus_oliveira`),
  <https://unsplash.com/photos/temple-of-hephaestus-with-columns-yEsyprCZcEY>.
- Download: the original size, 2026-11-09
  (`matheus-oliveira-yEsyprCZcEY-unsplash.jpg`): 6000×4000 JPEG, 2 916 365
  bytes, SHA-256
  `6a361727dc5c7569f60f1171c92f782a296a5fe2d890a4dbb83bd497589884b5`.
- Crop box `2768x4000`; quality 80.
- Result: 746×1078 JPEG, 123 922 bytes, SHA-256
  `69940b7cbaad159cff1393c0d29e8373b10094bc287abd866df9467dd439ad96`.

Splash art in the app: 148 922 + 158 803 + 123 922 + 679 388
(`art-shaded.webp`) = 1 111 035 bytes, within S33's 1.2 MB.

## `src/splash-page/vendor/bitmap-organico.ts`

The shader the live art runs (§4.5, S19): Figma's shader effect "Bitmap
orgânico", owned by the user and copied under MIT (UR19, © jao.scheuermann).

- Source: Figma file `ITniMiH6BnZHhuX6NkJhqP`, shader
  `071018be-b00a-4c0a-83da-1729a60fc95b`, version
  `2d24f46323ce8a35993d022830f285c2421814f6` (`features.json`: `version: 3`,
  `renderScaleAware: true`, `isAnimated: false`), its `main.ts` as the Figma MCP
  `get_shader` returned it on 2026-11-09: 10 994 bytes, SHA-256
  `be1356639a90329ad56bd144c785e32e9798fc6cb6582dddc411f1b2bad89568`.
- Edits, exactly three (S19; T-4.5.9 diffs them):
  1. a first line `// @ts-nocheck`;
  2. a header comment naming the shader, file key, shader id, version, read
     date and the MIT grant;
  3. `import { defineProperties } from "figma:shaders";` replaced by
     `function defineProperties(_component: unknown, _properties: unknown): void {}`,
     as Figma's code export writes it.
- Result: 11 469 bytes, SHA-256
  `eb805d3d16fbbf833d22fb777c3a2d5e19547b8e0727365220dea46feaef8f8d`.
- The parameters it runs with on layer `302:22443` are `SPLASH_ART_PARAMS` in
  `src/splash-page/art/run-effect.ts`.
