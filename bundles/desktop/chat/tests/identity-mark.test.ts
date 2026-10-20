// The mark an identity carries: the initials a name reads as, and the tone it is
// drawn in. Both are stated in terms of their arguments, so the conversation's
// blocks and the composer's stack wear the same mark for the same name.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { identityTone, initials } from '../src/client/utility/identity-mark.js';

describe('the initials a name reads as', () => {
  test('takes the first letter of the first two parts of a name', () => {
    assert.equal(initials('jao.scheuermann'), 'JS');
    assert.equal(initials('Marina Costa'), 'MC');
    assert.equal(initials('agent'), 'A');
    assert.equal(initials(''), '?');
  });

  test('reads the same parts through extra spaces and leading punctuation', () => {
    assert.equal(initials('  Marina   Costa  '), 'MC');
    assert.equal(initials('.marina_costa'), 'MC');
    assert.equal(initials('-jao.scheuermann.silva'), 'JS');
  });
});

describe('the tone an identity is drawn in', () => {
  test('answers the same tone for the same name and another for another', () => {
    assert.equal(identityTone('Marina Costa'), identityTone('Marina Costa'));
    assert.notEqual(identityTone('Marina Costa'), identityTone('agent'));
  });

  test('is a color mixed in oklch over the muted foreground', () => {
    const tone = identityTone('Marina Costa');

    assert.match(tone, /color-mix\(/);
    assert.match(tone, /oklch\(/);
    assert.match(tone, /var\(--muted\)/);
  });
});
