import { type HostContext, SecretsV1, ToolsV1 } from 'bundle/contracts';
import { type RuntimeTerminals, RuntimeTerminalsV1 } from 'runtime/contracts';

import { gitCredentialKind } from './credentials.js';
import { createGitService } from './service.js';
import { createTool } from './tools/git.js';

/**
 * Registers the routable `git` tool, the `GIT` credential kind, and provides
 * `git.commands/v1`. The kind is registered at activation, before any start
 * step reads a credential. The Project's terminal list serves the branch
 * switch's busy check while some bundle provides it; without one, only running
 * prompts block a switch.
 */
export const activate = ({ services }: HostContext): void => {
  let terminals: RuntimeTerminals | undefined;

  services.use(SecretsV1).registerKind(gitCredentialKind);

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
