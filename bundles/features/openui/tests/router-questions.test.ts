// R6–R14 (phase 3, S56): `openui.questions/v1` over the router keeps the
// kernel's question behaviour (conversation-openui.md D21, D22): the state is
// folded from the Thread's `openui.answered/v1` rows, the answer is sent by
// D20's route and recorded under the prompt that took it; requests are parsed
// again with today's zod schemas (D2), and a row the kernel wrote and one the
// routed append stored both read `answered` (D3).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { type JsonObject, toJson } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';

import {
  AnswerResponseSchema,
  StatusResponseSchema,
} from '../src/contracts/gen/doric/openui/questions/v1/questions_pb.js';
import {
  type AskAnswer,
  type AskInput,
  askInputSchema,
} from '../src/contracts/index.js';
import {
  failureOf,
  otherProjectId,
  projectId,
  type RouterWorld,
  routerWorld,
  threadId,
} from './support/router.js';

/** D21's example question. */
const questions: AskInput = {
  context: 'The service needs a database.',
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
};

const postgres: AskAnswer[] = [{ id: 'db', options: ['Postgres'] }];

/** The text `formatAnswers` gives for D21's example with Postgres chosen. */
const POSTGRES_TEXT =
  'Answers to your questions:\n\n1. Which database?\n   Postgres';

/** Hex SHA-256 of the parsed questions' JSON. */
const digestOf = (input: AskInput): string =>
  createHash('sha256')
    .update(JSON.stringify(askInputSchema.parse(input)))
    .digest('hex');

const activated = async (
  t: test.TestContext,
  setup: (world: RouterWorld) => void = () => undefined,
): Promise<RouterWorld> => {
  const world = routerWorld();
  t.after(() => world.stop());
  setup(world);
  await world.activate();
  return world;
};

/** The route's calls, in order: what was sent and recorded. */
const sent = (world: RouterWorld): string[] =>
  world.calls
    .map(({ method }) => method)
    .filter((method) =>
      [
        'threads.steer',
        'threads.resumeQueue',
        'threads.prompt',
        'events.append',
      ].includes(method),
    );

const answer = (world: RouterWorld, answers: AskAnswer[] = postgres) =>
  world.questions().answer({ promptId: 'q1', questions, answers });

const running = (world: RouterWorld): void => {
  world.threads.set(threadId, { projectId, activePromptId: 'p-run' });
};

void test('R6: Status on an empty log answers pending, having read the log from sequence 0', async (t) => {
  const world = await activated(t);

  const response = await world
    .questions()
    .status({ promptId: 'q1', questions });

  assert.deepEqual(toJson(StatusResponseSchema, response), {
    questionState: { pending: {} },
  });
  assert.deepEqual(
    world.callsOf('threads.threadEvents').map(({ request }) => request),
    [{ id: threadId, afterSequence: 0 }],
  );
});

void test('R7: Answer with a running prompt steers formatAnswers’ text, then appends the packed row under the steered prompt, and answers answered', async (t) => {
  const world = await activated(t, running);

  const response = await answer(world);

  assert.deepEqual(sent(world), ['threads.steer', 'events.append']);
  assert.deepEqual(world.callsOf('threads.steer')[0]?.request, {
    id: threadId,
    prompt: POSTGRES_TEXT,
    promptId: 'p-run',
  });
  const [appended] = world.callsOf('events.append');
  assert.deepEqual(appended?.scope, {
    projectId,
    threadId,
    promptId: 'p-run',
  });
  assert.deepEqual(appended?.request, {
    type: 'openui.answered/v1',
    payload: {
      questionPromptId: 'q1',
      digest: digestOf(questions),
      answers: [{ id: 'db', options: ['Postgres'] }],
    },
  });
  assert.deepEqual(toJson(AnswerResponseSchema, response), {
    questionState: {
      answered: { answers: [{ id: 'db', options: ['Postgres'] }] },
    },
  });
});

void test('R8: with nothing running, a paused, empty queue is resumed before the prompt; a running queue only gets the prompt', async (t) => {
  for (const paused of [true, false]) {
    const world = await activated(t, (w) => w.paused.set(threadId, paused));

    await answer(world);

    assert.deepEqual(
      sent(world),
      paused
        ? ['threads.resumeQueue', 'threads.prompt', 'events.append']
        : ['threads.prompt', 'events.append'],
    );
    assert.deepEqual(world.callsOf('threads.prompt')[0]?.request, {
      id: threadId,
      prompt: POSTGRES_TEXT,
    });
    assert.equal(
      world.callsOf('events.append')[0]?.scope?.promptId,
      'answer-prompt',
    );
  }
});

void test('R9: an unknown Thread, another Project’s, an agent’s and a refused steer are unavailable with their status, and nothing is appended', async (t) => {
  const cases: [string, (world: RouterWorld) => void][] = [
    ['missing', (w) => w.threads.delete(threadId)],
    ['missing', (w) => w.threads.set(threadId, { projectId: otherProjectId })],
    [
      'forbidden',
      (w) => w.threads.set(threadId, { projectId, origin: 'agent' }),
    ],
    [
      'inactive',
      (w) => {
        running(w);
        w.threadsAnswers.steer = () => ({
          steerResult: { status: 'inactive' },
        });
      },
    ],
  ];

  for (const [status, setup] of cases) {
    const world = await activated(t, setup);

    const error = await failureOf(() => answer(world));

    assert.equal(error.code, 'unavailable');
    assert.equal(error.message, 'The Thread did not take the answers.');
    assert.deepEqual(error.details, { status });
    assert.deepEqual(world.callsOf('events.append'), []);
  }
});

void test('R10: a rejected Prompt is unavailable with the provider’s message as the reason', async (t) => {
  const world = await activated(t, (w) => {
    w.threadsAnswers.prompt = () => {
      throw new ContractError('unavailable', 'x');
    };
  });

  const error = await failureOf(() => answer(world));

  assert.equal(error.code, 'unavailable');
  assert.equal(error.message, 'The Thread did not take the answers.');
  assert.deepEqual(error.details, { reason: 'x' });
  assert.deepEqual(world.callsOf('events.append'), []);
});

void test('R11: a second Answer returns the first state without sending; two Answers at once send once', async (t) => {
  const first = await activated(t, running);
  await answer(first);
  const again = await answer(first, [{ id: 'db', options: ['SQLite'] }]);

  assert.deepEqual(toJson(AnswerResponseSchema, again), {
    questionState: {
      answered: { answers: [{ id: 'db', options: ['Postgres'] }] },
    },
  });
  assert.equal(first.callsOf('threads.steer').length, 1);

  const racing = await activated(t, running);
  await Promise.all([answer(racing), answer(racing)]);

  assert.equal(racing.callsOf('threads.steer').length, 1);
  assert.equal(racing.callsOf('events.append').length, 1);
});

void test('R12: a row as the kernel wrote it and a row as the routed append stored it both make Status answer answered', async (t) => {
  const asked: AskInput = {
    questions: [
      ...questions.questions,
      {
        id: 'notes',
        question: 'Anything else?',
        options: [{ label: 'No' }, { label: 'Later' }],
        allowOther: true,
      },
    ],
  };
  const answers: AskAnswer[] = [
    { id: 'db', options: ['Postgres'] },
    { id: 'notes', options: [], other: '' },
  ];
  const writer = await activated(t, running);
  await writer
    .questions()
    .answer({ promptId: 'q1', questions: asked, answers });
  const stored = writer.log.find(({ type }) => type === 'openui.answered/v1');
  assert.ok(stored !== undefined, 'the routed append stored a row');

  // The kernel's zod output: `options` always, `other` only when given.
  const kernelRow: JsonObject = {
    questionPromptId: 'q1',
    digest: digestOf(asked),
    answers: [
      { id: 'db', options: ['Postgres'] },
      { id: 'notes', options: [], other: '' },
    ],
  };
  const { type: _type, ...routedRow } = stored.event;

  for (const row of [kernelRow, routedRow]) {
    const world = await activated(t);
    world.row(threadId, 'a1', 'openui.answered/v1', row);

    const response = await world
      .questions()
      .status({ promptId: 'q1', questions: asked });

    assert.deepEqual(toJson(StatusResponseSchema, response), {
      questionState: {
        answered: {
          answers: [
            { id: 'db', options: ['Postgres'] },
            { id: 'notes', other: '' },
          ],
        },
      },
    });
  }
});

void test('R13: a no-break-space label and a label of 61 astral characters pass protovalidate but are invalid_input, and nothing is called', async (t) => {
  const world = await activated(t, running);
  const withLabel = (label: string): AskInput => ({
    questions: [
      {
        id: 'db',
        question: 'Which database?',
        options: [{ label }, { label: 'SQLite' }],
      },
    ],
  });

  for (const label of ['\u00a0', '\u{1F600}'.repeat(61)]) {
    const status = await failureOf(() =>
      world.questions().status({ promptId: 'q1', questions: withLabel(label) }),
    );
    const answered = await failureOf(() =>
      world.questions().answer({
        promptId: 'q1',
        questions: withLabel(label),
        answers: [{ id: 'db', options: ['SQLite'] }],
      }),
    );

    assert.equal(status.code, 'invalid_input');
    assert.equal(answered.code, 'invalid_input');
  }
  assert.deepEqual(world.calls, []);
});

void test('R14: an Append failing invalid_scope fails Answer with invalid_scope after the answers were sent', async (t) => {
  const world = await activated(t, (w) => {
    running(w);
    w.failures.append = new ContractError(
      'invalid_scope',
      'No sink serves this stream.',
    );
  });

  const error = await failureOf(() => answer(world));

  assert.equal(error.code, 'invalid_scope');
  assert.deepEqual(sent(world), ['threads.steer', 'events.append']);
  assert.deepEqual(
    world.log.filter(({ type }) => type === 'openui.answered/v1'),
    [],
  );
});
