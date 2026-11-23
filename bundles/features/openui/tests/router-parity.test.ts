// P2 (phase 3, S56, D1): one scripted session — a closed report, an
// unterminated report, a prompt start and an answer — run on the kernel host
// (`HostWorld`) and on the host part as a process (the router world) gives the
// same instruct texts, the same answer text sent to the Thread and the same
// stored `openui.answered/v1` row. (P1 is the existing kernel tests passing
// unchanged.)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AskAnswer,
  type AskInput,
  OpenuiProgramsV1,
  OpenuiQuestionsV1,
  type ProgramErrorsInput,
} from '../src/contracts/index.js';
import { activateHost, threadRecord } from './support/host.js';
import {
  projectId,
  routerWorld,
  sleep,
  threadId,
  windowScope,
} from './support/router.js';

const questions: AskInput = {
  context: 'The service needs a database.',
  questions: [
    {
      id: 'db',
      question: 'Which database?',
      options: [
        { label: 'Postgres', recommended: true },
        { label: 'SQLite', description: 'One file, no server' },
      ],
      allowOther: true,
    },
  ],
};

const answers: AskAnswer[] = [
  { id: 'db', options: ['Postgres'], other: 'with backups\nnightly' },
];

const closed = {
  tag: 'openui-lang',
  key: 'p1/97/0',
  identity: 'a',
  revision: 1,
  state: 'closed',
  errors: [{ code: 'excess-args', statementId: 'b' }],
} satisfies ProgramErrorsInput;

const unterminated = {
  tag: 'papercraft',
  key: 'p1/98/0',
  identity: 'b',
  revision: 2,
  state: 'unterminated',
  errors: [{ code: 'runtime-error', message: 'OpenUrl is disabled' }],
} satisfies ProgramErrorsInput;

/** What the session sent and stored. */
interface Session {
  readonly instructs: readonly string[];
  readonly sent: readonly string[];
  readonly row: unknown;
}

const kernelSession = async (t: test.TestContext): Promise<Session> => {
  const world = await activateHost();
  t.after(() => world.deactivate());
  world.threads.set(threadId, threadRecord(threadId, { activePromptId: 'p2' }));
  const programs = world.test.services.use(OpenuiProgramsV1, windowScope);

  await world.promptStarted(threadId, 'p1');
  await programs.reportErrors(closed);
  await sleep(300);
  await programs.reportErrors(unterminated);
  await world.promptStarted(threadId, 'p2');
  await world.test.services
    .use(OpenuiQuestionsV1, windowScope)
    .answer({ promptId: 'q1', questions, answers });

  return {
    instructs: world.instructs.map(({ input }) => input.prompt),
    sent: world.calls
      .filter(({ method }) => method === 'steer')
      .map(({ input }) => (input as { prompt: string }).prompt),
    row: world.log.find(({ type }) => type === 'openui.answered/v1')?.event,
  };
};

const routedSession = async (t: test.TestContext): Promise<Session> => {
  const world = routerWorld();
  t.after(() => world.stop());
  world.threads.set(threadId, { projectId, activePromptId: 'p2' });
  await world.activate();

  await world.promptStarted(threadId, 'p1');
  await world.programs().reportErrors(closed);
  await sleep(300);
  await world.programs().reportErrors(unterminated);
  await world.promptStarted(threadId, 'p2');
  await world.questions().answer({ promptId: 'q1', questions, answers });

  return {
    instructs: world
      .callsOf('threads.instruct')
      .map(({ request }) => (request as { prompt: string }).prompt),
    sent: world
      .callsOf('threads.steer')
      .map(({ request }) => (request as { prompt: string }).prompt),
    row: world.log.find(({ type }) => type === 'openui.answered/v1')?.event,
  };
};

void test('P2: the kernel host and the routed host part give equal instruct texts, sent answer text and stored row for one session', async (t) => {
  const kernel = await kernelSession(t);
  const routed = await routedSession(t);

  assert.equal(kernel.instructs.length, 2);
  assert.equal(kernel.sent.length, 1);
  assert.notEqual(kernel.row, undefined);
  assert.deepEqual(routed, kernel);
});
