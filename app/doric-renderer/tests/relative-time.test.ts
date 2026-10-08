import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { relativeTime } from '../src/utility/relative-time';

const now = new Date('2026-03-12T15:00:00.000Z');

const at = (iso: string): string => relativeTime(iso, now);

describe('how a turn time reads', () => {
  test('reads as elapsed time within the day', () => {
    assert.equal(at('2026-03-12T14:59:45.000Z'), 'now');
    assert.equal(at('2026-03-12T14:55:00.000Z'), '5 min ago');
    assert.equal(at('2026-03-12T14:00:00.000Z'), '1 h ago');
    assert.equal(at('2026-03-12T13:00:00.000Z'), '2 h ago');
  });

  test('reads as a date and a clock time once a day has passed', () => {
    const value = at('2026-03-10T15:05:00.000Z');
    assert.doesNotMatch(value, /ago/);
    assert.match(value, /10/);
    assert.match(value, /:/);
  });

  test('reads as nothing when the time cannot be parsed', () => {
    assert.equal(at('not a date'), '');
  });
});
