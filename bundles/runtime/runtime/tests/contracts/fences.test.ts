import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closesFence,
  completedStatements,
  fenceInfo,
  fenceMarker,
  firstCompletedLine,
  hasQuestionForm,
  isQuestionLine,
  questionFenceTag,
} from '../../src/contracts/fences.js';

/*
 * The fence and question-form line rules of runtime.threads/v1 1.8.0
 * (docs/designs/thread-archive.md §2.1, T-30, AC22): one copy the windows draw
 * by and the host archives by.
 */

const form = 'root = AskForm([q1])';
const question = 'q1 = Question("Pick one", ["a", "b"])';

/** Each text and whether it holds a question form. */
const questionTexts: readonly (readonly [string, string, boolean])[] = [
  [
    'a closed openui-lang fence opening with root = AskForm(',
    `Pick one:\n\n\`\`\`openui-lang\n${form}\n${question}\n\`\`\``,
    true,
  ],
  [
    'an id after the info string',
    `\`\`\`openui-lang form-1\n${form}\n${question}\n\`\`\``,
    true,
  ],
  [
    'a four-backtick fence',
    `\`\`\`\`openui-lang\n${form}\n${question}\n\`\`\`\``,
    true,
  ],
  ['a tilde fence', `~~~openui-lang\n${form}\n${question}\n~~~`, true],
  [
    'an opener indented by spaces',
    `Text\n\n  \`\`\`openui-lang\n${form}\n${question}\n  \`\`\``,
    true,
  ],
  [
    'leading blank lines inside the fence',
    `\`\`\`openui-lang\n\n   \n${form}\n${question}\n\`\`\``,
    true,
  ],
  [
    'an unclosed fence whose AskForm line is complete',
    `\`\`\`openui-lang\n${form}\n${question}`,
    true,
  ],
  [
    'an unclosed fence whose only line is root = AskForm( without a newline',
    '```openui-lang\nroot = AskForm(',
    false,
  ],
  [
    'AskForm on the second line',
    `\`\`\`openui-lang\n${question}\n${form}\n\`\`\``,
    false,
  ],
  ['another info string', `\`\`\`openui\n${form}\n${question}\n\`\`\``, false],
  [
    'a closer of the other character does not close the fence before it',
    `\`\`\`text\nnot a form\n~~~\n\`\`\`openui-lang\n${form}\n\`\`\`\n\`\`\``,
    false,
  ],
  ['no fence', `${form}\n${question}`, false],
];

void test('hasQuestionForm answers each text of the fence rules', () => {
  for (const [what, text, expected] of questionTexts)
    assert.equal(hasQuestionForm(text), expected, what);
});

void test('hasQuestionForm never throws and answers false for an empty text', () => {
  assert.equal(hasQuestionForm(''), false);
  assert.equal(hasQuestionForm('```'), false);
});

void test('isQuestionLine accepts a root = AskForm( line only', () => {
  assert.equal(isQuestionLine('root = AskForm([q1])'), true);
  assert.equal(isQuestionLine('root=AskForm([q1])'), true);
  assert.equal(isQuestionLine('form = AskForm([q1])'), false);
  assert.equal(isQuestionLine('root = Stack([form])'), false);
});

void test('firstCompletedLine reads the first non-blank completed statement', () => {
  assert.equal(firstCompletedLine(`\n${form}\n${question}`, true), form);
  assert.equal(firstCompletedLine(`${form}\n`, false), form);
  assert.equal(firstCompletedLine(`${form}\n${question}`, false), form);
  assert.equal(firstCompletedLine('root = AskForm(', false), undefined);
  assert.equal(firstCompletedLine('  \n', true), undefined);
});

void test('completedStatements keeps the whole body only when closed or newline-terminated', () => {
  assert.equal(completedStatements('a\nb', true), 'a\nb');
  assert.equal(completedStatements('a\nb\n', false), 'a\nb\n');
  assert.equal(completedStatements('a\nb', false), 'a');
  assert.equal(completedStatements('a', false), '');
});

void test('fenceMarker, closesFence and fenceInfo read openers and closers', () => {
  assert.equal(fenceMarker('```openui-lang'), '```');
  assert.equal(fenceMarker('  ~~~~'), '~~~~');
  assert.equal(fenceMarker('``not'), undefined);
  assert.equal(fenceMarker('text ```'), undefined);
  assert.equal(closesFence('```', '```'), true);
  assert.equal(closesFence('  ````  ', '```'), true);
  assert.equal(closesFence('```', '````'), false);
  assert.equal(closesFence('~~~', '```'), false);
  assert.equal(closesFence('``` x', '```'), false);
  assert.deepEqual(fenceInfo('```openui-lang form-1 '), {
    info: 'openui-lang form-1',
    tag: 'openui-lang',
  });
  assert.deepEqual(fenceInfo('~~~'), { info: '', tag: '' });
  assert.equal(questionFenceTag, 'openui-lang');
});
