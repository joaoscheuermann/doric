// The comment pins' pure parts (`surface/pins-layer.tsx`,
// `surface/thread-popover.tsx`, `surface/threads-view.ts`): where the input
// and the thread open beside their pin, and which pins a revision shows.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INPUT_HEIGHT,
  inputPlacement,
  nextPinOf,
  openCountOf,
  pinsOf,
  popoverPlacement,
} from 'desktop/ui/canvas';

import type { PreviewDraft } from '../../src/client/comment.js';
import { threadsOf } from '../../src/client/domain/preview-state.js';

const area = { width: 800, height: 600 };

test('the input opens to the right of the pin, level with it', () => {
  const at = { x: 100, y: 200 };
  const placed = inputPlacement(at, area);

  // Right of the 32px pin, never over it.
  assert.ok(placed.left >= at.x + 32);
  assert.ok(placed.top < at.y && placed.top > at.y - 60);
});

test('without room on the right the input opens to the left, still clear of the pin', () => {
  const at = { x: 700, y: 200 };
  const placed = inputPlacement(at, area);

  assert.ok(placed.left + 280 <= at.x);
  assert.ok(placed.left >= 4);
});

test('the input stays inside the canvas at its edges', () => {
  const top = inputPlacement({ x: 100, y: 10 }, area);
  const bottom = inputPlacement({ x: 100, y: 600 }, area);

  assert.ok(top.top >= 4);
  // The popover of a one-line field stays whole inside the canvas.
  assert.ok(bottom.top + INPUT_HEIGHT <= area.height - 4);
});

test('the thread opens below its pin, or above it near the bottom, inside the canvas', () => {
  const below = popoverPlacement({ x: 100, y: 100 }, area);
  assert.ok('top' in below && below.top > 100);

  const above = popoverPlacement({ x: 100, y: 560 }, area);
  assert.ok('bottom' in above && area.height - above.bottom < 560);

  const right = popoverPlacement({ x: 790, y: 100 }, area);
  assert.ok(right.left + 320 <= area.width);
});

const anchor = { form: 'point' as const, x: 10, y: 20 };
const target = { kind: 'artifact', id: 'a', revision: 1, anchor };
const sent = (
  commentId: string,
  extra: { inReplyTo?: string; resolved?: boolean; author?: string } = {},
) => ({
  commentId,
  text: commentId,
  revision: 1,
  anchor,
  resolved: false,
  ...extra,
});
const draft = (
  id: string,
  extra: Partial<PreviewDraft> = {},
): PreviewDraft => ({
  id,
  note: id,
  target,
  ...extra,
});
const place = () => ({ x: 0, y: 0 });

test('a draft root is a pin until its sent comment takes its place; replies never are', () => {
  const threads = threadsOf([sent('c1'), sent('c2')]);
  const drafts = [
    draft('d1', { pin: 3 }),
    draft('reply', { inReplyTo: 'c1' }),
    // Sent already: the durable thread is its pin now.
    draft('c2', { pin: 2 }),
  ];

  const pins = pinsOf(threads, drafts, true, place);

  assert.deepEqual(
    pins.map((pin) => [pin.key, pin.pin, pin.state]),
    [
      ['c1', 1, 'open'],
      ['c2', 2, 'open'],
      ['d1', 3, 'draft'],
    ],
  );
  assert.equal(nextPinOf(threads, drafts), 4);
  assert.equal(openCountOf(threads, drafts), 3);
});

test('resolved threads leave the count, and their pins show only while shown', () => {
  const threads = threadsOf([sent('c1', { resolved: true }), sent('c2')]);

  assert.equal(openCountOf(threads, []), 1);
  assert.deepEqual(
    pinsOf(threads, [], false, place).map((pin) => pin.key),
    ['c2'],
  );
  assert.deepEqual(
    pinsOf(threads, [], true, place).map((pin) => pin.key),
    ['c1', 'c2'],
  );
  // A resolved pin keeps its number: the next one never reuses it.
  assert.equal(nextPinOf(threads, []), 3);
});

test('a pin whose anchor no longer resolves is detached by the edge, never dropped', () => {
  const gone = { form: 'source' as const, path: 'src/Gone.tsx', line: 7 };
  const threads = threadsOf([
    sent('c1'),
    { ...sent('c2'), revision: 1, anchor: gone },
    { ...sent('c3'), anchor: gone },
  ]);
  const drafts = [
    // A draft whose element is gone and that recorded no point of its own.
    draft('d1', { pin: 4, target: { ...target, anchor: gone } }),
  ];
  // Only the free point resolves on this revision.
  const resolveOnly = (at: { form: string }) =>
    at.form === 'point' ? { x: 50, y: 60 } : undefined;

  const pins = pinsOf(threads, drafts, true, resolveOnly, 30);

  assert.deepEqual(
    pins.map((pin) => [pin.key, pin.pin, pin.detached === true]),
    [
      ['c1', 1, false],
      ['c2', 2, true],
      ['c3', 3, true],
      ['d1', 4, true],
    ],
  );
  // Detached pins sit apart from one another, down the content's left edge.
  const detached = pins.filter((pin) => pin.detached === true);
  assert.equal(new Set(detached.map((pin) => pin.point.y)).size, 3);
  for (const pin of detached) assert.equal(pin.point.x, 0);
  // They still count.
  assert.equal(openCountOf(threads, drafts), 4);
});
