import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { createTool } from './tools/git.js';

/** Registers the routable `git` tool. */
export const activate = ({ services }: HostContext): void => {
  services.use(ToolsV1).register(createTool(), { alwaysAvailable: false });
};
