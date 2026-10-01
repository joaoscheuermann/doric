import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  lineSource,
  type MarkdownBlock,
  markdownBlocks,
  type MarkdownLine,
} from '../src/domain/markdown';

/** Every line a block holds, whichever shape it is. */
const linesOf = (block: MarkdownBlock): readonly MarkdownLine[] =>
  block.kind === 'bullet' || block.kind === 'ordered'
    ? block.items.reduce<MarkdownLine[]>((all, item) => [...all, ...item], [])
    : block.lines;

/** The source a whole block joins back to, line by line. */
const blockSource = (block: MarkdownBlock): string =>
  linesOf(block).map(lineSource).join('\n');

const source = (blocks: readonly MarkdownBlock[]): string =>
  blocks.map(blockSource).join('\n');

describe('reading markdown as blocks', () => {
  test('keeps every character of the source except its blank separators', () => {
    const text = [
      '# Heavy',
      '',
      'A line with **bold** and `code`.',
      '',
      '- one',
      '- two',
      '',
      '> quoted',
      '',
      '```ts',
      'const a = 1;',
      '```',
    ].join('\n');

    assert.equal(
      source(markdownBlocks(text)),
      text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .join('\n'),
    );
  });

  test('reads a heading with its marker and its depth', () => {
    assert.deepEqual(markdownBlocks('## Two words'), [
      {
        kind: 'heading',
        depth: 2,
        lines: [[{ kind: 'text', source: '## Two words' }]],
      },
    ]);
  });

  test('gathers the lines between blank lines into one paragraph', () => {
    assert.deepEqual(markdownBlocks('one\ntwo\n\nthree'), [
      {
        kind: 'paragraph',
        lines: [
          [{ kind: 'text', source: 'one' }],
          [{ kind: 'text', source: 'two' }],
        ],
      },
      { kind: 'paragraph', lines: [[{ kind: 'text', source: 'three' }]] },
    ]);
  });

  test('reads consecutive quote lines as one quote', () => {
    const blocks = markdownBlocks('> one\n> two\n\nplain');

    assert.equal(blocks[0]?.kind, 'quote');
    assert.deepEqual(linesOf(blocks[0] ?? { kind: 'quote', lines: [] }), [
      [{ kind: 'text', source: '> one' }],
      [{ kind: 'text', source: '> two' }],
    ]);
  });

  test('keeps a line that opens nothing inside the item it continues', () => {
    const blocks = markdownBlocks('- one\nthat wraps\n- two');

    assert.deepEqual(blocks[0], {
      kind: 'bullet',
      items: [
        [
          [
            { kind: 'marker', source: '- ' },
            { kind: 'text', source: 'one' },
          ],
          [{ kind: 'text', source: 'that wraps' }],
        ],
        [
          [
            { kind: 'marker', source: '- ' },
            { kind: 'text', source: 'two' },
          ],
        ],
      ],
    });

    // A heading closes the item rather than joining it.
    assert.deepEqual(
      markdownBlocks('- one\n# Two').map((block) => block.kind),
      ['bullet', 'heading'],
    );
  });

  test('reads consecutive items of one kind as one list', () => {
    const blocks = markdownBlocks('- one\n* two\n\n1. first\n2. second');

    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['bullet', 'ordered'],
    );
    assert.deepEqual(
      blocks.map((block) => linesOf(block).length),
      [2, 2],
    );
  });

  test('runs a fence to its own closing fence, and to the end when none closes it', () => {
    const closed = markdownBlocks('```\na\nb\n```\nafter');
    assert.deepEqual(
      closed.map((block) => block.kind),
      ['code', 'paragraph'],
    );
    assert.equal(
      blockSource(closed[0] ?? { kind: 'code', lines: [] }),
      '```\na\nb\n```',
    );

    const open = markdownBlocks('~~~\na\nb');
    assert.equal(open.length, 1);
    assert.equal(open[0]?.kind, 'code');
    assert.equal(
      blockSource(open[0] ?? { kind: 'code', lines: [] }),
      '~~~\na\nb',
    );
  });

  test('splits a line into runs that keep their own markers', () => {
    assert.deepEqual(markdownBlocks('a **b** c')[0], {
      kind: 'paragraph',
      lines: [
        [
          { kind: 'text', source: 'a ' },
          { kind: 'bold', source: '**b**' },
          { kind: 'text', source: ' c' },
        ],
      ],
    });

    assert.deepEqual(markdownBlocks('~5 *x* `y`')[0], {
      kind: 'paragraph',
      lines: [
        [
          { kind: 'text', source: '~5 ' },
          { kind: 'italic', source: '*x*' },
          { kind: 'text', source: ' ' },
          { kind: 'code', source: '`y`' },
        ],
      ],
    });
  });

  test('keeps a list item marker as a run of its own, because the list draws it', () => {
    assert.deepEqual(markdownBlocks('- one')[0], {
      kind: 'bullet',
      items: [
        [
          [
            { kind: 'marker', source: '- ' },
            { kind: 'text', source: 'one' },
          ],
        ],
      ],
    });

    assert.deepEqual(markdownBlocks('1. **two**')[0], {
      kind: 'ordered',
      items: [
        [
          [
            { kind: 'marker', source: '1. ' },
            { kind: 'bold', source: '**two**' },
          ],
        ],
      ],
    });
  });

  test('leaves a marker with no closer as the text it is', () => {
    assert.deepEqual(markdownBlocks('2 * 3')[0], {
      kind: 'paragraph',
      lines: [[{ kind: 'text', source: '2 * 3' }]],
    });
  });

  test('reads an empty source as no block at all', () => {
    assert.deepEqual(markdownBlocks(''), []);
    assert.deepEqual(markdownBlocks('   \n\n '), []);
  });
});
