import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { createTool as createWebTool } from './tools/web.js';

/** Registers the web tool at its established model-visible position. */
export const activate = ({ services }: HostContext): void => {
  // Global model-visible position 700 (D10-5): between `tree` and `write`.
  services
    .use(ToolsV1)
    .register(createWebTool(), { alwaysAvailable: true, order: 700 });
};
