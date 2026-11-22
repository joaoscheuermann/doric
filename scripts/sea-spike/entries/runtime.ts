/**
 * SEA entry of the `runtime` bundle (phase 0 spike, T0.1): bundles its host part
 * with every dependency, so the process holds the code it will run, and
 * says Hello.
 */
import * as host from '../../../bundles/runtime/runtime/src/host/index.js';
import { run } from '../client.js';

await run(async () => ({ activate: typeof host.activate }));
