// Provider records across the envelope (57-WP-K): every record a generation
// bundle provides for a `many` contract reaches the kernel as its own record
// and answers its own calls, and an optional output that is `undefined`
// crosses as `undefined`. Real forked generation processes, plain-JS bundles.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { ref } from '../src/contracts/index.js';
import {
  contractsUrl,
  descriptorFor,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';
import { bootKernel, zodUrl } from './support/generation-fixtures.js';

interface Kind {
  id(): Promise<string>;
  find(name: string): Promise<{ readonly name: string } | undefined>;
}

const KindV1 = ref<Kind>('kind/v1');

/** One generation bundle with three `kind/v1` records, in a fixed order. */
const writeKinds = (root: string) => {
  const source = manifest('kinds', { provides: ['kind/v1@1.0.0'] });

  return writeBundle(join(root, 'bundles'), 'kinds', {
    manifest: source,
    descriptor: descriptorFor(source, { 'kind/v1': { cardinality: 'many' } }),
    host: `
import { z } from ${JSON.stringify(zodUrl)};
import { defineMethod, defineService, ref } from ${JSON.stringify(contractsUrl)};

const KindV1 = ref('kind/v1');

export const activate = ({ services }) => {
  for (const id of ['first', 'second', 'third']) {
    services.provide(
      defineService(KindV1, {
        id: defineMethod({
          input: z.tuple([]),
          output: z.string(),
          execute: async () => id,
        }),
        find: defineMethod({
          input: z.string(),
          output: z.object({ name: z.string() }).optional(),
          execute: async (name) => (name === id ? { name } : undefined),
        }),
      }, { cardinality: 'many' }),
    );
  }
};
`,
  });
};

void test('each record a generation bundle provides for a many contract reaches the kernel and answers on its own', async () => {
  await withRoot(async (root) => {
    await writeKinds(root);

    const { platform } = await bootKernel(root, ['kinds']);

    try {
      const records: Kind[] = [];
      const subscription = platform.services.whenAvailable(KindV1, (api) => {
        records.push(api);
      });

      try {
        assert.deepEqual(
          await Promise.all(records.map((record) => record.id())),
          ['first', 'second', 'third'],
        );
      } finally {
        subscription.dispose();
      }
    } finally {
      await platform.stop();
    }
  });
});

void test('an optional output that is undefined crosses the envelope as undefined', async () => {
  await withRoot(async (root) => {
    await writeKinds(root);

    const { platform } = await bootKernel(root, ['kinds']);

    try {
      const records: Kind[] = [];
      const subscription = platform.services.whenAvailable(KindV1, (api) => {
        records.push(api);
      });

      try {
        const [first] = records;

        assert.ok(first !== undefined);
        assert.deepEqual(await first.find('first'), { name: 'first' });
        assert.equal(await first.find('missing'), undefined);
      } finally {
        subscription.dispose();
      }
    } finally {
      await platform.stop();
    }
  });
});
