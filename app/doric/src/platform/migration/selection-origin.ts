// One-time origin migration of the saved selection (section 16.4): the
// renderer kept `localStorage['doric.selection']` under the packaged
// `file://` origin; windows now load `doric://app`. Packaged installs copy
// the key once, never over a value already there. Development profiles
// (`http://localhost:4200`) are not migrated (Q3).

import { pathToFileURL } from 'node:url';

import { BrowserWindow } from 'electron';

import { messageOf, type PlatformLog } from '../log';
import { doricUrl } from '../protocol/scheme';
import type { DesktopState } from '../state';

export const SELECTION_KEY = 'doric.selection';

export type MigrationResult = 'migrated' | 'none' | 'skipped' | 'failed';

const hiddenWindow = (): BrowserWindow =>
  new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

export const migrateSelectionOrigin = async (deps: {
  readonly state: DesktopState;
  readonly packaged: boolean;
  /** `assets/legacy-origin.html`, an empty page under the old origin. */
  readonly legacyPage: string;
  /** A static page of the new origin: `/platform/splash@<v>/blank.html`. */
  readonly blankPath: string;
  readonly log: PlatformLog;
}): Promise<MigrationResult> => {
  if (deps.state.data.migrations.selectionOrigin === true) {
    return 'skipped';
  }

  const done = () =>
    deps.state.update((data) => ({
      ...data,
      migrations: { ...data.migrations, selectionOrigin: true },
    }));

  if (!deps.packaged) {
    await done();

    return 'skipped';
  }

  const windows: BrowserWindow[] = [];

  try {
    const legacy = hiddenWindow();

    windows.push(legacy);
    await legacy.loadURL(pathToFileURL(deps.legacyPage).href);

    const value: unknown = await legacy.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(SELECTION_KEY)})`,
    );

    if (typeof value !== 'string') {
      await done();

      return 'none';
    }

    const current = hiddenWindow();

    windows.push(current);
    await current.loadURL(doricUrl(deps.blankPath));
    await current.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(SELECTION_KEY)}) === null && localStorage.setItem(${JSON.stringify(SELECTION_KEY)}, ${JSON.stringify(value)})`,
    );
    await done();

    return 'migrated';
  } catch (error) {
    deps.log.warn(
      { error: messageOf(error) },
      'Selection origin migration failed',
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
