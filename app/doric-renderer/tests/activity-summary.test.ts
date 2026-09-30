import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { activitySummary } from '../src/utility/activity-summary';

describe('a completed burst as one line', () => {
  test('names both acts with their counts', () => {
    assert.equal(activitySummary(3, 5), 'Thought 3 times, called 5 tools');
  });

  test('leaves out an act that did not happen', () => {
    assert.equal(activitySummary(2, 0), 'Thought 2 times');
    assert.equal(activitySummary(0, 4), 'Called 4 tools');
  });

  test('reads a single act as one', () => {
    assert.equal(activitySummary(1, 1), 'Thought once, called 1 tool');
    assert.equal(activitySummary(0, 1), 'Called 1 tool');
  });
});
