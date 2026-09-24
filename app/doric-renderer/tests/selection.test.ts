import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseSelection,
  serializeSelection,
  shouldWriteSelection,
} from '../src/domain/selection';

describe('persisted selection', () => {
  test('round-trips the selected Thread id', () => {
    const stored = parseSelection(serializeSelection('thread'));

    assert.equal(stored?.selectedThreadId, 'thread');
  });

  test('rejects unversioned and malformed local state', () => {
    assert.equal(parseSelection('{"selectedThreadId":"thread"}'), undefined);
    assert.equal(
      parseSelection('{"version":1,"selectedThreadId":1}'),
      undefined,
    );
    assert.equal(
      parseSelection('{"version":2,"selectedThreadId":"t"}'),
      undefined,
    );
    assert.equal(parseSelection('not json'), undefined);
    assert.equal(parseSelection(null), undefined);
  });

  test('writes nothing while the saved selection is still being read', () => {
    assert.equal(shouldWriteSelection(undefined, false), false);
    assert.equal(shouldWriteSelection(undefined, true), false);
  });

  test('writes once a read found nothing or restored the saved selection', () => {
    assert.equal(shouldWriteSelection('none', false), true);
    assert.equal(shouldWriteSelection('restored', false), true);
  });

  test('keeps the saved selection when the read that would replace it failed', () => {
    assert.equal(shouldWriteSelection('failed', false), false);
  });

  test('writes every change that follows a failed read', () => {
    assert.equal(shouldWriteSelection('failed', true), true);
  });
});
