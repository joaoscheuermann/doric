import assert from 'node:assert/strict';
import test from 'node:test';

import { duration, elapsedBadge } from '../src/client/utility/duration.js';

test('shows elapsed minutes and seconds and adds hours for long executions', () => {
  assert.equal(duration(0), '00:00');
  assert.equal(duration(61_900), '01:01');
  assert.equal(duration(3_600_000), '1:00:00');
  assert.equal(duration(-1000), '00:00');
});

const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('the elapsed badge reads 00:00 for no or negative time (T-2.9)', () => {
  assert.equal(elapsedBadge(-5 * SECOND), '00:00');
  assert.equal(elapsedBadge(0), '00:00');
});

test('the elapsed badge counts minutes and hours below 100 h (T-2.9)', () => {
  assert.equal(elapsedBadge(5 * 60 * SECOND + 12 * SECOND), '05:12');
  assert.equal(elapsedBadge(HOUR), '1:00:00');
  assert.equal(elapsedBadge(100 * HOUR - SECOND), '99:59:59');
});

test('the elapsed badge agrees with duration below 100 h (T-2.9)', () => {
  for (const ms of [0, 59 * SECOND, HOUR, 100 * HOUR - SECOND]) {
    assert.equal(elapsedBadge(ms), duration(ms));
  }
});

test('the elapsed badge writes days and hours from 100 h (T-2.9)', () => {
  assert.equal(elapsedBadge(100 * HOUR), '4d 4h');
  assert.equal(elapsedBadge(100 * DAY - SECOND), '99d 23h');
});

test('the elapsed badge caps at 99d+ from 100 days (T-2.9)', () => {
  assert.equal(elapsedBadge(100 * DAY), '99d+');
  assert.equal(elapsedBadge(400 * DAY), '99d+');
});
