import { type HostContext, ToolsV1 } from 'bundle/contracts';
import { type Terminal, TerminalV1 } from 'terminal/contracts';

import { tool as cwd } from './tools/cwd.js';
import { tool as edit } from './tools/edit.js';
import { tool as find } from './tools/find.js';
import { tool as grep } from './tools/grep.js';
import { createTool as createTerminalTool } from './tools/terminal.js';
import { tool as tree } from './tools/tree.js';
import { createTool as createWebTool } from './tools/web.js';
import { tool as write } from './tools/write.js';

/**
 * Registers the workspace tools in their established model-visible order.
 * `terminal/v1` is optional: while no provider is active the terminal tool
 * falls back to a plain command in the leased sandbox.
 */
export const activate = ({ services }: HostContext): void => {
  let terminals: Terminal | undefined;

  services.whenAvailable(TerminalV1, (api) => {
    terminals = api;

    return () => {
      terminals = undefined;
    };
  });

  const tools = services.use(ToolsV1);

  tools.register(cwd, { alwaysAvailable: true });
  tools.register(edit, { alwaysAvailable: true });
  tools.register(find, { alwaysAvailable: true });
  tools.register(grep, { alwaysAvailable: true });
  tools.register(createTerminalTool({ terminals: () => terminals }), {
    alwaysAvailable: true,
  });
  tools.register(tree, { alwaysAvailable: true });
  tools.register(createWebTool(), { alwaysAvailable: true });
  tools.register(write, { alwaysAvailable: true });
};
