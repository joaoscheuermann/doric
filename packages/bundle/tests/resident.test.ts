import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { ref } from '../src/contracts/index.js';
import { startKernel } from '../src/index.js';
import {
  captureLog,
  captureSink,
  contractsUrl,
  descriptorFor,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';
import { zodUrl } from './support/generation-fixtures.js';
import { minimalCore } from './support/minimal-core.js';

void test('a composition loads a resident bundle on native listeners and releases its handlers', async () => {
  await withRoot(async (root) => {
    const source = {
      ...manifest('routes', { provides: ['routes/v1@1.0.0'] }),
      optional: ['optional/v1'],
    };
    await writeBundle(root, 'routes', {
      manifest: source,
      descriptor: descriptorFor(source),
      host: `
        import { z } from ${JSON.stringify(zodUrl)};
        import { DoricNetworkV1, defineService, defineMethod, ref } from ${JSON.stringify(contractsUrl)};
        export const activate = ({ services }) => {
          services.use(DoricNetworkV1).register(({ http, server }) => {
            http.attached = process.pid;
            server.upgrade = process.pid;
            return () => {
              http.attached = null;
              server.upgrade = null;
            };
          });
          const optional = services.use(ref('optional/v1'));
          services.provide(defineService('routes/v1', {
            read: defineMethod({ input: z.tuple([]), output: z.string(), execute: async () => {
              try { return await optional.read(); } catch (error) { return error.code; }
            } }),
          }));
        };
      `,
    });
    const path = join(root, 'composition.json');
    const composition = {
      core: 'mincore',
      enabled: ['mincore', 'routes'],
      resident: ['routes'],
    };
    await writeFile(path, JSON.stringify(composition));
    const http: { attached?: number | null } = {};
    const server: { upgrade?: number | null } = {};
    const platform = await startKernel({
      bundlesPath: root,
      composition: { path },
      embedded: [minimalCore()],
      log: captureLog(),
      sink: captureSink(),
      network: { http, server, sockets: {} },
    });
    try {
      assert.equal(platform.mode, 'normal');
      assert.equal(http.attached, process.pid);
      assert.equal(server.upgrade, process.pid);
      assert.equal(
        await platform.services
          .use(ref<{ read(): Promise<string> }>('routes/v1'))
          .read(),
        'unavailable',
      );
      await writeFile(path, JSON.stringify({ ...composition, resident: [] }));
      assert.equal(
        (await platform.generations.publish()).status,
        'kernel_restart_required',
      );
    } finally {
      await platform.stop();
    }
    assert.equal(http.attached, null);
    assert.equal(server.upgrade, null);
  });
});
