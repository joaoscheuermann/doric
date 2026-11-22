// Resumable streams, the caller's side (spec `docs/designs/grpc-processes.md`,
// section 4, "Resumable streams"; section 6, "Drain"): `reopenResumable`
// opens a resumable server stream again when an opening ends with
// `generation_lost`, with `resume(last)` after an item, waits
// `resumableDelays` between openings (100 ms, doubling while an opening
// answers `unavailable`, at most 5 s), and stops on any other end. The clock
// is faked with `node:test`'s mock timers: `drive` advances it 10 ms at a
// time and lets the iteration run between steps.

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';

import { ContractError, isContractError } from '../src/contracts/error.js';
import { toConnectError } from '../src/contracts/status.js';
import { reopenResumable, resumableDelays } from '../src/runtime/index.js';

// ---------------------------------------------------------------------------
// Helpers

/** What one opening yields, then how it ends: `undefined` for no error. */
interface Opening {
  readonly items: readonly number[];
  readonly end?: Error;
}

const lost = (): ContractError =>
  new ContractError('generation_lost', 'The provider instance was lost.');
const unavailable = (): ContractError =>
  new ContractError('unavailable', 'No instance is active.');

interface Opener {
  readonly open: (request: string) => AsyncIterable<number>;
  /** `<request>@<mocked time>` of every opening, in order. */
  readonly opened: string[];
  /** How many openings ended through their iterator's `return`. */
  readonly returned: () => number;
}

const opener = (script: readonly Opening[]): Opener => {
  const opened: string[] = [];
  let returned = 0;

  return {
    opened,
    returned: () => returned,
    open: (request) => {
      const opening = script[opened.length] ?? { items: [] };

      opened.push(`${request}@${Date.now()}`);

      return (async function* () {
        let done = false;

        try {
          for (const item of opening.items) {
            yield item;
          }

          done = true;
        } finally {
          if (!done) {
            returned += 1;
          }
        }

        if (opening.end !== undefined) {
          throw opening.end;
        }
      })();
    },
  };
};

const resume = (last: number): string => `resume:${last}`;

const enableClock = (t: TestContext): void => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
};

/** Lets pending promise jobs and I/O callbacks run. */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/**
 * Advances the mocked clock 10 ms at a time until `done()` holds or `maxMs`
 * of mocked time passed.
 */
const drive = async (
  t: TestContext,
  done: () => boolean,
  maxMs: number,
): Promise<void> => {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 10) {
    await flush();

    if (done()) {
      return;
    }

    t.mock.timers.tick(10);
  }

  await flush();
};

interface Run {
  readonly items: number[];
  readonly settled: () => boolean;
  readonly error: () => unknown;
}

/** Iterates `iterable` in the background, collecting its items. */
const consume = (iterable: AsyncIterable<number>): Run => {
  const items: number[] = [];
  let settled = false;
  let error: unknown;

  void (async () => {
    try {
      for await (const item of iterable) {
        items.push(item);
      }
    } catch (caught) {
      error = caught;
    } finally {
      settled = true;
    }
  })();

  return { items, settled: () => settled, error: () => error };
};

const codeOf = (error: unknown): string | undefined => {
  if (isContractError(error)) {
    return error.code;
  }

  return undefined;
};

/** The mocked times of the openings. */
const timesOf = (opened: readonly string[]): number[] =>
  opened.map((entry) => Number(entry.slice(entry.indexOf('@') + 1)));

// ---------------------------------------------------------------------------
// Tests

describe('reopenResumable', () => {
  test('waits 100 ms at first and 5 s at most', () => {
    assert.deepEqual(resumableDelays, { firstMs: 100, maxMs: 5_000 });
  });

  test('yields the items of an opening that ends without error, opened once', async (t) => {
    enableClock(t);

    const { open, opened } = opener([{ items: [1, 2, 3] }]);
    const run = consume(reopenResumable(open, 'start', resume));

    await drive(t, run.settled, 1_000);

    assert.equal(run.settled(), true);
    assert.equal(run.error(), undefined);
    assert.deepEqual(run.items, [1, 2, 3]);
    assert.deepEqual(opened, ['start@0']);
  });

  test('opens nothing before the iteration starts, and each iteration opens anew', async (t) => {
    enableClock(t);

    const { open, opened } = opener([{ items: [1] }, { items: [2] }]);
    const iterable = reopenResumable(open, 'start', resume);

    await drive(t, () => false, 200);
    assert.deepEqual(opened, []);

    const first = consume(iterable);

    await drive(t, first.settled, 1_000);

    const second = consume(iterable);

    await drive(t, second.settled, 1_000);

    assert.deepEqual([...first.items, ...second.items], [1, 2]);
    assert.equal(opened.length, 2);
  });

  test('after generation_lost, opens again 100 ms later with resume(last)', async (t) => {
    enableClock(t);

    const { open, opened } = opener([
      { items: [1, 2], end: lost() },
      { items: [3] },
    ]);
    const run = consume(reopenResumable(open, 'start', resume));

    await drive(t, run.settled, 2_000);

    assert.equal(run.error(), undefined);
    assert.deepEqual(run.items, [1, 2, 3]);
    assert.deepEqual(opened, ['start@0', 'resume:2@100']);
  });

  test('reopens on generation_lost carried by a ConnectError', async (t) => {
    enableClock(t);

    const { open, opened } = opener([
      { items: [1], end: toConnectError(lost()) },
      { items: [2] },
    ]);
    const run = consume(reopenResumable(open, 'start', resume));

    await drive(t, run.settled, 2_000);

    assert.equal(run.error(), undefined);
    assert.deepEqual(run.items, [1, 2]);
    assert.deepEqual(opened, ['start@0', 'resume:1@100']);
  });

  test('reopens with the request when no resume is given, or when no item was yielded', async (t) => {
    enableClock(t);

    const withoutResume = opener([{ items: [1], end: lost() }, { items: [] }]);
    const first = consume(reopenResumable(withoutResume.open, 'start'));

    await drive(t, first.settled, 2_000);

    const beforeAnyItem = opener([{ items: [], end: lost() }, { items: [] }]);
    const second = consume(
      reopenResumable(beforeAnyItem.open, 'start', resume),
    );

    await drive(t, second.settled, 2_000);

    assert.deepEqual(
      withoutResume.opened.map((entry) => entry.split('@')[0]),
      ['start', 'start'],
    );
    assert.deepEqual(
      beforeAnyItem.opened.map((entry) => entry.split('@')[0]),
      ['start', 'start'],
    );
  });

  test('doubles the delay while reopenings answer unavailable, up to 5 s, and starts over after an item', async (t) => {
    enableClock(t);

    const { open, opened } = opener([
      { items: [1], end: lost() },
      { items: [], end: unavailable() },
      { items: [], end: unavailable() },
      { items: [], end: unavailable() },
      { items: [], end: unavailable() },
      { items: [], end: unavailable() },
      { items: [], end: unavailable() },
      { items: [], end: unavailable() },
      { items: [2], end: lost() },
      { items: [3] },
    ]);
    const run = consume(reopenResumable(open, 'start', resume));

    await drive(t, run.settled, 25_000);

    assert.equal(run.error(), undefined);
    assert.deepEqual(run.items, [1, 2, 3]);

    const times = timesOf(opened);
    const gaps = times
      .slice(1)
      .map((time, index) => time - (times[index] ?? 0));

    assert.deepEqual(
      gaps,
      [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000, 100],
    );
  });

  test('fails with unavailable when the first opening answers it, without reopening', async (t) => {
    enableClock(t);

    const { open, opened } = opener([{ items: [], end: unavailable() }]);
    const run = consume(reopenResumable(open, 'start', resume));

    await drive(t, run.settled, 1_000);

    assert.equal(run.settled(), true);
    assert.equal(codeOf(run.error()), 'unavailable');
    assert.equal(opened.length, 1);
  });

  test('fails with the error of an opening that ends with another code, without reopening', async (t) => {
    enableClock(t);

    const denied = new ConnectError('denied', Code.PermissionDenied);
    const { open, opened } = opener([
      { items: [1], end: lost() },
      { items: [2], end: new ContractError('internal', 'boom') },
      { items: [3] },
    ]);
    const run = consume(reopenResumable(open, 'start', resume));

    await drive(t, run.settled, 2_000);

    assert.equal(codeOf(run.error()), 'internal');
    assert.deepEqual(run.items, [1, 2]);
    assert.equal(opened.length, 2);

    const other = opener([{ items: [], end: denied }]);
    const second = consume(reopenResumable(other.open, 'start', resume));

    await drive(t, second.settled, 1_000);

    assert.equal(second.error(), denied);
    assert.equal(other.opened.length, 1);
  });

  test('break ends the open stream through its return', async (t) => {
    enableClock(t);

    const { open, opened, returned } = opener([{ items: [1, 2, 3] }]);
    const seen: number[] = [];
    let finished = false;

    void (async () => {
      for await (const item of reopenResumable(open, 'start', resume)) {
        seen.push(item);
        break;
      }

      finished = true;
    })();
    await drive(t, () => finished, 1_000);

    assert.equal(finished, true);
    assert.deepEqual(seen, [1]);
    assert.equal(returned(), 1);
    assert.equal(opened.length, 1);
  });

  test('return during the delay cancels the pending reopening', async (t) => {
    enableClock(t);

    const { open, opened } = opener([
      { items: [1], end: lost() },
      { items: [2] },
    ]);
    const iterator = reopenResumable(open, 'start', resume)[
      Symbol.asyncIterator
    ]();

    assert.deepEqual(await iterator.next(), { done: false, value: 1 });

    // The opening ends with generation_lost: the iteration waits 100 ms.
    const pending = iterator.next();

    await drive(t, () => false, 30);

    let returnedResult: IteratorResult<number> | undefined;

    void iterator.return?.().then((result) => {
      returnedResult = result;
    });
    void pending.catch(() => {});
    await drive(t, () => false, 500);

    assert.equal(opened.length, 1, `opened again: ${opened.join(', ')}`);
    assert.deepEqual(returnedResult, { done: true, value: undefined });
  });
});
