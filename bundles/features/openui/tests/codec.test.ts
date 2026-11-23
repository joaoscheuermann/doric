// C1–C2 (phase 3, S56): the codec of `openui`'s host part as a process. A
// routed request decodes to today's domain value with the kernel's key order
// and presence, so the questions' digest is the kernel's (D2); the question
// state and the hook input convert both ways the contracts state.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  create,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import type { InputSourceSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import {
  AskInputSchema,
  QuestionStateSchema,
  StatusRequestSchema,
} from '../src/contracts/gen/doric/openui/questions/v1/questions_pb.js';
import { type AskInput, askInputSchema } from '../src/contracts/index.js';
import {
  promptStartedOf,
  questionRefOf,
  questionStateMessageOf,
} from '../src/host/codec.js';

/** The kernel's digest: hex SHA-256 of the zod-parsed questions' JSON. */
const kernelDigestOf = (input: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(askInputSchema.parse(input)))
    .digest('hex');

const digestOf = (questions: AskInput): string =>
  createHash('sha256').update(JSON.stringify(questions)).digest('hex');

void test('C1: questionRefOf of a request built from an AskInput whose keys are out of order gives the kernel’s value and digest', () => {
  // Keys deliberately in another order than the schema's, optional fields set and unset.
  const domain = {
    questions: [
      {
        allowOther: true,
        options: [
          { recommended: true, description: 'Relational', label: 'Postgres' },
          { label: 'SQLite' },
        ],
        question: 'Which database?',
        multiSelect: false,
        id: 'db',
      },
      {
        options: [{ label: 'Yes' }, { description: 'Not now', label: 'No' }],
        id: 'ship',
        question: 'Ship today?',
      },
    ],
    context: 'The service needs a database.',
  };
  const request = create(StatusRequestSchema, {
    promptId: 'q1',
    questions: fromJson(AskInputSchema, domain as unknown as JsonValue),
  });

  const ref = questionRefOf(request);

  assert.equal(ref.promptId, 'q1');
  assert.deepEqual(ref.questions, askInputSchema.parse(domain));
  assert.equal(digestOf(ref.questions), kernelDigestOf(domain));
});

void test('C2: questionStateMessageOf gives the pending and the answered case', () => {
  const asJson = (state: Parameters<typeof questionStateMessageOf>[0]) =>
    toJson(
      QuestionStateSchema,
      create(QuestionStateSchema, questionStateMessageOf(state)),
    );

  assert.deepEqual(asJson({ state: 'pending' }), { pending: {} });
  assert.deepEqual(
    asJson({
      state: 'answered',
      answers: [
        { id: 'db', options: ['Postgres'] },
        { id: 'notes', options: [], other: 'Later' },
      ],
    }),
    {
      answered: {
        answers: [
          { id: 'db', options: ['Postgres'] },
          { id: 'notes', other: 'Later' },
        ],
      },
    },
  );
});

void test('C2: promptStartedOf reads each InputSource case as today’s InputSource, and a source with no case is invalid_input', () => {
  const inputOf = (source: MessageInitShape<typeof InputSourceSchema>) =>
    create(OnPromptStartedHookInputSchema, {
      projectId: 'project-1',
      threadId: 'thread-1',
      promptId: 'p1',
      source,
      cwd: '/workspace',
    });
  const cases: [MessageInitShape<typeof InputSourceSchema>, unknown][] = [
    [{ kind: { case: 'user', value: {} } }, { kind: 'user' }],
    [
      {
        kind: { case: 'terminal', value: { terminalId: 't1', promptId: 'p0' } },
      },
      { kind: 'terminal', terminalId: 't1', promptId: 'p0' },
    ],
    [
      {
        kind: {
          case: 'parent',
          value: { threadId: 'thread-0', promptId: 'p0' },
        },
      },
      { kind: 'parent', threadId: 'thread-0', promptId: 'p0' },
    ],
    [
      {
        kind: {
          case: 'result',
          value: {
            threadId: 'thread-2',
            promptId: 'p2',
            requestPromptId: 'p0',
          },
        },
      },
      {
        kind: 'result',
        threadId: 'thread-2',
        promptId: 'p2',
        requestPromptId: 'p0',
      },
    ],
    [
      {
        kind: {
          case: 'bundle',
          value: { bundleId: 'openui', reason: 'validation' },
        },
      },
      { kind: 'bundle', bundleId: 'openui', reason: 'validation' },
    ],
    [
      {
        kind: {
          case: 'bundle',
          value: { bundleId: 'git', reason: 'status', retain: true },
        },
      },
      { kind: 'bundle', bundleId: 'git', reason: 'status', retain: true },
    ],
  ];

  for (const [source, expected] of cases) {
    assert.deepEqual(promptStartedOf(inputOf(source)), {
      threadId: 'thread-1',
      promptId: 'p1',
      source: expected,
    });
  }
  assert.throws(() => promptStartedOf(inputOf({})), { code: 'invalid_input' });
});
