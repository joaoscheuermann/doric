import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CallArg,
  defineMethod,
  defineService,
  LogV1,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import { boot, core, errorKinds, probe } from './support/host.js';

/** A service of `writer` that logs under the call it receives. */
const WriterV1 = ref<{ write(message: string, call?: CallArg): Promise<void> }>(
  'writer.write/v1',
);

const writer = (options: { readonly onActivate?: string } = {}) =>
  probe('writer', {
    requires: ['log/v1@^1.0.0'],
    provides: [['writer.write/v1', 'service']],
    activate: ({ services }) => {
      const log = services.use(LogV1);

      if (options.onActivate !== undefined) {
        log.info(options.onActivate, { deadline: 5 });
      }

      services.provide(
        defineService('writer.write/v1', {
          write: defineMethod({
            input: z.string(),
            output: z.void(),
            execute: async (message, call) => {
              log.warn(message, { attempt: 2, deadline: 5 }, call);
            },
          }),
        }),
      );
    },
  });

void test('a record names the calling bundle, its call scope, trace and environment', async () => {
  const host = await boot([await core(), writer()]);

  try {
    const call = host.platform.call({
      scope: { projectId: 'p-1', threadId: 't-1', promptId: 'q-1' },
    });

    await host.platform.services.use(WriterV1).write('over budget', call);

    const record = host.records.find(
      ({ message }) => message === 'over budget',
    );

    assert.ok(record);
    assert.equal(record.level, 'warn');
    assert.equal(record.bundleId, 'writer');
    assert.equal(record.version, '1.2.3');
    assert.equal(record.generation, host.platform.generation);
    assert.equal(record.environment, 'host');
    assert.deepEqual(record.scope, {
      projectId: 'p-1',
      threadId: 't-1',
      promptId: 'q-1',
    });
    // Positional fields stay fields, even when a key looks like a call option.
    assert.deepEqual(record.fields, { attempt: 2, deadline: 5 });
    assert.equal(record.traceId, call.trace.traceparent.split('-')[1]);
  } finally {
    await host.close();
  }
});

void test('a record logged without a call carries no scope and keeps its fields', async () => {
  const host = await boot([await core(), writer({ onActivate: 'ready' })]);

  try {
    const record = host.records.find(({ message }) => message === 'ready');

    assert.ok(record);
    assert.equal(record.level, 'info');
    assert.equal(record.bundleId, 'writer');
    assert.equal(record.scope, undefined);
    assert.deepEqual(record.fields, { deadline: 5 });
  } finally {
    await host.close();
  }
});

void test('a level never throws, even when the sink refuses the record', async () => {
  const host = await boot([await core(), writer()], {
    sink: {
      write: () => {
        throw new Error('disk full');
      },
    },
  });

  try {
    await host.platform.services.use(WriterV1).write('lost');

    assert.ok(errorKinds(host.platform).includes('writer:log_write_failed'));
  } finally {
    await host.close();
  }
});
