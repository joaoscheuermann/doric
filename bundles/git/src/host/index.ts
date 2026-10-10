import { type HostContext, ToolsV1 } from 'bundle/contracts';
import { type RuntimeTerminals, RuntimeTerminalsV1 } from 'runtime/contracts';

import { createGitService } from './service.js';
import { createTool } from './tools/git.js';

/**
 * Registers the routable `git` tool and provides `git.commands/v1`. The
 * Project's terminal list serves the branch switch's busy check while some
 * bundle provides it; without one, only running prompts block a switch.
 */
export const activate = ({ services }: HostContext): void => {
  let terminals: RuntimeTerminals | undefined;

  services.whenAvailable(RuntimeTerminalsV1, (api) => {
    terminals = api;
    return () => {
      terminals = undefined;
    };
  });

  services.provide(createGitService(() => terminals));

  services.use(ToolsV1).register(createTool(), {
    alwaysAvailable: false,
    // Global model-visible position (D10-5).
    order: 900,
  });
};
