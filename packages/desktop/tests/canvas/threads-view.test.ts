// What a canvas shows of its threads (`desktop/ui/canvas`), generic in the
// owner's anchor: the pins of the sent threads and of the draft roots, the
// next pin's number, the comment control's count, and the thread a pin opens.
// The anchor is a stand-in owner's `{ cell }`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  artifactTargetOf,
  type CanvasComment,
  type CanvasDraft,
  type ContentPoint,
  draftRootsOf,
  nextPinOf,
  openCountOf,
  pinsOf,
  threadsOf,
  threadViewOf,
} from 'desktop/ui/canvas';

interface Cell {
  readonly cell: string;
}

const comment = (
  commentId: string,
  fields: Partial<CanvasComment<Cell>> = {},
): CanvasComment<Cell> => ({
  commentId,
  text: `${commentId} text`,
  resolved: false,
  ...fields,
});

const draft = (
  id: string,
  fields: Partial<CanvasDraft<Cell>> = {},
): CanvasDraft<Cell> => ({
  id,
  note: `${id} note`,
  target: { kind: 'artifact', id: 'a1', revision: 3, anchor: { cell: 'gone' } },
  ...fields,
});

// Sent: an open root with a reply (A1), a resolved root (B2), a root that
// recorded no anchor, and a root written without a revision (D4).
const threads = threadsOf<Cell>([
  comment('open', {
    anchor: { cell: 'A1' },
    revision: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
  }),
  comment('done', { anchor: { cell: 'B2' }, revision: 2, resolved: true }),
  comment('bare'),
  comment('norev', { anchor: { cell: 'D4' } }),
  comment('open-reply', { inReplyTo: 'open', author: 'agent' }),
]);

// Drafts: a root nobody can place, a reply to it, a root with its own point,
// another unplaceable root, a draft reply to a sent root, and a draft whose id
// is already a sent root (it was flushed).
const drafts: CanvasDraft<Cell>[] = [
  draft('d1', { pin: 5 }),
  draft('d1-reply', { inReplyTo: 'd1' }),
  draft('d2', { pin: 6, point: { x: 5, y: 6 } }),
  draft('d3', { pin: 7 }),
  draft('sent-reply', { inReplyTo: 'open', author: 'ana' }),
  draft('open'),
];

const placed: Record<string, ContentPoint> = {
  A1: { x: 10, y: 20 },
  B2: { x: 30, y: 40 },
  D4: { x: 50, y: 60 },
};

const pointOf = (anchor: Cell, fallback?: ContentPoint) =>
  placed[anchor.cell] ?? fallback;

describe('draftRootsOf and openCountOf', () => {
  test('a draft root answers nothing and is not sent yet', () => {
    assert.deepEqual(
      draftRootsOf(threads, drafts).map((each) => each.id),
      ['d1', 'd2', 'd3'],
    );
  });

  test('the control counts the threads not done and the draft roots', () => {
    // open, bare, norev + d1, d2, d3.
    assert.equal(openCountOf(threads, drafts), 6);
    assert.equal(openCountOf([], []), 0);
  });
});

describe('pinsOf', () => {
  const step = 10;

  test('lists the sent pins, then the draft roots; the resolved only when shown', () => {
    assert.deepEqual(
      pinsOf(threads, drafts, false, pointOf, step).map((pin) => pin.key),
      ['open', 'norev', 'd1', 'd2', 'd3'],
    );
    assert.deepEqual(
      pinsOf(threads, drafts, true, pointOf, step).map((pin) => pin.key),
      ['open', 'done', 'norev', 'd1', 'd2', 'd3'],
    );
  });

  test('a sent pin wears its thread: number, place, state, replies and note', () => {
    const pin = pinsOf(threads, drafts, false, pointOf, step)[0];
    assert.equal(pin?.pin, 1);
    assert.deepEqual(pin?.point, { x: 10, y: 20 });
    assert.equal(pin?.state, 'await');
    assert.equal(pin?.replies, 1);
    assert.equal(pin?.note, 'open text');
    assert.ok(pin?.detached !== true);
  });

  test('a draft root is a draft pin, placed by its own point when its anchor cannot be', () => {
    const pins = pinsOf(threads, drafts, false, pointOf, step);
    const d1 = pins.find((pin) => pin.key === 'd1');
    const d2 = pins.find((pin) => pin.key === 'd2');
    assert.equal(d1?.state, 'draft');
    assert.equal(d1?.pin, 5);
    assert.equal(d1?.replies, 1);
    assert.deepEqual(d2?.point, { x: 5, y: 6 });
    assert.ok(d2?.detached !== true);
  });

  test('a pin that cannot be placed is stacked step apart, never dropped', () => {
    const pins = pinsOf(threads, drafts, false, pointOf, step);
    const d1 = pins.find((pin) => pin.key === 'd1');
    const d3 = pins.find((pin) => pin.key === 'd3');
    assert.equal(d1?.detached, true);
    assert.equal(d3?.detached, true);
    assert.ok(d1 !== undefined && d3 !== undefined);
    assert.equal(d1.point.x, d3.point.x);
    assert.equal(Math.abs(d3.point.y - d1.point.y), step);
  });
});

describe('nextPinOf', () => {
  test('never reuses a number the artifact shows', () => {
    const shown = [
      ...threads.map((thread) => thread.pin),
      ...pinsOf(threads, drafts, true, pointOf).map((pin) => pin.pin),
    ];
    const next = nextPinOf(threads, drafts);
    assert.ok(!shown.includes(next), `${next} is already shown`);
    assert.ok(next > 0);
  });

  test('the first pin of an artifact is 1', () => {
    assert.equal(nextPinOf<Cell>([], []), 1);
  });
});

describe('threadViewOf', () => {
  const on = { artifactId: 'a1', revision: 9 };

  test('a sent root opens on its own revision: root, replies, then draft replies', () => {
    const view = threadViewOf('open', threads, drafts, on);
    assert.deepEqual(view?.target, {
      kind: 'artifact',
      id: 'a1',
      revision: 2,
      anchor: { cell: 'A1' },
    });
    assert.equal(view?.rootId, 'open');
    assert.equal(view?.pin, 1);
    assert.deepEqual(
      view?.messages.map((message) => [message.id, message.draft]),
      [
        ['open', false],
        ['open-reply', false],
        ['sent-reply', true],
      ],
    );
    assert.equal(view?.messages[0]?.createdAt, '2026-10-01T10:00:00.000Z');
    assert.equal(view?.sent?.root.commentId, 'open');
  });

  test('a sent root written without a revision takes the one given', () => {
    assert.equal(
      threadViewOf('norev', threads, drafts, on)?.target.revision,
      9,
    );
  });

  test('a draft root opens on its own target and point', () => {
    const view = threadViewOf('d2', threads, drafts, on);
    assert.deepEqual(view?.target, drafts[2]?.target);
    assert.deepEqual(view?.point, { x: 5, y: 6 });
    assert.equal(view?.pin, 6);
    assert.deepEqual(
      threadViewOf('d1', threads, drafts, on)?.messages.map((m) => m.id),
      ['d1', 'd1-reply'],
    );
  });

  test('a sent root without an anchor, or an unknown id, opens nothing', () => {
    assert.equal(threadViewOf('bare', threads, drafts, on), undefined);
    assert.equal(threadViewOf('nobody', threads, drafts, on), undefined);
  });
});

describe('artifactTargetOf', () => {
  test('builds an artifact target, with the revision when given', () => {
    assert.deepEqual(artifactTargetOf('a1', 4, { cell: 'A1' }), {
      kind: 'artifact',
      id: 'a1',
      revision: 4,
      anchor: { cell: 'A1' },
    });
  });

  test('leaves the revision out when it is undefined', () => {
    const target = artifactTargetOf('a1', undefined, { cell: 'A1' });
    assert.deepEqual(target, {
      kind: 'artifact',
      id: 'a1',
      anchor: { cell: 'A1' },
    });
    assert.ok(!('revision' in target));
  });
});
