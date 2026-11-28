// The cases of the protocol conformance suite (spec
// `docs/designs/grpc-processes.md`, section 10, "Protocol conformance across
// SDKs"), registered by `runConformance`, which imports this module only when
// it runs: `node:test`, the HTTP/2 server and the router's constants stay out
// of every bundle that imports `bundle/testing`.
//
// Each case plays the router: it serves `BundleHostService/Connect` on a
// loopback port of its own, spawns one fixture process with the spawn
// environment of section 7, drives the control frames and checks the answers.

import assert from 'node:assert/strict';
import { describe, type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  create,
  fromBinary,
  type JsonObject,
  toBinary,
} from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';

import {
  ConformanceService,
  CountRequestSchema,
  CountResponseSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  FailRequestSchema,
  FailResponseSchema,
  FreezeRequestSchema,
  SumRequestSchema,
  SumResponseSchema,
  WaitRequestSchema,
  WaitResponseSchema,
} from '../../contracts/gen/doric/conformance/v1/conformance_pb.js';
import { ConnectRequestSchema } from '../../contracts/gen/doric/platform/v1/control_pb.js';
import { StatusSchema } from '../../contracts/gen/google/rpc/status_pb.js';
import { fromStatus } from '../../contracts/status.js';
import {
  maxMessageBytes,
  protocolVersion,
} from '../../platform/router/control.js';
import { timings } from '../../platform/supervisor/timings.js';
import type { ConformanceOptions } from './index.js';
import {
  assertStatus,
  caller,
  codeOk,
  describeExit,
  encode,
  isCase,
  methodOf,
  Session,
  traceparent,
} from './session.js';

// ---------------------------------------------------------------------------
// Values every case uses

/** The instance every fixture process is spawned as. */
const fixtureInstance = {
  bundleId: 'conformance.fixture',
  version: '1.0.0',
  generation: 3,
  incarnation: 2,
} as const;
const helloInstance = {
  bundleId: fixtureInstance.bundleId,
  generation: fixtureInstance.generation,
  incarnation: fixtureInstance.incarnation,
};

/** The messages of each streamed case, and the number of `Echo` calls. */
const messageCount = 1_000;
/** Response credit the streamed case grants at a time, once it is spent. */
const creditStep = 7;
/** How long the streamed case waits, with the credit spent, before granting. */
const creditDelayMs = 2;
/** How long a case waits for an exit that has no deadline of its own. */
const exitTimeoutMs = 5_000;
/** Each case's `node:test` timeout. */
const caseTimeoutMs = 60_000;
/** Processes alive at once: one per running case. */
const concurrency = 4;

/**
 * The encoded size of the `ConnectRequest` frame that carries `payload` as
 * the `CallMessage` of `callId`: the size the 4 MiB limit of a frame counts.
 */
const callMessageFrameBytes = (callId: bigint, payload: Uint8Array): number =>
  toBinary(
    ConnectRequestSchema,
    create(ConnectRequestSchema, {
      frame: { case: 'callMessage', value: { callId, payload } },
    }),
  ).length;

/** The encoded `EchoResponse` that `Echo` answers to `text` and `padBytes`. */
const echoResponse = (text: string, padBytes: number): Uint8Array =>
  encode(EchoResponseSchema, { text, padding: new Uint8Array(padBytes) });

/**
 * The largest `pad_bytes` whose `Echo` response to `text`, sent as the
 * `CallMessage` of `callId`, makes a frame of at most
 * {@link maxMessageBytes}; one more byte of padding makes it pass the limit.
 */
const largestFittingPad = (callId: bigint, text: string): number => {
  const frameBytes = (padBytes: number): number =>
    callMessageFrameBytes(callId, echoResponse(text, padBytes));
  let padBytes = maxMessageBytes;

  for (
    let over = frameBytes(padBytes) - maxMessageBytes;
    over > 0;
    over = frameBytes(padBytes) - maxMessageBytes
  ) {
    padBytes -= over;
  }

  // A shorter length varint can leave room for more padding.
  while (frameBytes(padBytes + 1) <= maxMessageBytes) {
    padBytes += 1;
  }

  return padBytes;
};

/** Runs one case: opens a session, runs `body`, closes it in all outcomes. */
const runCase = async (
  t: TestContext,
  options: ConformanceOptions,
  body: (session: Session) => Promise<void>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> => {
  const session = await Session.open(options, extraEnv, fixtureInstance);

  try {
    await body(session);
    assert.deepEqual(session.violations, [], 'protocol violations');
  } catch (error) {
    t.diagnostic(`fixture output:\n${session.outputTail}`);
    throw error;
  } finally {
    await session.close();
  }
};

// ---------------------------------------------------------------------------
// The cases

/** One code of each family of the error table, with its gRPC code. */
const errorFamilies: readonly (readonly [string, Code])[] = [
  ['invalid_input', Code.InvalidArgument],
  ['invalid_instance_token', Code.Unauthenticated],
  ['not_owner', Code.PermissionDenied],
  ['not_found', Code.NotFound],
  ['registration_conflict', Code.AlreadyExists],
  ['revision_conflict', Code.Aborted],
  ['limit_exceeded', Code.ResourceExhausted],
  ['unknown_contract', Code.Unimplemented],
  ['unavailable', Code.Unavailable],
  ['internal', Code.Internal],
  // a bundle's own code: no row, so the default
  ['conformance_refused', Code.FailedPrecondition],
];

/** A case: its name and its body against an open session. */
interface Case {
  readonly name: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run: (session: Session, t: TestContext) => Promise<void>;
}

const cases: readonly Case[] = [
  // The longest cases first, so they overlap the others.
  {
    name: 'a Hello never answered ends with exit code 70 within the Hello timeout and one second',
    run: async (session) => {
      await session.frame('hello', 'Hello');

      const exit = await session.exitWithin(
        timings.helloTimeoutMs + exitTimeoutMs,
        'after its Hello was never answered',
      );
      const elapsedMs = exit.atMs - session.spawnedAt;

      assert.equal(exit.code, 70, describeExit(exit));
      assert.ok(
        elapsedMs <= timings.helloTimeoutMs + 1_000,
        `exited ${Math.round(elapsedMs)} ms after its spawn`,
      );
    },
  },
  {
    name: 'no HealthReply after Freeze, the case the router quarantines',
    run: async (session) => {
      await session.ready();
      session.send({ frame: { case: 'healthCheck', value: { nonce: 1n } } });
      await session.frame(
        'healthReply',
        'HealthReply 1',
        (reply) => reply.nonce === 1n,
      );
      session.startCall({
        method: methodOf('Freeze'),
        kind: 'unary',
        payload: encode(FreezeRequestSchema, {}),
      });
      session.send({ frame: { case: 'healthCheck', value: { nonce: 2n } } });
      await sleep(timings.healthTimeoutMs);

      assert.equal(
        session.frames.some(
          (frame) => isCase(frame, 'healthReply') && frame.value.nonce === 2n,
        ),
        false,
        'a HealthReply arrived after Freeze',
      );
      assert.equal(session.exited, undefined, 'the frozen process exited');
    },
  },
  {
    name: 'Hello carries the token and the instance',
    run: async (session) => {
      const hello = await session.accept();

      assert.equal(session.frames[0]?.case, 'hello', 'the first frame');
      assert.equal(session.authorization, `Bearer ${session.token}`);
      assert.equal(hello.protocolVersion, protocolVersion);
      assert.deepEqual(
        {
          bundleId: hello.instance?.bundleId,
          generation: hello.instance?.generation,
          incarnation: hello.instance?.incarnation,
        },
        helloInstance,
      );
      assert.ok(
        hello.services.includes(ConformanceService.typeName),
        `services ${hello.services.join(', ')}`,
      );
      assert.equal(hello.httpPort, 0);
    },
  },
  {
    name: 'a refused Hello ends with exit code 70',
    run: async (session) => {
      await session.frame('hello', 'Hello');
      session.send({
        frame: {
          case: 'rejected',
          value: {
            reason: 'hello_mismatch',
            message: 'The conformance suite refuses this Hello.',
          },
        },
      });
      session.endStream();

      const exit = await session.exitWithin(
        exitTimeoutMs,
        'after its Hello was refused',
      );

      assert.equal(exit.code, 70, describeExit(exit));
    },
  },
  {
    name: 'the end of the control stream after Accepted ends with exit code 70',
    run: async (session) => {
      await session.accept();
      session.endStream();

      const exit = await session.exitWithin(
        exitTimeoutMs,
        'after its control stream ended',
      );

      assert.equal(exit.code, 70, describeExit(exit));
    },
  },
  {
    name: 'one HealthReply with the nonce per HealthCheck',
    run: async (session) => {
      const nonces = [1n, 2n, 2n ** 64n - 1n, 42n, 2n ** 53n + 3n];
      const last = 7n;

      await session.ready();

      for (const nonce of [...nonces, last]) {
        session.send({ frame: { case: 'healthCheck', value: { nonce } } });
      }

      // Replies come in order, so once the last one arrived every one has.
      await session.frame(
        'healthReply',
        'the last HealthReply',
        (reply) => reply.nonce === last,
      );

      const replies = session.frames.flatMap((frame) =>
        isCase(frame, 'healthReply') ? [frame.value.nonce] : [],
      );

      assert.deepEqual(replies, [...nonces, last]);
    },
  },
  {
    name: 'activation succeeds',
    run: async (session) => {
      await session.accept();
      assertStatus(await session.activate(), codeOk, 'ActivateResult');
    },
  },
  {
    name: 'activation fails under DORIC_CONFORMANCE_ACTIVATE=fail',
    env: { DORIC_CONFORMANCE_ACTIVATE: 'fail' },
    run: async (session) => {
      await session.accept();

      const status = await session.activate();

      assert.notEqual(status.code, codeOk, 'the ActivateResult code');

      // The process keeps running until Stop.
      session.send({ frame: { case: 'healthCheck', value: { nonce: 1n } } });
      await session.frame('healthReply', 'HealthReply after the failure');
    },
  },
  {
    name: `unary Echo, ${messageCount} calls`,
    run: async (session) => {
      await session.ready();

      const callIds = Array.from({ length: messageCount }, (_, index) =>
        session.startCall({
          method: methodOf('Echo'),
          kind: 'unary',
          payload: encode(EchoRequestSchema, { text: `echo ${index}` }),
        }),
      );
      const calls = await session.waitFor(
        () => {
          const records = callIds.map((callId) => session.call(callId));

          return records.every((call) => call.end !== undefined)
            ? records
            : undefined;
        },
        `the CallEnds of ${messageCount} Echo calls`,
        caseTimeoutMs / 2,
      );

      assert.deepEqual(
        calls.map((call) => call.end?.code),
        callIds.map(() => codeOk),
        'the codes of the Echo calls',
      );
      assert.deepEqual(
        calls.map((call) =>
          call.messages.map(
            (payload) => fromBinary(EchoResponseSchema, payload).text,
          ),
        ),
        callIds.map((_, index) => [`echo ${index}`]),
        'the responses of the Echo calls',
      );
    },
  },
  {
    name: `server-streaming Count, ${messageCount} messages, credit granted slowly`,
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: methodOf('Count'),
        kind: 'server_stream',
        payload: encode(CountRequestSchema, { n: messageCount }),
      });
      const call = session.call(callId);

      while (call.end === undefined) {
        await session.waitFor(
          () =>
            call.end !== undefined || call.messages.length >= call.allowance
              ? true
              : undefined,
          'Count messages up to the credit',
        );

        if (call.end === undefined) {
          // The credit is spent: nothing more may arrive before the grant.
          await sleep(creditDelayMs);
          session.grant(callId, creditStep);
        }
      }

      assertStatus(call.end, codeOk, 'Count');
      assert.deepEqual(
        call.messages.map(
          (payload) => fromBinary(CountResponseSchema, payload).index,
        ),
        Array.from({ length: messageCount }, (_, index) => index),
      );
    },
  },
  {
    name: `client-streaming Sum, ${messageCount} messages within the bundle's credit`,
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: methodOf('Sum'),
        kind: 'client_stream',
      });
      const call = session.call(callId);
      let sent = 0;
      let total = 0;

      while (sent < messageCount) {
        await session.waitFor(
          () => (sent < call.requestCredit ? true : undefined),
          `request credit beyond ${sent} Sum messages`,
        );

        while (sent < call.requestCredit && sent < messageCount) {
          session.send({
            frame: {
              case: 'callMessage',
              value: {
                callId,
                payload: encode(SumRequestSchema, { value: sent }),
              },
            },
          });
          total += sent;
          sent += 1;
        }
      }

      session.send({ frame: { case: 'callHalfClose', value: { callId } } });

      const ended = await session.ended(callId, 'Sum');

      assertStatus(ended.end ?? create(StatusSchema), codeOk, 'Sum');
      assert.deepEqual(
        ended.messages.map((payload) => {
          const response = fromBinary(SumResponseSchema, payload);

          return { total: response.total, count: response.count };
        }),
        [{ total, count: messageCount }],
      );
    },
  },
  {
    name: 'Fail with each family of the error table',
    run: async (session, t) => {
      await session.ready();

      for (const [code, grpcCode] of errorFamilies) {
        await t.test(code, async () => {
          const message = `The fixture fails with ${code}.`;
          const details: JsonObject | undefined =
            grpcCode === Code.FailedPrecondition
              ? undefined
              : { family: code, nested: { list: [1, 'two', true, null] } };
          const { status, responses } = await session.unary(
            'Fail',
            FailRequestSchema,
            { code, message, ...(details === undefined ? {} : { details }) },
            FailResponseSchema,
          );
          const error = fromStatus(status);

          assert.equal(responses.length, 0, 'no response message');
          assertStatus(status, grpcCode, `Fail ${code}`);
          assert.equal(status.message, message);
          assert.deepEqual(
            {
              code: error.code,
              message: error.message,
              details: error.details,
            },
            { code, message, details },
          );
        });
      }
    },
  },
  {
    name: 'cancellation seen by the handler, then CallEnd CANCELLED',
    run: async (session) => {
      const scope = { windowKey: 'window-1', thread: 'thread-9' };

      await session.ready();

      const callId = session.startCall({
        method: methodOf('Wait'),
        kind: 'unary',
        payload: encode(WaitRequestSchema, { key: 'cancel', holdMs: 0 }),
        scope,
      });

      await session.waitStarted('cancel');
      session.send({
        frame: { case: 'callCancel', value: { callId, reason: 'cancelled' } },
      });

      const call = await session.ended(callId, 'the cancelled Wait');

      assertStatus(call.end ?? create(StatusSchema), Code.Canceled, 'Wait');
      assert.equal(call.messages.length, 0, 'no response message');

      const seen = await session.observed('cancel');

      assert.deepEqual(
        {
          cancelled: seen.cancelled,
          answered: seen.answered,
          callerBundleId: seen.callerBundleId,
          callerVersion: seen.callerVersion,
          callerGeneration: seen.callerGeneration,
          scope: { ...seen.scope },
          traceparent: seen.traceparent,
          deadlineUnixMs: seen.deadlineUnixMs,
        },
        {
          cancelled: true,
          answered: false,
          callerBundleId: caller.bundleId,
          callerVersion: caller.version,
          callerGeneration: caller.generation,
          scope,
          traceparent,
          deadlineUnixMs: 0,
        },
      );
    },
  },
  {
    name: 'deadline seen by the handler, then CallEnd CANCELLED',
    run: async (session) => {
      await session.ready();

      const deadlineUnixMs = Date.now() + 500;
      const callId = session.startCall({
        method: methodOf('Wait'),
        kind: 'unary',
        payload: encode(WaitRequestSchema, { key: 'deadline', holdMs: 0 }),
        deadlineUnixMs,
      });

      await session.waitStarted('deadline');

      // As the router does, at the deadline.
      const timer = setTimeout(
        () =>
          session.send({
            frame: {
              case: 'callCancel',
              value: { callId, reason: 'deadline' },
            },
          }),
        Math.max(0, deadlineUnixMs - Date.now()),
      );

      try {
        const call = await session.ended(callId, 'the Wait past its deadline');

        assertStatus(call.end ?? create(StatusSchema), Code.Canceled, 'Wait');
        assert.equal(call.messages.length, 0, 'no response message');
      } finally {
        clearTimeout(timer);
      }

      const seen = await session.observed('deadline');

      assert.deepEqual(
        {
          cancelled: seen.cancelled,
          answered: seen.answered,
          deadlineUnixMs: seen.deadlineUnixMs,
        },
        { cancelled: true, answered: false, deadlineUnixMs },
      );
    },
  },
  {
    name: 'GenerationChanged draining acknowledged while a call in flight finishes',
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: methodOf('Wait'),
        kind: 'unary',
        payload: encode(WaitRequestSchema, { key: 'drain', holdMs: 1_000 }),
      });

      await session.waitStarted('drain');
      session.send({
        frame: {
          case: 'generationChanged',
          value: {
            event: 'draining',
            subject: helloInstance,
            live: [{ instance: helloInstance, state: 'draining' }],
          },
        },
      });

      const ack = await session.frame('generationAck', 'GenerationAck');

      assert.equal(ack.event, 'draining');

      const call = await session.ended(callId, 'the draining Wait');
      const ackAt = session.frames.findIndex((frame) =>
        isCase(frame, 'generationAck'),
      );
      const endAt = session.frames.findIndex(
        (frame) => isCase(frame, 'callEnd') && frame.value.callId === callId,
      );

      assert.ok(ackAt < endAt, 'the GenerationAck came before the CallEnd');
      assertStatus(call.end ?? create(StatusSchema), codeOk, 'Wait');
      assert.deepEqual(
        call.messages.map(
          (payload) => fromBinary(WaitResponseSchema, payload).key,
        ),
        ['drain'],
      );

      const seen = await session.observed('drain');

      assert.deepEqual(
        { cancelled: seen.cancelled, answered: seen.answered },
        { cancelled: false, answered: true },
      );
    },
  },
  {
    name: 'Stop answered, then exit code 0 within the stop deadline',
    run: async (session) => {
      await session.ready();
      session.send({ frame: { case: 'stop', value: {} } });

      const sentAt = performance.now();

      await session.frame('stopResult', 'StopResult');

      const exit = await session.exitWithin(
        timings.stopTimeoutMs + exitTimeoutMs,
        'after Stop',
      );

      assert.equal(exit.code, 0, describeExit(exit));
      assert.ok(
        exit.atMs - sentAt <= timings.stopTimeoutMs,
        `exited ${Math.round(exit.atMs - sentAt)} ms after Stop`,
      );
    },
  },
  {
    name: 'an unregistered method answered UNIMPLEMENTED',
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: '/doric.conformance.v1.UnregisteredService/Echo',
        kind: 'unary',
        payload: encode(EchoRequestSchema, { text: 'nobody' }),
      });
      const call = await session.ended(callId, 'the unregistered method');

      assertStatus(
        call.end ?? create(StatusSchema),
        Code.Unimplemented,
        'the unregistered method',
      );
      assert.equal(call.messages.length, 0, 'no response message');
    },
  },
  {
    name: 'an Echo response over 4 MiB ended with RESOURCE_EXHAUSTED, limit_exceeded',
    run: async (session) => {
      await session.ready();

      const { status, responses } = await session.unary(
        'Echo',
        EchoRequestSchema,
        { text: 'large', padBytes: maxMessageBytes },
        EchoResponseSchema,
      );

      assert.equal(responses.length, 0, 'no response message');
      assertStatus(status, Code.ResourceExhausted, 'Echo over 4 MiB');
      assert.equal(fromStatus(status).code, 'limit_exceeded');
    },
  },
  {
    name: 'an Echo response within 4 MiB whose frame passes 4 MiB ended with limit_exceeded, the instance still serving',
    run: async (session) => {
      await session.ready();

      const text = 'frame over';
      const callId = session.nextCall;
      const padBytes = largestFittingPad(callId, text) + 1;

      assert.ok(
        echoResponse(text, padBytes).length <= maxMessageBytes,
        'the response fits 4 MiB',
      );
      assert.ok(
        callMessageFrameBytes(callId, echoResponse(text, padBytes)) >
          maxMessageBytes,
        'its frame passes 4 MiB',
      );

      const { status, responses } = await session.unary(
        'Echo',
        EchoRequestSchema,
        { text, padBytes },
        EchoResponseSchema,
      );

      assert.equal(responses.length, 0, 'no response message');
      assertStatus(
        status,
        Code.ResourceExhausted,
        'Echo with a frame over 4 MiB',
      );
      assert.equal(fromStatus(status).code, 'limit_exceeded');

      // The call ended, not the instance.
      session.send({ frame: { case: 'healthCheck', value: { nonce: 9n } } });
      await session.frame(
        'healthReply',
        'the HealthReply after the call',
        (reply) => reply.nonce === 9n,
      );

      const next = await session.unary(
        'Echo',
        EchoRequestSchema,
        { text: 'after' },
        EchoResponseSchema,
      );

      assertStatus(next.status, codeOk, 'the Echo after the call');
      assert.deepEqual(
        next.responses.map((response) => response.text),
        ['after'],
        'the response of the Echo after the call',
      );
    },
  },
  {
    name: 'an Echo response whose frame is just within 4 MiB delivered',
    run: async (session) => {
      await session.ready();

      const text = 'frame within';
      const padBytes = largestFittingPad(session.nextCall, text);
      const { status, responses } = await session.unary(
        'Echo',
        EchoRequestSchema,
        { text, padBytes },
        EchoResponseSchema,
      );

      assertStatus(status, codeOk, 'Echo with a frame within 4 MiB');
      assert.deepEqual(
        responses.map((response) => [response.text, response.padding.length]),
        [[text, padBytes]],
        'the response, with its padding',
      );
    },
  },
];

/**
 * Registers the cases under one `describe` named after `options.command`,
 * at most {@link concurrency} at once. Returns once they are registered.
 */
export const registerConformance = (options: ConformanceOptions): void => {
  const { command, args } = options.command;

  void describe(`protocol conformance: ${[command, ...args].join(' ')}`, {
    concurrency,
  }, () => {
    for (const { name, env, run } of cases) {
      void test(name, { timeout: caseTimeoutMs }, (t) =>
        runCase(t, options, (session) => run(session, t), env),
      );
    }
  });
};
