import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createPromptSignal } from '../src/utility/prompt-signal';

describe('whether the prompt holds words, as a value', () => {
  test('starts empty, and says so', () => {
    assert.equal(createPromptSignal().snapshot(), false);
  });

  test('tells a subscriber when the value changes', () => {
    const signal = createPromptSignal();
    let told = 0;
    signal.subscribe(() => {
      told += 1;
    });

    signal.set(true);
    assert.equal(signal.snapshot(), true);
    assert.equal(told, 1);
  });

  test('says nothing twice about the same value', () => {
    const signal = createPromptSignal();
    let told = 0;
    signal.subscribe(() => {
      told += 1;
    });

    signal.set(true);
    signal.set(true);
    assert.equal(told, 1);

    signal.set(false);
    signal.set(false);
    assert.equal(told, 2);
  });

  test('stops telling a subscriber that stopped wanting the value', () => {
    const signal = createPromptSignal();
    let told = 0;
    const stop = signal.subscribe(() => {
      told += 1;
    });

    signal.set(true);
    stop();
    signal.set(false);

    assert.equal(told, 1);
    assert.equal(signal.snapshot(), false);
  });
});
