import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createToolStorage, ToolErrorObject } from 'tool';

import type {
  AskAnswer,
  AskInput,
  AskQuestion,
  AskState,
} from '../src/contracts/index.js';
import { formatAnswers } from '../src/host/ask.js';
import {
  type AskHarness,
  activePromptId,
  askHarness,
  askPromptId,
  projectId,
  rowsOf,
  type SteerOutcome,
  threadId,
  threadLog,
} from './support/ask.js';

const SUCCESS =
  'The questions are shown to the user. End your turn now without further tool calls; the answers arrive as the next user request.';
const REFUSAL =
  'Not asked: only the main thread can ask the user. Put the question in your result instead, so your coordinator can ask the user or decide.';
const HEADER = 'Answers to your questions:\n\n';
const ASKED = 'threads.asked/v1';
const ANSWERED = 'threads.answered/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A well-formed askId no ask ever received. */
const unknownAskId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf17ff';

/** A single-select question; `allowOther` is left out on purpose. */
const approval: AskQuestion = {
  id: 'approve',
  question: 'Ship the migration today?',
  options: [{ label: 'Yes', recommended: true }, { label: 'No' }],
};

/** A multi-select question that takes a free answer too. */
const platforms: AskQuestion = {
  id: 'platforms',
  question: 'Which platforms must it support?',
  multiSelect: true,
  allowOther: true,
  options: [{ label: 'Linux' }, { label: 'macOS' }, { label: 'Windows' }],
};

/** A multi-select question that refuses a free answer. */
const regions: AskQuestion = {
  id: 'regions',
  question: 'Which regions get it first?',
  multiSelect: true,
  allowOther: false,
  options: [{ label: 'EU' }, { label: 'US' }],
};

const codeOf = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: unknown }).code, expected);
  return true;
};

const withHarness = async (
  run: (harness: AskHarness) => Promise<void>,
  options: Parameters<typeof askHarness>[0] = {},
): Promise<void> => {
  const harness = await askHarness(options);

  try {
    await run(harness);
  } finally {
    await harness.close();
  }
};

/** Runs the `ask` tool as the agent loop does, under the ask prompt (P). */
const runAsk = (harness: AskHarness, payload: unknown): Promise<unknown> =>
  createToolStorage(harness.tools()).execute({
    id: 'call',
    name: 'ask',
    payload: payload as never,
  });

/** Asks `input` and returns the askId its asked row carries. */
const askFor = async (
  harness: AskHarness,
  input: AskInput,
): Promise<string> => {
  assert.equal(await runAsk(harness, input), SUCCESS);
  const rows = rowsOf(harness.log, ASKED);
  const askId = (rows.at(-1)?.event as { askId?: unknown } | undefined)?.askId;
  assert.equal(typeof askId, 'string');

  return askId as string;
};

const answer = (
  harness: AskHarness,
  askId: string,
  answers: readonly AskAnswer[],
): Promise<AskState> => harness.ask.answer({ askId, answers }, harness.call());

const status = (harness: AskHarness, askId: string): Promise<AskState> =>
  harness.ask.status({ askId }, harness.call());

describe('ask tool registration', () => {
  // H1
  test('registers the eight thread tools and then ask, at order 1660 and always available', async () => {
    await withHarness(async (harness) => {
      assert.deepEqual(
        harness.registered.map(({ tool }) => tool.name),
        [
          'thread-spawn',
          'thread-list',
          'thread-get',
          'thread-events',
          'thread-send',
          'thread-interrupt',
          'thread-terminate',
          'thread-restart',
          'ask',
        ],
      );

      const orders = harness.registered.map(({ options }) => options.order);
      assert.deepEqual(
        orders,
        [...orders].sort((a, b) => (a ?? 0) - (b ?? 0)),
      );

      const ask = harness.registered.find(({ tool }) => tool.name === 'ask');
      assert.equal(ask?.options.order, 1660);
      assert.equal(ask?.options.alwaysAvailable, true);
    });
  });
});

describe('ask tool payload', () => {
  const option = (label: string) => ({ label });
  const question = (overrides: Record<string, unknown> = {}) => ({
    ...approval,
    ...overrides,
  });

  // H2
  test('rejects every malformed payload as invalid_payload', async () => {
    await withHarness(async (harness) => {
      const cases: readonly [string, unknown][] = [
        ['empty payload', {}],
        ['no questions', { questions: [] }],
        [
          'six questions',
          {
            questions: Array.from({ length: 6 }, (_, index) =>
              question({ id: `q${index}` }),
            ),
          },
        ],
        ['one option', { questions: [question({ options: [option('A')] })] }],
        [
          'seven options',
          {
            questions: [
              question({
                options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(option),
              }),
            ],
          },
        ],
        ['blank question', { questions: [question({ question: '   ' })] }],
        [
          'blank label',
          { questions: [question({ options: [option('A'), option('   ')] })] },
        ],
        ['blank context', { context: '   ', questions: [question()] }],
        [
          'duplicate question ids',
          { questions: [question(), question({ question: 'Again?' })] },
        ],
        [
          'duplicate labels',
          { questions: [question({ options: [option('A'), option('A')] })] },
        ],
        [
          '501-char question',
          { questions: [question({ question: 'q'.repeat(501) })] },
        ],
        [
          'extra question key',
          { questions: [question({ header: 'Migration' })] },
        ],
        ['extra top-level key', { questions: [question()], title: 'Choose' }],
      ];

      for (const [name, payload] of cases) {
        await assert.rejects(
          runAsk(harness, payload),
          (error: unknown) => {
            assert.ok(error instanceof ToolErrorObject, name);
            assert.equal(error.data.code, 'invalid_payload', name);
            return true;
          },
          name,
        );
      }

      assert.equal(rowsOf(harness.log, ASKED).length, 0);
    });
  });

  // H2 (boundary)
  test('accepts a question of exactly 500 characters', async () => {
    await withHarness(async (harness) => {
      assert.equal(
        await runAsk(harness, {
          questions: [question({ question: 'q'.repeat(500) })],
        }),
        SUCCESS,
      );
    });
  });
});

describe('ask tool on a Thread', () => {
  // H3
  test('on the main thread, shows the questions and records them pending', async () => {
    await withHarness(async (harness) => {
      const questions = [approval, platforms];

      assert.equal(await runAsk(harness, { questions }), SUCCESS);

      assert.equal(harness.log.rows.length, 1);
      const [row] = rowsOf(harness.log, ASKED);
      const event = row?.event as { askId: string; questions: unknown };
      assert.match(event.askId, UUID);
      assert.deepEqual(event.questions, questions);
      assert.deepEqual(await status(harness, event.askId), {
        state: 'pending',
      });
    });
  });

  // H4
  test('on an agent thread, refuses and records nothing', async () => {
    await withHarness(
      async (harness) => {
        assert.equal(await runAsk(harness, { questions: [approval] }), REFUSAL);
        assert.equal(harness.log.rows.length, 0);
      },
      { thread: { origin: 'agent' } },
    );
  });
});

describe('threads.ask/v1.answer', () => {
  // H5
  test('on an idle thread, queues one input on the ask prompt and records the answers', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });
      const answers: AskAnswer[] = [{ id: 'approve', options: ['Yes'] }];

      harness.steerWith({ status: 'queued', promptId: askPromptId });
      const result = await answer(harness, askId, answers);

      assert.deepEqual(result, { state: 'answered', answers });
      assert.deepEqual(harness.steers, [
        {
          id: threadId,
          promptId: askPromptId,
          prompt: `${HEADER}1. Ship the migration today?\n   Yes`,
        },
      ]);
      const answered = rowsOf(harness.log, ANSWERED);
      assert.equal(answered.length, 1);
      assert.deepEqual(answered[0]?.event, { type: ANSWERED, askId, answers });
    });
  });

  // H6
  test('while another prompt runs, steers that prompt', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });

      harness.thread.activePromptId = activePromptId;
      harness.steerWith({ status: 'steered', promptId: activePromptId });
      const result = await answer(harness, askId, [
        { id: 'approve', options: ['No'] },
      ]);

      assert.equal(result.state, 'answered');
      assert.equal(harness.steers.length, 1);
      assert.equal(harness.steers[0]?.promptId, activePromptId);
    });
  });

  // H7
  test('lists chosen labels in option order, then the trimmed free answer, indented', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [platforms] });

      await answer(harness, askId, [
        {
          id: 'platforms',
          options: ['Windows', 'Linux'],
          other: '  FreeBSD\nOpenBSD  ',
        },
      ]);

      assert.equal(
        harness.steers[0]?.prompt,
        `${HEADER}1. Which platforms must it support?\n   Linux; Windows; FreeBSD\n   OpenBSD`,
      );
    });
  });

  // H7
  test('numbers the questions in the order they were asked, whatever the answer order', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval, platforms] });

      await answer(harness, askId, [
        { id: 'platforms', options: ['macOS'] },
        { id: 'approve', options: ['No'] },
      ]);

      const prompt = harness.steers[0]?.prompt ?? '';
      const first = '1. Ship the migration today?\n   No';
      const second = '2. Which platforms must it support?\n   macOS';
      assert.ok(prompt.startsWith(`${HEADER}${first}`), prompt);
      assert.ok(prompt.indexOf(second) > prompt.indexOf(first), prompt);
    });
  });

  // H8
  test('rejects answers that do not fit the questions, sending and recording nothing', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval, regions] });
      const approve: AskAnswer = { id: 'approve', options: ['Yes'] };
      const region: AskAnswer = { id: 'regions', options: ['EU'] };
      const cases: readonly [string, AskAnswer[]][] = [
        ['unknown id', [approve, region, { id: 'ghost', options: ['Yes'] }]],
        ['unknown label', [{ id: 'approve', options: ['Maybe'] }, region]],
        [
          'two labels on single-select',
          [{ id: 'approve', options: ['Yes', 'No'] }, region],
        ],
        [
          'other without allowOther',
          [approve, { id: 'regions', options: ['EU'], other: 'APAC' }],
        ],
        ['missing answer', [approve]],
        [
          'no label and blank other',
          [{ id: 'approve', options: [], other: '   ' }, region],
        ],
      ];

      for (const [name, answers] of cases) {
        await assert.rejects(
          answer(harness, askId, answers),
          codeOf('invalid_input'),
          name,
        );
      }

      assert.equal(harness.steers.length, 0);
      assert.equal(rowsOf(harness.log, ANSWERED).length, 0);
      assert.deepEqual(await status(harness, askId), { state: 'pending' });
    });
  });

  // H8
  test('accepts a free answer when allowOther is left out', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });

      const result = await answer(harness, askId, [
        { id: 'approve', options: [], other: 'Only after the freeze' },
      ]);

      assert.equal(result.state, 'answered');
      assert.equal(harness.steers.length, 1);
    });
  });

  // H9
  test('a second answer returns the first answers and sends nothing more', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });
      const first: AskAnswer[] = [{ id: 'approve', options: ['Yes'] }];

      await answer(harness, askId, first);
      const again = await answer(harness, askId, [
        { id: 'approve', options: ['No'] },
      ]);

      assert.deepEqual(again, { state: 'answered', answers: first });
      assert.equal(harness.steers.length, 1);
      assert.equal(rowsOf(harness.log, ANSWERED).length, 1);
    });
  });

  // H9 (concurrency)
  test('two concurrent answers send one input and both resolve answered', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });

      const results = await Promise.all([
        answer(harness, askId, [{ id: 'approve', options: ['Yes'] }]),
        answer(harness, askId, [{ id: 'approve', options: ['No'] }]),
      ]);

      assert.deepEqual(
        results.map((result) => result.state),
        ['answered', 'answered'],
      );
      assert.equal(harness.steers.length, 1);
      assert.equal(rowsOf(harness.log, ANSWERED).length, 1);
    });
  });

  // H11
  test('answering an ask a later ask replaced is superseded and sends nothing', async () => {
    await withHarness(async (harness) => {
      const first = await askFor(harness, { questions: [approval] });
      await askFor(harness, { questions: [platforms] });

      assert.deepEqual(
        await answer(harness, first, [{ id: 'approve', options: ['Yes'] }]),
        { state: 'superseded' },
      );
      assert.equal(harness.steers.length, 0);
      assert.equal(rowsOf(harness.log, ANSWERED).length, 0);
    });
  });

  // H13
  for (const [name, outcome] of [
    ['missing', { status: 'missing' }],
    ['inactive', { status: 'inactive' }],
    ['forbidden', { status: 'forbidden' }],
    ['a thrown error', new Error('store down')],
  ] as const satisfies readonly (readonly [string, SteerOutcome])[]) {
    test(`a refused send (${name}) is unavailable and leaves the ask pending`, async () => {
      await withHarness(async (harness) => {
        const askId = await askFor(harness, { questions: [approval] });

        harness.steerWith(outcome);
        await assert.rejects(
          answer(harness, askId, [{ id: 'approve', options: ['Yes'] }]),
          codeOf('unavailable'),
        );

        assert.equal(rowsOf(harness.log, ANSWERED).length, 0);
        assert.deepEqual(await status(harness, askId), { state: 'pending' });
      });
    });
  }
});

describe('threads.ask/v1.status', () => {
  // H10
  test('moves from pending to answered, with the answers', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });
      const answers: AskAnswer[] = [{ id: 'approve', options: ['Yes'] }];

      assert.deepEqual(await status(harness, askId), { state: 'pending' });
      await answer(harness, askId, answers);
      assert.deepEqual(await status(harness, askId), {
        state: 'answered',
        answers,
      });
    });
  });

  // H10
  test('an unanswered ask is superseded by a later ask; an answered one stays answered', async () => {
    await withHarness(async (harness) => {
      const answered = await askFor(harness, { questions: [approval] });
      const answers: AskAnswer[] = [{ id: 'approve', options: ['No'] }];
      await answer(harness, answered, answers);

      const unanswered = await askFor(harness, { questions: [platforms] });
      const latest = await askFor(harness, { questions: [regions] });

      assert.deepEqual(await status(harness, answered), {
        state: 'answered',
        answers,
      });
      assert.deepEqual(await status(harness, unanswered), {
        state: 'superseded',
      });
      assert.deepEqual(await status(harness, latest), { state: 'pending' });
    });
  });

  // H12
  test('an askId no ask received is not_found, for status and answer', async () => {
    await withHarness(async (harness) => {
      await askFor(harness, { questions: [approval] });

      await assert.rejects(status(harness, unknownAskId), codeOf('not_found'));
      await assert.rejects(
        answer(harness, unknownAskId, [{ id: 'approve', options: ['Yes'] }]),
        codeOf('not_found'),
      );
      assert.equal(harness.steers.length, 0);
    });
  });

  // H14
  test('a fresh activation over the same log keeps answered and pending asks', async () => {
    const log = threadLog();
    let answeredId = '';
    let pendingId = '';
    const answers: AskAnswer[] = [{ id: 'approve', options: ['Yes'] }];

    await withHarness(
      async (harness) => {
        answeredId = await askFor(harness, { questions: [approval] });
        await answer(harness, answeredId, answers);
        pendingId = await askFor(harness, { questions: [platforms] });
      },
      { log },
    );

    await withHarness(
      async (restarted) => {
        assert.deepEqual(await status(restarted, answeredId), {
          state: 'answered',
          answers,
        });
        assert.deepEqual(await status(restarted, pendingId), {
          state: 'pending',
        });
      },
      { log },
    );
  });
});

describe('threads.ask/v1 scope', () => {
  test('status needs a threadId and answer needs a promptId', async () => {
    await withHarness(async (harness) => {
      const askId = await askFor(harness, { questions: [approval] });

      await assert.rejects(
        harness.ask.status(
          { askId },
          harness.call({ projectId, promptId: askPromptId }),
        ),
        codeOf('invalid_scope'),
      );
      await assert.rejects(
        harness.ask.answer(
          { askId, answers: [{ id: 'approve', options: ['Yes'] }] },
          harness.call({ projectId, threadId }),
        ),
        codeOf('invalid_scope'),
      );
      assert.equal(harness.steers.length, 0);
    });
  });
});

describe('formatAnswers', () => {
  // H7 (direct)
  test('writes each answer under its numbered question, in the asked order', () => {
    const text = formatAnswers(
      [approval, platforms],
      [
        {
          id: 'platforms',
          options: ['Windows', 'Linux'],
          other: ' BSD\nHaiku ',
        },
        { id: 'approve', options: ['Yes'] },
      ],
    );

    const first = '1. Ship the migration today?\n   Yes';
    const second =
      '2. Which platforms must it support?\n   Linux; Windows; BSD\n   Haiku';
    assert.ok(text.includes(first), text);
    assert.ok(text.indexOf(second) > text.indexOf(first), text);
  });
});
