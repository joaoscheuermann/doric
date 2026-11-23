import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { kernelRegistrable } from './ports.js';
import { filesService } from './reads.js';
import { fileTools } from './tools/catalog.js';

/**
 * Registers the workspace tools at their global model-visible positions
 * (D10-5); `terminal` (500) is the `terminal` bundle's, and `web` (700) and
 * the `web-research` skill are the `web` bundle's (stage 10 host switch).
 * It also provides `files/v1`, the sandbox reads of the file panel and the
 * file tab.
 */
export const activate = ({ services }: HostContext): void => {
  services.provide(filesService);

  // Global model-visible positions (D10-5); they survive tools moving out.
  const tools = services.use(ToolsV1);

  for (const { tool, order } of fileTools) {
    tools.register(kernelRegistrable(tool), { alwaysAvailable: true, order });
  }
};
