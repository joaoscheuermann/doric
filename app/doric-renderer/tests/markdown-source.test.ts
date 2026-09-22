import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Descendant } from 'slate';

import { markdownFromValue, markdownValue } from '../src/chat/markdown-source';

test('Markdown source survives a Slate value round trip exactly', () => {
  const markdown = [
    '# Heading',
    '',
    '- [x] **done**',
    '> quote with `code` and [link](https://example.test)',
    '```ts',
    'const answer = 42;',
    '```',
  ].join('\n');

  assert.equal(
    markdownFromValue(markdownValue(markdown) as readonly Descendant[]),
    markdown,
  );
});
