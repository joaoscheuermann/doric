// `usage`'s host part as a process (phase 3, slice S50c): `usage/v1` served
// through the router over `runtime.usage/v1`, `runtime.threads/v1`,
// `host-config/v1` and `models/v1`. Built into `dist/host/main.mjs`.

import { runBundle } from 'bundle/host';

import { UsageService } from '../contracts/gen/doric/usage/v1/usage_pb.js';
import { createUsageService } from './rpc/usage.js';

const usage = createUsageService();

runBundle({
  services: [[UsageService, usage.implementation]],
  activate: usage.activate,
});
