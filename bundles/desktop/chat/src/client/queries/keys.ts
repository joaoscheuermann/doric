/**
 * Every key the chat caches a host read under. The shapes are the renderer's
 * (`app/desktop/doric-renderer/src/queries/keys.ts`), so a key still names what the
 * host was asked.
 */
export const queryKeys = {
  threadQueue: (threadId: string | undefined) => ['thread', threadId, 'queue'],
  /** One answering model's icon, by provider id and model name. */
  modelIcon: (providerId: string, model: string) => [
    'models',
    'icon',
    providerId,
    model,
  ],
};
