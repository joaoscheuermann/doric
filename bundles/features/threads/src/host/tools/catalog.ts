import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import type { ThreadToolPorts } from '../threads.js';
import { tool as events } from './thread-events.js';
import { tool as get } from './thread-get.js';
import { tool as interrupt } from './thread-interrupt.js';
import { tool as list } from './thread-list.js';
import { tool as restart } from './thread-restart.js';
import { tool as send } from './thread-send.js';
import { tool as spawn } from './thread-spawn.js';
import { tool as terminate } from './thread-terminate.js';

/** One delegation tool and its global model-visible position (D10-5). */
export interface ThreadToolEntry {
  readonly tool: UnboundTool<ToolInput, ToolOutput, ThreadToolPorts>;
  readonly order: number;
}

/**
 * The eight tools in registration order: spawn 1000, list 1100, get 1200,
 * events 1300, send 1400, interrupt 1500, terminate 1600, restart 1650. Both
 * entries register exactly these, `alwaysAvailable: true`.
 */
export const threadTools: readonly ThreadToolEntry[] = [
  { tool: spawn, order: 1000 },
  { tool: list, order: 1100 },
  { tool: get, order: 1200 },
  { tool: events, order: 1300 },
  { tool: send, order: 1400 },
  { tool: interrupt, order: 1500 },
  { tool: terminate, order: 1600 },
  { tool: restart, order: 1650 },
];
