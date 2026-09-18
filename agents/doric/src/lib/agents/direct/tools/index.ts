import type { Sandbox } from 'sandbox';

import type { ThreadCoordination } from '../../../workspace/coordination.js';
import * as spawn from './spawn-thread.js';
import * as list from './list-threads.js';
import * as get from './get-thread.js';
import * as send from './send-to-thread.js';
import * as interrupt from './interrupt-thread.js';
import * as terminate from './terminate-thread.js';

export const coordinationNames = [
  spawn.name,
  list.name,
  get.name,
  send.name,
  interrupt.name,
  terminate.name,
] as const;

/** Uses the existing tool contract without giving sandbox tools host privileges. */
export const createCoordinationTools = (
  control: ThreadCoordination,
  sandbox: Sandbox,
) => [
  spawn.create(control)(sandbox),
  list.create(control)(sandbox),
  get.create(control)(sandbox),
  send.create(control)(sandbox),
  interrupt.create(control)(sandbox),
  terminate.create(control)(sandbox),
];
