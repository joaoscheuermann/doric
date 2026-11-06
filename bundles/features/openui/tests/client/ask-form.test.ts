// C7 (conversation-openui.md D21, D29): the question form. `questionOf`
// reads a question fence's program; `AskForm`'s component, drawn by the
// chunk's `ConversationFence` over a fake `openui.questions/v1`, draws each
// row of D21's table; Send answers through the service; and the
// conversation's check reports cases 3 to 5 of D29 at the fence's report.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { act } from 'react';

import type { ChatFence } from '../../src/client/chat-contract.js';
import { questionOf } from '../../src/client/chunks/renderer.js';
import {
  type AskInput,
  askInputSchema,
  type ProgramErrorsInput,
} from '../../src/contracts/index.js';
import { closeWindow, settle } from './support/dom.js';
import {
  chatFence,
  type FenceAnswers,
  fenceServices,
  type Mounted,
  mountFence,
  projectId,
  revisionOf,
  threadId,
} from './support/fence.js';

after(closeWindow);

/** D21's example, with each positional argument named there. */
const VALID = [
  'root = AskForm([q1], "The service needs a database.")',
  'q1 = AskQuestion("db", "Which database?", [pg, lite], false, true)',
  'pg = AskOption("Postgres", "Relational, already used by billing", true)',
  'lite = AskOption("SQLite", "One file, no server")',
  '',
].join('\n');

const EXAMPLE: AskInput = {
  questions: [
    {
      id: 'db',
      question: 'Which database?',
      options: [
        {
          label: 'Postgres',
          description: 'Relational, already used by billing',
          recommended: true,
        },
        { label: 'SQLite', description: 'One file, no server' },
      ],
      multiSelect: false,
      allowOther: true,
    },
  ],
  context: 'The service needs a database.',
};

/** One question with a single option: it fails `askQuestionSchema`. */
const ONE_OPTION = [
  'root = AskForm([q1], "The service needs a database.")',
  'q1 = AskQuestion("db", "Which database?", [pg])',
  'pg = AskOption("Postgres")',
  '',
].join('\n');

/** A valid question and one with a single option. */
const MIXED = [
  'root = AskForm([q1, q2])',
  'q1 = AskQuestion("db", "Which database?", [pg, lite], false, true)',
  'q2 = AskQuestion("cache", "Which cache?", [redis])',
  'pg = AskOption("Postgres", "Relational, already used by billing", true)',
  'lite = AskOption("SQLite", "One file, no server")',
  'redis = AskOption("Redis")',
  '',
].join('\n');

/** The first zod issue's message for ONE_OPTION's mapped root. */
const oneOptionIssue = (): string => {
  const parsed = askInputSchema.safeParse({
    questions: [
      {
        id: 'db',
        question: 'Which database?',
        options: [{ label: 'Postgres' }],
      },
    ],
    context: 'The service needs a database.',
  });
  assert.equal(parsed.success, false);
  return parsed.error?.issues[0]?.message ?? '';
};

const mountQuestion = async (
  body: string,
  options: {
    readonly state?: ChatFence['state'];
    readonly origin?: 'user' | 'agent';
    readonly superseded?: boolean;
    readonly question?: boolean;
    readonly answers?: FenceAnswers;
  } = {},
): Promise<{
  mounted: Mounted;
  calls: ReturnType<typeof fenceServices>['calls'];
}> => {
  const fence = chatFence(body, {
    info: 'openui-lang',
    state: options.state ?? 'closed',
  });
  const { services, calls } = fenceServices(options.answers ?? {});
  const question = options.question ?? true;
  const mounted = await mountFence({
    view: { fence, origin: options.origin ?? 'user', fences: [fence] },
    revision: revisionOf(fence, {
      identity: question ? '_1' : 'settings',
      question,
    }),
    superseded: options.superseded ?? false,
    services,
  });
  await settle(20);
  return { mounted, calls };
};

const text = (mounted: Mounted): string => mounted.container.textContent ?? '';

const button = (
  mounted: Mounted,
  name: string,
): HTMLButtonElement | undefined =>
  [...mounted.container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent?.trim().startsWith(name) === true,
  ) as HTMLButtonElement | undefined;

const reportsOf = (calls: ReturnType<typeof fenceServices>['calls']) =>
  calls.reports.map(({ input }) => input as ProgramErrorsInput);

test("questionOf maps D21's example to its AskInput", () => {
  const read = questionOf(VALID);

  assert.deepEqual(read.input, EXAMPLE);
  assert.equal(read.issue, undefined);
  assert.deepEqual(read.questions, EXAMPLE.questions);
});

test('questionOf gives an issue for a question with one option and for a root that is not AskForm', () => {
  const one = questionOf(ONE_OPTION);
  assert.equal(one.input, undefined);
  assert.equal(one.issue, oneOptionIssue());
  assert.deepEqual(one.questions, []);

  const card = questionOf('root = Stack([t])\nt = TextContent("Hello")\n');
  assert.equal(card.input, undefined);
  assert.equal(typeof card.issue, 'string');
  assert.deepEqual(card.questions, []);
});

test('questionOf keeps in questions only the entries that pass', () => {
  const read = questionOf(MIXED);

  assert.equal(read.input, undefined);
  assert.deepEqual(read.questions, EXAMPLE.questions);
});

test('not a question fence: the notice, and the check reports the AskForm line', async () => {
  const body = 'root = Stack([form])\nform = AskForm([q1])\n';
  const { mounted, calls } = await mountQuestion(body, { question: false });

  assert.ok(
    text(mounted).includes('A question must be the root of its own fence'),
  );
  assert.deepEqual(
    reportsOf(calls)
      .flatMap(({ errors }) => errors)
      .filter(({ statementId }) => statementId === 'form'),
    [
      {
        code: 'runtime-error',
        statementId: 'form',
        message:
          'A question must be the root of its own fence: write root = AskForm(…) as its first line.',
      },
    ],
  );
  await mounted.unmount();
});

test('an agent Thread: settled, "Not asked", the questions, no controls; the check reports the refusal', async () => {
  const { mounted, calls } = await mountQuestion(VALID, { origin: 'agent' });

  assert.ok(
    text(mounted).includes(
      'Not asked: only the main thread can ask the reader.',
    ),
  );
  assert.ok(text(mounted).includes('Which database?'));
  assert.equal(button(mounted, 'Send'), undefined);
  assert.equal(
    calls.questions.filter(({ method }) => method === 'answer').length,
    0,
  );
  assert.ok(
    reportsOf(calls)
      .flatMap(({ errors }) => errors)
      .some(
        (error) =>
          error.code === 'runtime-error' &&
          error.statementId === 'root' &&
          error.message ===
            'Not asked: only the main thread can ask the user. Put the question in your result instead, so your coordinator can ask the user or decide.',
      ),
  );
  await mounted.unmount();
});

test('streaming with a parsed question: the questions, disabled, with the note', async () => {
  const { mounted, calls } = await mountQuestion(VALID, { state: 'streaming' });

  assert.ok(text(mounted).includes('Which database?'));
  assert.ok(text(mounted).includes('Writing the question…'));
  const postgres = [
    ...mounted.container.querySelectorAll('[role="radio"]'),
  ][0] as HTMLButtonElement | undefined;
  assert.ok(postgres !== undefined);
  assert.equal(postgres.disabled, true);
  assert.deepEqual(calls.questions, []);
  await mounted.unmount();
});

test('streaming before any question parsed: the note alone', async () => {
  const { mounted, calls } = await mountQuestion(
    'root = AskForm([q1], "ctx")\n',
    {
      state: 'streaming',
    },
  );

  assert.ok(text(mounted).includes('Writing the question…'));
  assert.equal(text(mounted).includes('Which database?'), false);
  assert.deepEqual(calls.questions, []);
  await mounted.unmount();
});

test('unterminated: settled, "cut off", with only the questions that pass', async () => {
  const { mounted, calls } = await mountQuestion(MIXED, {
    state: 'unterminated',
  });

  assert.ok(text(mounted).includes('Not asked: the question was cut off'));
  assert.ok(text(mounted).includes('Which database?'));
  assert.equal(text(mounted).includes('Which cache?'), false);
  assert.equal(button(mounted, 'Send'), undefined);
  assert.deepEqual(calls.questions, []);
  await mounted.unmount();
});

test('closed and invalid: an error block with the issue; the check reports it', async () => {
  const { mounted, calls } = await mountQuestion(ONE_OPTION);
  const issue = oneOptionIssue();

  assert.ok(text(mounted).includes(issue));
  assert.ok(
    reportsOf(calls)
      .flatMap(({ errors }) => errors)
      .some(
        (error) =>
          error.code === 'runtime-error' &&
          error.statementId === 'root' &&
          error.message === `Invalid question: ${issue}`.slice(0, 300),
      ),
  );
  await mounted.unmount();
});

test('answered: "Answered" with the answers', async () => {
  const { mounted, calls } = await mountQuestion(VALID, {
    answers: {
      status: async () => ({
        state: 'answered',
        answers: [{ id: 'db', options: ['Postgres'] }],
      }),
    },
  });

  assert.ok(text(mounted).includes('Answered'));
  assert.ok(text(mounted).includes('Postgres'));
  assert.equal(button(mounted, 'Send'), undefined);
  assert.deepEqual(calls.questions[0], {
    method: 'status',
    input: { promptId: 'p1', questions: EXAMPLE },
    scope: { projectId, threadId },
  });
  await mounted.unmount();
});

test('superseded and pending: "Replaced by a later question"', async () => {
  const { mounted } = await mountQuestion(VALID, { superseded: true });

  assert.ok(text(mounted).includes('Replaced by a later question'));
  assert.equal(button(mounted, 'Send'), undefined);
  await mounted.unmount();
});

test('pending: the questions with controls; Send answers with the picks', async () => {
  const { mounted, calls } = await mountQuestion(VALID);

  assert.ok(text(mounted).includes('Which database?'));
  assert.ok(text(mounted).includes('The service needs a database.'));
  const postgres = [
    ...mounted.container.querySelectorAll('[role="radio"]'),
  ].find((row) => row.textContent?.includes('Postgres')) as
    | HTMLElement
    | undefined;
  assert.ok(postgres !== undefined);

  await act(async () => {
    postgres.click();
  });
  const send = button(mounted, 'Send');
  assert.ok(send !== undefined);
  await act(async () => {
    send.click();
  });
  await settle(20);

  const answer = calls.questions.find(({ method }) => method === 'answer');
  assert.deepEqual(answer, {
    method: 'answer',
    input: {
      promptId: 'p1',
      questions: EXAMPLE,
      answers: [{ id: 'db', options: ['Postgres'] }],
    },
    scope: { projectId, threadId },
  });
  assert.ok(text(mounted).includes('Answered'));
  await mounted.unmount();
});

test('a rejected answer shows "Could not send. Try again." with the picks kept', async () => {
  const { mounted } = await mountQuestion(VALID, {
    answers: {
      answer: async () => {
        throw new Error('unavailable');
      },
    },
  });
  const postgres = [
    ...mounted.container.querySelectorAll('[role="radio"]'),
  ].find((row) => row.textContent?.includes('Postgres')) as
    | HTMLElement
    | undefined;
  assert.ok(postgres !== undefined);

  await act(async () => {
    postgres.click();
  });
  await act(async () => {
    button(mounted, 'Send')?.click();
  });
  await settle(20);

  assert.ok(text(mounted).includes('Could not send. Try again.'));
  const kept = [...mounted.container.querySelectorAll('[role="radio"]')].find(
    (row) => row.textContent?.includes('Postgres'),
  );
  assert.equal(kept?.getAttribute('aria-checked'), 'true');
  await mounted.unmount();
});
