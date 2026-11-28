// The test process of `bundle/testing` (spec `docs/designs/grpc-processes.md`,
// "Phase 4's slices", QD; T4.21): `startTestProcess` spawns one built bundle
// process, activates it, and lets a test call it through Connect transports
// stamped with a caller. It runs against both protocol conformance fixtures:
// the TypeScript SDK's, compiled to `tests/fixtures/conformance/main.js`, and
// the Rust SDK's example `conformance`, which `doric-bundle:compile-example`
// builds before the `test` target runs.

import assert from 'node:assert/strict';
import { describe, type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Code, ConnectError, createClient } from '@connectrpc/connect';

import { ConformanceService } from '../../src/contracts/gen/doric/conformance/v1/conformance_pb.js';
import { ContractError, fromConnectError } from '../../src/contracts/index.js';
import { startTestProcess, type TestProcess } from '../../src/testing/index.js';

/** The bundle id both fixtures send in their Hello. */
const bundleId = 'conformance.fixture';

// From `packages/bundle/dist-tests/tests/testing/`.
const typescriptFixture = fileURLToPath(
  new URL('../fixtures/conformance/main.js', import.meta.url),
);
// From `packages/bundle/dist-tests/tests/testing/` to the repository root.
const rustFixture = fileURLToPath(
  new URL(
    '../../../../../dist/target/doric-bundle/debug/examples/conformance',
    import.meta.url,
  ),
);

const fixtures: readonly { name: string; command: readonly string[] }[] = [
  {
    name: 'TypeScript fixture',
    command: [process.execPath, typescriptFixture],
  },
  { name: 'Rust fixture', command: [rustFixture] },
];

/** Each case's bound; a fixture starts and answers well within it. */
const caseTimeoutMs = 30_000;

/** Starts the fixture and stops it when the test ends. */
const start = async (
  t: TestContext,
  command: readonly string[],
): Promise<TestProcess> => {
  const started = await startTestProcess({ bundleId, command });

  t.after(() => started.stop());

  return started;
};

const clientOf = (started: TestProcess, caller: string) =>
  createClient(ConformanceService, started.transport(caller));

async function* values(...items: number[]): AsyncIterable<{ value: number }> {
  for (const value of items) yield { value };
}

/** Polls `Observed` until the `Wait` of `key` has started. */
const waitStarted = async (
  client: ReturnType<typeof clientOf>,
  key: string,
): Promise<void> => {
  for (;;) {
    if ((await client.observed({ key })).found) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Asserts `error` is a ConnectError carrying the ContractError `code`. */
const isContractFailure =
  (grpcCode: Code, code: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);
    assert.equal(error.code, grpcCode);
    assert.equal(fromConnectError(error).code, code);

    return true;
  };

for (const fixture of fixtures) {
  describe(`startTestProcess, ${fixture.name}`, {
    timeout: caseTimeoutMs,
  }, () => {
    test('answers a unary call', async (t) => {
      const client = clientOf(await start(t, fixture.command), 'a');

      const response = await client.echo({ text: 'hello' });

      assert.equal(response.text, 'hello');
    });

    test('answers a server-streaming call in order', async (t) => {
      const client = clientOf(await start(t, fixture.command), 'a');
      const indexes: number[] = [];

      for await (const message of client.count({ n: 3 })) {
        indexes.push(message.index);
      }

      assert.deepEqual(indexes, [0, 1, 2]);
    });

    test('answers a client-streaming call after the requests end', async (t) => {
      const client = clientOf(await start(t, fixture.command), 'a');

      const response = await client.sum(values(2, 3, 5));

      assert.deepEqual(
        { total: response.total, count: response.count },
        { total: 10, count: 3 },
      );
    });

    test('stamps the transport caller on each call', async (t) => {
      const client = clientOf(await start(t, fixture.command), 'a');

      await client.wait({ key: 'stamped', holdMs: 1 });
      const observed = await client.observed({ key: 'stamped' });

      assert.deepEqual(
        {
          found: observed.found,
          bundleId: observed.callerBundleId,
          version: observed.callerVersion,
          generation: observed.callerGeneration,
        },
        { found: true, bundleId: 'a', version: '0.0.0', generation: 1 },
      );
    });

    test('stamps the generation the transport is given', async (t) => {
      const started = await start(t, fixture.command);
      const client = createClient(
        ConformanceService,
        started.transport('a', 2),
      );

      await client.wait({ key: 'second-generation', holdMs: 1 });
      const observed = await client.observed({ key: 'second-generation' });

      assert.deepEqual(
        {
          found: observed.found,
          bundleId: observed.callerBundleId,
          generation: observed.callerGeneration,
        },
        { found: true, bundleId: 'a', generation: 2 },
      );
    });

    test('carries a handler failure as a ConnectError of its ContractError', async (t) => {
      const client = clientOf(await start(t, fixture.command), 'a');
      const details = { key: '612f6b', nested: { list: [1, 'two', true] } };

      const failure = await client
        .fail({ code: 'not_owner', message: 'Not yours.', details })
        .then(
          () => assert.fail('Fail answered'),
          (error: unknown) => error,
        );

      assert.ok(
        failure instanceof ConnectError,
        `not a ConnectError: ${failure}`,
      );
      const error = fromConnectError(failure);
      assert.deepEqual(
        { code: error.code, message: error.message, details: error.details },
        { code: 'not_owner', message: 'Not yours.', details },
      );
    });

    test('cancels a call when its signal aborts', async (t) => {
      const client = clientOf(await start(t, fixture.command), 'a');
      const controller = new AbortController();

      const pending = client.wait(
        { key: 'cancelled', holdMs: 0 },
        { signal: controller.signal },
      );
      await waitStarted(client, 'cancelled');
      controller.abort();

      await assert.rejects(pending, (error: unknown) => {
        assert.ok(
          error instanceof ConnectError,
          `not a ConnectError: ${error}`,
        );
        assert.equal(error.code, Code.Canceled);

        return true;
      });
      for (;;) {
        if ((await client.observed({ key: 'cancelled' })).cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    test('stop ends the process with code 0 and later calls are unavailable', async (t) => {
      const started = await start(t, fixture.command);
      const client = clientOf(started, 'a');

      await started.stop();

      assert.equal(await started.exited, 0);
      await assert.rejects(
        client.echo({ text: 'after stop' }),
        isContractFailure(Code.Unavailable, 'unavailable'),
      );
    });

    test('serves two callers at once, each stamped with its own', async (t) => {
      const started = await start(t, fixture.command);
      const a = clientOf(started, 'a');
      const b = clientOf(started, 'b');

      await Promise.all([
        a.wait({ key: 'from-a', holdMs: 50 }),
        b.wait({ key: 'from-b', holdMs: 50 }),
      ]);
      const [fromA, fromB] = await Promise.all([
        a.observed({ key: 'from-a' }),
        b.observed({ key: 'from-b' }),
      ]);

      assert.deepEqual(
        [fromA.callerBundleId, fromB.callerBundleId],
        ['a', 'b'],
      );
    });

    test('rejects the start when the activation fails', async () => {
      // Called directly, not awaited inside a wrapper: a start that fails
      // must answer a rejected promise.
      const pending = startTestProcess({
        bundleId,
        command: fixture.command,
        env: { DORIC_CONFORMANCE_ACTIVATE: 'fail' },
      });

      await assert.rejects(pending, (error: unknown) => {
        assert.ok(
          error instanceof ContractError,
          `not a ContractError: ${error}`,
        );
        assert.equal(error.code, 'activation_failed');

        return true;
      });
    });
  });
}

describe('startTestProcess, commands that never become active', {
  timeout: caseTimeoutMs,
}, () => {
  test('rejects an empty command', async () => {
    const pending = startTestProcess({ bundleId, command: [] });

    await assert.rejects(pending);
  });

  test('rejects when the process exits before its Hello', async () => {
    const pending = startTestProcess({
      bundleId,
      command: [process.execPath, '-e', 'process.exit(3)'],
    });

    await assert.rejects(pending);
  });
});
