// One-time copy of a window's localStorage key from the packaged `file://`
// origin to `doric://app` (section 16.4). The platform owns both origins and
// both pages; a caller names only the key to copy and the marker that records
// the copy as done in the desktop state. Packaged installs copy the key once,
// never over a value already there. Development profiles
// (`http://localhost:4200`) are not migrated (Q3).

import { pathToFileURL } from 'node:url';

import type { MigrationResult } from 'bundle/contracts';
import { BrowserWindow } from 'electron';

import { messageOf, type PlatformLog } from '../log';
import { doricUrl } from '../protocol/scheme';
import type { DesktopState } from '../state';

export interface StorageOriginDeps {
  readonly state: DesktopState;
  readonly packaged: boolean;
  /** `assets/legacy-origin.html`, an empty page under the old origin. */
  readonly legacyPage: string;
  /** A static page of the new origin: `/platform/splash@<v>/blank.html`. */
  readonly blankPath: string;
  readonly log: PlatformLog;
}

const hiddenWindow = (): BrowserWindow =>
  new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

const copyOnce = async (
  deps: StorageOriginDeps,
  key: string,
  marker: string,
): Promise<MigrationResult> => {
  if (deps.state.data.migrations[marker] === true) {
    return 'skipped';
  }

  const done = () =>
    deps.state.update((data) => ({
      ...data,
      migrations: { ...data.migrations, [marker]: true },
    }));

  if (!deps.packaged) {
    await done();

    return 'skipped';
  }

  const windows: BrowserWindow[] = [];
  const read = `localStorage.getItem(${JSON.stringify(key)})`;

  try {
    const legacy = hiddenWindow();

    windows.push(legacy);
    await legacy.loadURL(pathToFileURL(deps.legacyPage).href);

    const value: unknown = await legacy.webContents.executeJavaScript(read);

    if (typeof value !== 'string') {
      await done();

      return 'none';
    }

    const current = hiddenWindow();

    windows.push(current);
    await current.loadURL(doricUrl(deps.blankPath));
    await current.webContents.executeJavaScript(
      `${read} === null && localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    );
    await done();

    return 'migrated';
  } catch (error) {
    deps.log.warn(
      { error: messageOf(error), marker },
      'Storage origin migration failed',
    );
    await done().catch(() => undefined);

    return 'failed';
  } finally {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  }
};

/**
 * Runs the one-time copy for `key`, recorded under `marker`. Never rejects: a
 * failure is logged, the marker is still recorded, and the result is `failed`,
 * so a broken migration never blocks the window that asked for it.
 */
export const migrateStorageOrigin = async (
  deps: StorageOriginDeps,
  request: { readonly key: string; readonly marker: string },
): Promise<MigrationResult> => {
  try {
    return await copyOnce(deps, request.key, request.marker);
  } catch (error) {
    deps.log.warn(
      { error: messageOf(error), marker: request.marker },
      'Storage origin migration failed',
    );

    return 'failed';
  }
};
