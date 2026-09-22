import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Shortcut, shouldSubmit } from '../src/chat/shortcuts';

const shortcut = (value: Partial<Shortcut>): Shortcut => ({
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...value,
});

describe('prompt shortcut', () => {
  test('submits only with Command+Enter on macOS', () => {
    assert.equal(shouldSubmit(shortcut({ metaKey: true }), 'MacIntel'), true);
    assert.equal(shouldSubmit(shortcut({ ctrlKey: true }), 'MacIntel'), false);
  });

  test('submits only with Control+Enter on Windows', () => {
    assert.equal(shouldSubmit(shortcut({ ctrlKey: true }), 'Win32'), true);
    assert.equal(shouldSubmit(shortcut({ metaKey: true }), 'Win32'), false);
  });

  test('plain Enter and extra modifiers do not submit', () => {
    assert.equal(shouldSubmit(shortcut({}), 'MacIntel'), false);
    assert.equal(
      shouldSubmit(shortcut({ metaKey: true, shiftKey: true }), 'MacIntel'),
      false,
    );
    assert.equal(
      shouldSubmit(shortcut({ ctrlKey: true, metaKey: true }), 'Win32'),
      false,
    );
  });
});
