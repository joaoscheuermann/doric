// R6–R14 (phase 3, S56): `openui.questions/v1` over the router keeps the
// kernel's question behaviour (conversation-openui.md D21, D22): the state is
// folded from the Thread's `openui.answered/v1` rows, the answer is sent by
// D20's route and recorded under the prompt that took it; requests are parsed
// again with today's zod schemas (D2), and a row the kernel wrote and one the
// routed append stored both read `answered` (D3).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  fromJson,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import { type CallScope, ContractError } from 'bundle/contracts';
import { ThreadEventSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

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

void test('S62b 16: Status reads every row of a log ThreadEvents cuts into pages of two', async (t) => {
  const world = await activated(t);
  for (let index = 0; index < 4; index += 1)
    world.row(threadId, 'p1', 'text.delta', { delta: `part ${index}` });
  world.row(threadId, 'a1', 'openui.answered/v1', {
    questionPromptId: 'q1',
    digest: digestOf(questions),
    answers: [{ id: 'db', options: ['Postgres'] }],
  });
  world.threadsAnswers.threadEvents = (request) => {
    const rows = world.log.filter((row) => row.threadId === request.id);
    return {
      threadEventLog: {
        events: rows
          .filter((row) => row.sequence > request.afterSequence)
          .slice(0, 2)
          .map((row) =>
            fromJson(ThreadEventSchema, row as unknown as JsonValue),
          ),
        lastSequence: rows.at(-1)?.sequence ?? 0,
      },
    };
  };

  const response = await world
    .questions()
    .status({ promptId: 'q1', questions });

  assert.deepEqual(toJson(StatusResponseSchema, response), {
    questionState: {
      answered: { answers: [{ id: 'db', options: ['Postgres'] }] },
    },
  });
  assert.deepEqual(
    world.callsOf('threads.threadEvents').map(({ request }) => request),
    [
      { id: threadId, afterSequence: 0 },
      { id: threadId, afterSequence: 2 },
      { id: threadId, afterSequence: 4 },
    ],
  );
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

// The kernel suite `questions.test.ts` (C5, C6), moved to the router world in
// S68c (X3): the cases R6–R14 do not already cover.

/** The question's prompt wrote its fence. */
const asked = (world: RouterWorld): void => {
  world.row(threadId, 'q1', 'text.delta', { text: '```openui-lang\n' });
};

const answeredBy =
  (promptId: string) =>
  (world: RouterWorld): void => {
    world.threadsAnswers.prompt = () => ({
      promptResult: { status: 'accepted', promptId },
    });
  };

const status = async (world: RouterWorld, promptId = 'q1') =>
  toJson(
    StatusResponseSchema,
    await world.questions().status({ promptId, questions }),
  );

const ANSWERED = {
  questionState: {
    answered: { answers: [{ id: 'db', options: ['Postgres'] }] },
  },
};
const PENDING = { questionState: { pending: {} } };

void test('C5: a scope without a Project or a Thread is invalid_scope for both methods, before any read', async (t) => {
  const world = await activated(t, asked);

  for (const scope of [{ threadId }, { projectId }] as CallScope[]) {
    const statusError = await failureOf(() =>
      world.questions(scope).status({ promptId: 'q1', questions }),
    );
    const answerError = await failureOf(() =>
      world
        .questions(scope)
        .answer({ promptId: 'q1', questions, answers: postgres }),
    );

    assert.equal(statusError.code, 'invalid_scope');
    assert.equal(answerError.code, 'invalid_scope');
  }
  assert.deepEqual(world.calls, []);
});

void test('C5: invalid questions are invalid_input for both methods', async (t) => {
  const world = await activated(t, asked);
  const oneOption = {
    questions: [{ id: 'db', question: 'Which?', options: [{ label: 'Only' }] }],
  } as unknown as AskInput;

  const statusError = await failureOf(() =>
    world.questions().status({ promptId: 'q1', questions: oneOption }),
  );
  const answerError = await failureOf(() =>
    world
      .questions()
      .answer({ promptId: 'q1', questions: oneOption, answers: [] }),
  );

  assert.equal(statusError.code, 'invalid_input');
  assert.equal(answerError.code, 'invalid_input');
  assert.deepEqual(world.calls, []);
});

void test("C5: answers that fail ask's checks are invalid_input", async (t) => {
  const world = await activated(t, asked);
  const failing: AskAnswer[][] = [
    [{ id: 'nope', options: ['Postgres'] }],
    [{ id: 'db', options: ['MySQL'] }],
    [{ id: 'db', options: ['Postgres', 'SQLite'] }],
    [],
  ];

  for (const answers of failing) {
    const error = await failureOf(() => answer(world, answers));
    assert.equal(error.code, 'invalid_input');
  }
  assert.deepEqual(sent(world), []);
});

void test('C5: a paused queue holding a resumable prompt is not resumed; the answer is prompted', async (t) => {
  const world = await activated(t, (w) => {
    asked(w);
    w.threadsAnswers.queue = () => ({
      threadQueue: {
        revision: 1,
        paused: true,
        stopping: false,
        items: [],
        resumable: {
          promptId: 'resumable-1',
          source: { kind: { case: 'user', value: {} } },
          label: 'You',
          preview: 'queued',
          acceptedAt: '2026-01-01T00:00:00.000Z',
          editable: true,
          revision: 1,
        },
      },
    });
  });

  await answer(world);

  assert.deepEqual(sent(world), ['threads.prompt', 'events.append']);
});

void test("C5: a refused prompt, a missing queue and a busy resume are unavailable with the runtime's status and write nothing", async (t) => {
  const cases: [string, (world: RouterWorld) => void][] = [
    [
      'inactive',
      (w) => {
        w.threadsAnswers.prompt = () => ({
          promptResult: { status: 'inactive' },
        });
      },
    ],
    [
      'missing',
      (w) => {
        w.threadsAnswers.queue = () => ({});
      },
    ],
    [
      'busy',
      (w) => {
        w.paused.set(threadId, true);
        w.threadsAnswers.resumeQueue = () => ({
          resumeResult: { status: 'busy' },
        });
      },
    ],
  ];

  for (const [expected, setup] of cases) {
    const world = await activated(t, (w) => {
      asked(w);
      setup(w);
    });

    const error = await failureOf(() => answer(world));

    assert.equal(error.code, 'unavailable', expected);
    assert.deepEqual(error.details, { status: expected });
    assert.deepEqual(world.callsOf('events.append'), []);
  }
});

void test('C5: a steer or a Thread read that rejects is unavailable with the reason', async (t) => {
  const cases: [RegExp, (world: RouterWorld) => void][] = [
    [
      /steer broke/,
      (w) => {
        running(w);
        w.threadsAnswers.steer = () => {
          throw new ContractError('unavailable', 'steer broke');
        };
      },
    ],
    [
      /thread broke/,
      (w) => {
        w.threadsAnswers.thread = () => {
          throw new ContractError('unavailable', 'thread broke');
        };
      },
    ],
  ];

  for (const [reason, setup] of cases) {
    const world = await activated(t, (w) => {
      asked(w);
      setup(w);
    });

    const error = await failureOf(() => answer(world));

    assert.equal(error.code, 'unavailable');
    assert.match(
      String((error.details as { reason?: unknown } | undefined)?.reason),
      reason,
    );
    assert.deepEqual(world.callsOf('events.append'), []);
  }
});

void test('C5: a rejected log read or append rejects with that error', async (t) => {
  const read = await activated(t, (w) => {
    asked(w);
    w.threadsAnswers.threadEvents = () => {
      throw new ContractError('unavailable', 'log unreadable');
    };
  });
  for (const call of [
    () => read.questions().status({ promptId: 'q1', questions }),
    () => answer(read),
  ]) {
    const error = await failureOf(call);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /log unreadable/);
  }

  const append = await activated(t, (w) => {
    asked(w);
    running(w);
    w.failures.append = new ContractError('unavailable', 'log full');
  });
  const error = await failureOf(() => answer(append));
  assert.equal(error.code, 'unavailable');
  assert.match(error.message, /log full/);
});

void test("C5: each runtime and events call carries the method's call scope", async (t) => {
  const world = await activated(t, (w) => {
    asked(w);
    running(w);
  });

  await world.questions().status({ promptId: 'q1', questions });
  await answer(world);

  assert.ok(world.calls.length >= 4);
  for (const call of world.calls) {
    assert.deepEqual(
      call.scope,
      call.method === 'events.append'
        ? { projectId, threadId, promptId: 'p-run' }
        : { projectId, threadId },
      call.method,
    );
  }
});

void test('C6: status is answered after a replay of the same log', async (t) => {
  const writer = await activated(t, asked);
  await answer(writer);

  const replay = await activated(t);
  replay.log.push(...writer.log);

  assert.deepEqual(await status(replay), ANSWERED);
});

void test("C6: a rewind of the answer's prompt, of a prompt between, or of the question's prompt gives pending", async (t) => {
  for (const rewound of ['a1', 'm1', 'q1']) {
    const world = await activated(t, (w) => {
      asked(w);
      w.row(threadId, 'm1', 'text.delta', { text: 'between' });
      answeredBy('a1')(w);
    });
    await answer(world);

    world.rewind(threadId, rewound);

    assert.deepEqual(await status(world), PENDING, rewound);
  }
});

void test('C6: a rewind of a prompt whose first row comes after the answered row leaves it answered', async (t) => {
  const world = await activated(t, (w) => {
    asked(w);
    answeredBy('a1')(w);
  });
  await answer(world);
  world.row(threadId, 'l1', 'text.delta', { text: 'later' });

  world.rewind(threadId, 'l1');

  assert.deepEqual(await status(world), ANSWERED);
});

void test('C6: the same questions of two prompts are two questions; two fences of one prompt share the answer', async (t) => {
  const world = await activated(t, (w) => {
    asked(w);
    w.row(threadId, 'q2', 'text.delta', { text: '```openui-lang\n' });
  });

  await answer(world);

  assert.deepEqual(await status(world, 'q2'), PENDING);
  assert.deepEqual(await status(world, 'q1'), ANSWERED);
});

void test('C6: a row that fails the event schema is skipped', async (t) => {
  const world = await activated(t, (w) => {
    asked(w);
    w.row(threadId, 'a0', 'openui.answered/v1', {
      questionPromptId: 'q1',
      digest: 'not-a-digest',
      answers: [{ id: 'db', options: ['Postgres'] }],
    });
  });

  assert.deepEqual(await status(world), PENDING);
});
