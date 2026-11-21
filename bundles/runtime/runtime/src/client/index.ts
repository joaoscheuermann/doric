// The runtime's client part (bundle isolation phase 3): the window's records
// mirror, `runtime.records/v1`, over the host's `runtime/v2` and
// `runtime.threads/v1`. Activation calls no host method: the first read or
// `follow` does.

import {
  type Cleanup,
  type ClientContext,
  DoricConnectionV1,
} from 'bundle/contracts';

import { runtimeRecordsService } from '../contracts/index.js';
import { RuntimeThreadsV1, RuntimeV2 } from './api/host.js';
import { createRecords } from './records.js';

export function activate({ services }: ClientContext): Cleanup {
  const connection = services.use(DoricConnectionV1);
  const records = createRecords({
    runtime: services.use(RuntimeV2),
    threads: services.use(RuntimeThreadsV1),
    connection,
  });
  services.provide(runtimeRecordsService(records));

  return () => records.close();
}
