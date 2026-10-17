import assert from 'node:assert/strict';

import { storageHealthSchema, storageIdentitySchema } from 'bundle/contracts';

import { caseGroup } from './harness.js';
import { open } from './support.js';

const health = caseGroup('health and identity');

export const identityCases = [
  health(
    'H1',
    'health reports measurements in the contract shape',
    async (harness) => {
      const report = await (await open(harness)).health();

      assert.deepEqual(storageHealthSchema.parse(report), report);

      if (report.status === 'unavailable') {
        assert.equal(report.writable, false);
        assert.equal(report.disk, undefined);
      }

      if (report.disk !== undefined) {
        assert.ok(report.disk.availableBlocks <= report.disk.blocks);
      }
    },
  ),
  health(
    'H2',
    'the identity is created once and is the same for every instance',
    async (harness) => {
      const first = await open(harness);
      const second = await open(harness);
      // Concurrent first calls agree on one record.
      const [one, two] = await Promise.all([
        first.identity(),
        second.identity(),
      ]);

      assert.deepEqual(storageIdentitySchema.parse(one), one);
      assert.ok(one.storageGeneration >= 1);
      assert.deepEqual(two, one);
      assert.deepEqual(await first.identity(), one);
      assert.deepEqual(await (await open(harness)).identity(), one);

      // A crash does not change it.
      const crashed = await harness.open();

      await crashed.backend.commit({
        put: [{ type: 'conformance.note/v1', id: 'n1', value: 1 }],
      });
      await harness.crash(crashed);
      assert.deepEqual(await (await open(harness)).identity(), one);
    },
  ),
];
