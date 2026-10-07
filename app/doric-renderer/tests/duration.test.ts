import assert from 'node:assert/strict';
import test from 'node:test';

import { duration } from '../src/utility/duration.js';

test('shows elapsed minutes and seconds and adds hours for long executions', () => {
  assert.equal(duration(0), '00:00');
  assert.equal(duration(61_900), '01:01');
  assert.equal(duration(3_600_000), '1:00:00');
  assert.equal(duration(-1000), '00:00');
});
