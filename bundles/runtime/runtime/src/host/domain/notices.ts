import type { Disposable, Log } from 'bundle/contracts';

import type {
  RuntimeListener,
  RuntimeNotice,
} from '../../contracts/runtime.js';
import type { WorkspacePublisher } from './types.js';

/*
 * The live notices of `runtime/v1.watch` (design 57 §4.8). The publisher the
 * domain notifies after each commit emits one notice synchronously to every
 * listener, in registration order; a listener that throws is logged and
 * never reaches back into the domain.
 */
export interface Notices {
  readonly publisher: WorkspacePublisher;
  watch(listener: RuntimeListener): Disposable;
}

export const createNotices = (log: Pick<Log, 'error'>): Notices => {
  const listeners: { readonly listener: RuntimeListener }[] = [];
  const emit = (notice: RuntimeNotice) => {
    for (const { listener } of [...listeners]) {
      try {
        listener(notice);
      } catch (error) {
        log.error('Runtime notice listener failed', {
          kind: notice.kind,
          err: error,
        });
      }
    }
  };

  return {
    publisher: {
      event: (value) => emit({ kind: 'event', value }),
      threadUpdated: (value) => emit({ kind: 'threadUpdated', value }),
      threadDeleted: (projectId, threadId) =>
        emit({ kind: 'threadDeleted', projectId, threadId }),
      projectUpdated: (value) => emit({ kind: 'projectUpdated', value }),
      projectDeleted: (projectId) =>
        emit({ kind: 'projectDeleted', projectId }),
      terminalUpdated: (value) => emit({ kind: 'terminalUpdated', value }),
      terminalOutput: (value) => emit({ kind: 'terminalOutput', value }),
      terminalRemoved: (value) => emit({ kind: 'terminalRemoved', ...value }),
    },
    watch: (listener) => {
      const entry = { listener };

      listeners.push(entry);

      let disposed = false;

      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          const index = listeners.indexOf(entry);
          if (index !== -1) listeners.splice(index, 1);
        },
      };
    },
  };
};
