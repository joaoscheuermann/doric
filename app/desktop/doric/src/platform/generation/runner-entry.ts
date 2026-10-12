// One desktopMain generation in its utility process (section 13.3): the
// environment-generic runner over the Electron channel, with the parts main
// verified in the artifact cache.

import type { Activate } from 'bundle/contracts';
import { createErrorClassRegistry, runGeneration } from 'bundle/runtime';

import { createSchemaValidators } from '../bridge/validation';
import { parentPortTransport } from './electron-transport';
import { decodeRunnerArguments } from './module-hooks';

const args = decodeRunnerArguments(process.argv);
// A utility process's channel to main (Electron's `process.parentPort`).
const port = (
  process as unknown as {
    readonly parentPort: Parameters<typeof parentPortTransport>[0];
  }
).parentPort;

await runGeneration({
  transport: parentPortTransport(port),
  validators: createSchemaValidators(),
  errors: createErrorClassRegistry(),
  loadPart: async (entry) => {
    const url = Object.hasOwn(args.parts, entry.id)
      ? args.parts[entry.id]
      : undefined;

    if (url === undefined) {
      return undefined;
    }

    const loaded = (await import(url)) as { readonly activate?: Activate };

    return loaded.activate;
  },
});

process.exit(0);
