// What the router harness (`./router.ts`) shares with the tests: the durable
// Thread log its fakes of `events/v1` and `runtime.threads/v1` write into and
// read back, and the prompt scope every registry call runs under. The log
// outlives a harness, so a test can activate the part again over what an
// earlier activation wrote.

import type { CallScope } from 'bundle/contracts';
import type { ThreadEvent } from 'runtime/contracts';

/** The durable Thread logs, as the runtime's storage keeps them. */
export interface ThreadLog {
  /** Every row, in append order, across every Thread. */
  readonly rows: ThreadEvent[];
}

export const threadLog = (): ThreadLog => ({ rows: [] });

/** The prompt scope every registry call in these tests runs under. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};
