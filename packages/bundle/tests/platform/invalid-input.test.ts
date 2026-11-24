// The SDK's answer to a request that breaks a protovalidate rule (S60 §2.1,
// D4; tests V1–V4 and V6 of S60a): `CallServerOptions.invalidInput`, which
// `runBundle` fills from `BundleDefinition.invalidInput`, chooses the error a
// violating call ends with; without it, or when it answers `undefined` or
// throws, the call ends with `invalid_input` and protovalidate's message, as
// before. The call server runs in this process with recorded frames: the
// tests send `CallStart`/`CallMessage`/`CallHalfClose` and read the
// `CallEnd`. Rules come from real contracts: `settings/v1` (`id` min_len,
// unary and server stream), `events/v1` `Sink` (a field rule and a message
// CEL rule) and `storage/v1` `Commit` (client stream, a nested field).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  create,
  type DescMessage,
  type DescMethod,
  type DescService,
  type MessageInitShape,
  toBinary,
} from '@bufbuild/protobuf';
import { anyPack, EmptySchema } from '@bufbuild/protobuf/wkt';
import { createValidator } from '@bufbuild/protovalidate';
import { Code, type ServiceImpl } from '@connectrpc/connect';

import { ContractError } from '../../src/contracts/error.js';
import {
  EventsService,
  SinkRequestSchema,
} from '../../src/contracts/gen/doric/events/v1/events_pb.js';
import {
  CallStartSchema,
  type ConnectRequestSchema,
} from '../../src/contracts/gen/doric/platform/v1/control_pb.js';
import {
  GetRequestSchema,
  SettingsService,
  WatchRequestSchema,
} from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import {
  CommitRequestSchema,
  StorageService,
} from '../../src/contracts/gen/doric/storage/v1/storage_pb.js';
import type { Status } from '../../src/contracts/gen/google/rpc/status_pb.js';
import { fromStatus, grpcCodeOf } from '../../src/contracts/status.js';
import type {
  BundleDefinition,
  InputViolation,
  InvalidInputAnswer,
  ServiceEntry,
} from '../../src/sdk/host/index.js';
import {
  type CallControlFrame,
  createCallServer,
} from '../../src/sdk/host/serve.js';

// ---------------------------------------------------------------------------
// Helpers

type SentFrame = MessageInitShape<typeof ConnectRequestSchema>;

/** An implementation that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One hook call, as the hook received it. */
interface HookCall {
  readonly method: DescMethod;
  readonly violations: readonly InputViolation[];
}

/** A hook that records its calls and answers `answer`. */
const recordingHook = (
  answer: (method: DescMethod) => ContractError | undefined,
): { readonly hook: InvalidInputAnswer; readonly calls: HookCall[] } => {
  const calls: HookCall[] = [];

  return {
    calls,
    hook: (method, violations) => {
      calls.push({
        method,
        violations: violations.map((violation) => ({
          field: [...violation.field],
          ruleId: violation.ruleId,
          message: violation.message,
        })),
      });

      return answer(method);
    },
  };
};

/** A call server over `services`, whose sent frames the test reads. */
const serverOf = (
  services: readonly ServiceEntry[],
  invalidInput?: InvalidInputAnswer,
) => {
  const sent: SentFrame[] = [];
  const server = createCallServer({
    services,
    send: (frame) => sent.push(frame),
    signal: new AbortController().signal,
    ...(invalidInput === undefined ? {} : { invalidInput }),
  });
  let nextId = 1n;

  /** The `CallEnd` status of `callId`; fails the test after 3 s. */
  const end = async (callId: bigint): Promise<Status> => {
    const deadline = performance.now() + 3_000;

    for (;;) {
      for (const frame of sent) {
        const value = frame.frame;

        if (value?.case === 'callEnd' && value.value.callId === callId) {
          return value.value.status as Status;
        }
      }

      if (performance.now() > deadline) {
        return assert.fail(`no CallEnd for call ${callId}`);
      }

      await sleep(5);
    }
  };

  const receive = (frame: CallControlFrame): void => server.receive(frame);

  /** Starts a call of `service`'s `method`; `payload` for unary and server stream. */
  const start = (
    service: DescService,
    method: string,
    kind: string,
    payload: Uint8Array = new Uint8Array(),
  ): bigint => {
    const callId = nextId;

    nextId += 1n;
    receive({
      case: 'callStart',
      value: create(CallStartSchema, {
        callId,
        method: `/${service.typeName}/${method}`,
        kind,
        caller: { bundleId: 'caller', version: '1.0.0', generation: 1 },
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01',
        initialCredit: 16,
        payload,
      }),
    });

    return callId;
  };

  return { sent, end, receive, start };
};

/** The binary payload of `init` as a message of `schema`. */
const payloadOf = <D extends DescMessage>(
  schema: D,
  init: MessageInitShape<D>,
): Uint8Array => toBinary(schema, create(schema, init));

const validator = createValidator();

/** protovalidate's message for `init`, the SDK's `invalid_input` message. */
const protovalidateMessage = <D extends DescMessage>(
  schema: D,
  init: MessageInitShape<D>,
): string => {
  const result = validator.validate(schema, create(schema, init));

  assert.notEqual(result.kind, 'valid', 'the fixture breaks a rule');

  return result.kind === 'invalid' ? result.error.message : '';
};

/** Asserts `status` is the end of a call that failed with `code` and `message`. */
const assertEnded = (
  status: Status,
  code: string,
  message: string,
  grpc: Code,
): void => {
  const error = fromStatus(status);

  assert.equal(error.code, code, status.message);
  assert.equal(error.message, message);
  assert.equal(status.code, grpc);
  assert.equal(status.code, grpcCodeOf(code));
};

const someValue = () => anyPack(EmptySchema, create(EmptySchema));

/** `settings/v1` whose handlers record that they ran. */
const settings = (reached: string[]): ServiceEntry =>
  partial(SettingsService, {
    get: () => {
      reached.push('get');

      return { value: someValue() };
    },
    watch: async function* () {
      reached.push('watch');
      yield {};
    },
  });

const emptyGet = { id: '' } satisfies MessageInitShape<typeof GetRequestSchema>;

/** A Sink request breaking a field rule and the message's CEL rule. */
const doubleSink = {
  scopeKeys: ['a'],
  stream: '{b}',
  scopeDescription: '',
} satisfies MessageInitShape<typeof SinkRequestSchema>;

// ---------------------------------------------------------------------------
// Tests

describe('invalidInput: the hook answers a violating request (V1)', () => {
  test("a violating unary request ends with the hook's ContractError, its gRPC code from the table; the handler does not run", async () => {
    const reached: string[] = [];
    const { hook } = recordingHook(
      () => new ContractError('not_found', 'The space is unknown.'),
    );
    const server = serverOf([settings(reached)], hook);

    const status = await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        payloadOf(GetRequestSchema, emptyGet),
      ),
    );

    assertEnded(status, 'not_found', 'The space is unknown.', Code.NotFound);
    assert.deepEqual(reached, []);
  });

  test("a violating server-stream request ends with the hook's error and no response message", async () => {
    const reached: string[] = [];
    const { hook } = recordingHook(
      () => new ContractError('invalid_scope', 'The id is empty.'),
    );
    const server = serverOf([settings(reached)], hook);

    const callId = server.start(
      SettingsService,
      'Watch',
      'server_stream',
      payloadOf(WatchRequestSchema, { id: '' }),
    );
    const status = await server.end(callId);

    assertEnded(
      status,
      'invalid_scope',
      'The id is empty.',
      Code.InvalidArgument,
    );
    assert.deepEqual(reached, []);
    assert.equal(
      server.sent.filter(
        (frame) =>
          frame.frame?.case === 'callMessage' &&
          frame.frame.value.callId === callId,
      ).length,
      0,
    );
  });

  test('a valid request does not reach the hook and runs the handler', async () => {
    const reached: string[] = [];
    const { hook, calls } = recordingHook(
      () => new ContractError('not_found', 'unexpected'),
    );
    const server = serverOf([settings(reached)], hook);

    const status = await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        payloadOf(GetRequestSchema, { id: 'space/v1' }),
      ),
    );

    assert.equal(status.code, 0, status.message);
    assert.deepEqual(reached, ['get']);
    assert.equal(calls.length, 0);
  });
});

describe('invalidInput: undefined or a throw keeps invalid_input (V2)', () => {
  test("a hook answering undefined keeps invalid_input with protovalidate's message", async () => {
    const reached: string[] = [];
    const { hook, calls } = recordingHook(() => undefined);
    const server = serverOf([settings(reached)], hook);

    const status = await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        payloadOf(GetRequestSchema, emptyGet),
      ),
    );

    assertEnded(
      status,
      'invalid_input',
      protovalidateMessage(GetRequestSchema, emptyGet),
      Code.InvalidArgument,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(reached, []);
  });

  test("a hook that throws keeps invalid_input with protovalidate's message", async () => {
    const reached: string[] = [];
    let called = 0;
    const hook: InvalidInputAnswer = () => {
      called += 1;
      throw new Error('the hook broke');
    };
    const server = serverOf([settings(reached)], hook);

    const status = await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        payloadOf(GetRequestSchema, emptyGet),
      ),
    );

    assertEnded(
      status,
      'invalid_input',
      protovalidateMessage(GetRequestSchema, emptyGet),
      Code.InvalidArgument,
    );
    assert.equal(called, 1);
    assert.deepEqual(reached, []);
  });
});

describe('invalidInput: what the hook receives (V3)', () => {
  test('the method and one field violation, its path from the root as proto names', async () => {
    const { hook, calls } = recordingHook(() => undefined);
    const server = serverOf([settings([])], hook);

    await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        payloadOf(GetRequestSchema, emptyGet),
      ),
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.method === SettingsService.method.get, 'method Get');
    assert.deepEqual(calls[0]?.violations, [
      {
        field: ['id'],
        ruleId: 'string.min_len',
        message: 'must be at least 1 characters',
      },
    ]);
  });

  test('a message-level CEL rule has an empty field path', async () => {
    const { hook, calls } = recordingHook(() => undefined);
    const server = serverOf(
      [partial(EventsService, { sink: () => ({}) })],
      hook,
    );

    await server.end(
      server.start(
        EventsService,
        'Sink',
        'unary',
        payloadOf(SinkRequestSchema, { scopeKeys: ['a'], stream: '{b}' }),
      ),
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.method === EventsService.method.sink, 'method Sink');
    assert.deepEqual(calls[0]?.violations, [
      {
        field: [],
        ruleId: 'sink_request.placeholders',
        message: 'every stream placeholder must be a scope key of the sink',
      },
    ]);
  });

  test("every violation of one request reaches one hook call, in protovalidate's order", async () => {
    const { hook, calls } = recordingHook(() => undefined);
    const server = serverOf(
      [partial(EventsService, { sink: () => ({}) })],
      hook,
    );

    await server.end(
      server.start(
        EventsService,
        'Sink',
        'unary',
        payloadOf(SinkRequestSchema, doubleSink),
      ),
    );

    const expectedOrder = (() => {
      const result = validator.validate(
        SinkRequestSchema,
        create(SinkRequestSchema, doubleSink),
      );

      return result.kind === 'invalid'
        ? result.violations.map((violation) => violation.ruleId)
        : [];
    })();

    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]?.violations.map((violation) => violation.ruleId),
      expectedOrder,
    );
    assert.deepEqual(
      [...(calls[0]?.violations ?? [])].sort((a, b) =>
        a.ruleId.localeCompare(b.ruleId),
      ),
      [
        {
          field: [],
          ruleId: 'sink_request.placeholders',
          message: 'every stream placeholder must be a scope key of the sink',
        },
        {
          field: ['scope_description'],
          ruleId: 'string.min_len',
          message: 'must be at least 1 characters',
        },
      ],
    );
  });

  test('a request that does not decode never reaches the hook and ends invalid_input', async () => {
    const reached: string[] = [];
    const { hook, calls } = recordingHook(
      () => new ContractError('not_found', 'unexpected'),
    );
    const server = serverOf([settings(reached)], hook);

    // Field 1, length-delimited, announcing 127 bytes that never come.
    const status = await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        new Uint8Array([0x0a, 0x7f]),
      ),
    );

    const error = fromStatus(status);

    assert.equal(error.code, 'invalid_input');
    assert.equal(status.code, Code.InvalidArgument);
    assert.equal(calls.length, 0);
    assert.deepEqual(reached, []);
  });
});

describe('invalidInput: absent (V4)', () => {
  test("without the hook a violating request ends invalid_input with protovalidate's message", async () => {
    const reached: string[] = [];
    const server = serverOf([settings(reached)]);

    const status = await server.end(
      server.start(
        SettingsService,
        'Get',
        'unary',
        payloadOf(GetRequestSchema, emptyGet),
      ),
    );

    assertEnded(
      status,
      'invalid_input',
      protovalidateMessage(GetRequestSchema, emptyGet),
      Code.InvalidArgument,
    );
    assert.deepEqual(reached, []);
  });

  test('BundleDefinition.invalidInput is optional and takes an InvalidInputAnswer', () => {
    const hook: InvalidInputAnswer = () => undefined;
    const without: BundleDefinition = { activate: () => {} };
    const withHook: BundleDefinition = {
      activate: () => {},
      invalidInput: hook,
    };

    assert.equal(without.invalidInput, undefined);
    assert.equal(withHook.invalidInput, hook);
  });
});

describe('invalidInput: client streaming (V6)', () => {
  test('the hook runs for the violating request message; the call ends with its error after the valid ones reached the handler', async () => {
    const taken: unknown[] = [];
    const { hook, calls } = recordingHook(
      () => new ContractError('invalid_scope', 'The commit is malformed.'),
    );
    const server = serverOf(
      [
        partial(StorageService, {
          commit: async (requests) => {
            for await (const request of requests) {
              taken.push(request.item.case);
            }

            return { position: 1 };
          },
        }),
      ],
      hook,
    );

    const callId = server.start(StorageService, 'Commit', 'client_stream');
    const message = (init: MessageInitShape<typeof CommitRequestSchema>) =>
      server.receive({
        case: 'callMessage',
        value: { callId, payload: payloadOf(CommitRequestSchema, init) },
      } as CallControlFrame);

    message({ item: { case: 'dropStream', value: 'orders' } });
    message({
      item: {
        case: 'expect',
        value: { type: 'order/v1', id: 'o1', revision: -1 },
      },
    });
    server.receive({
      case: 'callHalfClose',
      value: { callId },
    } as CallControlFrame);

    const status = await server.end(callId);

    assertEnded(
      status,
      'invalid_scope',
      'The commit is malformed.',
      Code.InvalidArgument,
    );
    assert.deepEqual(taken, ['dropStream']);
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0]?.method === StorageService.method.commit,
      'method Commit',
    );
    assert.deepEqual(calls[0]?.violations, [
      {
        field: ['expect', 'revision'],
        ruleId: 'double.gte',
        message: 'must be greater than or equal to 0',
      },
    ]);
  });

  test('a violating first message runs the hook once for that message in each call', async () => {
    const { hook, calls } = recordingHook(() => undefined);
    const server = serverOf(
      [
        partial(StorageService, {
          commit: async (requests) => {
            for await (const _request of requests) {
              // drains the stream
            }

            return { position: 1 };
          },
        }),
      ],
      hook,
    );

    for (const dropStream of ['', '']) {
      const callId = server.start(StorageService, 'Commit', 'client_stream');

      server.receive({
        case: 'callMessage',
        value: {
          callId,
          payload: payloadOf(CommitRequestSchema, {
            item: { case: 'dropStream', value: dropStream },
          }),
        },
      } as CallControlFrame);
      server.receive({
        case: 'callHalfClose',
        value: { callId },
      } as CallControlFrame);

      const status = await server.end(callId);

      assert.equal(fromStatus(status).code, 'invalid_input');
    }

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.violations, [
        {
          field: ['drop_stream'],
          ruleId: 'string.min_len',
          message: 'must be at least 1 characters',
        },
      ]);
    }
  });
});
