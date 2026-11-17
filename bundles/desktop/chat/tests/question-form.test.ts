// The question form chat draws and the one the host archives by
// (docs/designs/thread-archive.md §2.1, T-38, AC22): over one list of turn
// texts, the turn's `openui-lang` fences, read with the runtime's
// `firstCompletedLine` and `isQuestionLine`, hold a question form exactly
// when `hasQuestionForm` says so — on every text but an opener holding a `|`
// right after a table row, which the table takes (the host keeps that Thread
// in Chat, which fails safe).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  firstCompletedLine,
  hasQuestionForm,
  isQuestionLine,
  questionFenceTag,
} from 'runtime/contracts';

import { threadFences } from '../src/client/domain/fences.js';
import {
  emptyProjection,
  projectEvents,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';

const thread = { projectId: 'p', threadId: 't' } as const;

const event = (
  sequence: number,
  type: string,
  value: Record<string, unknown> = {},
): ThreadEvent => ({
  projectId: 'p',
  threadId: 't',
  promptId: 'one',
  type,
  event: { type, ...value },
  sequence,
  createdAt: new Date(sequence * 1000).toISOString(),
});

/** A completed turn whose answer is `text`. */
const turnOf = (text: string): ThreadEvent[] => [
  event(1, 'prompt.accepted', {
    text: 'ask me',
    source: { kind: 'user' },
    queued: false,
  }),
  event(2, 'prompt.started'),
  event(3, 'agent.started'),
  event(4, 'text.delta', { delta: text }),
  event(5, 'prompt.finished', { text, status: 'completed' }),
];

/** Whether chat draws a question form in a completed turn answering `text`. */
const chatDrawsForm = (text: string): boolean =>
  threadFences(
    projectEvents(emptyProjection, turnOf(text)).turns,
    new Set([questionFenceTag]),
    thread,
  ).some((fence) => {
    const line = firstCompletedLine(fence.body, fence.state === 'closed');
    return line !== undefined && isQuestionLine(line);
  });

const form = 'root = AskForm([q1])';
const question = 'q1 = Question("Pick one", ["a", "b"])';
const fenced = (opener = '```openui-lang', closer = '```') =>
  `${opener}\n${form}\n${question}\n${closer}`;
const table = '| a | b |\n| - | - |\n| 1 | 2 |';

/** Each text, and whether it holds a question form by §2.1's rules. */
const texts: readonly (readonly [string, string, boolean])[] = [
  ['a closed fence', `Pick one:\n\n${fenced()}`, true],
  ['an id after the info string', fenced('```openui-lang form-1'), true],
  ['a four-backtick fence', fenced('````openui-lang', '````'), true],
  ['a tilde fence', fenced('~~~openui-lang', '~~~'), true],
  [
    'an indented opener',
    `Text\n\n${fenced('  ```openui-lang', '  ```')}`,
    true,
  ],
  [
    'leading blank lines inside',
    `\`\`\`openui-lang\n\n   \n${form}\n${question}\n\`\`\``,
    true,
  ],
  [
    'an unclosed fence whose AskForm line is complete',
    `\`\`\`openui-lang\n${form}\n${question}`,
    true,
  ],
  [
    'an unclosed fence whose only line is incomplete',
    '```openui-lang\nroot = AskForm(',
    false,
  ],
  [
    'AskForm on the second line',
    `\`\`\`openui-lang\n${question}\n${form}\n\`\`\``,
    false,
  ],
  ['another info string', fenced('```openui'), false],
  [
    'a closer of the other character',
    `\`\`\`text\nnot a form\n~~~\n${fenced()}\n\`\`\``,
    false,
  ],
  ['no fence', `${form}\n${question}`, false],
  ['a form right after a paragraph', `Please choose.\n${fenced()}`, true],
  ['a form inside a list', `- first\n- second\n${fenced()}`, true],
  ['a form after a quote', `> Which one?\n${fenced()}`, true],
  ['a form after a table', `${table}\n\n${fenced()}`, true],
  ['two forms', `${fenced()}\n\nOr:\n\n${fenced()}`, true],
  [
    'a form followed by another fence',
    `${fenced()}\n\n\`\`\`ts\nconst x = 1;\n\`\`\``,
    true,
  ],
];

const tablePipe = `${table}\n${fenced('```openui-lang | form')}`;

describe('the question form chat draws and the host reads', () => {
  test('hasQuestionForm answers each text by the fence rules', () => {
    for (const [what, text, expected] of texts)
      assert.equal(hasQuestionForm(text), expected, what);
  });

  test('chat draws a question form exactly where hasQuestionForm finds one', () => {
    for (const [what, text] of texts)
      assert.equal(chatDrawsForm(text), hasQuestionForm(text), what);
  });

  test('an opener with a pipe right after a table row is a form to the host only', () => {
    assert.equal(hasQuestionForm(tablePipe), true);
    assert.equal(chatDrawsForm(tablePipe), false);
  });
});
