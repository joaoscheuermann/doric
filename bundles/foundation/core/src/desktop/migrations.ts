import type { Call, Services } from 'bundle/contracts';
import { DoricMigrationsV1, LogV1 } from 'bundle/contracts';

/**
 * The renderer's saved selection, copied once from the packaged `file://`
 * origin to `doric://app`. The key is the one the layout keeps in
 * localStorage; the marker is the name of the desktop state record that
 * records the copy as done. Both names are persisted, so they never change.
 */
export const SELECTION_MIGRATION = {
  key: 'doric.selection',
  marker: 'selectionOrigin',
} as const;

/**
 * Asks the platform to run the selection migration and waits for it. A
 * failure to run it is logged and never keeps the primary window closed.
 */
export const migrateSelection = async (
  services: Services,
  call: Call,
): Promise<void> => {
  try {
    await services.use(DoricMigrationsV1).storage(SELECTION_MIGRATION, call);
  } catch {
    services
      .use(LogV1)
      .warn(
        'Selection migration did not run',
        { marker: SELECTION_MIGRATION.marker },
        call,
      );
  }
};
