// C5, C6 and C9's schema case (conversation-openui.md D21, D22): the question
// service `openui.questions/v1` over a fake `runtime.threads/v1` whose log
// applies the runtime's rewind rule. A question is its prompt and the digest
// of its parsed questions; the answer is sent by D20's route and recorded as
// `openui.answered/v1` under the prompt that took it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';

import type { Call, CallScope } from 'bundle/contracts';
import {
  askAnswerSchema as threadsAskAnswerSchema,
  askInputSchema as threadsAskInputSchema,
} from 'threads/contracts';
import { z } from 'zod';

import {
  type AskAnswer,
  type AskInput,
  askAnswerSchema,
  askInputSchema,
  OpenuiQuestionsV1,
} from '../src/contracts/index.js';
import {
  activateHost,
  type HostWorld,
  otherProjectId,
  projectId,
  queueOf,
  threadRecord,
} from './support/host.js';

const threadId = 'thread-1';
const scope: CallScope = { projectId, threadId };

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

const postgres: readonly AskAnswer[] = [{ id: 'db', options: ['Postgres'] }];

/** The text `formatAnswers` gives for D21's example with Postgres chosen. */
const POSTGRES_TEXT =
  'Answers to your questions:\n\n1. Which database?\n   Postgres';

/** The question's digest: hex SHA-256 of the parsed questions' JSON. */
const digestOf = (input: AskInput): string =>
  createHash('sha256')
    .update(JSON.stringify(askInputSchema.parse(input)))
    .digest('hex');

const traceIdOf = (call: Call): string | undefined =>
  call.trace.traceparent.split('-')[1];

const worlds: HostWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.deactivate();
});

const start = async (thread = threadRecord(threadId)): Promise<HostWorld> => {
  const world = await activateHost();
  worlds.push(world);
  world.threads.set(thread.id, thread);
  // The question's prompt wrote its fence.
  world.row(threadId, 'q1', 'text.delta', { text: '```openui-lang\n' });
  return world;
};

const service = (world: HostWorld, at: CallScope = scope) =>
  world.test.services.use(OpenuiQuestionsV1, at);

const sent = (world: HostWorld) =>
  world.calls.filter(({ method }) =>
    ['steer', 'prompt', 'resumeQueue', 'append'].includes(method),
  );

const methods = (world: HostWorld) => world.calls.map(({ method }) => method);

test('C5: a scope without a Project or a Thread is invalid_scope for both methods, before any read', async () => {
  const world = await start();

  for (const at of [{ threadId }, { projectId }] as CallScope[]) {
    await assert.rejects(
      service(world, at).status({ promptId: 'q1', questions }),
      {
        code: 'invalid_scope',
      },
    );
    await assert.rejects(
      service(world, at).answer({
        promptId: 'q1',
        questions,
        answers: postgres,
      }),
      { code: 'invalid_scope' },
    );
  }

  assert.deepEqual(world.calls, []);
});

test('C5: invalid questions are invalid_input for both methods', async () => {
  const world = await start();
  const oneOption = {
    questions: [{ id: 'db', question: 'Which?', options: [{ label: 'Only' }] }],
  } as unknown as AskInput;

  await assert.rejects(
    async () => service(world).status({ promptId: 'q1', questions: oneOption }),
    {
      code: 'invalid_input',
    },
  );
  await assert.rejects(
    async () =>
      service(world).answer({
        promptId: 'q1',
        questions: oneOption,
        answers: [],
      }),
    { code: 'invalid_input' },
  );
  assert.deepEqual(world.calls, []);
});

test('C5: in an agent Thread answer is unavailable with status forbidden, and nothing is sent', async () => {
  const world = await start(threadRecord(threadId, { origin: 'agent' }));

  await assert.rejects(
    service(world).answer({ promptId: 'q1', questions, answers: postgres }),
    {
      code: 'unavailable',
      message: 'The Thread did not take the answers.',
      details: { status: 'forbidden' },
    },
  );
  assert.deepEqual(sent(world), []);
});

test('C5: a Thread that is undefined or of another Project is unavailable with status missing', async () => {
  for (const thread of [
    undefined,
    threadRecord(threadId, { projectId: otherProjectId }),
  ]) {
    const world = await start();
    world.threads.delete(threadId);
    if (thread !== undefined) world.threads.set(threadId, thread);

    await assert.rejects(
      service(world).answer({ promptId: 'q1', questions, answers: postgres }),
      { code: 'unavailable', details: { status: 'missing' } },
    );
    assert.deepEqual(sent(world), []);
  }
});

test("C5: answers that fail ask's checks are invalid_input", async () => {
  const world = await start();
  const failing: AskAnswer[][] = [
    [{ id: 'nope', options: ['Postgres'] }],
    [{ id: 'db', options: ['MySQL'] }],
    [{ id: 'db', options: ['Postgres', 'SQLite'] }],
    [],
  ];

  for (const answers of failing) {
    await assert.rejects(
      service(world).answer({ promptId: 'q1', questions, answers }),
      { code: 'invalid_input' },
    );
  }
  assert.deepEqual(sent(world), []);
});

test('C5: a valid answer steers the running prompt and is recorded under it', async () => {
  const world = await start(
    threadRecord(threadId, { activePromptId: 'run-1' }),
  );

  const state = await service(world).answer({
    promptId: 'q1',
    questions,
    answers: postgres,
  });

  assert.deepEqual(state, { state: 'answered', answers: postgres });
  const steer = world.calls.find(({ method }) => method === 'steer');
  assert.deepEqual(steer?.input, {
    id: threadId,
    prompt: POSTGRES_TEXT,
    promptId: 'run-1',
  });
  const append = world.calls.find(({ method }) => method === 'append');
  assert.deepEqual(append?.input, {
    type: 'openui.answered/v1',
    payload: {
      questionPromptId: 'q1',
      digest: digestOf(questions),
      answers: postgres,
    },
  });
  assert.deepEqual(append?.call.scope, {
    projectId,
    threadId,
    promptId: 'run-1',
  });
  assert.deepEqual(
    methods(world).filter((method) => method !== 'threadEvents'),
    ['thread', 'steer', 'append'],
  );
});

test('C5: with no running prompt it prompts, and records under the prompt that took the answers', async () => {
  const world = await start();
  world.answers.prompt = () => ({ status: 'accepted', promptId: 'a1' });

  await service(world).answer({ promptId: 'q1', questions, answers: postgres });

  assert.deepEqual(
    world.calls.find(({ method }) => method === 'prompt')?.input,
    {
      id: threadId,
      prompt: POSTGRES_TEXT,
    },
  );
  assert.equal(methods(world).includes('resumeQueue'), false);
  assert.deepEqual(
    world.calls.find(({ method }) => method === 'append')?.call.scope,
    {
      projectId,
      threadId,
      promptId: 'a1',
    },
  );
});

test('C5: a paused, empty queue is resumed before the prompt; one holding a resumable prompt is not', async () => {
  const resumed = await start();
  resumed.queues.set(threadId, queueOf({ paused: true }));
  await service(resumed).answer({
    promptId: 'q1',
    questions,
    answers: postgres,
  });
  const order = methods(resumed);
  assert.ok(order.indexOf('resumeQueue') >= 0);
  assert.ok(order.indexOf('resumeQueue') < order.indexOf('prompt'));

  const held = await start();
  held.queues.set(threadId, queueOf({ paused: true, resumable: true }));
  await service(held).answer({ promptId: 'q1', questions, answers: postgres });
  assert.equal(methods(held).includes('resumeQueue'), false);
  assert.equal(methods(held).includes('prompt'), true);
});

test('C5: a second answer returns the first, and two calls at once send once', async () => {
  const world = await start();
  const other: AskAnswer[] = [{ id: 'db', options: ['SQLite'] }];

  const [one, two] = await Promise.all([
    service(world).answer({ promptId: 'q1', questions, answers: postgres }),
    service(world).answer({ promptId: 'q1', questions, answers: other }),
  ]);
  const three = await service(world).answer({
    promptId: 'q1',
    questions,
    answers: other,
  });

  assert.deepEqual(one, { state: 'answered', answers: postgres });
  assert.deepEqual(two, { state: 'answered', answers: postgres });
  assert.deepEqual(three, { state: 'answered', answers: postgres });
  assert.equal(
    methods(world).filter((method) => method === 'prompt').length,
    1,
  );
  assert.equal(
    methods(world).filter((method) => method === 'append').length,
    1,
  );
});

test("C5: a refused route is unavailable with the runtime's status and writes nothing", async () => {
  const cases: {
    readonly thread: ReturnType<typeof threadRecord>;
    readonly set: (world: HostWorld) => void;
    readonly status: string;
  }[] = [
    {
      thread: threadRecord(threadId, { activePromptId: 'run-1' }),
      set: (world) => {
        world.answers.steer = () => ({ status: 'inactive' });
      },
      status: 'inactive',
    },
    {
      thread: threadRecord(threadId),
      set: (world) => {
        world.answers.prompt = () => ({ status: 'inactive' });
      },
      status: 'inactive',
    },
    {
      thread: threadRecord(threadId),
      set: (world) => {
        world.answers.queue = () => undefined;
      },
      status: 'missing',
    },
    {
      thread: threadRecord(threadId),
      set: (world) => {
        world.queues.set(threadId, queueOf({ paused: true }));
        world.answers.resumeQueue = () => ({ status: 'busy' });
      },
      status: 'busy',
    },
  ];

  for (const { thread, set, status } of cases) {
    const world = await start(thread);
    set(world);

    await assert.rejects(
      service(world).answer({ promptId: 'q1', questions, answers: postgres }),
      { code: 'unavailable', details: { status } },
    );
    assert.equal(methods(world).includes('append'), false);
  }
});

test('C5: a steer, prompt or thread that rejects is unavailable with the reason', async () => {
  const cases: {
    readonly thread: ReturnType<typeof threadRecord>;
    readonly set: (world: HostWorld) => void;
  }[] = [
    {
      thread: threadRecord(threadId, { activePromptId: 'run-1' }),
      set: (world) => {
        world.answers.steer = () => {
          throw new Error('steer broke');
        };
      },
    },
    {
      thread: threadRecord(threadId),
      set: (world) => {
        world.answers.prompt = () => {
          throw new Error('prompt broke');
        };
      },
    },
    {
      thread: threadRecord(threadId),
      set: (world) => {
        world.answers.thread = () => {
          throw new Error('thread broke');
        };
      },
    },
  ];
  const reasons: string[] = [];

  for (const { thread, set } of cases) {
    const world = await start(thread);
    set(world);
    await assert.rejects(
      service(world).answer({ promptId: 'q1', questions, answers: postgres }),
      (error: { code?: string; details?: { reason?: string } }) => {
        assert.equal(error.code, 'unavailable');
        reasons.push(error.details?.reason ?? '');
        return true;
      },
    );
    assert.equal(methods(world).includes('append'), false);
  }

  assert.equal(reasons.length, 3);
  assert.match(reasons[0] ?? '', /steer broke/);
  assert.match(reasons[1] ?? '', /prompt broke/);
  assert.match(reasons[2] ?? '', /thread broke/);
});

test('C5: a rejected log read or append rejects with that error', async () => {
  const read = await start();
  read.answers.threadEvents = () => {
    throw new Error('log unreadable');
  };
  await assert.rejects(
    service(read).status({ promptId: 'q1', questions }),
    /log unreadable/,
  );
  await assert.rejects(
    service(read).answer({ promptId: 'q1', questions, answers: postgres }),
    /log unreadable/,
  );

  const append = await start();
  append.answers.append = () => {
    throw new Error('log full');
  };
  await assert.rejects(
    service(append).answer({ promptId: 'q1', questions, answers: postgres }),
    /log full/,
  );
});

test("C5: each runtime and events call carries the method's call", async () => {
  const world = await start(
    threadRecord(threadId, { activePromptId: 'run-1' }),
  );
  const call = world.call(scope);

  await service(world).status({ promptId: 'q1', questions }, call);
  await service(world).answer(
    { promptId: 'q1', questions, answers: postgres },
    call,
  );

  assert.ok(world.calls.length >= 4);
  for (const recorded of world.calls) {
    assert.equal(traceIdOf(recorded.call), traceIdOf(call), recorded.method);
  }
});

test('C6: status is answered after a replay of the same log', async () => {
  const world = await start();
  await service(world).answer({ promptId: 'q1', questions, answers: postgres });

  const replay = await activateHost();
  worlds.push(replay);
  replay.threads.set(threadId, threadRecord(threadId));
  replay.log.push(...world.log);

  assert.deepEqual(
    await service(replay).status({ promptId: 'q1', questions }),
    {
      state: 'answered',
      answers: postgres,
    },
  );
});

test("C6: a rewind of the answer's prompt, of a prompt between, or of the question's prompt gives pending", async () => {
  for (const rewound of ['a1', 'm1', 'q1']) {
    const world = await start();
    world.row(threadId, 'm1', 'text.delta', { text: 'between' });
    world.answers.prompt = () => ({ status: 'accepted', promptId: 'a1' });
    await service(world).answer({
      promptId: 'q1',
      questions,
      answers: postgres,
    });

    world.rewind(threadId, rewound);

    assert.deepEqual(
      await service(world).status({ promptId: 'q1', questions }),
      { state: 'pending' },
      rewound,
    );
  }
});

test('C6: a rewind of a prompt whose first row comes after the answered row leaves it answered', async () => {
  const world = await start();
  world.answers.prompt = () => ({ status: 'accepted', promptId: 'a1' });
  await service(world).answer({ promptId: 'q1', questions, answers: postgres });
  world.row(threadId, 'l1', 'text.delta', { text: 'later' });

  world.rewind(threadId, 'l1');

  assert.deepEqual(await service(world).status({ promptId: 'q1', questions }), {
    state: 'answered',
    answers: postgres,
  });
});

test('C6: the same questions of two prompts are two questions; two fences of one prompt share the answer', async () => {
  const world = await start();
  world.row(threadId, 'q2', 'text.delta', { text: '```openui-lang\n' });

  await service(world).answer({ promptId: 'q1', questions, answers: postgres });

  assert.deepEqual(await service(world).status({ promptId: 'q2', questions }), {
    state: 'pending',
  });
  assert.deepEqual(await service(world).status({ promptId: 'q1', questions }), {
    state: 'answered',
    answers: postgres,
  });
});

test('C6: a row that fails the event schema is skipped', async () => {
  const world = await start();
  world.row(threadId, 'a0', 'openui.answered/v1', {
    questionPromptId: 'q1',
    digest: 'not-a-digest',
    answers: postgres,
  });

  assert.deepEqual(await service(world).status({ promptId: 'q1', questions }), {
    state: 'pending',
  });
});

test("C9: openui's askInputSchema and askAnswerSchema give the JSON Schema of threads'", () => {
  assert.deepEqual(
    z.toJSONSchema(askInputSchema),
    z.toJSONSchema(threadsAskInputSchema),
  );
  assert.deepEqual(
    z.toJSONSchema(askAnswerSchema),
    z.toJSONSchema(threadsAskAnswerSchema),
  );
});
