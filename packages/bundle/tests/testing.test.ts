import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  type Call,
  defineMethod,
  defineService,
  type ProviderInfo,
  ref,
} from '../src/contracts/index.js';
import { createTestServices } from '../src/testing/index.js';

const workspace = defineService('runtime.workspace/v1', {
  cwd: defineMethod({
    input: z.tuple([]),
    output: z.string(),
    execute: async (_input, call) => {
      await Promise.resolve();

      return `/workspace/${call.scope?.threadId ?? 'none'}:${call.caller.bundleId}`;
    },
  }),
});
const WorkspaceV1 = ref<typeof workspace>('runtime.workspace/v1');

void test('test services reach fake providers with the bundle under test as caller', async () => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [workspace],
  });
  const call = harness.call({ projectId: 'p', threadId: 't' });

  assert.equal(call.caller.bundleId, 'test');
  assert.equal(
    await harness.services.use(WorkspaceV1, call.scope).cwd(call),
    '/workspace/t:files',
  );

  await harness.dispose();

  assert.equal(call.signal.aborted, true);
});

/*
 * `providers` (bundle isolation T8.3): each entry provides its definitions
 * from a principal of its own, whose bundle id `whenAvailable` reports, so a
 * test can stand up several providers of a many-contract; `provide` keeps
 * providing under `test-provider`.
 */

/** A fake of the many-contract `demo.source/v1` that answers `answer`. */
const source = (answer: string) =>
  defineService(
    'demo.source/v1',
    {
      name: defineMethod({
        input: z.tuple([]),
        output: z.string(),
        execute: () => answer,
      }),
    },
    { cardinality: 'many' },
  );
const SourceV1 = ref<ReturnType<typeof source>>('demo.source/v1');

/** Every provider of `demo.source/v1` now: its bundle id and its answer. */
const answers = async (
  harness: ReturnType<typeof createTestServices>,
  call: Call,
) => {
  const found: { provider: ProviderInfo; name: () => Promise<string> }[] = [];
  harness.services
    .whenAvailable(SourceV1, (api, provider) => {
      found.push({ provider, name: async () => api.name(call) });
    })
    .dispose();
  return Promise.all(
    found.map(async ({ provider, name }) => ({
      bundleId: provider.bundleId,
      answer: await name(),
    })),
  );
};

void test('test services report each providers entry through whenAvailable with its own bundle id', async () => {
  const harness = createTestServices({
    bundle: { id: 'default' },
    providers: [{ bundleId: 'acme', provide: [source('from acme')] }],
  });

  assert.deepEqual(await answers(harness, harness.call()), [
    { bundleId: 'acme', answer: 'from acme' },
  ]);

  await harness.dispose();
});

void test('test services keep two many-providers of one contract side by side, in the order given', async () => {
  const harness = createTestServices({
    bundle: { id: 'default' },
    providers: [
      { bundleId: 'zeta', provide: [source('from zeta')] },
      { bundleId: 'alpha', provide: [source('from alpha')] },
    ],
  });

  assert.deepEqual(await answers(harness, harness.call()), [
    { bundleId: 'zeta', answer: 'from zeta' },
    { bundleId: 'alpha', answer: 'from alpha' },
  ]);

  await harness.dispose();
});

void test('test services still provide the provide list under test-provider beside the providers entries', async () => {
  const harness = createTestServices({
    bundle: { id: 'default' },
    provide: [source('from the fake'), workspace],
    providers: [{ bundleId: 'acme', provide: [source('from acme')] }],
  });
  const call = harness.call({ projectId: 'p', threadId: 't' });

  const found = await answers(harness, call);
  assert.deepEqual(
    [...found].sort((a, b) => a.bundleId.localeCompare(b.bundleId)),
    [
      { bundleId: 'acme', answer: 'from acme' },
      { bundleId: 'test-provider', answer: 'from the fake' },
    ],
  );
  assert.equal(
    await harness.services.use(WorkspaceV1, call.scope).cwd(call),
    '/workspace/t:default',
  );

  await harness.dispose();
});

void test('test services end every provider when disposed', async () => {
  const harness = createTestServices({
    bundle: { id: 'default' },
    providers: [
      { bundleId: 'acme', provide: [source('from acme')] },
      { bundleId: 'other', provide: [source('from other')] },
    ],
  });
  const started: string[] = [];
  const ended: string[] = [];
  harness.services.whenAvailable(SourceV1, (_api, { bundleId }) => {
    started.push(bundleId);
    return () => {
      ended.push(bundleId);
    };
  });

  await harness.dispose();

  assert.deepEqual(started, ['acme', 'other']);
  assert.deepEqual([...ended].sort(), ['acme', 'other']);
});
