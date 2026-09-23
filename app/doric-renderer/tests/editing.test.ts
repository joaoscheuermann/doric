import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  caretTarget,
  type Comment,
  type CommentAnchor,
  commentsFor,
  composePrompt,
  continuesComment,
  dirtyIndex,
  draftNodeId,
  extendComment,
  isDirty,
  markdownBlocks,
  type ProseNode,
  proseNodes,
  removeComment,
  startComment,
  textNodeId,
  trimComment,
  userNodeId,
} from '../src/chat/editing';
import type { PromptTurn } from '../src/chat/projector';

const user: ProseNode = {
  id: userNodeId('one'),
  role: 'user',
  promptId: 'one',
  original: 'Question?',
};
const answer: ProseNode = {
  id: textNodeId('one', 1),
  role: 'agent',
  promptId: 'one',
  original: 'Answer.',
};
const later: ProseNode = {
  id: userNodeId('two'),
  role: 'user',
  promptId: 'two',
  original: 'Follow up.',
};
const document: readonly ProseNode[] = [user, answer, later];

const turn = (
  promptId: string,
  userMarkdown: string,
  texts: readonly string[],
): PromptTurn => ({
  promptId,
  sequence: 1,
  inputRole: 'user',
  accepted: true,
  userMarkdown,
  segments: texts.map((text) => ({ kind: 'text', text })),
  status: 'completed',
});

const anchor: CommentAnchor = { quote: 'Answer.', start: 0, end: 7 };

const comment = (
  id: string,
  text: string,
  extra?: Partial<Comment>,
): Comment => ({
  id,
  nodeId: answer.id,
  block: 0,
  text,
  ...extra,
});

describe('prose nodes', () => {
  test('keeps a prompt, its answers and the next prompt in document order', () => {
    const nodes = proseNodes([
      turn('one', 'Question?', ['First', 'Second']),
      turn('two', 'Follow up.', []),
    ]);

    assert.deepEqual(
      nodes.map(({ id }) => id),
      [
        userNodeId('one'),
        textNodeId('one', 0),
        textNodeId('one', 1),
        userNodeId('two'),
      ],
    );
  });

  test('leaves out a prompt with no recorded text and an empty answer', () => {
    const nodes = proseNodes([turn('one', '', [''])]);

    assert.deepEqual(nodes, []);
  });

  test('leaves out a delegated input, which is not the human\u2019s prose', () => {
    const nodes = proseNodes([
      {
        ...turn('one', 'Delegated task', []),
        delegated: { kind: 'parent', threadId: 'p', text: 'Delegated task' },
      },
    ]);

    assert.deepEqual(nodes, []);
  });
});

describe('the dirty rule', () => {
  test('marks a user node dirty once its text differs from the projection', () => {
    assert.equal(isDirty(user, { [user.id]: 'Question?' }), false);
    assert.equal(isDirty(user, { [user.id]: 'Question!' }), true);
  });

  test('clears the dirty state when the text returns to the original', () => {
    const edited = { [user.id]: 'Question?' };

    assert.equal(dirtyIndex(document, edited), -1);
  });

  test('reports the first dirty node so everything below it dims', () => {
    const edits = { [user.id]: 'Changed?', [later.id]: 'Also changed.' };

    assert.equal(dirtyIndex(document, edits), 0);
  });

  test('dims from a later node once the earlier edit is undone', () => {
    const edits = { [later.id]: 'Changed.' };

    assert.equal(dirtyIndex(document, edits), 2);
  });

  test('never marks an agent node dirty even when an edit is recorded for it', () => {
    assert.equal(isDirty(answer, { [answer.id]: 'Tampered.' }), false);
  });

  test('is not dirty without any recorded edit', () => {
    assert.equal(dirtyIndex(document, {}), -1);
  });
});

describe('comments', () => {
  test('creates a caret comment with no quoted excerpt', () => {
    const comments = startComment([], comment('c1', 'Tighten this.'));

    assert.deepEqual(comments, [
      { id: 'c1', nodeId: answer.id, block: 0, text: 'Tighten this.' },
    ]);
  });

  test('quotes the selection a comment was started over', () => {
    const comments = startComment([], comment('c1', 'Explain.', { anchor }));

    assert.deepEqual(comments[0]?.anchor, anchor);
  });

  test('extends the active comment as more characters arrive', () => {
    const comments = extendComment(
      startComment([], comment('c1', 'Ex')),
      'c1',
      'plain.',
    );

    assert.equal(comments[0]?.text, 'Explain.');
  });

  test('leaves other comments untouched while extending one', () => {
    const comments = extendComment(
      [comment('c1', 'One'), comment('c2', 'Two')],
      'c2',
      '!',
    );

    assert.deepEqual(
      comments.map(({ text }) => text),
      ['One', 'Two!'],
    );
  });

  test('drops a comment once its last character is deleted', () => {
    assert.deepEqual(trimComment([comment('c1', 'a')], 'c1'), []);
  });

  test('removes one character at a time from a longer comment', () => {
    const comments = trimComment([comment('c1', 'abc')], 'c1');

    assert.equal(comments[0]?.text, 'ab');
  });

  test('removes a whole comment by id', () => {
    const comments = removeComment(
      [comment('c1', 'One'), comment('c2', 'Two')],
      'c1',
    );

    assert.deepEqual(
      comments.map(({ id }) => id),
      ['c2'],
    );
  });

  test('selects the comments attached to one node', () => {
    const comments = [
      comment('c1', 'One'),
      { ...comment('c2', 'Two'), nodeId: later.id },
    ];

    assert.deepEqual(
      commentsFor(comments, answer.id).map(({ id }) => id),
      ['c1'],
    );
  });
});

describe('prompt composition', () => {
  test('returns the prompt unchanged when there are no comments', () => {
    assert.equal(composePrompt('Do the thing.', []), 'Do the thing.');
  });

  test('appends a quoted bullet for a comment on a selection', () => {
    assert.equal(
      composePrompt('Do the thing.', [comment('c1', 'Explain.', { anchor })]),
      ['Do the thing.', '', '## Comments', '', '- "Answer.": Explain.'].join(
        '\n',
      ),
    );
  });

  test('appends a plain bullet for a comment on the whole answer', () => {
    assert.equal(
      composePrompt('Do the thing.', [comment('c1', 'Go deeper.')]),
      ['Do the thing.', '', '## Comments', '', '- Go deeper.'].join('\n'),
    );
  });

  test('keeps one bullet per comment in the order they were written', () => {
    assert.equal(
      composePrompt('Do the thing.', [
        comment('c1', 'Explain.', { anchor }),
        comment('c2', 'Go deeper.'),
      ]),
      [
        'Do the thing.',
        '',
        '## Comments',
        '',
        '- "Answer.": Explain.',
        '- Go deeper.',
      ].join('\n'),
    );
  });

  test('composes only the section when the prompt itself is empty', () => {
    assert.equal(
      composePrompt('', [comment('c1', 'Go deeper.')]),
      ['## Comments', '', '- Go deeper.'].join('\n'),
    );
  });
});

describe('caret navigation between nodes', () => {
  test('moves right into the next node\u2019s start', () => {
    assert.deepEqual(caretTarget(document, user.id, 'ArrowRight'), {
      id: answer.id,
      edge: 'start',
    });
  });

  test('moves left into the previous node\u2019s end', () => {
    assert.deepEqual(caretTarget(document, answer.id, 'ArrowLeft'), {
      id: user.id,
      edge: 'end',
    });
  });

  test('moves down into the next node\u2019s start', () => {
    assert.deepEqual(caretTarget(document, user.id, 'ArrowDown'), {
      id: answer.id,
      edge: 'start',
    });
  });

  test('moves up into the previous node\u2019s end', () => {
    assert.deepEqual(caretTarget(document, answer.id, 'ArrowUp'), {
      id: user.id,
      edge: 'end',
    });
  });

  test('stops at the vertical edges too', () => {
    assert.equal(caretTarget(document, user.id, 'ArrowUp'), undefined);
    assert.equal(caretTarget(document, later.id, 'ArrowDown'), undefined);
  });

  test('stops at the document\u2019s edges', () => {
    assert.equal(caretTarget(document, user.id, 'ArrowLeft'), undefined);
    assert.equal(caretTarget(document, later.id, 'ArrowRight'), undefined);
  });

  test('finds nothing for a node outside the document', () => {
    assert.equal(caretTarget(document, draftNodeId, 'ArrowRight'), undefined);
  });
});

describe('markdown blocks', () => {
  test('splits on blank lines and keeps a fenced block whole', () => {
    const source = [
      '# Title',
      '',
      'A paragraph',
      'over two lines.',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      'Closing words.',
    ].join('\n');

    assert.deepEqual(markdownBlocks(source), [
      '# Title',
      'A paragraph\nover two lines.',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```',
      'Closing words.',
    ]);
  });

  test('returns nothing for empty source', () => {
    assert.deepEqual(markdownBlocks('   \n\n'), []);
  });
});

describe('one comment per excerpt', () => {
  test('extends while the anchor is the same excerpt', () => {
    const quoted = comment('c1', 'Explain.', { anchor });
    const other = { quote: 'Other.', start: 20, end: 26 };

    assert.equal(continuesComment(quoted, anchor, 0), true);
    assert.equal(continuesComment(quoted, other, 0), false);
    assert.equal(continuesComment(undefined, anchor, 0), false);
  });

  test('extends a bare caret only inside the comment\u2019s own block', () => {
    const deeper = comment('c1', 'Deeper.');

    assert.equal(continuesComment(deeper, undefined, 0), true);
    assert.equal(continuesComment(deeper, undefined, 2), false);
    assert.equal(continuesComment(deeper, anchor, 0), false);
  });
});
