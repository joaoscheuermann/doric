import {
  HooksV1,
  type HostContext,
  LogV1,
  SecretsV1,
  ToolsV1,
} from 'bundle/contracts';

import {
  RuntimeHooksV1,
  RuntimeThreadsV1,
  RuntimeWorkspaceV1,
} from './peers.js';
import { terminalService } from './provider.js';
import { createRedactions } from './redactions.js';
import { createTerminalRegistry } from './registry.js';
import { createTool } from './tool.js';
import { createNotices } from './watch.js';

/**
 * The `terminal` bundle's host part (stage 10, §3.10): provides terminal/v1
 * 1.1.0 over the process-local registry, registers the `terminal` tool at its
 * model-visible position (D10-5) and closes the sessions of closing Threads.
 */
export const activate = ({ services }: HostContext) => {
  const redactions = createRedactions(services.use(SecretsV1));
  const notices = createNotices();
  const registry = createTerminalRegistry(notices.notify, redactions.latest);
  const log = () => services.use(LogV1);

  services.provide(
    terminalService({
      registry,
      notices,
      redactions,
      workspace: () => services.use(RuntimeWorkspaceV1),
      threads: () => services.use(RuntimeThreadsV1),
      log,
    }),
  );

  const tool = services
    .use(ToolsV1)
    .register(createTool(), { alwaysAvailable: true, order: 500 });

  // Awaited by the runner where it closed the Threads' terminals; a failed
  // cleanup is logged and never fails the close.
  const closing = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (hooks) => {
      const registration = hooks.onThreadsClosingHook(
        async ({ projectId, threadIds }) => {
          await registry.close(threadIds).catch(() => {
            log().error('Terminal cleanup failed', { projectId });
          });
        },
      );
      return () => registration.dispose();
    });

  return () => {
    closing.dispose();
    tool.dispose();
    redactions.dispose();
  };
};
