// The runtime's client part (bundle isolation phase 3): the window's records
// mirror, `runtime.records/v1`, over the host's `runtime/v2` and
// `runtime.threads/v1`, reached through their generated Connect clients
// (`RuntimeService`, `ThreadsService`; slice S65a). Activation calls no host
// method and creates no client: the first read, `follow` or `view` does.

import {
  type Cleanup,
  type ClientContext,
  type ClientServices,
  DoricConnectionV1,
} from 'bundle/contracts';

import { ThreadsService } from '../contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { RuntimeService } from '../contracts/gen/doric/runtime/v2/runtime_pb.js';
import { runtimeRecordsService } from '../contracts/index.js';
import { runtimeHost, threadsHost } from './api/host.js';
import { createRecords } from './records.js';

export function activate(context: ClientContext): Cleanup {
  const services = context.services as ClientServices;
  const threads = () => services.use(ThreadsService);
  const records = createRecords({
    runtime: runtimeHost(() => services.use(RuntimeService)),
    threads: threadsHost(threads),
    views: {
      viewThread: (request, options) => threads().viewThread(request, options),
    },
    connection: services.use(DoricConnectionV1),
  });
  services.provide(runtimeRecordsService(records));

  return () => records.close();
}
