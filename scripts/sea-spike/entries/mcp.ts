/**
 * SEA entry of the `mcp` bundle (phase 0 spike, T0.1): bundles its host part
 * with every dependency, so the process holds the code it will run, and
 * says Hello.
 */
import * as host from '../../../bundles/features/mcp/src/host/index.js';
import { run } from '../client.js';

await run(async () => ({ activate: typeof host.activate }));
