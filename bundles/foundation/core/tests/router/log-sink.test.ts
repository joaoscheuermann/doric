// `core`'s own `context.log` sink (spec `docs/designs/grpc-processes.md`,
// "`log/v1` and the other synchronous commands", A7; slice S42): `core`
// writes its records in process, as `log/v1.WriteBatch` from its own
// instance would, without a router call to itself, and reads the redaction
// list from its own secrets service. Before `activate` both fail with
// `unavailable`, so the SDK's queue falls back to stdout and retries.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  type ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import {
  LogRecordSchema,
  LogService,
} from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { ajvValidators, type HostContext, type LogSink } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';

import { createCoreServices } from '../../src/host/services.js';
import {
  CORE_INSTANCE,
  type RoutedCore,
  serveCore,
  testMessages,
} from '../support/router.js';

const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const withCore = async (run: (core: RoutedCore) => Promise<void>) => {
  const core = await serveCore({
    bundles: { notes: [] },
    secretsOptions: {
      rows: [{ id: 'c-1', kind: 'API_TOKEN', name: 'key', secret: 'sk-stored' }],
    },
  });

  try {
    await run(core);
  } finally {
    await core.close();
  }
};

/** The Doric code of a rejection, a `ConnectError` or a `ContractError`. */
const codeOf = (error: unknown): string => {
  if (error instanceof ConnectError) {
    return fromConnectError(error).code;
  }

  assert.ok(isContractError(error), `not a contract error: ${error}`);

  return (error as ContractError).code;
};

/** Waits until `ready` holds; fails after 2 s. */
const until = async (ready: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;

  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 1));
  }
};

/** Collects the lists `sink.watchRedactions` yields until `cancel`. */
const watch = (sink: LogSink) => {
  const controller = new AbortController();
  const state: { readonly lists: string[][]; error: unknown } = {
    lists: [],
    error: undefined,
  };

  void (async () => {
    try {
      for await (const list of sink.watchRedactions(controller.signal)) {
        state.lists.push([...list]);
      }
    } catch (error) {
      state.error = error;
    }
  })();

  return { state, cancel: () => controller.abort() };
};

void test("writeBatch writes to doric.log/v1 as core's instance, with the batch's scope and trace, redacted, and no log/v1 call", async () => {
  await withCore(async (core) => {
    const sink = core.core.logSink(core.context);

    await sink.writeBatch(
      [
        create(LogRecordSchema, {
          level: 'warn',
          message: 'token sk-stored leaked',
          fields: { auth: 'Bearer sk-stored' },
        }),
      ],
      {
        trace: { traceparent },
        scope: { projectId: 'p1' },
        signal: new AbortController().signal,
      },
    );

    const [written] = core.platformLogs;

    assert.ok(written !== undefined, 'one record was written');
    assert.deepEqual(
      {
        level: written.level,
        message: written.message,
        fields: written.fields,
        bundleId: written.bundleId,
        generation: written.generation,
        scope: written.scope,
        traceId: written.traceId,
      },
      {
        level: 'warn',
        message: 'token [REDACTED] leaked',
        fields: { auth: 'Bearer [REDACTED]' },
        bundleId: 'core',
        generation: CORE_INSTANCE.generation,
        scope: { projectId: 'p1' },
        traceId: '0af7651916cd43dd8448eb211c80319c',
      },
    );
    assert.equal(core.used.includes(LogService.typeName), false);
  });
});

void test('before activate, writeBatch rejects and watchRedactions fails with unavailable', async () => {
  const core = createCoreServices({
    types: testMessages(),
    validators: ajvValidators(),
  });
  const router = createTestRouter({ instance: CORE_INSTANCE });
  const contexts: HostContext[] = [];

  // The test router activates the part; `core.activate` is never called.
  await router.activate({
    services: core.services,
    activate: (received) => {
      contexts.push(received);
    },
  });

  try {
    const [context] = contexts;

    assert.ok(context !== undefined, 'the test router activated');

    const sink = core.logSink(context);

    await assert.rejects(
      sink.writeBatch(
        [create(LogRecordSchema, { level: 'info', message: 'early' })],
        { signal: new AbortController().signal },
      ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'unavailable');

        return true;
      },
    );

    const watching = watch(sink);

    await until(() => watching.state.error !== undefined, 'the watch to fail');
    watching.cancel();
    assert.equal(codeOf(watching.state.error), 'unavailable');
    assert.deepEqual(watching.state.lists, []);
  } finally {
    await router.control.stop();
  }
});

void test('watchRedactions yields the list, then the list after a credential is created', async () => {
  await withCore(async (core) => {
    const watching = watch(core.core.logSink(core.context));

    try {
      await until(() => watching.state.lists.length === 1, 'the first list');
      assert.deepEqual(watching.state.lists, [['sk-stored']]);

      await core
        .client(SecretsService, 'doric')
        .create({ kind: 'API_TOKEN', name: 'other', secret: 'sk-new' });
      await until(() => watching.state.lists.length === 2, 'the second list');

      assert.deepEqual(watching.state.lists.at(-1), ['sk-stored', 'sk-new']);
      assert.equal(watching.state.error, undefined);
    } finally {
      watching.cancel();
    }
  });
});
