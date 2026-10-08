import { randomUUID } from 'node:crypto';

import { storageMessage } from './disk.js';
import {
  type RuntimeContext,
  ThreadPersistenceError,
  type ThreadRuntime,
} from './runtime.js';

/** Retain failed checkpoints in memory until storage accepts them again. */
export const pauseForStorage = async (
  context: RuntimeContext,
  thread: ThreadRuntime,
  error: unknown,
): Promise<void> => {
  const { threads: store, publisher } = context;
  thread.active?.controller.abort();
  thread.pausing = undefined;
  thread.thread = {
    ...thread.thread,
    state: 'ready',
    activePromptId: undefined,
    queuePaused: true,
    errorCode: 'storage_low',
  };
  const job = thread.active?.job;
  const retry =
    error instanceof ThreadPersistenceError ? error.retry : undefined;
  let saved = false;
  let marked = false;
  thread.storagePending = async () => {
    if (!saved) {
      await retry?.();
      saved = true;
    }
    if (!marked) {
      const events = await store.appendEvents(
        thread.thread.id,
        job?.id ?? randomUUID(),
        [
          { type: 'queue.paused', reason: 'storage_low' },
          ...(job === undefined
            ? []
            : [{ type: 'prompt.paused', reason: 'storage_low' }]),
        ],
      );
      marked = true;
      for (const event of events) publisher.event(event);
    }
    const updated = await store.setState(
      thread.thread.id,
      'ready',
      undefined,
      'storage_low',
    );
    if (updated !== undefined) thread.thread = updated;
    thread.storagePending = undefined;
    publisher.threadUpdated(thread.thread);
  };
  // A full disk may reject even the pause marker. The in-memory gate and error
  // remain visible; resumption first flushes this checkpoint and durable pause.
  await thread.storagePending().catch(() => {
    context.logger.warn(
      { threadId: thread.thread.id },
      'Storage pause awaits persistence',
    );
  });
  publisher.threadUpdated(thread.thread);
};

export const storageQueueError = {
  code: 'storage_low',
  message: storageMessage,
} as const;
