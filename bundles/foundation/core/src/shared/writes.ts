/**
 * One serializer for the core's cross-facade writes: `settings/v1.set` and
 * `secrets/v1.create|update|delete` run one at a time, in arrival order. It
 * replaces the atomicity the foreign keys and the Serializable configuration
 * transaction gave between configuration and credentials (decision S-8).
 */
export interface WriteQueue {
  /** Runs `task` after every earlier task settled; a failure frees the queue. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

const settle = (): undefined => undefined;

export const createWriteQueue = (): WriteQueue => {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      const result = tail.then(task);

      tail = result.then(settle, settle);

      return result;
    },
  };
};
