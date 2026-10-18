import { join } from 'node:path';

import {
  AppHooksV1,
  type Cleanup,
  type DesktopContext,
  DoricCacheV1,
  DoricCatalogV1,
  defineMethod,
  defineService,
  HooksV1,
} from 'bundle/contracts';

import {
  HistorySnapshotsV1,
  type HistoryWrite,
  historySnapshotsMethods,
} from '../contracts/index.js';
import {
  createHistoryStore,
  disabledHistoryStore,
  type ThreadHistoryStore,
} from './store.js';

const historySnapshots = (store: ThreadHistoryStore) =>
  defineService(HistorySnapshotsV1, {
    read: defineMethod({
      expose: historySnapshotsMethods.read.expose,
      input: historySnapshotsMethods.read.input,
      output: historySnapshotsMethods.read.output,
      execute: (threadId: string) => Promise.resolve(store.read(threadId)),
    }),
    write: defineMethod({
      expose: historySnapshotsMethods.write.expose,
      input: historySnapshotsMethods.write.input,
      output: historySnapshotsMethods.write.output,
      execute: ({ threadId, updates }: HistoryWrite) => {
        for (const update of updates) store.absorb(threadId, update);
        return Promise.resolve();
      },
    }),
  });

/**
 * Provides `history.snapshots/v1` over this bundle's `doric.cache/v1`
 * directory, namespaced by the host's storage identity
 * (`<hostId>/<storageGeneration>/<threadId>.json`), so a different database
 * or a reset storage never shows another history. Without that identity the
 * store is disabled. Pending writes are flushed before quitting and on
 * deactivation.
 */
export const activate = async ({
  services,
}: DesktopContext): Promise<Cleanup> => {
  const root = await services.use(DoricCacheV1).directory();
  const storage = services.use(DoricCatalogV1).get().storage;
  const store =
    storage === undefined
      ? disabledHistoryStore()
      : createHistoryStore(
          join(
            root,
            encodeURIComponent(storage.hostId),
            String(storage.storageGeneration),
          ),
        );

  services.provide(historySnapshots(store));
  services
    .use(HooksV1)
    .use(AppHooksV1)
    .onBeforeQuitHook(() => {
      store.flush();
      return { allow: true };
    });

  return () => store.flush();
};
