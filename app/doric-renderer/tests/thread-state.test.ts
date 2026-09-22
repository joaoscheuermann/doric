import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { promptNotice } from '../src/chat/thread-state';

describe('prompt availability', () => {
  test('accepts prompts while the thread is queued, ready, or running', () => {
    for (const state of ['queued', 'ready', 'running']) {
      assert.equal(promptNotice(state, 'ready'), undefined);
    }
  });

  test('explains a stopped project before a stopped thread', () => {
    assert.match(
      promptNotice('failed', 'failed') ?? '',
      /Create a new project/,
    );
    assert.match(
      promptNotice('ready', 'cancelled') ?? '',
      /Create a new project/,
    );
  });

  test('explains a stopped thread without blaming the project', () => {
    assert.match(promptNotice('failed', 'ready') ?? '', /Create a new thread/);
    assert.match(
      promptNotice('cancelled', 'ready') ?? '',
      /Create a new thread/,
    );
    assert.equal(
      promptNotice('cancelling', 'ready'),
      'This thread is stopping.',
    );
  });
});
