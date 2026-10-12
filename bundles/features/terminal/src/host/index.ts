import {
  HooksV1,
  type HostContext,
  type Log,
  LogV1,
  type Secrets,
  SecretsV1,
  ToolsV1,
} from 'bundle/contracts';

import {
  RuntimeHooksV1,
  type RuntimeThreads,
  RuntimeThreadsV1,
  type RuntimeWorkspace,
  RuntimeWorkspaceV1,
} from './peers.js';
import { terminalService } from './provider.js';
import { createRedactions } from './redactions.js';
import { createTerminalRegistry } from './registry.js';
import { createTool } from './tool.js';
import { createNotices } from './watch.js';

export interface TerminalHostOptions {
  readonly secrets: Pick<Secrets, 'redactions' | 'watchRedactions'>;
  readonly workspace: () => RuntimeWorkspace;
  readonly threads: () => RuntimeThreads;
  readonly log: () => Log;
}

export interface TerminalHost {
  /** terminal/v1 1.1.0 over the process-local registry. */
  readonly definition: ReturnType<typeof terminalService>;
  /**
   * The runtime.hooks/v1 onThreadsClosingHook handler: closes the sessions of
   * the closing Threads; a failed cleanup is logged and never throws.
   */
  threadsClosing(input: {
    readonly projectId: string;
    readonly threadIds: readonly string[];
  }): Promise<void>;
  dispose(): void;
}

/**
 * The bundle's terminal sessions without the kernel wiring: what `activate`
 * provides and hooks, reusable by a peer's tests that need the real owner.
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

  return {
    definition: terminalService({
      registry,
      notices,
      redactions,
      workspace,
      threads,
      log,
    }),
    threadsClosing: async ({ projectId, threadIds }) => {
      await registry.close(threadIds).catch(() => {
        log().error('Terminal cleanup failed', { projectId });
      });
    },
    dispose: () => redactions.dispose(),
  };
};

/**
 * The `terminal` bundle's host part (stage 10, §3.10): provides terminal/v1
 * 1.1.0 over the process-local registry, registers the `terminal` tool at its
 * model-visible position (D10-5) and closes the sessions of closing Threads.
 */
export const activate = ({ services }: HostContext) => {
  const host = createTerminalHost({
    secrets: services.use(SecretsV1),
    workspace: () => services.use(RuntimeWorkspaceV1),
    threads: () => services.use(RuntimeThreadsV1),
    log: () => services.use(LogV1),
  });

  services.provide(host.definition);

  const tool = services
    .use(ToolsV1)
    .register(createTool(), { alwaysAvailable: true, order: 500 });

  // Awaited by the runner where it closed the Threads' terminals; a failed
  // cleanup is logged and never fails the close.
  const closing = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (hooks) => {
      const registration = hooks.onThreadsClosingHook(host.threadsClosing);
      return () => registration.dispose();
    });

  return () => {
    closing.dispose();
    tool.dispose();
    host.dispose();
  };
};
