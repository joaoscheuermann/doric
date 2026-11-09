// S21: an open terminal reads its palette again when the window's
// `prefers-color-scheme` changes, not only at mount.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  followColorScheme,
  type SchemeQuery,
} from '../src/client/view/color-scheme.js';

/** A `MediaQueryList` whose `change` the test fires. */
const fakeQuery = () => {
  const listeners = new Set<() => void>();
  const query: SchemeQuery = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    query,
    change: () => {
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
};

test('each change of the color scheme repaints once', () => {
  const media = fakeQuery();
  let repaints = 0;

  followColorScheme(media.query, () => {
    repaints += 1;
  });
  media.change();
  media.change();

  assert.equal(repaints, 2);
});

test('nothing repaints before the color scheme changes', () => {
  const media = fakeQuery();
  let repaints = 0;

  followColorScheme(media.query, () => {
    repaints += 1;
  });

  assert.equal(repaints, 0);
});

test('the cleanup stops following the color scheme', () => {
  const media = fakeQuery();
  let repaints = 0;

  const stop = followColorScheme(media.query, () => {
    repaints += 1;
  });
  media.change();
  stop();
  media.change();

  assert.equal(repaints, 1);
  assert.equal(media.listening(), 0);
});
