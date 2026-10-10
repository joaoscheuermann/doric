// Node entry of a host generation process, forked by the kernel with
// `serialization: 'advanced'` and an IPC channel.

import {
  importHostPart,
  registerInstalledSkills,
  registerInstalledTools,
} from '../loader/activate.js';
import { readInstalledBundle } from '../loader/discover.js';
import { createErrorClassRegistry } from '../runtime/envelope/errors.js';
import type { Principal } from '../runtime/principal.js';
import {
  runGeneration,
  type SerializedCatalogEntry,
} from '../runtime/runner.js';
import { ajvValidators } from './ajv.js';
import { parentTransport } from './node-transport.js';

const ignore = () => undefined;

// The kernel alone ends a generation (Ctrl-C reaches the whole process group).
process.on('SIGINT', ignore);
process.on('SIGTERM', ignore);
// A dead kernel never leaves an orphan generation.
process.on('disconnect', () => process.exit(0));

const installedResources =
  (register: typeof registerInstalledTools) =>
  async (
    entry: SerializedCatalogEntry,
    principal: Principal,
  ): Promise<void> => {
    if (entry.source.kind !== 'installed') {
      return;
    }

    const { dir } = entry.source;
    const installed = await readInstalledBundle(dir);

    await register(dir, installed.read?.legacy, principal);
  };

await runGeneration({
  transport: parentTransport(),
  validators: ajvValidators(),
  errors: createErrorClassRegistry(),
  loadPart: async (entry) =>
    entry.source.kind === 'installed'
      ? await importHostPart(entry.source.dir)
      : undefined,
  afterActivate: installedResources(registerInstalledTools),
  // Skills once the generation's whole phase has activated (D10-6).
  afterPhase: installedResources(registerInstalledSkills),
});
