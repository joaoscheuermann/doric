import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { filesService } from './reads.js';
import { tool as cwd } from './tools/cwd.js';
import { tool as edit } from './tools/edit.js';
import { tool as find } from './tools/find.js';
import { tool as grep } from './tools/grep.js';
import { tool as tree } from './tools/tree.js';
import { tool as viewImage } from './tools/view-image.js';
import { tool as write } from './tools/write.js';

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

  tools.register(cwd, { alwaysAvailable: true, order: 100 });
  tools.register(edit, { alwaysAvailable: true, order: 200 });
  tools.register(find, { alwaysAvailable: true, order: 300 });
  tools.register(grep, { alwaysAvailable: true, order: 400 });
  tools.register(tree, { alwaysAvailable: true, order: 600 });
  tools.register(write, { alwaysAvailable: true, order: 800 });
  tools.register(viewImage, { alwaysAvailable: true, order: 850 });
};
