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
import { kernelRegistrable } from './ports.js';
import { createTerminalHost } from './terminals.js';
import { createTool } from './tool.js';

export {
  createTerminalHost,
  type TerminalHost,
  type TerminalHostOptions,
} from './terminals.js';

/**
 * The `terminal` bundle's host part (stage 10, §3.10): provides terminal/v1
 * 1.2.0 over the process-local registry, registers the `terminal` tool at its
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

  const tool = services.use(ToolsV1).register(kernelRegistrable(createTool()), {
    alwaysAvailable: true,
    order: 500,
  });

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
