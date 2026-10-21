import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  blockEquals,
  commonBlocks,
  commonItems,
  lineSource,
  type MarkdownBlock,
  type MarkdownLine,
  type MarkdownRun,
  markdownBlocks,
} from '../src/client/domain/markdown.js';

/** Every line a block holds, whichever shape it is. */
const linesOf = (block: MarkdownBlock): readonly MarkdownLine[] => {
  if (block.kind === 'table')
    return [block.header, block.delimiter, ...block.rows].map((row) =>
      row.flat(),
    );
  if (block.kind === 'bullet' || block.kind === 'ordered')
    return block.items.flat();
  return block.lines;
};

/** The text a cell draws: its runs without the markers the table draws itself. */
const cellSource = (cell: readonly MarkdownRun[]): string =>
  cell
    .filter((run) => run.kind !== 'marker')
    .map((run) => run.source)
    .join('');

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

  test('reads a pipe table into its header, delimiter and body rows', () => {
    const text = [
      '| Name | Qty |',
      '| --- | ---: |',
      '| one | 1 |',
      '| two | 2 |',
    ].join('\n');
    const blocks = markdownBlocks(text);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.kind, 'table');
    // Every character is still there: the pipes and the delimiter row travel as
    // markers, and the block joins back to the source it was written as.
    assert.equal(source(blocks), text);

    const table = blocks[0];
    if (table?.kind !== 'table') return assert.fail('not a table');
    assert.deepEqual(table.align, [undefined, 'right']);
    assert.deepEqual(table.header.map(cellSource), ['Name', 'Qty']);
    assert.deepEqual(
      table.rows.map((row) => row.map(cellSource)),
      [
        ['one', '1'],
        ['two', '2'],
      ],
    );
  });

  test("reads a table column's alignment from its delimiter markers", () => {
    const blocks = markdownBlocks(
      '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |',
    );

    const table = blocks[0];
    if (table?.kind !== 'table') return assert.fail('not a table');
    assert.deepEqual(table.align, ['left', 'center', 'right']);
  });

  test('leaves a table with no delimiter row, or one of a different width, as text', () => {
    // A header with no pipe is a paragraph, and a lone delimiter line under it is
    // a setext underline this reader never claimed.
    assert.deepEqual(
      markdownBlocks('plain\n---').map((block) => block.kind),
      ['paragraph'],
    );
    // A delimiter row must match the header cell for cell, or nothing is a table.
    assert.deepEqual(
      markdownBlocks('| a | b |\n| --- |\n| 1 | 2 |').map(
        (block) => block.kind,
      ),
      ['paragraph'],
    );
  });

  test("keeps a cell's emphasis and the table's markers apart", () => {
    const table = markdownBlocks('| **b** | c |\n| --- | --- |')[0];

    if (table?.kind !== 'table') return assert.fail('not a table');
    const [first, second] = table.header[0] ?? [];
    assert.deepEqual(first, { kind: 'marker', source: '|' });
    assert.deepEqual(second, { kind: 'marker', source: ' ' });
    assert.deepEqual(
      table.header[0]?.filter((run) => run.kind !== 'marker'),
      [{ kind: 'bold', source: '**b**' }],
    );
    assert.equal(cellSource(table.header[1] ?? []), 'c');
  });
});

describe('blocks shared between two reads of a growing source', () => {
  test('counts every block when both reads parse the same source', () => {
    const text = [
      '# Heavy',
      '',
      'A line with **bold** and `code`.',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const blocks = markdownBlocks(text);
    const reread = markdownBlocks(text);

    assert.equal(commonBlocks(blocks, reread), blocks.length);
    for (let index = 0; index < blocks.length; index += 1) {
      const left = blocks[index];
      const right = reread[index];
      if (left === undefined || right === undefined)
        return assert.fail('a block went missing');
      assert.ok(blockEquals(left, right), `block ${index} equals its reread`);
    }
  });

  test('keeps the whole finished answer when the stream only appends blocks', () => {
    const before = markdownBlocks('one\n\ntwo');
    const after = markdownBlocks('one\n\ntwo\n\nthree');

    assert.equal(commonBlocks(before, after), before.length);
  });

  test('shares only the blocks before the one the delta lands in', () => {
    const before = markdownBlocks('one\n\ntwo');
    const after = markdownBlocks('one\n\ntwo grows');

    assert.equal(commonBlocks(before, after), before.length - 1);
    // A delta inside the only block there is shares nothing with it.
    assert.equal(
      commonBlocks(markdownBlocks('one'), markdownBlocks('one two')),
      0,
    );
  });

  test('holds a list and its new item as one block, rebuilt together', () => {
    const before = markdownBlocks('- one');
    const after = markdownBlocks('- one\n- two');

    assert.equal(commonBlocks(before, after), 0);
  });

  test('keeps a closed fence while the stream writes what follows it', () => {
    const before = markdownBlocks('```ts\nconst a = 1;\n```');
    const after = markdownBlocks('```ts\nconst a = 1;\n```\nafter');

    assert.equal(commonBlocks(before, after), before.length);
  });

  test('tells blocks apart by kind, heading depth and table cells', () => {
    const first = (text: string): MarkdownBlock => {
      const block = markdownBlocks(text)[0];
      if (block === undefined) return assert.fail('no block');
      return block;
    };
    const differs = (left: string, right: string): void => {
      assert.ok(!blockEquals(first(left), first(right)));
    };

    differs('plain', '> plain');
    differs('# One', '## One');
    differs(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      '| a | b |\n| --- | --- |\n| 1 | 3 |',
    );
  });

  test('reads a line that is only an attachment reference as its image', () => {
    const line = `![cat.png](doric-attachment:sha256-${'a'.repeat(64)})`;
    const blocks = markdownBlocks(`Before.\n${line}\nAfter.`);

    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['paragraph', 'image', 'paragraph'],
    );
    const image = blocks[1];
    assert.equal(image?.kind === 'image' ? image.name : undefined, 'cat.png');
    assert.equal(source(blocks), `Before.\n${line}\nAfter.`);
  });

  test('reads a reference with words around it on its line as text', () => {
    const line = `See ![cat.png](doric-attachment:sha256-${'a'.repeat(64)}) here.`;

    assert.deepEqual(
      markdownBlocks(line).map((block) => block.kind),
      ['paragraph'],
    );
  });
});

describe('commonItems', () => {
  const first = (source: string) => {
    const [block] = markdownBlocks(source);
    assert.ok(block);
    return block;
  };

  test('counts the items a growing list keeps while its last item grows', () => {
    assert.equal(commonItems(first('- one\n- tw'), first('- one\n- two')), 1);
  });

  test('keeps every item when the delta opens a new one', () => {
    assert.equal(
      commonItems(first('1. one\n2. two'), first('1. one\n2. two\n3. three')),
      2,
    );
  });

  test('answers nothing for two blocks that are not the same kind of list', () => {
    assert.equal(commonItems(first('- one'), first('1. one')), undefined);
    assert.equal(commonItems(first('one'), first('one two')), undefined);
  });
});

describe('markdownBlocks, loose lists', () => {
  test('keeps items of one kind in one list across the blank lines between them', () => {
    const blocks = markdownBlocks('1. a\n\n2. b\n\npara');

    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['ordered', 'paragraph'],
    );
    const [list] = blocks;
    assert.equal(list?.kind === 'ordered' ? list.items.length : 0, 2);
  });

  test('reads a tight list as the same one list', () => {
    assert.deepEqual(
      markdownBlocks('- a\n- b').map((block) => block.kind),
      ['bullet'],
    );
  });

  test('ends a list at a blank line that leads to another block or another kind of list', () => {
    assert.deepEqual(
      markdownBlocks('- a\n\npara\n\n- b').map((block) => block.kind),
      ['bullet', 'paragraph', 'bullet'],
    );
    assert.deepEqual(
      markdownBlocks('- a\n\n1. b').map((block) => block.kind),
      ['bullet', 'ordered'],
    );
  });
});
