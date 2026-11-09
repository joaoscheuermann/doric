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
