// Which inline comment seats the transcript holds, and in what order: a seat is
// one comment, named by its id, so a paragraph can hold several. Every stack
// item that names a seat stands at it while its turn is shown, beside the seats
// the reader opened; anything else goes, a seat the transcript lost comes back,
// and the seats after one paragraph stand in the order of their passages.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bySeatPlace,
  planSeats,
  type SeatWant,
  seatWantOf,
  seatWantsKey,
} from '../src/client/domain/comment-seats.js';

/** A stack item with the given id and data. */
const item = (id: string, data: unknown) => ({
  id,
  kind: 'message',
  elementTag: 'chat-comment-line',
  data,
  note: 'a note',
});

/** A seated message comment's data, quoting `text` at the seat. */
const seated = (turn: string, block: number, text: string, at?: number) => ({
  target: {
    kind: 'message',
    id: 'prompt-1',
    anchor: { form: 'range', text, turn, block },
  },
  seat: at === undefined ? { turn, block } : { turn, block, at },
});

const want = (id: string, turn = 't1', block = 0): SeatWant => ({
  id,
  turn,
  block,
  quote: 'words',
  at: 0,
  after: block,
});

describe('seatWantOf', () => {
  test('asks for the item’s own seat, under its id, quoting its anchor’s words', () => {
    assert.deepEqual(
      seatWantOf(item('comment-a', seated('t1', 2, 'the form', 5))),
      {
        id: 'comment-a',
        turn: 't1',
        block: 2,
        quote: 'the form',
        at: 5,
        after: 2,
      },
    );
  });

  test('stands where the item says its words end: a later block, a list’s item', () => {
    const data = {
      ...seated('t1', 2, 'the form', 5),
      seat: { turn: 't1', block: 2, at: 5, after: 3, item: 1 },
    };

    assert.deepEqual(seatWantOf(item('comment-a', data)), {
      id: 'comment-a',
      turn: 't1',
      block: 2,
      quote: 'the form',
      at: 5,
      after: 3,
      item: 1,
    });
  });

  test('keeps the list item its anchor says the words start in, for a reader who goes to them', () => {
    const data = {
      target: {
        kind: 'message',
        id: 'prompt-1',
        anchor: {
          form: 'range',
          text: 'the form',
          turn: 't1',
          block: 2,
          at: 5,
          item: 1,
        },
      },
      seat: { turn: 't1', block: 2, at: 5, after: 2, item: 1 },
    };

    assert.equal(seatWantOf(item('comment-a', data))?.startItem, 1);
    assert.equal(
      seatWantOf(item('comment-a', seated('t1', 2, 'the form')))?.startItem,
      undefined,
      'an anchor that names no item asks for none',
    );
  });

  test('counts from the block’s start when the item did not record where', () => {
    assert.equal(seatWantOf(item('comment-a', seated('t1', 2, 'x')))?.at, 0);
  });

  test('asks for nothing for an item without a seat or without words', () => {
    assert.equal(
      seatWantOf(item('comment-a', { target: { anchor: { text: 'x' } } })),
      undefined,
    );
    assert.equal(
      seatWantOf(
        item('comment-a', { seat: { turn: 't1', block: 0 }, target: {} }),
      ),
      undefined,
    );
  });
});

describe('planSeats', () => {
  const turns = new Set(['t1', 't2']);

  test('opens the wanted comments the transcript lacks, in the turns it shows', () => {
    const plan = planSeats([want('a'), want('b', 't3')], [], turns);

    assert.deepEqual(plan.open, [want('a')]);
    assert.deepEqual(plan.remove, []);
  });

  test('holds several comments after one paragraph', () => {
    const plan = planSeats([want('a'), want('b'), want('c')], ['a'], turns);

    assert.deepEqual(plan.open, [want('b'), want('c')]);
    assert.deepEqual(plan.remove, []);
  });

  test('removes the comments nobody wants', () => {
    const plan = planSeats([want('a')], ['a', 'gone'], turns);

    assert.deepEqual(plan, { remove: ['gone'], open: [] });
  });

  test('opens one seat for a comment the stack and the reader both name', () => {
    const plan = planSeats(
      [want('a'), { ...want('a'), quote: 'other' }],
      [],
      turns,
    );

    assert.deepEqual(plan.open, [want('a')]);
  });
});

describe('seatWantsKey', () => {
  /** The seats a stack asks for, its items written with `notes`. */
  const wantsOf = (notes: readonly string[]) =>
    notes.flatMap((note, index) => {
      const want = seatWantOf({
        ...item(`comment-${index}`, seated('t1', index, 'words', 2)),
        note,
      });
      return want === undefined ? [] : [want];
    });

  test('a note’s words leave the seats a stack asks for as they were', () => {
    assert.equal(
      seatWantsKey(wantsOf(['a note', 'another'])),
      seatWantsKey(wantsOf(['a note, edited', 'another, edited'])),
    );
  });

  test('a seat that comes, goes or stands elsewhere asks for other seats', () => {
    const base = [want('a'), want('b')];
    const key = seatWantsKey(base);

    for (const changed of [
      [want('a')],
      [...base, want('c')],
      [want('a'), want('b', 't2')],
      [want('a'), { ...want('b'), after: 1 }],
      [want('a'), { ...want('b'), item: 0 }],
      [want('a'), { ...want('b'), startItem: 0 }],
      [want('a'), { ...want('b'), at: 3 }],
    ]) {
      assert.notEqual(seatWantsKey(changed), key, JSON.stringify(changed));
    }
  });
});

describe('bySeatPlace', () => {
  test('orders seats by their block, then by where their words start in it', () => {
    const seats = [
      { id: 'c', block: 1, at: 0 },
      { id: 'b', block: 0, at: 30 },
      { id: 'a', block: 0, at: 4 },
    ];

    assert.deepEqual(
      [...seats].sort(bySeatPlace).map((seat) => seat.id),
      ['a', 'b', 'c'],
    );
  });

  test('settles two comments on the same words by their ids', () => {
    const seats = [
      { id: 'comment-b', block: 0, at: 4 },
      { id: 'comment-a', block: 0, at: 4 },
    ];

    assert.deepEqual(
      [...seats].sort(bySeatPlace).map((seat) => seat.id),
      ['comment-a', 'comment-b'],
    );
  });
});
