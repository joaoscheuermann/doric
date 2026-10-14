// The desktop part's pure decisions: what a `screen.sessions/v2` answer means,
// which of them are worth retrying, how long to wait, and what the view's
// window should do — including the healing decision that re-points a window
// whose screen moved.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRetry,
  LIVE_RETRY_MS,
  retryDelayMs,
  statusOf,
  WAITING_RETRY_MS,
  windowActionFor,
} from '../src/desktop/status.js';

void test('each attach answer maps to the status the row shows', () => {
  assert.deepEqual(statusOf({ status: 'pending' }), { kind: 'waiting' });
  assert.deepEqual(
    statusOf({ status: 'ready', path: '/screen/token/', display: ':100' }),
    { kind: 'ready', path: '/screen/token/', display: ':100' },
  );
  assert.deepEqual(
    statusOf({ status: 'unavailable', reason: 'missing-xpra' }),
    { kind: 'unavailable', reason: 'missing-xpra' },
  );
  // No answer at all: the host could not be reached, which is retryable.
  assert.deepEqual(statusOf(null), { kind: 'failed' });
});

void test('only a state retrying can help offers the retry control', () => {
  assert.equal(canRetry({ kind: 'waiting' }), false);
  assert.equal(
    canRetry({ kind: 'ready', path: '/screen/t/', display: ':100' }),
    false,
  );
  assert.equal(canRetry({ kind: 'failed' }), true);
  assert.equal(
    canRetry({ kind: 'unavailable', reason: 'missing-xpra' }),
    false,
  );
  assert.equal(canRetry({ kind: 'unavailable', reason: 'sandbox' }), true);
  assert.equal(canRetry({ kind: 'unavailable', reason: 'start-failed' }), true);
});

void test('a waiting or failed view is re-asked until it resolves', () => {
  assert.equal(retryDelayMs({ kind: 'waiting' }, false), WAITING_RETRY_MS);
  assert.equal(retryDelayMs({ kind: 'failed' }, false), WAITING_RETRY_MS);
  assert.equal(
    retryDelayMs({ kind: 'unavailable', reason: 'sandbox' }, false),
    WAITING_RETRY_MS,
  );
  assert.equal(
    retryDelayMs({ kind: 'unavailable', reason: 'start-failed' }, false),
    WAITING_RETRY_MS,
  );
  assert.equal(
    retryDelayMs({ kind: 'unavailable', reason: 'missing-xpra' }, false),
    undefined,
  );
});

void test('a screen that is up is only re-asked while its window is open', () => {
  const ready = { kind: 'ready', path: '/screen/t/', display: ':100' } as const;

  assert.equal(retryDelayMs(ready, true), LIVE_RETRY_MS);
  assert.equal(retryDelayMs(ready, false), undefined);
});

void test('a view that is not ready has no window to open', () => {
  assert.deepEqual(
    windowActionFor({
      status: { kind: 'waiting' },
      wanted: true,
      focus: true,
    }),
    { kind: 'none' },
  );
  assert.deepEqual(
    windowActionFor({
      status: { kind: 'failed' },
      wanted: true,
      focus: false,
    }),
    { kind: 'none' },
  );
});

void test('the reader opening a ready view opens its window once', () => {
  const status = {
    kind: 'ready',
    path: '/screen/a/',
    display: ':100',
  } as const;

  assert.deepEqual(windowActionFor({ status, wanted: true, focus: true }), {
    kind: 'open',
    path: '/screen/a/',
  });
});

void test('a window already on this screen is focused, never reopened', () => {
  const status = {
    kind: 'ready',
    path: '/screen/a/',
    display: ':100',
  } as const;

  assert.deepEqual(
    windowActionFor({
      status,
      openedPath: '/screen/a/',
      wanted: true,
      focus: true,
    }),
    { kind: 'focus' },
  );
  // The heal loop asks without focus: the window is left alone.
  assert.deepEqual(
    windowActionFor({
      status,
      openedPath: '/screen/a/',
      wanted: false,
      focus: false,
    }),
    { kind: 'none' },
  );
});

void test('a screen that moved re-points the window that shows it', () => {
  assert.deepEqual(
    windowActionFor({
      status: { kind: 'ready', path: '/screen/moved/', display: ':100' },
      openedPath: '/screen/a/',
      wanted: false,
      focus: false,
    }),
    { kind: 'navigate', path: '/screen/moved/' },
  );
});
