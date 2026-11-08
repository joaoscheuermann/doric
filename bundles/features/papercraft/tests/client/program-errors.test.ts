// PC1 (papercraft-openui.md D6, "The app's check of a papercraft program"):
// `programErrors` is the app's own check of a papercraft program, a pure
// function of its text. A papercraft fence has local state only, so the
// action steps that leave the fence, the reserved data calls and the
// question form are reported with fixed messages; everything else is the
// renderer's to report.
//
// Contract matrix:
// - `@ToAssistant`, `@OpenUrl`, `@Run` in a statement → one `unknown-function`
//   each, naming the step, with the fixed hint;
// - `@Set`, `@Reset` → nothing (local state);
// - a `Query` statement, a `Mutation` statement → one `tool-not-found` each;
// - an `AskForm` statement → one `unknown-component` with the question hint;
// - a program that does not parse, a plain `ToAssistant("x")` statement and a
//   `Filter("x")` statement → nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { programErrors } from '../../src/client/program-errors.js';

const stepMessage = (step: string) =>
  `@${step} is not available in papercraft fences. Actions belong in openui-lang fences; a preview changes only local state ($variables, forms, @Set, @Reset), and the reader answers with pinned comments.`;

const DATA_HINT =
  'Query and Mutation are not available; write the data as literals.';
const QUESTION_HINT = 'Questions go in openui-lang fences.';

test('PC1: each of @ToAssistant, @OpenUrl and @Run gives one unknown-function with the fixed message', () => {
  for (const [step, call] of [
    ['ToAssistant', '@ToAssistant("Tell me more")'],
    ['OpenUrl', '@OpenUrl("https://example.com")'],
    ['Run', '@Run(refresh)'],
  ] as const) {
    const program = ['root = Stack([go])', `go = Button("Go", ${call})`].join(
      '\n',
    );

    assert.deepEqual(
      programErrors(program),
      [
        {
          code: 'unknown-function',
          statementId: 'go',
          message: stepMessage(step),
        },
      ],
      `@${step}`,
    );
  }
});

test('PC1: steps inside Action([...]) are found too, one entry per step', () => {
  const program = [
    'root = Stack([read])',
    'read = Button("Read", Action([@OpenUrl("https://example.com"), @ToAssistant("Summarize")]))',
  ].join('\n');

  const errors = programErrors(program);

  assert.deepEqual(
    errors
      .map((error) => [error.code, error.statementId, error.message])
      .sort(),
    [
      ['unknown-function', 'read', stepMessage('OpenUrl')],
      ['unknown-function', 'read', stepMessage('ToAssistant')],
    ].sort(),
  );
});

test('PC1: @Set and @Reset change local state only and give nothing', () => {
  const program = [
    'root = Stack([open, clear])',
    'open = Button("Open", @Set($showModal, true))',
    'clear = Button("Clear", Action([@Reset($filter), @Set($page, 1)]))',
  ].join('\n');

  assert.deepEqual(programErrors(program), []);
});

test('PC1: a Query statement and a Mutation statement each give one tool-not-found with the hint', () => {
  const program = [
    'root = Stack([table])',
    'data = Query("list_orders", {}, {rows: []})',
    'save = Mutation("save_order", {id: 1})',
    'table = Table([Col("Id", data.rows)])',
  ].join('\n');

  assert.deepEqual(programErrors(program), [
    { code: 'tool-not-found', statementId: 'data', message: DATA_HINT },
    { code: 'tool-not-found', statementId: 'save', message: DATA_HINT },
  ]);
});

test('PC1: an AskForm statement gives one unknown-component with the question hint', () => {
  const program = [
    'root = Stack([ask])',
    'ask = AskForm("release", [AskQuestion("version", "Which version?")])',
  ].join('\n');

  assert.deepEqual(programErrors(program), [
    { code: 'unknown-component', statementId: 'ask', message: QUESTION_HINT },
  ]);
});

test('PC1: a program that does not parse gives no entry, and never throws', () => {
  for (const program of ['root = Stack([', '= = =', ')))(((', '']) {
    assert.deepEqual(programErrors(program), [], JSON.stringify(program));
  }
});

test('PC1: a plain ToAssistant("x") statement and a Filter("x") statement give no entry', () => {
  const program = [
    'root = Stack([a, b])',
    'a = ToAssistant("x")',
    'b = Filter("x")',
  ].join('\n');

  assert.deepEqual(programErrors(program), []);
});
