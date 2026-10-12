/**
 * Every key the chat caches a host read under. The shapes are the renderer's
 * (`app/doric-renderer/src/queries/keys.ts`), so a key still names what the
 * host was asked.
 */
export const queryKeys = {
  threadQueue: (threadId: string | undefined) => ['thread', threadId, 'queue'],
};
