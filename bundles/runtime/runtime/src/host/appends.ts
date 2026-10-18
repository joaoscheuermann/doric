// What other bundles append to a Thread's log. `events/v1` writes their rows
// to `runtime.thread.events/<threadId>` without the runtime, and the core
// fires `core.event-hooks/v1.onEventAppendedHook` once each row is committed;
// this handler folds the rows into the Thread and publishes them right then,
// instead of at the runtime's next write on that Thread.

import { threadIdOfStream } from '../contracts/storage.js';
import type { ThreadStore } from './store/types.js';

/** The `onEventAppendedHook` handler over the runtime's Thread store. */
export const onEventAppended =
  (threads: Pick<ThreadStore, 'catchUp'>) =>
  async ({
    stream,
  }: {
    readonly stream: string;
    readonly type: string;
  }): Promise<void> => {
    const threadId = threadIdOfStream(stream);

    if (threadId !== undefined) await threads.catchUp(threadId);
  };
