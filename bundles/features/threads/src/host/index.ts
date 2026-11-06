import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { tool as events } from './tools/thread-events.js';
import { tool as get } from './tools/thread-get.js';
import { tool as interrupt } from './tools/thread-interrupt.js';
import { tool as list } from './tools/thread-list.js';
import { tool as restart } from './tools/thread-restart.js';
import { tool as send } from './tools/thread-send.js';
import { tool as spawn } from './tools/thread-spawn.js';
import { tool as terminate } from './tools/thread-terminate.js';

/** The delegation tools with their global model-visible positions (D10-5). */
const threadTools = [
  [spawn, 1000],
  [list, 1100],
  [get, 1200],
  [events, 1300],
  [send, 1400],
  [interrupt, 1500],
  [terminate, 1600],
  [restart, 1650],
] as const;

/** Registers the delegation tools in their established model-visible order. */
export const activate = ({ services }: HostContext): void => {
  const tools = services.use(ToolsV1);
  for (const [tool, order] of threadTools) {
    tools.register(tool, { alwaysAvailable: true, order });
  }
};
