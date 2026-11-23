import type { Log, Secrets } from 'bundle/contracts';

import type { TerminalService } from '../contracts/index.js';
import type { RuntimeThreads, RuntimeWorkspace } from './peers.js';
import { createTerminalOperations, terminalService } from './provider.js';
import { createRedactions } from './redactions.js';
import { createTerminalRegistry } from './registry.js';
import { createNotices } from './watch.js';

export interface TerminalHostOptions {
  readonly secrets: Pick<Secrets, 'redactions' | 'watchRedactions'>;
  readonly workspace: () => RuntimeWorkspace;
  readonly threads: () => RuntimeThreads;
  readonly log: () => Log;
}

export interface TerminalHost {
  /** terminal/v1 1.2.0 for the kernel (`terminalService`). Kernel-only. */
  readonly definition: ReturnType<typeof terminalService>;
  /** The same operations, for the process's `TerminalService` (D1). */
  readonly operations: TerminalService;
  /**
   * The `onThreadsClosingHook` handler: stops every session of `threadIds`
   * and resolves once each stop resolved; a failure is logged at `error`
   * ('Terminal cleanup failed', `{projectId}`) and never rejects.
   */
  threadsClosing(input: {
    readonly projectId: string;
    readonly threadIds: readonly string[];
  }): Promise<void>;
  /** Stops the redaction watch. Running sessions are left as they are. */
  dispose(): void;
}

/**
 * The bundle's terminal sessions without the kernel wiring: what `activate`
 * provides and hooks, reusable by a peer's tests that need the real owner.
 * Builds the host with no call: the redaction watch opens here
 * (`secrets.watchRedactions`).
 */
export const createTerminalHost = ({
  secrets,
  workspace,
  threads,
  log,
}: TerminalHostOptions): TerminalHost => {
  const redactions = createRedactions(secrets);
  const notices = createNotices();
  const registry = createTerminalRegistry(notices.notify, redactions.latest);
  const operations = createTerminalOperations({
    registry,
    notices,
    redactions,
    workspace,
    threads,
    log,
  });

  return {
    definition: terminalService(operations),
    operations,
    threadsClosing: async ({ projectId, threadIds }) => {
      await registry.close(threadIds).catch(() => {
        log().error('Terminal cleanup failed', { projectId });
      });
    },
    dispose: () => redactions.dispose(),
  };
};
