import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultAssetPaths, useAssetTexts } from '../../src/host/assets.js';

/*
 * `assetText` has no disk fallback since S68d: the texts come only from
 * `useAssetTexts`, which the host part calls at `activate` with what
 * `loadAssetTexts(context.assets.read)` answers (`src/host/service.ts`). The
 * envelope test worlds install the same texts, read from the bundle's own
 * files, before they read a template or a built-in agent.
 */

/** The bundle directory: the compiled support is `dist-tests/tests/support`. */
const bundleRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Every `defaultAssetPaths` entry's text, as the bundle's files hold it. */
export const bundleAssetTexts = (): ReadonlyMap<string, string> =>
  new Map(
    defaultAssetPaths.map((path) => [
      path,
      readFileSync(join(bundleRoot, path), 'utf8'),
    ]),
  );

/** Installs {@link bundleAssetTexts} with `useAssetTexts`, as the host part's `activate` does. */
export const installBundleAssets = (): void => {
  useAssetTexts(bundleAssetTexts());
};
