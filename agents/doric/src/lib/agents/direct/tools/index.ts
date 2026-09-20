import type { Sandbox } from 'sandbox';

import type { ThreadCoordination } from '../../../workspace/coordination.js';
import * as spawn from './spawn-thread.js';
import * as list from './list-threads.js';
import * as get from './get-thread.js';
import * as send from './send-to-thread.js';
import * as interrupt from './interrupt-thread.js';
import * as terminate from './terminate-thread.js';

const tools = [spawn, list, get, send, interrupt, terminate] as const;

export const coordinationNames: readonly string[] = tools.map(
  (tool) => tool.name,
);

/** Uses the existing tool contract without giving sandbox tools host privileges. */
export const createCoordinationTools = (
  control: ThreadCoordination,
  sandbox: Sandbox,
) => tools.map((tool) => tool.create(control)(sandbox));
