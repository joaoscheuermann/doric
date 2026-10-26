// The comment anchor papercraft reads back with each pending comment
// (`contracts/index.ts`): an anchor on an out-of-flow pseudo-element names
// it, `::before` or `::after`, and nothing else passes for one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commentAnchorSchema } from '../src/contracts/index.js';

const onButton = {
  form: 'source',
  path: 'src/Checkout.tsx',
  line: 42,
  selector: 'button#pay',
  label: 'button::before',
} as const;

test('a source anchor on a pseudo-element keeps the pseudo it names', () => {
  for (const pseudo of ['::before', '::after'] as const) {
    const parsed = commentAnchorSchema.safeParse({ ...onButton, pseudo });

    assert.equal(parsed.success, true, pseudo);
    assert.deepEqual(parsed.data, { ...onButton, pseudo });
  }
});

test('an anchor naming any other pseudo-element is refused', () => {
  for (const pseudo of ['::marker', 'after', '']) {
    assert.equal(
      commentAnchorSchema.safeParse({ ...onButton, pseudo }).success,
      false,
      JSON.stringify(pseudo),
    );
  }
});
