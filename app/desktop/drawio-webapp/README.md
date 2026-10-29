# drawio-webapp

The vendored draw.io editor that the desktop main process serves at
`https://drawio.doric.invalid` (`DRAWIO_ORIGIN`). This project holds no
editor source. `vendor.mjs` unpacks the pinned upstream archive into
`dist/app/desktop/doric/assets/drawio/`:

- `webapp/`: the upstream `src/main/webapp/`, without the folders listed
  in `exclude`;
- `LICENSE`, plus `NOTICE` when the archive has one;
- `manifest.json`: the version and the SHA-256 of every file under
  `webapp/`.

Owner: the desktop platform (`app/desktop/doric`). Main's
`platform/drawio/` serves these files and reports them through
`doric.drawio/v1`.

## Build

```sh
npx nx run drawio-webapp:build   # doric-app:build depends on it
npx nx run drawio-webapp:test
```

The build reads the archive from the offline cache
`node_modules/.cache/drawio/<sha256>.tar.gz`. When the archive is not
cached, the build downloads the lock's `url` and caches it only after its
SHA-256 matches the lock. A hash mismatch fails the build and does not
write `manifest.json`.

## Updating draw.io

1. Change `version` and `url` in `drawio.lock.json` to the new tag
   (`https://github.com/jgraph/drawio/archive/refs/tags/v<version>.tar.gz`).
2. Download it once and record its hash:

   ```sh
   curl -L -o drawio.tar.gz <url>
   sha256sum drawio.tar.gz
   ```

3. Put that hash in `sha256`. To build offline, copy the file to
   `node_modules/.cache/drawio/<sha256>.tar.gz`.
4. Run the build and the draw.io e2e:

   ```sh
   DORIC_ELECTRON_TESTS=drawio-editor ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx nx run doric-app-e2e:e2e
   ```

   Drop `xvfb-run -a` where a display is available.
