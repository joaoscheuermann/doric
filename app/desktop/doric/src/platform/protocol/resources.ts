import { join } from 'node:path';

import { PLATFORM_VERSION } from 'bundle/runtime';

/** Where the files served under `doric://app` live on disk. */
export interface Resources {
  /** `/platform/<pkg>@<v>/…` (except the shell). */
  readonly platformRoot: string;
  /** `/schemas/…`. */
  readonly schemasRoot: string;
  /** `/platform/shell@<v>/…` when packaged (the renderer build). */
  readonly shellRoot: string;
  /** `PLATFORM_VERSION`: the shell's URL prefix is `/platform/shell@<v>/`. */
  readonly shellVersion: string;
}

/**
 * The resources next to the built main process: `assets/` is copied by the
 * packager with `main.js`, and the renderer build sits beside it as
 * `doric-renderer/` in both the workspace `dist/app` and the package.
 */
export const resourcesFor = (mainDir: string): Resources => ({
  platformRoot: join(mainDir, 'assets', 'platform'),
  schemasRoot: join(mainDir, 'assets', 'schemas'),
  shellRoot: join(mainDir, '..', 'doric-renderer'),
  shellVersion: PLATFORM_VERSION,
});

export const shellPrefix = (resources: Resources): string =>
  `/platform/shell@${resources.shellVersion}/`;

export const splashPrefix = (resources: Resources): string =>
  `/platform/splash@${resources.shellVersion}/`;

/** The splash page URL path. */
export const splashPath = (resources: Resources): string =>
  `${splashPrefix(resources)}index.html`;
