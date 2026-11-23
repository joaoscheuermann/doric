import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { kernelRegistrable } from './threads.js';
import { threadTools } from './tools/catalog.js';

/** Registers the delegation tools in their established model-visible order. */
export const activate = ({ services }: HostContext): void => {
  const tools = services.use(ToolsV1);
  for (const { tool, order } of threadTools) {
    tools.register(kernelRegistrable(tool), { alwaysAvailable: true, order });
  }
};
