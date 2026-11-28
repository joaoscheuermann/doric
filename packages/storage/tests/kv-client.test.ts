// The `Kv` doc comment of `src/kv.ts`: every refusal reaches the caller as a
// `ContractError`, `cancelled` and `deadline_exceeded` for the call's signal
// and deadline, `unavailable` when the engine cannot be reached, and a
// contract refusal keeps its code and details. Checked through `kvClient` on
// the engine `openTestEngine` spawns.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { CommitRequest } from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import {
  bytes,
  collect,
  condition,
  getRequest,
  hex,
  put,
  rangeRequest,
  refusal,
} from '../src/conformance/kv/support.js';
import { openTestEngine, type TestEngine } from '../src/testing.js';

const caseTimeoutMs = 120_000;

/** Waits `ms` milliseconds of real time, or until `signal` aborts. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Commit items that arrive slowly: one put, then nothing until `signal`
 * aborts or `ms` have passed, then a second put.
 */
async function* slowItems(ms: number, signal?: AbortSignal): AsyncGenerator<CommitRequest> {
  yield put(bytes('a/slow/1'), bytes('v'));
  await pause(ms, signal);
  yield put(bytes('a/slow/2'), bytes('v'));
}

describe('kvClient', { timeout: caseTimeoutMs }, () => {
  let engine: TestEngine | undefined;

  before(async () => {
    engine = await openTestEngine();
  });

  after(async () => {
    await engine?.close();
  });

  const opened = (): TestEngine => {
    assert.ok(engine, 'the engine opened');

    return engine;
  };

  test('an abort during a long Range iteration rejects with cancelled', async () => {
    const kv = opened().kv('doric');
    const value = new Uint8Array(4096).fill(0x76);

    await opened().reset();
    await kv.commit(
      Array.from({ length: 1000 }, (_, index) =>
        put(bytes(`a/r/${String(index).padStart(4, '0')}`), value),
      ),
    );

    const controller = new AbortController();
    const answer = kv.range(
      rangeRequest({ start: bytes('a/r/'), end: bytes('a/r0'), limit: 1000 }),
      { signal: controller.signal },
    );

    await assert.rejects(
      (async () => {
        let read = 0;

        for await (const _ of answer) {
          read += 1;

          if (read === 1) {
            controller.abort();
          }
        }
      })(),
      refusal('cancelled'),
    );
  });

  test('an abort during a Commit whose items stream slowly rejects with cancelled', async () => {
    const kv = opened().kv('doric');
    const controller = new AbortController();
    const committed = kv.commit(slowItems(60_000, controller.signal), {
      signal: controller.signal,
    });

    await pause(200);
    controller.abort();
    await assert.rejects(committed, refusal('cancelled'));
  });

  test('a deadline already in the past rejects with deadline_exceeded', async () => {
    const kv = opened().kv('doric');

    await assert.rejects(
      collect(kv.get(getRequest([bytes('a/x')]), { deadline: Date.now() - 1000 })),
      refusal('deadline_exceeded'),
    );
  });

  test('a short deadline on a Commit whose items stream slowly rejects with deadline_exceeded', async () => {
    const kv = opened().kv('doric');
    const stop = new AbortController();

    try {
      await assert.rejects(
        kv.commit(slowItems(60_000, stop.signal), { deadline: Date.now() + 200 }),
        refusal('deadline_exceeded'),
      );
    } finally {
      stop.abort();
    }
  });

  test('a contract refusal keeps its code and details', async () => {
    const kv = opened().kv('doric');

    const keys = Array.from({ length: 1001 }, (_, index) => bytes(`a/${index}`));

    await assert.rejects(
      collect(kv.get(getRequest(keys))),
      refusal('limit_exceeded', { limit: 'getKeys' }),
    );
    await assert.rejects(
      kv.commit([condition(bytes('a/x'), 7), put(bytes('a/x'), bytes('v'))]),
      refusal('condition_failed', { key: hex(bytes('a/x')) }),
    );
  });

  test('a call after the engine is closed rejects with unavailable', async () => {
    const closed = await openTestEngine();
    const kv = closed.kv('doric');

    await closed.close();
    await assert.rejects(collect(kv.get(getRequest([bytes('a/x')]))), refusal('unavailable'));
    await assert.rejects(kv.commit([put(bytes('a/x'), bytes('v'))]), refusal('unavailable'));
  });
});
