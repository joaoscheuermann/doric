import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import pino, { type Logger } from 'pino';

import type { SandboxSession } from 'sandbox';

import { createSandpool } from '../src/index.js';

type LogRecord = Record<string, unknown> & {
  readonly level: number;
  readonly msg: string;
};

test('validates the logger contract synchronously', () => {
  const create = async () => session('unused');
  const valid = pino({ enabled: false });

  assert.throws(
    () =>
      createSandpool({
        minIdle: 0,
        maxSandboxes: 1,
        create,
        logger: { ...valid, debug: undefined } as unknown as Logger,
      }),
    /logger\.debug must be a function/u,
  );

  assert.throws(
    () =>
      createSandpool({
        minIdle: 0,
        maxSandboxes: 1,
        create,
        logger: { ...valid, child: undefined } as unknown as Logger,
      }),
    /logger\.child must be a function/u,
  );

  assert.throws(
    () =>
      createSandpool({
        minIdle: 0,
        maxSandboxes: 1,
        create,
        logger: {
          debug: () => undefined,
          child: () => undefined,
        } as unknown as Logger,
      }),
    /logger\.child must return a logger with a debug method/u,
  );
});

test('logs lifecycle events as safe structured debug records', async () => {
  const { logger, records } = capture();

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger,
    create: async () => session('sandbox-safe-id'),
  });

  await pool.waitUntilHeated();

  const lease = await pool.acquire();

  await lease.release();

  await pool.waitUntilHeated();

  await pool.dispose();

  assert.deepEqual(
    records.map(({ msg }) => msg),
    [
      'sandpool started',
      'sandbox creation started',
      'waiting for sandpool to heat',
      'sandbox created',
      'sandpool heated',
      'sandbox acquisition queued',
      'sandbox leased',
      'sandbox lease released',
      'sandbox disposal started',
      'sandbox disposed',
      'sandbox creation started',
      'sandbox created',
      'sandpool heated',
      'sandpool disposal started',
      'sandbox disposal started',
      'sandbox disposed',
      'sandpool disposed',
    ],
  );

  assert.ok(records.every(({ level }) => level === 20));

  assert.ok(records.every(({ component }) => component === 'sandpool'));

  assert.ok(records.every(({ minIdle }) => minIdle === 1));

  assert.ok(records.every(({ maxSandboxes }) => maxSandboxes === 1));

  assert.equal(
    records.find(({ msg }) => msg === 'sandbox leased')?.sandboxId,
    'sandbox-safe-id',
  );

  assert.doesNotMatch(JSON.stringify(records), /workspace|secret/u);
});

test('logs cancellations, failures, and retries without causes', async () => {
  const { logger, records } = capture();
  const creationFailure = new Error('secret creation cause');
  const disposalFailure = new Error('secret disposal cause');
  let creations = 0;
  let disposals = 0;

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger,
    create: async () => {
      creations += 1;

      if (creations === 1) {
        throw creationFailure;
      }

      return session('retry-safe-id', async () => {
        disposals += 1;

        if (disposals === 1) {
          throw disposalFailure;
        }
      });
    },
  });
  const heatController = new AbortController();
  const acquisitionController = new AbortController();
  const heating = pool.waitUntilHeated({ signal: heatController.signal });
  const acquisition = pool.acquire({ signal: acquisitionController.signal });

  heatController.abort();

  acquisitionController.abort();

  await assert.rejects(heating, { name: 'AbortError' });

  await assert.rejects(acquisition, { name: 'AbortError' });

  await pool.waitUntilHeated();

  await (await pool.acquire()).release();

  await pool.dispose();

  const messages = records.map(({ msg }) => msg);

  assert.ok(messages.includes('sandpool heat wait cancelled'));

  assert.ok(messages.includes('sandbox acquisition cancelled'));

  assert.ok(messages.includes('sandbox creation failed'));

  assert.ok(messages.includes('sandbox creation retry scheduled'));

  assert.ok(messages.includes('sandbox disposal failed'));

  assert.ok(messages.includes('sandbox disposal retry scheduled'));

  assert.doesNotMatch(
    JSON.stringify(records),
    /secret creation cause|secret disposal cause|lastFailure|cause/u,
  );

  assert.equal(
    records.find(({ msg }) => msg === 'sandbox creation retry scheduled')
      ?.retryDelayMs,
    250,
  );

  const creationRecord = records.find(
    ({ msg }) => msg === 'sandbox creation failed',
  );

  assert.equal(creationRecord?.reason, 'sandbox_factory_rejected');

  assert.equal(
    creationRecord?.hint,
    'Check sandbox provider availability, image access, and resource support.',
  );
});

test('logs exhausted creation attempts without the factory cause', async () => {
  const { logger, records } = capture();

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    maxCreateAttempts: 1,
    logger,
    create: async () => {
      throw new Error('secret permanent failure');
    },
  });

  await assert.rejects(pool.acquire());

  await pool.dispose();

  const exhausted = records.find(
    ({ msg }) => msg === 'sandbox creation attempts exhausted',
  );

  assert.equal(exhausted?.reason, 'sandbox_creation_attempts_exhausted');

  assert.equal(exhausted?.createFailures, 1);

  assert.equal(exhausted?.maxCreateAttempts, 1);

  assert.doesNotMatch(JSON.stringify(records), /secret permanent failure/u);
});

test('logs release and pool disposal only once when calls are repeated', async () => {
  const { logger, records } = capture();

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    logger,
    create: async () => session('idempotent'),
  });
  const lease = await pool.acquire();

  await Promise.all([lease.release(), lease.release()]);

  await Promise.all([pool.dispose(), pool.dispose()]);

  assert.equal(
    records.filter(({ msg }) => msg === 'sandbox lease released').length,
    1,
  );

  assert.equal(
    records.filter(({ msg }) => msg === 'sandpool disposal started').length,
    1,
  );

  assert.equal(
    records.filter(({ msg }) => msg === 'sandpool disposed').length,
    1,
  );
});

const capture = (): {
  readonly logger: Logger;
  readonly records: LogRecord[];
} => {
  const records: LogRecord[] = [];

  const output = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(String(chunk)) as LogRecord);

      callback();
    },
  });

  const logger = pino(
    { base: undefined, level: 'debug', timestamp: false },
    output,
  );

  return { logger, records };
};

const session = (
  id: string,
  dispose: () => Promise<void> = async () => undefined,
): SandboxSession => {
  const unsupported = async (): Promise<never> => {
    throw new Error('secret unsupported operation');
  };

  return {
    id,
    root: '/secret/workspace',
    exec: unsupported,
    cloneRepo: unsupported,
    readFile: unsupported,
    writeFile: unsupported,
    putFile: unsupported,
    getFile: unsupported,
    diff: async () => '',
    ssh: async () => undefined,
    dispose,
  };
};
