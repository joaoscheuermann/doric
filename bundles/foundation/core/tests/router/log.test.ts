// `log/v1` served by `core` over the router (S40b): each record of a bundle
// is written to `doric.log/v1` (the fake of `serveCore`, `platformLogs`)
// with the router-stamped caller, `environment: 'host'`, the call's scope
// and trace, and the stored secrets redacted. A failed write fails the RPC,
// so the SDK's queue can fall back to stdout (A7).

import assert from 'node:assert/strict';
import test from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import {
  LogService,
  type WriteBatchRequestSchema,
} from 'bundle/contracts/gen/doric/log/v1/log_pb.js';

import {
  type RoutedCore,
  type ServeCoreOptions,
  serveCore,
} from '../support/router.js';

const withCore = async (
  run: (core: RoutedCore) => Promise<void>,
  options: ServeCoreOptions = {},
) => {
  const core = await serveCore({ bundles: { notes: [] }, ...options });

  try {
    await run(core);
  } finally {
    await core.close();
  }
};

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);
    assert.equal(fromConnectError(error).code, code, error.message);

    return true;
  });
};

const log = (
  core: RoutedCore,
  projectId?: string,
): Client<typeof LogService> =>
  core.client(
    LogService,
    'notes',
    projectId === undefined ? {} : { scope: { projectId } },
  );

type BatchItem = MessageInitShape<typeof WriteBatchRequestSchema>;

/** One `WriteBatch` stream of `items`. */
async function* batchOf(
  items: readonly BatchItem[],
): AsyncIterable<BatchItem> {
  for (const item of items) {
    yield item;
  }
}

/** Waits until `ready` holds or 2 s passed, polling every millisecond. */
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 2000;

  while (!ready() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1));
  }
};

void test('Write stamps the record with the caller, host, the call scope and trace, and keeps its fields', async () => {
  await withCore(async (core) => {
    const fields = { count: 2, nested: { flag: true, label: 'x' } };

    await log(core, 'p1').write({
      record: { level: 'info', message: 'hello', fields },
    });

    assert.equal(core.platformLogs.length, 1);

    const [written] = core.platformLogs;

    assert.ok(written);
    assert.deepEqual(
      {
        level: written.level,
        message: written.message,
        fields: written.fields,
        bundleId: written.bundleId,
        version: written.version,
        generation: written.generation,
        environment: written.environment,
        scope: written.scope,
      },
      {
        level: 'info',
        message: 'hello',
        fields,
        bundleId: 'notes',
        version: '1.2.3',
        generation: 1,
        environment: 'host',
        scope: { projectId: 'p1' },
      },
    );
    // The trace id of the `Write` call, which the hop to `doric.log/v1`
    // carries on as its parent trace.
    assert.match(written.traceId ?? '', /^[0-9a-f]{32}$/);
    assert.equal(written.traceId, core.platformLogTraceIds[0]);
  });
});

void test('a stored secret in the message or in a nested string field is written as [REDACTED]', async () => {
  await withCore(
    async (core) => {
      await log(core).write({
        record: {
          level: 'warn',
          message: 'token sk-stored leaked',
          fields: { request: { headers: { auth: 'Bearer sk-stored' } } },
        },
      });

      const [written] = core.platformLogs;

      assert.equal(written?.message, 'token [REDACTED] leaked');
      assert.deepEqual(written?.fields, {
        request: { headers: { auth: 'Bearer [REDACTED]' } },
      });
    },
    {
      secretsOptions: {
        rows: [
          { id: 'c-1', kind: 'API_TOKEN', name: 'key', secret: 'sk-stored' },
        ],
      },
    },
  );
});

void test('WriteBatch writes its records in stream order and answers after the last', async () => {
  await withCore(async (core) => {
    await log(core).writeBatch(
      batchOf([
        { record: { level: 'debug', message: 'one' } },
        { record: { level: 'info', message: 'two' } },
        { record: { level: 'error', message: 'three' } },
      ]),
    );

    assert.deepEqual(
      core.platformLogs.map(({ level, message }) => ({ level, message })),
      [
        { level: 'debug', message: 'one' },
        { level: 'info', message: 'two' },
        { level: 'error', message: 'three' },
      ],
    );
  });
});

void test('a failed doric.log/v1 write fails Write with its code; in a batch the records before it stay written', async () => {
  await withCore(async (core) => {
    core.failLog = new ContractError('unavailable', 'the log is down');

    await rejectsWith(
      log(core).write({ record: { level: 'info', message: 'lost' } }),
      'unavailable',
    );
    assert.deepEqual(core.platformLogs, []);

    core.failLog = undefined;

    // `doric.log/v1` goes down once the first record is written.
    async function* failingOnSecond(): AsyncIterable<BatchItem> {
      yield { record: { level: 'info', message: 'first' } };
      await until(() => core.platformLogs.length === 1);
      core.failLog = new ContractError('unavailable', 'the log is down');
      yield { record: { level: 'info', message: 'second' } };
    }

    await rejectsWith(log(core).writeBatch(failingOnSecond()), 'unavailable');
    assert.deepEqual(
      core.platformLogs.map(({ message }) => message),
      ['first'],
    );
  });
});

void test('a level outside debug, info, warn and error is invalid_input and nothing is written', async () => {
  await withCore(async (core) => {
    await rejectsWith(
      log(core).write({ record: { level: 'trace', message: 'nope' } }),
      'invalid_input',
    );
    assert.deepEqual(core.platformLogs, []);
  });
});
