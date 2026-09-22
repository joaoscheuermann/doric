import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  graphemes,
  initialVisibleMarkdown,
  revealStep,
} from '../src/chat/reveal';

describe('typewriter reveal', () => {
  test('reveals whole graphemes rather than splitting an emoji', () => {
    const family = '👨‍👩‍👧‍👦';
    assert.deepEqual(graphemes(`${family}!`), [family, '!']);
    assert.equal(
      revealStep({
        receivedMarkdown: `${family}!`,
        visibleMarkdown: '',
        terminal: false,
      }),
      family,
    );
  });

  test('catches up faster when receipt is far ahead of visibility', () => {
    const next = revealStep({
      receivedMarkdown: 'abcdefghijklmnopqrstuvwx',
      visibleMarkdown: '',
      terminal: false,
    });
    assert.equal(next, 'ab');
  });

  test('drains terminal output in no more than four steps', () => {
    const receivedMarkdown = 'abcdefghijklmnop';
    let visibleMarkdown = '';
    visibleMarkdown = revealStep({
      receivedMarkdown,
      visibleMarkdown,
      terminal: true,
    });
    assert.notEqual(visibleMarkdown, receivedMarkdown);

    for (let index = 1; index < 4; index += 1) {
      visibleMarkdown = revealStep({
        receivedMarkdown,
        visibleMarkdown,
        terminal: true,
      });
    }
    assert.equal(visibleMarkdown, receivedMarkdown);
  });

  test('shows historical replay immediately and animates only live text', () => {
    assert.equal(initialVisibleMarkdown('history', false), 'history');
    assert.equal(initialVisibleMarkdown('live', true), '');
  });
});
