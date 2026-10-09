import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type EmbeddedBundle, startHost } from 'bundle';

/** A core that only requires the two backends the real core requires. */
export const testCore: EmbeddedBundle = {
  manifest: {
    manifestVersion: 1,
    id: 'testcore',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: [],
    requires: ['storage.backend/v1@^1.0.0', 'secrets.backend/v1@^1.0.0'],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id: 'testcore', version: '1.0.0' },
    contracts: [],
  },
  host: { activate: () => undefined },
};

/** Boots a host whose composition chooses `foundation` for both backends. */
export const bootHost = async (options: {
  readonly foundation: string;
  readonly embedded?: readonly EmbeddedBundle[];
  readonly bundlesPath?: string;
}) => {
  const root =
    options.bundlesPath ?? (await mkdtemp(join(tmpdir(), 'postgres-host-')));
  const noop = () => undefined;
  const platform = await startHost({
    bundlesPath: root,
    composition: {
      core: 'testcore',
      enabled: ['testcore', options.foundation],
      providers: {
        'storage.backend/v1': options.foundation,
        'secrets.backend/v1': options.foundation,
      },
    },
    embedded: [testCore, ...(options.embedded ?? [])],
    log: { info: noop, warn: noop, error: noop },
    sink: { write: noop },
  });

  return {
    platform,
    close: async () => {
      await platform.stop();

      if (options.bundlesPath === undefined) {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
};
