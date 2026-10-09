import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { tool as events } from './tools/thread-events.js';
import { tool as get } from './tools/thread-get.js';
import { tool as interrupt } from './tools/thread-interrupt.js';
import { tool as list } from './tools/thread-list.js';
import { tool as send } from './tools/thread-send.js';
import { tool as spawn } from './tools/thread-spawn.js';
import { tool as terminate } from './tools/thread-terminate.js';

/** The delegation tools, in their established model-visible order. */
export const threadTools = [
  spawn,
  list,
  get,
  events,
  send,
  interrupt,
  terminate,
] as const;

/** Registers the delegation tools in their established model-visible order. */
export const activate = ({ services }: HostContext): void => {
  const tools = services.use(ToolsV1);

  for (const tool of threadTools) {
    tools.register(tool, { alwaysAvailable: true });
  }
};
