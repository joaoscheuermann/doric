import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { humanize } from '../src/utility/humanize';

describe('a code name as prose', () => {
  test('turns the separators a code name uses into spaces', () => {
    assert.equal(humanize('read_file'), 'read file');
    assert.equal(humanize('run-terminal'), 'run terminal');
  });

  test('collapses runs of separators and trims the ends', () => {
    assert.equal(humanize('__edit__file__'), 'edit file');
  });

  test('leaves a name that is already prose alone', () => {
    assert.equal(humanize('terminal'), 'terminal');
  });
});
