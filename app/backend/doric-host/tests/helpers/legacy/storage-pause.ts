/** The queue error a storage pause shows (`workspace/storage-pause.ts`). */
export const storageQueueError = {
  code: 'storage_low',
  message:
    'Execution paused: storage is low or unavailable. Free disk space above 10% and resume the queue.',
} as const;
