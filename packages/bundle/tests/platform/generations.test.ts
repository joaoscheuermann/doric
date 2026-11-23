// The SDK's side of the generation frames (spec
// `docs/designs/grpc-processes.md`, section 6, "Generation events and peer
// signals", D5; T2.18): `createGenerations` runs the `onChanged` handlers of
// a `GenerationChanged` in order and answers once they settled or the ack
// timeout passed, one frame at a time; it logs a failing handler and still
// acknowledges; it delivers `PeerSignal` to the `onSignal` handlers with the
// `live` of the last frame. `bundle/testing`'s router sends both frames to
// the bundle under test as the host SDK would.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import type { Log } from '../../src/contracts/basic/log.js';
import {
  GenerationChangedSchema,
  PeerSignalSchema,
} from '../../src/contracts/gen/doric/platform/v1/control_pb.js';
import type {
  BundleInstance,
  GenerationChangedEvent,
  PeerSignalEvent,
} from '../../src/sdk/host/context.js';
import { createGenerations } from '../../src/sdk/host/generations.js';
import { createTestRouter } from '../../src/testing/index.js';

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 2_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Whether `promise` settled within `ms`. */
const settlesWithin = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> => {
  let settled = false;

  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(ms);

  return settled;
};

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

interface LogRecord {
  readonly level: string;
  readonly text: string;
}

const recordingLog = (): {
  readonly log: Log;
  readonly records: LogRecord[];
} => {
  const records: LogRecord[] = [];
  const write =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      records.push({
        level,
        text: `${message} ${JSON.stringify(fields ?? {})}`,
      });
    };

  return {
    records,
    log: {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
    },
  };
};

const self: BundleInstance = { bundleId: 'b', generation: 2, incarnation: 1 };

const instance = (generation: number, incarnation = 1) => ({
  bundleId: 'b',
  generation,
  incarnation,
});

const changedFrame = (
  event: string,
  subject?: ReturnType<typeof instance>,
  live: readonly {
    readonly instance: ReturnType<typeof instance>;
    readonly state: string;
  }[] = [],
) =>
  create(GenerationChangedSchema, {
    event,
    ...(subject === undefined ? {} : { subject }),
    live: [...live],
  });

const signalFrame = (topic: string, payload?: JsonValue) =>
  create(PeerSignalSchema, {
    topic,
    from: instance(1),
    ...(payload === undefined
      ? {}
      : { payload: fromJson(ValueSchema, payload) }),
  });

const setup = (ackTimeoutMs = 2_000) => {
  const { log, records } = recordingLog();
  const generations = createGenerations({ instance: self, log, ackTimeoutMs });

  return { generations, records };
};

// ---------------------------------------------------------------------------
// GenerationChanged

describe('createGenerations: GenerationChanged', () => {
  test('acknowledges at once when no handler was added', async () => {
    const { generations } = setup();

    assert.equal(
      await settlesWithin(generations.changed(changedFrame('draining')), 50),
      true,
    );
  });

  test('runs every handler with the event, in the order they were added', async () => {
    const { generations } = setup();
    const seen: string[] = [];
    let event: GenerationChangedEvent | undefined;

    generations.api.onChanged((change) => {
      seen.push('first');
      event = change;
    });
    generations.api.onChanged(() => {
      seen.push('second');
    });

    await within(
      generations.changed(
        changedFrame('activated', instance(3, 2), [
          { instance: instance(3, 2), state: 'active' },
          { instance: instance(2, 1), state: 'draining' },
          { instance: instance(1, 4), state: 'stopping' },
        ]),
      ),
      'the ack',
    );

    assert.deepEqual(seen, ['first', 'second']);
    assert.deepEqual(event, {
      event: 'activated',
      generation: 3,
      incarnation: 2,
      self,
      live: [
        { generation: 3, incarnation: 2, state: 'active' },
        { generation: 2, incarnation: 1, state: 'draining' },
      ],
    });
  });

  test('takes the generation and incarnation of this instance for a frame without subject', async () => {
    const { generations } = setup();
    let event: GenerationChangedEvent | undefined;

    generations.api.onChanged((change) => {
      event = change;
    });
    await within(generations.changed(changedFrame('draining')), 'the ack');

    assert.equal(event?.generation, 2);
    assert.equal(event?.incarnation, 1);
  });

  test('acknowledges only once every handler settled', async () => {
    const { generations } = setup();
    const gate = deferred();

    generations.api.onChanged(() => gate.promise);
    generations.api.onChanged(() => {});

    const ack = generations.changed(changedFrame('draining', instance(2)));

    assert.equal(await settlesWithin(ack, 100), false);

    gate.resolve();
    await within(ack, 'the ack after the handler settled');
  });

  test('acknowledges after ackTimeoutMs when a handler never settles', async () => {
    const { generations } = setup(150);

    generations.api.onChanged(() => new Promise<void>(() => {}));

    const started = performance.now();

    await within(
      generations.changed(changedFrame('draining', instance(2))),
      'the ack after the timeout',
    );

    assert.ok(performance.now() - started >= 140, 'acknowledged too early');
  });

  test('logs a handler that throws or rejects at level error, runs the others and still acknowledges', async () => {
    const { generations, records } = setup();
    const ran: string[] = [];

    generations.api.onChanged(() => {
      throw new Error('handler broke');
    });
    generations.api.onChanged(() =>
      Promise.reject(new Error('handler rejected')),
    );
    generations.api.onChanged(() => {
      ran.push('third');
    });

    await within(
      generations.changed(changedFrame('stopped', instance(1))),
      'the ack',
    );

    assert.deepEqual(ran, ['third']);

    const errors = records.filter(({ level }) => level === 'error');

    assert.equal(errors.length, 2);
    assert.ok(
      errors.every(({ text }) => text.includes('stopped')),
      `the records name the event: ${JSON.stringify(errors)}`,
    );
  });

  test('delivers frames one at a time: the next frame waits for the previous ack', async () => {
    const { generations } = setup();
    const gate = deferred();
    const seen: string[] = [];

    generations.api.onChanged(async (change) => {
      seen.push(`start ${change.event}`);

      if (change.event === 'draining') {
        await gate.promise;
      }

      seen.push(`end ${change.event}`);
    });

    const first = generations.changed(changedFrame('draining', instance(2)));
    const second = generations.changed(changedFrame('activated', instance(3)));

    await sleep(50);
    assert.deepEqual(seen, ['start draining']);

    gate.resolve();
    await within(Promise.all([first, second]), 'both acks');

    assert.deepEqual(seen, [
      'start draining',
      'end draining',
      'start activated',
      'end activated',
    ]);
  });

  test('stops calling a handler once its remover was called', async () => {
    const { generations } = setup();
    const seen: string[] = [];
    const remove = generations.api.onChanged((change) => {
      seen.push(change.event);
    });

    await within(generations.changed(changedFrame('lost', instance(1))), 'ack');
    remove();
    await within(
      generations.changed(changedFrame('stopped', instance(1))),
      'ack',
    );

    assert.deepEqual(seen, ['lost']);
  });

  test('does not replay a frame acknowledged before any handler was added', async () => {
    const { generations } = setup();
    const seen: string[] = [];

    await within(
      generations.changed(changedFrame('draining', instance(2))),
      'the ack',
    );
    generations.api.onChanged((change) => {
      seen.push(change.event);
    });
    await sleep(20);

    assert.deepEqual(seen, []);
  });

  test('runs no handler for an event that is not a generation event', async () => {
    const { generations } = setup();
    const seen: string[] = [];

    generations.api.onChanged((change) => {
      seen.push(change.event);
    });
    await within(generations.changed(changedFrame('rebooted')), 'the ack');

    assert.deepEqual(seen, []);
  });
});

// ---------------------------------------------------------------------------
// PeerSignal

describe('createGenerations: PeerSignal', () => {
  test('calls every handler with the topic, the payload as JSON, the sender and this instance alone as live', () => {
    const { generations } = setup();
    const signals: PeerSignalEvent[] = [];

    generations.api.onSignal((signal) => {
      signals.push(signal);
    });
    generations.api.onSignal((signal) => {
      signals.push(signal);
    });
    generations.signal(signalFrame('hello', { n: 1, tags: ['a'] }));

    assert.equal(signals.length, 2);
    assert.deepEqual(signals[0], {
      topic: 'hello',
      payload: { n: 1, tags: ['a'] },
      from: instance(1),
      self,
      live: [{ generation: 2, incarnation: 1, state: 'active' }],
    });
  });

  test('gives null as the payload of a signal without one', () => {
    const { generations } = setup();
    let payload: JsonValue | undefined;

    generations.api.onSignal((signal) => {
      payload = signal.payload;
    });
    generations.signal(signalFrame('bare'));

    assert.equal(payload, null);
  });

  test('gives the live instances of the last GenerationChanged', async () => {
    const { generations } = setup();
    let live: PeerSignalEvent['live'] | undefined;

    generations.api.onSignal((signal) => {
      live = signal.live;
    });
    await within(
      generations.changed(
        changedFrame('activated', instance(3), [
          { instance: instance(3), state: 'active' },
          { instance: instance(2), state: 'draining' },
        ]),
      ),
      'the ack',
    );
    generations.signal(signalFrame('hello'));

    assert.deepEqual(live, [
      { generation: 3, incarnation: 1, state: 'active' },
      { generation: 2, incarnation: 1, state: 'draining' },
    ]);
  });

  test('logs a failing handler at level error with the topic and still calls the others', async () => {
    const { generations, records } = setup();
    const ran: string[] = [];

    generations.api.onSignal(() => {
      throw new Error('signal handler broke');
    });
    generations.api.onSignal(() => {
      ran.push('second');
    });
    generations.signal(signalFrame('ping'));
    await sleep(10);

    assert.deepEqual(ran, ['second']);

    const errors = records.filter(({ level }) => level === 'error');

    assert.equal(errors.length, 1);
    assert.match(errors[0]?.text ?? '', /ping/);
  });

  test('drops a signal that arrives before any handler, and stops after the remover', () => {
    const { generations } = setup();
    const topics: string[] = [];

    generations.signal(signalFrame('early'));

    const remove = generations.api.onSignal((signal) => {
      topics.push(signal.topic);
    });

    generations.signal(signalFrame('kept'));
    remove();
    generations.signal(signalFrame('late'));

    assert.deepEqual(topics, ['kept']);
  });
});

// ---------------------------------------------------------------------------
// bundle/testing

describe('bundle/testing: generation frames', () => {
  const testInstance = {
    bundleId: 'under-test',
    generation: 4,
    incarnation: 2,
  };

  test('generationChanged runs the onChanged handlers and resolves once they settled', async () => {
    const router = createTestRouter({ instance: testInstance });
    const seen: GenerationChangedEvent[] = [];
    const gate = deferred();

    await router.activate({
      activate: (context) => {
        context.generations.onChanged(async (change) => {
          seen.push(change);
          await gate.promise;
        });
      },
    });

    const ack = router.control.generationChanged({
      event: 'draining',
      subject: { bundleId: 'under-test', generation: 3, incarnation: 1 },
    });

    assert.equal(await settlesWithin(ack, 100), false);

    gate.resolve();
    await within(ack, 'generationChanged');

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.event, 'draining');
    assert.equal(seen[0]?.generation, 3);
    assert.equal(seen[0]?.incarnation, 1);
    assert.deepEqual(seen[0]?.self, testInstance);

    await router.control.stop();
  });

  test("generationChanged without subject is about the test's instance, and a failing handler is logged", async () => {
    const router = createTestRouter({ instance: testInstance });
    let event: GenerationChangedEvent | undefined;

    await router.activate({
      activate: (context) => {
        context.generations.onChanged((change) => {
          event = change;
          throw new Error('handler broke');
        });
      },
    });
    await within(
      router.control.generationChanged({ event: 'activated' }),
      'generationChanged',
    );

    assert.equal(event?.generation, 4);
    assert.equal(event?.incarnation, 2);
    assert.ok(
      router.logs.some(({ level }) => level === 'error'),
      'the failure is in the logs',
    );

    await router.control.stop();
  });

  test('peerSignal calls the onSignal handlers in order with the live of the last frame', async () => {
    const router = createTestRouter({ instance: testInstance });
    const seen: string[] = [];
    const signals: PeerSignalEvent[] = [];

    await router.activate({
      activate: (context) => {
        context.generations.onSignal((signal) => {
          seen.push(`first ${signal.topic}`);
          signals.push(signal);
        });
        context.generations.onSignal((signal) => {
          seen.push(`second ${signal.topic}`);
        });
      },
    });

    await within(
      router.control.peerSignal({
        topic: 'before',
        from: { bundleId: 'under-test', generation: 3, incarnation: 1 },
        payload: fromJson(ValueSchema, 'x'),
      }),
      'peerSignal',
    );
    await within(
      router.control.generationChanged({
        event: 'activated',
        live: [
          {
            instance: { bundleId: 'under-test', generation: 4, incarnation: 2 },
            state: 'active',
          },
          {
            instance: { bundleId: 'under-test', generation: 3, incarnation: 1 },
            state: 'draining',
          },
        ],
      }),
      'generationChanged',
    );
    await within(
      router.control.peerSignal({
        topic: 'after',
        from: { bundleId: 'under-test', generation: 3, incarnation: 1 },
      }),
      'peerSignal',
    );

    assert.deepEqual(seen, [
      'first before',
      'second before',
      'first after',
      'second after',
    ]);
    assert.deepEqual(signals[0]?.live, [
      { generation: 4, incarnation: 2, state: 'active' },
    ]);
    assert.equal(signals[0]?.payload, 'x');
    assert.deepEqual(signals[0]?.self, testInstance);
    assert.deepEqual(signals[1]?.live, [
      { generation: 4, incarnation: 2, state: 'active' },
      { generation: 3, incarnation: 1, state: 'draining' },
    ]);

    await router.control.stop();
  });

  test('peerSignal resolves at once and runs nothing before activate and after stop', async () => {
    const router = createTestRouter({ instance: testInstance });
    const topics: string[] = [];

    await within(router.control.peerSignal({ topic: 'early' }), 'before');
    await router.activate({
      activate: (context) => {
        context.generations.onSignal((signal) => {
          topics.push(signal.topic);
        });
      },
    });
    await router.control.stop();
    await within(router.control.peerSignal({ topic: 'late' }), 'after stop');

    assert.deepEqual(topics, []);
  });

  test('peerSignal records a failing handler in the logs', async () => {
    const router = createTestRouter({ instance: testInstance });

    await router.activate({
      activate: (context) => {
        context.generations.onSignal(() => Promise.reject(new Error('nope')));
      },
    });
    await within(router.control.peerSignal({ topic: 'ping' }), 'peerSignal');

    assert.ok(router.logs.some(({ level }) => level === 'error'));

    await router.control.stop();
  });
});
