// The host SDK's log queue (spec `docs/designs/grpc-processes.md`,
// "`log/v1` and the other synchronous commands", A7; slice S42): records
// wait, go to `log/v1.WriteBatch` in batches of the same trace and scope,
// and what is not sent reaches stdout as one redacted JSON line each. The
// queue runs against a fake `LogSink` and a recording `LogOutput`; time is
// `node:test`'s mock clock (`setTimeout` and `Date`).

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import { create, type JsonObject } from '@bufbuild/protobuf';

import type { Call, CallScope } from '../src/contracts/call.js';
import { ContractError } from '../src/contracts/error.js';
import type { LogRecord } from '../src/contracts/gen/doric/log/v1/log_pb.js';
import { CallStartSchema } from '../src/contracts/gen/doric/platform/v1/control_pb.js';
import { toConnectError } from '../src/contracts/status.js';
import type { BundleInstance } from '../src/sdk/host/context.js';
import {
  createLogQueue,
  type LogBatchContext,
  type LogOutput,
  type LogQueue,
  type LogSink,
  type LogTimings,
} from '../src/sdk/host/log.js';
import {
  callFromStart,
  currentCall,
  runInCall,
} from '../src/sdk/host/serve.js';

// ---------------------------------------------------------------------------
// Helpers

const instance: BundleInstance = {
  bundleId: 'acme.echo',
  generation: 3,
  incarnation: 2,
};

const traceA = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01';
const traceB = '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01';

/** A runtime `Call` of `traceparent` and `scope`, its signal `signal`. */
const callOf = (
  traceparent: string,
  scope: CallScope = {},
  signal: AbortSignal = new AbortController().signal,
): Call =>
  callFromStart(
    create(CallStartSchema, {
      caller: { bundleId: 'acme.caller', version: '1.0.0', generation: 1 },
      scope,
      traceparent,
    }),
    signal,
  );

const enableClock = (t: TestContext): void => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
};

/** Lets pending promise jobs run. */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Advances the mocked clock by `ms`, 1 ms at a time, flushing in between. */
const advance = async (t: TestContext, ms: number): Promise<void> => {
  await flush();

  for (let elapsed = 0; elapsed < ms; elapsed += 1) {
    t.mock.timers.tick(1);
    await flush();
  }
};

/** One stdout line, parsed. */
type Line = Record<string, unknown>;

interface RecordingOutput extends LogOutput {
  /** The lines of `write`, parsed, in order. */
  readonly written: Line[];
  /** The lines of `writeSync`, parsed, in order. */
  readonly synced: Line[];
}

const recordingOutput = (): RecordingOutput => {
  const written: Line[] = [];
  const synced: Line[] = [];
  const parse = (line: string): Line => {
    assert.ok(line.endsWith('\n'), `a line ends with a newline: ${line}`);
    assert.equal(line.indexOf('\n'), line.length - 1, 'one line per record');

    return JSON.parse(line) as Line;
  };

  return {
    written,
    synced,
    write: (line) => written.push(parse(line)),
    writeSync: (line) => synced.push(parse(line)),
  };
};

const messagesOf = (lines: readonly Line[]): unknown[] =>
  lines.map((line) => line.message);

/** One `writeBatch` the queue made. */
interface SentBatch {
  readonly records: readonly {
    readonly level: string;
    readonly message: string;
    readonly fields: JsonObject | undefined;
  }[];
  readonly context: LogBatchContext;
  /** `currentCall()` inside `writeBatch`. */
  readonly current: Call | undefined;
  /** The mocked time it was made at. */
  readonly at: number;
  resolve(): void;
  reject(error: unknown): void;
}

/** One `watchRedactions` iteration the queue opened, driven by the test. */
interface Watch {
  push(list: readonly string[]): void;
  fail(error: unknown): void;
}

interface FakeSink extends LogSink {
  readonly batches: SentBatch[];
  readonly watches: Watch[];
}

/**
 * A sink whose batches the test answers (`manual`), that answers each batch
 * at once (`ok`) or `ms` later (`{ after: ms }`), or that never answers
 * (`never`). Every batch rejects with its signal's reason when it aborts.
 */
const fakeSink = (
  answer: 'manual' | 'ok' | 'never' | { readonly after: number } = 'manual',
): FakeSink => {
  const batches: SentBatch[] = [];
  const watches: Watch[] = [];

  return {
    batches,
    watches,
    writeBatch: (records: readonly LogRecord[], context) =>
      new Promise<void>((resolve, reject) => {
        batches.push({
          records: records.map(({ level, message, fields }) => ({
            level,
            message,
            fields,
          })),
          context,
          current: currentCall(),
          at: Date.now(),
          resolve,
          reject,
        });
        context.signal.addEventListener(
          'abort',
          () => reject(context.signal.reason ?? new Error('aborted')),
          { once: true },
        );

        if (answer === 'ok') {
          resolve();
        } else if (typeof answer === 'object') {
          setTimeout(resolve, answer.after);
        }
      }),
    watchRedactions: (signal) => {
      const lists: (readonly string[])[] = [];
      let failure: { readonly error: unknown } | undefined;
      let wake: (() => void) | undefined;

      watches.push({
        push: (list) => {
          lists.push(list);
          wake?.();
        },
        fail: (error) => {
          failure = { error };
          wake?.();
        },
      });

      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = lists.shift();

            if (next !== undefined) {
              yield next;
              continue;
            }

            if (failure !== undefined) {
              throw failure.error;
            }

            if (signal.aborted) {
              return;
            }

            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
            wake = undefined;
          }
        },
      };
    },
  };
};

const messagesSent = (sink: FakeSink): string[][] =>
  sink.batches.map((batch) => batch.records.map(({ message }) => message));

const queueOf = (
  timings: Partial<LogTimings>,
  output: LogOutput = recordingOutput(),
): LogQueue => createLogQueue({ instance, timings, output });

// ---------------------------------------------------------------------------
// Sending

describe('the log queue: sending', () => {
  test('records logged before start are not sent; after start they go in one batch once intervalMs passed', async (t) => {
    enableClock(t);
    const sink = fakeSink('ok');
    const queue = queueOf({ intervalMs: 10, batchSize: 100 });

    queue.log.info('a');
    queue.log.warn('b');
    await advance(t, 50);
    assert.equal(sink.batches.length, 0);

    queue.start(sink);
    await advance(t, 10);

    assert.deepEqual(messagesSent(sink), [['a', 'b']]);
    assert.deepEqual(
      sink.batches[0]?.records.map(({ level }) => level),
      ['info', 'warn'],
    );
  });

  test('batchSize records waiting are sent at once, without waiting for intervalMs', async (t) => {
    enableClock(t);
    const sink = fakeSink('ok');
    const queue = queueOf({ intervalMs: 1_000, batchSize: 3 });

    queue.start(sink);
    queue.log.info('one');
    queue.log.info('two');
    queue.log.info('three');
    await flush();

    assert.deepEqual(messagesSent(sink), [['one', 'two', 'three']]);
  });

  test('at most one batch is in flight; the next starts after the first settled, in order', async (t) => {
    enableClock(t);
    const sink = fakeSink('manual');
    const queue = queueOf({ intervalMs: 1_000, batchSize: 2 });

    queue.start(sink);

    for (const message of ['1', '2', '3', '4']) {
      queue.log.info(message);
    }

    await advance(t, 5);
    assert.deepEqual(messagesSent(sink), [['1', '2']]);

    sink.batches[0]?.resolve();
    await advance(t, 5);

    assert.deepEqual(messagesSent(sink), [
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  test('a batch takes the prefix of records of one trace and scope; a call argument wins over currentCall()', async (t) => {
    enableClock(t);
    const sink = fakeSink('ok');
    const queue = queueOf({ intervalMs: 10, batchSize: 100 });
    const inCall = callOf(traceA, { projectId: 'p1' });
    const explicit = callOf(traceB);

    queue.start(sink);
    runInCall(inCall, () => {
      queue.log.info('a1');
      queue.log.info('a2');
      queue.log.info('b', undefined, explicit);
    });
    queue.log.info('none');
    await advance(t, 100);

    assert.deepEqual(
      sink.batches.map(({ records, context }) => ({
        messages: records.map(({ message }) => message),
        traceparent: context.trace?.traceparent,
        scope: context.scope === undefined ? undefined : { ...context.scope },
      })),
      [
        {
          messages: ['a1', 'a2'],
          traceparent: traceA,
          scope: { projectId: 'p1' },
        },
        { messages: ['b'], traceparent: traceB, scope: undefined },
        { messages: ['none'], traceparent: undefined, scope: undefined },
      ],
    );
  });

  test('a batch is not sent in the handler context: a record of a call aborted since is still sent', async (t) => {
    enableClock(t);
    const sink = fakeSink('ok');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 10 }, output);
    const handler = new AbortController();
    const call = callOf(traceA, { projectId: 'p1' }, handler.signal);

    queue.start(sink);
    runInCall(call, () => queue.log.info('in the call'));
    handler.abort(new Error('the call ended'));
    await advance(t, 20);

    const [batch] = sink.batches;

    assert.ok(batch !== undefined, 'the record was sent');
    assert.deepEqual(
      batch.records.map(({ message }) => message),
      ['in the call'],
    );
    assert.equal(batch.context.trace?.traceparent, traceA);
    assert.deepEqual({ ...batch.context.scope }, { projectId: 'p1' });
    assert.equal(batch.context.signal.aborted, false);
    assert.equal(batch.current, undefined);
    assert.deepEqual(output.written, []);
  });

  test('a rejected batch goes to stdout in order and is not retried; the next batch is still sent', async (t) => {
    enableClock(t);
    const sink = fakeSink('manual');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 10 }, output);

    queue.start(sink);
    queue.log.info('a');
    queue.log.info('b');
    await advance(t, 15);
    queue.log.info('c');

    sink.batches[0]?.reject(new ContractError('internal', 'the log is down'));
    await flush();
    assert.deepEqual(messagesOf(output.written), ['a', 'b']);

    await advance(t, 15);

    assert.deepEqual(messagesSent(sink), [['a', 'b'], ['c']]);
  });

  test('a batch past deadlineMs has its signal aborted and its records go to stdout', async (t) => {
    enableClock(t);
    const sink = fakeSink('never');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 10, deadlineMs: 50 }, output);

    queue.start(sink);
    queue.log.info('late');
    await advance(t, 15);

    const [batch] = sink.batches;

    assert.ok(batch !== undefined, 'the batch was sent');
    await advance(t, batch.at + 45 - Date.now());
    assert.equal(batch.context.signal.aborted, false);
    assert.deepEqual(output.written, []);

    await advance(t, 10);
    assert.equal(batch.context.signal.aborted, true);
    assert.deepEqual(messagesOf(output.written), ['late']);
  });

  const refusals = [
    [
      'a ContractError undeclared_requirement',
      new ContractError('undeclared_requirement', 'log/v1 is not declared'),
    ],
    [
      'a ConnectError unknown_contract',
      toConnectError(new ContractError('unknown_contract', 'no log/v1')),
    ],
  ] as const;

  for (const [name, refusal] of refusals) {
    test(`after ${name}, what waits and every later record go to stdout, and nothing is sent again`, async (t) => {
      enableClock(t);
      const sink = fakeSink('manual');
      const output = recordingOutput();
      const queue = queueOf({ intervalMs: 10, batchSize: 1 }, output);

      queue.start(sink);
      queue.log.info('a');
      queue.log.info('b');
      await advance(t, 15);
      sink.batches[0]?.reject(refusal);
      await flush();

      assert.deepEqual(messagesOf(output.written), ['a', 'b']);

      queue.log.info('c');
      assert.deepEqual(messagesOf(output.written), ['a', 'b', 'c']);

      await advance(t, 100);
      assert.equal(sink.batches.length, 1);
    });
  }

  test('a full queue writes its oldest waiting record (not the one in flight) to stdout; no record is lost', async (t) => {
    enableClock(t);
    const sink = fakeSink('never');
    const output = recordingOutput();
    const queue = queueOf(
      { intervalMs: 1, batchSize: 1, capacity: 3, deadlineMs: 100_000 },
      output,
    );

    queue.start(sink);
    queue.log.info('r1');
    await advance(t, 5);
    assert.deepEqual(messagesSent(sink), [['r1']]);

    for (const message of ['r2', 'r3', 'r4']) {
      queue.log.info(message);
    }

    assert.deepEqual(output.written, []);

    queue.log.info('r5');
    assert.deepEqual(messagesOf(output.written), ['r2']);

    queue.flushSync();
    assert.deepEqual(messagesOf(output.synced), ['r1', 'r3', 'r4', 'r5']);
  });
});

// ---------------------------------------------------------------------------
// Redactions and stdout lines

describe('the log queue: stdout lines', () => {
  test('the last redaction list redacts message and string leaves of stdout lines, not keys; sent records are not redacted', async (t) => {
    enableClock(t);
    const sink = fakeSink('manual');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 10 }, output);

    queue.start(sink);
    await flush();
    assert.equal(sink.watches.length, 1);

    queue.log.info('early sk-secret');
    await advance(t, 15);
    sink.batches[0]?.reject(new Error('down'));
    await flush();

    sink.watches[0]?.push(['sk-secret', 'tok']);
    await flush();

    queue.log.warn('use sk-secret here', {
      'sk-secret': 'key',
      nested: { auth: 'Bearer tok', count: 2 },
      list: ['tok'],
    });
    await advance(t, 15);

    const sent = sink.batches[1];

    assert.ok(sent !== undefined, 'the second record was sent');
    assert.equal(sent.records[0]?.message, 'use sk-secret here');
    assert.deepEqual(sent.records[0]?.fields, {
      'sk-secret': 'key',
      nested: { auth: 'Bearer tok', count: 2 },
      list: ['tok'],
    });

    sent.reject(new Error('down'));
    await flush();

    const [early, redacted] = output.written;

    assert.equal(early?.message, 'early sk-secret');
    assert.equal(redacted?.message, 'use [REDACTED] here');
    assert.equal(redacted?.['sk-secret'], 'key');
    assert.deepEqual(redacted?.nested, { auth: 'Bearer [REDACTED]', count: 2 });
    assert.deepEqual(redacted?.list, ['[REDACTED]']);
  });

  test('the list outlives a failed watch, which is opened again after redactionRetryMs; never after undeclared_requirement', async (t) => {
    enableClock(t);
    const sink = fakeSink('never');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 100_000, redactionRetryMs: 100 }, output);

    queue.start(sink);
    await flush();
    sink.watches[0]?.push(['old']);
    await flush();
    sink.watches[0]?.fail(new ContractError('unavailable', 'core restarts'));
    await advance(t, 90);
    assert.equal(sink.watches.length, 1);

    await advance(t, 15);
    assert.equal(sink.watches.length, 2);

    sink.watches[1]?.push(['new']);
    await flush();
    queue.log.info('old new');
    queue.flushSync();
    assert.deepEqual(messagesOf(output.synced), ['old [REDACTED]']);

    sink.watches[1]?.fail(
      new ContractError('undeclared_requirement', 'secrets/v1 is not declared'),
    );
    await advance(t, 500);
    assert.equal(sink.watches.length, 2);
  });

  test('a list kept from a failed watch still redacts', async (t) => {
    enableClock(t);
    const sink = fakeSink('never');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 100_000, redactionRetryMs: 100 }, output);

    queue.start(sink);
    await flush();
    sink.watches[0]?.push(['old']);
    await flush();
    sink.watches[0]?.fail(new ContractError('unavailable', 'core restarts'));
    await flush();

    queue.log.info('x old');
    queue.flushSync();

    assert.deepEqual(messagesOf(output.synced), ['x [REDACTED]']);
  });

  test('a stdout line is the fields spread, level, message, the instance and the traceId of its call', async (t) => {
    enableClock(t);
    const output = recordingOutput();
    const queue = queueOf({}, output);

    runInCall(callOf(traceA), () =>
      queue.log.warn('shape', { count: 2, nested: { a: 1 } }),
    );
    queue.log.debug('outside');
    queue.flushSync();

    assert.deepEqual(output.synced, [
      {
        count: 2,
        nested: { a: 1 },
        level: 'warn',
        message: 'shape',
        bundleId: 'acme.echo',
        generation: 3,
        incarnation: 2,
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        level: 'debug',
        message: 'outside',
        bundleId: 'acme.echo',
        generation: 3,
        incarnation: 2,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// stop and flushSync

describe('the log queue: stop and flushSync', () => {
  test('stop sends what waits within stopBudgetMs and leaves the rest; later records go to stdout at once; a second stop resolves too', async (t) => {
    enableClock(t);
    const sink = fakeSink({ after: 60 });
    const output = recordingOutput();
    const queue = queueOf(
      {
        intervalMs: 100_000,
        batchSize: 2,
        stopBudgetMs: 150,
        finalDeadlineMs: 1_000,
      },
      output,
    );

    for (const message of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      queue.log.info(message);
    }

    queue.start(sink);

    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });

    await advance(t, 140);
    assert.equal(stopped, false);

    await advance(t, 20);
    await stopping;

    assert.deepEqual(messagesSent(sink), [
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
    assert.deepEqual(messagesOf(output.written), ['5', '6']);

    queue.log.info('after');
    assert.deepEqual(messagesOf(output.written), ['5', '6', 'after']);

    await queue.stop();
    await advance(t, 100);
    assert.equal(sink.batches.length, 3);

    queue.flushSync();
    assert.deepEqual(messagesOf(output.synced), ['7', '8']);
  });

  test('a batch stop sends, and the batch in flight at stop, end after finalDeadlineMs and go to stdout', async (t) => {
    enableClock(t);
    const sink = fakeSink('never');
    const output = recordingOutput();
    const queue = queueOf(
      {
        intervalMs: 1,
        batchSize: 1,
        deadlineMs: 100_000,
        stopBudgetMs: 10_000,
        finalDeadlineMs: 40,
      },
      output,
    );

    queue.start(sink);
    queue.log.info('in flight');
    await advance(t, 5);
    assert.deepEqual(messagesSent(sink), [['in flight']]);

    queue.log.info('final');

    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });

    await advance(t, 35);
    assert.equal(stopped, false);
    assert.equal(sink.batches[0]?.context.signal.aborted, false);

    await advance(t, 60);
    await stopping;

    assert.equal(sink.batches[0]?.context.signal.aborted, true);
    assert.deepEqual(messagesOf(output.written), ['in flight', 'final']);
    assert.deepEqual(output.synced, []);
  });

  test('flushSync writes waiting and in-flight records with writeSync, oldest first; it is idempotent and later records go to writeSync at once', async (t) => {
    enableClock(t);
    const sink = fakeSink('never');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 1, batchSize: 2 }, output);

    queue.start(sink);
    queue.log.info('a');
    queue.log.info('b');
    await advance(t, 5);
    assert.deepEqual(messagesSent(sink), [['a', 'b']]);
    queue.log.info('c');

    queue.flushSync();
    assert.deepEqual(messagesOf(output.synced), ['a', 'b', 'c']);
    assert.deepEqual(output.written, []);

    queue.flushSync();
    assert.deepEqual(messagesOf(output.synced), ['a', 'b', 'c']);

    queue.log.info('d');
    assert.deepEqual(messagesOf(output.synced), ['a', 'b', 'c', 'd']);

    await advance(t, 50);
    assert.equal(sink.batches.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The facade never throws

describe('the log queue: the facade never throws', () => {
  test('a cyclic field gives fields.unserializable and a bigint becomes its decimal string', (t) => {
    enableClock(t);
    const output = recordingOutput();
    const queue = queueOf({}, output);
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    assert.doesNotThrow(() => queue.log.info('cyclic', { cyclic }));
    assert.doesNotThrow(() => queue.log.info('big', { n: 10n }));
    queue.flushSync();

    const [cyclicLine, bigLine] = output.synced;

    assert.equal(typeof cyclicLine?.unserializable, 'string');
    assert.equal(cyclicLine?.cyclic, undefined);
    assert.equal(bigLine?.n, '10');
  });

  test('an output that throws is swallowed', (t) => {
    enableClock(t);
    const queue = queueOf(
      {},
      {
        write: () => {
          throw new Error('stdout closed');
        },
        writeSync: () => {
          throw new Error('stdout closed');
        },
      },
    );

    queue.log.info('lost');
    assert.doesNotThrow(() => queue.flushSync());
    assert.doesNotThrow(() => queue.log.error('after the flush'));
  });

  test('a record over 4 MiB goes straight to stdout and is never sent', async (t) => {
    enableClock(t);
    const sink = fakeSink('ok');
    const output = recordingOutput();
    const queue = queueOf({ intervalMs: 10 }, output);
    const huge = 'x'.repeat(4 * 1024 * 1024 + 1);

    queue.start(sink);
    queue.log.info(huge);

    assert.equal(output.written.length, 1);
    assert.equal(output.written[0]?.message, huge);

    await advance(t, 20);
    assert.equal(sink.batches.length, 0);
  });
});
