import { join } from 'node:path';

/** Where the desktop platform keeps its files under `userData`. */
export interface DesktopPaths {
  readonly userData: string;
  /** Verified bundle artifacts: `bundles/<id>@<version>/<path>`. */
  readonly bundles: string;
  /** Download staging on the same volume (atomic rename). */
  readonly staging: string;
  /** The old artifacts cache, deleted at each start (D25). */
  readonly artifacts: string;
  /** Verified papercraft modules: `papercraft/<dir>/<file>`, served under `/papercraft-modules/` (papercraft.cache/v1). */
  readonly papercraftModules: string;
  /** `doric.cache/v1`: `bundle-cache/<bundleId>/`. */
  readonly bundleCache: string;
  /** `doric/state.json`: migrations, last good core. */
  readonly state: string;
  /** `doric/windows.json`: the last path per window key. */
  readonly windows: string;
  /** `doric/catalog-snapshot.json`: the last distribution that activated. */
  readonly catalogSnapshot: string;
}

export const desktopPaths = (userData: string): DesktopPaths => ({
  userData,
  bundles: join(userData, 'bundles'),
  staging: join(userData, 'bundles', '.tmp'),
  artifacts: join(userData, 'artifacts'),
  papercraftModules: join(userData, 'papercraft'),
  bundleCache: join(userData, 'bundle-cache'),
  state: join(userData, 'doric', 'state.json'),
  windows: join(userData, 'doric', 'windows.json'),
  catalogSnapshot: join(userData, 'doric', 'catalog-snapshot.json'),
});
