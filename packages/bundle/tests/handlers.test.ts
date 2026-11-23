// The SDK's handler helpers of `bundle/host` (spec
// `docs/designs/grpc-processes.md`, section 4, "Handler services"; phase 3,
// slice S45a): `createToolHandlers` serves `tools/v1`'s `ToolHandlerService`
// and registers each tool with `tools/v1.Register`; `createHookHandlers`
// serves `hooks/v1`'s `HookHandlerService` and registers each handler with
// `hooks/v1.Register`; `onHostStart` registers a `doric.app.hooks/v1`
// `onHostStartHook` handler that reports through `doric.startup/v1`.
//
// The bundle under test runs in `createTestRouter`. `tools/v1`, `hooks/v1`
// and `doric.startup/v1` are fakes that record what they receive; `core`'s
// calls to the handler services arrive through `router.client` with the
// caller `core`. Hook kinds come from a test file `notes.hooks/v1`, built as
// `core`'s tests build it.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  create,
  createFileRegistry,
  type DescMessage,
  type DescService,
  fromJson,
  type JsonObject,
  type JsonValue,
  type Message,
  type MessageInitShape,
  setExtension,
  toJson,
} from '@bufbuild/protobuf';
import {
  anyPack,
  anyUnpack,
  DescriptorProtoSchema,
  EmptySchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  FileDescriptorProtoSchema,
  FileOptionsSchema,
  MessageOptionsSchema,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import {
  type Client,
  ConnectError,
  type ServiceImpl,
} from '@connectrpc/connect';
import { z } from 'zod';

import type { ContractTool } from '../src/contracts/basic/tools.js';
import type { Call, CallScope, Caller } from '../src/contracts/call.js';
import { ContractError, isContractError } from '../src/contracts/error.js';
import {
  HookHandlerService,
  HookHandlerServiceHandleResponseSchema,
  HooksService,
  RegisterRequestSchema as HookRegisterRequestSchema,
} from '../src/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { OnHostStartHookInputSchema } from '../src/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import {
  LogRequestSchema,
  StageRequestSchema,
  StartupService,
} from '../src/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import {
  file_doric_platform_v1_options,
  HookKind,
  HookOptionSchema,
  HooksOptionSchema,
  hook as hookOption,
  hooks as hooksOption,
} from '../src/contracts/gen/doric/platform/v1/options_pb.js';
import {
  ToolHandlerService,
  ToolHandlerServiceCheckResponseSchema,
  type ToolHandlerServiceExecuteResponse,
  ToolHandlerServiceExecuteResponseSchema,
  ToolsService,
  RegisterRequestSchema as ToolRegisterRequestSchema,
} from '../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { callOf } from '../src/contracts/metadata.js';
import { fromConnectError } from '../src/contracts/status.js';
import {
  createHookHandlers,
  createToolHandlers,
  type HandlerRegistration,
  type HookHandlers,
  type HostContext,
  type HostRegistrations,
  onHostStart,
  type ServiceEntry,
  type ToolHandlers,
  type TrackedRegistration,
} from '../src/sdk/host/index.js';
import { createTestRouter } from '../src/testing/index.js';

// ---------------------------------------------------------------------------
// Helpers

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 3_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** The error `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (
  promise: Promise<unknown>,
  what = 'the call',
): Promise<unknown> => {
  try {
    await within(promise, what);
  } catch (error) {
    return error;
  }

  return assert.fail(`${what} succeeded`);
};

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) {
    return fromConnectError(error);
  }

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error;
};

/** Asserts `promise` fails with the Doric code `code` (and `message`). */
const assertFails = async (
  promise: Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> => {
  const error = contractErrorOf(await rejectionOf(promise));

  assert.equal(error.code, code, error.message);

  if (message !== undefined) {
    assert.equal(error.message, message);
  }
};

/** A service entry that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** `core`, as the router stamps it on its calls to the handler services. */
const core: Caller = { bundleId: 'core', version: '1.0.0', generation: 1 };

/** The scope of the `tools/v1` or `hooks/v1` call `core` relays. */
const relayed: CallScope = { projectId: 'p1', windowKey: 'w1' };

const jsonValue = (json: JsonValue) => fromJson(ValueSchema, json);

// ---------------------------------------------------------------------------
// The test `notes.hooks/v1` file (as `core/tests/support/router.ts` builds it)

const hookMessage = (name: string, hook: string, kind: HookKind) => {
  const options = create(MessageOptionsSchema);

  setExtension(
    options,
    hookOption,
    create(HookOptionSchema, { name: hook, kind }),
  );

  return create(DescriptorProtoSchema, {
    name,
    field: [
      create(FieldDescriptorProtoSchema, {
        name: 'text',
        jsonName: 'text',
        number: 1,
        type: FieldDescriptorProto_Type.STRING,
        label: FieldDescriptorProto_Label.OPTIONAL,
      }),
    ],
    options,
  });
};

const notesRegistry = (() => {
  const options = create(FileOptionsSchema);

  setExtension(
    options,
    hooksOption,
    create(HooksOptionSchema, { id: 'notes.hooks/v1' }),
  );

  const file = create(FileDescriptorProtoSchema, {
    name: 'test/notes_hooks.proto',
    package: 'notes.hooks',
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    options,
    messageType: [
      hookMessage('SeenInput', 'onSeenHook', HookKind.OBSERVE),
      hookMessage('ShapeInput', 'onShapeHook', HookKind.TRANSFORM),
      hookMessage('AllowInput', 'onAllowHook', HookKind.DECIDE),
      hookMessage('StepInput', 'onStepHook', HookKind.SEQUENCE),
    ],
  });

  return createFileRegistry(file, (name) =>
    name === file_doric_platform_v1_options.proto.name
      ? file_doric_platform_v1_options
      : undefined,
  );
})();

const messageOf = (name: string): DescMessage => {
  const desc = notesRegistry.getMessage(`notes.hooks.${name}`);

  assert.ok(desc !== undefined, `no message ${name}`);

  return desc;
};

const SeenInput = messageOf('SeenInput');
const ShapeInput = messageOf('ShapeInput');
const AllowInput = messageOf('AllowInput');
const StepInput = messageOf('StepInput');

/** A message of `desc` with `text`. */
const note = (desc: DescMessage, text: string): Message =>
  create(desc, { text } as MessageInitShape<DescMessage>);

/** The `text` of a message; `undefined` for none (a failed `anyUnpack`). */
const textOf = (message: Message | undefined): unknown =>
  (message as { readonly text?: unknown } | undefined)?.text;

// ---------------------------------------------------------------------------
// The harness: the bundle under test and its recording fakes

interface Harness {
  readonly context: HostContext;
  readonly tools: ToolHandlers;
  readonly hooks: HookHandlers;
  /** `core`'s client of the bundle's `ToolHandlerService`. */
  readonly toolClient: Client<typeof ToolHandlerService>;
  /** `core`'s client of the bundle's `HookHandlerService`. */
  readonly hookClient: Client<typeof HookHandlerService>;
  /** `tools/v1.Register` requests, as JSON, in order. */
  readonly toolRegisters: JsonValue[];
  /** `tools/v1.Unregister` registration ids, in order. */
  readonly toolUnregisters: string[];
  /** `hooks/v1.Register` requests, as JSON, in order. */
  readonly hookRegisters: JsonValue[];
  /** `doric.startup/v1` requests, in order, with the scope each saw. */
  readonly startup: {
    readonly method: 'stage' | 'log';
    readonly request: JsonValue;
    readonly scope: CallScope | undefined;
  }[];
}

interface HarnessOptions {
  /** `tools/v1.Register` fails with this error. */
  readonly toolRegisterError?: ContractError;
  /** `doric.startup/v1.Stage` fails with this error. */
  readonly stageError?: ContractError;
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const tools = createToolHandlers();
  const hooks = createHookHandlers();
  const toolRegisters: JsonValue[] = [];
  const toolUnregisters: string[] = [];
  const hookRegisters: JsonValue[] = [];
  const startup: Harness['startup'] = [];
  let toolIds = 0;
  let hookIds = 0;

  const router = createTestRouter({
    caller: core,
    scope: relayed,
    // `doric.startup/v1` is a platform contract: declared without a line, as
    // `routeCall` step 3 has it.
    requires: [ToolsService.typeName, HooksService.typeName],
    fakes: [
      partial(ToolsService, {
        register: (request) => {
          toolRegisters.push(toJson(ToolRegisterRequestSchema, request));

          if (options.toolRegisterError !== undefined) {
            throw options.toolRegisterError;
          }

          toolIds += 1;

          return { registrationId: `tool-${toolIds}` };
        },
        unregister: (request) => {
          toolUnregisters.push(request.registrationId);

          return {};
        },
      }),
      partial(HooksService, {
        register: (request) => {
          hookRegisters.push(toJson(HookRegisterRequestSchema, request));
          hookIds += 1;

          return { registrationId: `hook-${hookIds}` };
        },
        unregister: () => ({}),
      }),
      partial(StartupService, {
        stage: (request, handlerContext) => {
          startup.push({
            method: 'stage',
            request: toJson(StageRequestSchema, request),
            scope: callOf(handlerContext).scope,
          });

          if (options.stageError !== undefined) {
            throw options.stageError;
          }

          return {};
        },
        log: (request, handlerContext) => {
          startup.push({
            method: 'log',
            request: toJson(LogRequestSchema, request),
            scope: callOf(handlerContext).scope,
          });

          return {};
        },
      }),
    ],
  });
  const context = await router.activate<readonly DescService[]>({
    services: [
      partial(ToolHandlerService, tools.implementation),
      partial(HookHandlerService, hooks.implementation),
    ],
    activate: () => {},
  });

  return {
    context,
    tools,
    hooks,
    toolClient: router.client(ToolHandlerService),
    hookClient: router.client(HookHandlerService),
    toolRegisters,
    toolUnregisters,
    hookRegisters,
    startup,
  };
};

/** A tool whose `execute` is `execute`; input `{a: {b: string}, n = 5}`. */
const contractTool = (
  name: string,
  execute: ContractTool['execute'],
  check?: ContractTool['check'],
): ContractTool => ({
  name,
  description: `The ${name} tool.`,
  input: z.object({
    a: z.object({ b: z.string() }),
    n: z.number().default(5),
  }),
  output: z.unknown(),
  definition: {
    name,
    description: `The ${name} tool, for the model.`,
    inputSchema: { type: 'object', required: ['a'] },
    outputSchema: { type: 'object' },
    strict: true,
  },
  settings: [{ key: 'apiKey', required: true }],
  resultModalities: ['image'],
  execute,
  ...(check === undefined ? {} : { check }),
});

const returning = (name: string, result: unknown): ContractTool =>
  contractTool(name, async () => result);

const execute = (
  h: Harness,
  name: string,
  payload: JsonValue,
  projectId?: string,
) =>
  h.toolClient.execute({
    name,
    payload: jsonValue(payload),
    ...(projectId === undefined ? {} : { projectId }),
  });

const resultOf = async (
  response: Promise<ToolHandlerServiceExecuteResponse>,
): Promise<JsonValue | undefined> => {
  const { result } = await within(response, 'Execute');

  return result === undefined ? undefined : toJson(ValueSchema, result);
};

const handle = (h: Harness, desc: DescMessage, input: Message) => {
  const contract =
    desc.file.proto.package === 'notes.hooks'
      ? 'notes.hooks/v1'
      : 'doric.app.hooks/v1';
  const hook = {
    SeenInput: 'onSeenHook',
    ShapeInput: 'onShapeHook',
    AllowInput: 'onAllowHook',
    StepInput: 'onStepHook',
    OnHostStartHookInput: 'onHostStartHook',
  }[desc.name];

  assert.ok(hook !== undefined, `no hook for ${desc.name}`);

  return h.hookClient.handle({
    contract,
    hook,
    input: anyPack(desc, input),
  });
};

// ---------------------------------------------------------------------------
// Tools

describe('createToolHandlers', () => {
  test('A1: register sends one tools/v1.Register with the tool, its schemas as JSON text, and the options; resolves with the registrationId', async () => {
    const h = await harness();
    const tool = returning('search', null);

    const registration = await within(
      h.tools.register(h.context, tool, {
        alwaysAvailable: true,
        order: 700,
        projectId: 'p1',
      }),
      'register',
    );

    assert.equal(registration.registrationId, 'tool-1');
    assert.deepEqual(h.toolRegisters, [
      {
        tool: {
          name: 'search',
          description: 'The search tool.',
          definition: {
            name: 'search',
            description: 'The search tool, for the model.',
            inputSchema: JSON.stringify({ type: 'object', required: ['a'] }),
            outputSchema: JSON.stringify({ type: 'object' }),
            strict: true,
          },
          settings: [{ key: 'apiKey', required: true }],
          resultModalities: ['image'],
        },
        options: { alwaysAvailable: true, order: 700, projectId: 'p1' },
      },
    ]);
  });

  test("A2: Execute runs tool.execute with the payload under the relayed call's caller and scope, and answers the result as JSON (toJSON applies)", async () => {
    const h = await harness();
    const seen: { payload: unknown; caller: Caller; scope: unknown }[] = [];
    const when = new Date('2026-01-02T03:04:05.000Z');

    await h.tools.register(
      h.context,
      contractTool('clock', async (payload, call: Call) => {
        seen.push({
          payload,
          caller: { ...call.caller },
          scope: call.scope === undefined ? undefined : { ...call.scope },
        });

        return { at: when, list: [1, 'two'] };
      }),
      { alwaysAvailable: false },
    );

    const result = await resultOf(execute(h, 'clock', { a: { b: 'x' } }));

    assert.deepEqual(result, {
      at: '2026-01-02T03:04:05.000Z',
      list: [1, 'two'],
    });
    assert.deepEqual(seen, [
      { payload: { a: { b: 'x' } }, caller: core, scope: relayed },
    ]);
  });

  test('A3: a tool is served under (name, projectId); an unscoped request never reaches a scoped tool', async () => {
    const h = await harness();
    const ran: string[] = [];
    const scoped = (projectId: string) =>
      contractTool('search', async () => {
        ran.push(projectId);

        return projectId;
      });

    await h.tools.register(h.context, scoped('p1'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });
    await h.tools.register(h.context, scoped('p2'), {
      alwaysAvailable: false,
      projectId: 'p2',
    });

    assert.equal(await resultOf(execute(h, 'search', {}, 'p2')), 'p2');
    assert.deepEqual(ran, ['p2']);
    await assertFails(execute(h, 'search', {}), 'not_found');
    assert.deepEqual(ran, ['p2']);
  });

  test('A4: Execute and Check of an unknown name answer not_found', async () => {
    const h = await harness();

    await h.tools.register(h.context, returning('known', 1), {
      alwaysAvailable: false,
    });

    await assertFails(execute(h, 'unknown', {}), 'not_found');
    await assertFails(
      h.toolClient.check({ name: 'unknown', payload: jsonValue({}) }),
      'not_found',
    );
  });

  test("A5: a tool's ContractError crosses unchanged; any other throw crosses as internal with its message", async () => {
    const h = await harness();

    await h.tools.register(
      h.context,
      contractTool('refuses', async () => {
        throw new ContractError('invalid_input', 'm');
      }),
      { alwaysAvailable: false },
    );
    await h.tools.register(
      h.context,
      contractTool('breaks', async () => {
        throw new Error('boom');
      }),
      { alwaysAvailable: false },
    );

    await assertFails(execute(h, 'refuses', {}), 'invalid_input', 'm');
    await assertFails(execute(h, 'breaks', {}), 'internal', 'boom');
  });

  test('A6: a result of undefined answers no result; a result JSON.stringify rejects answers invalid_output', async () => {
    const h = await harness();

    await h.tools.register(h.context, returning('nothing', undefined), {
      alwaysAvailable: false,
    });
    await h.tools.register(h.context, returning('big', { n: 1n }), {
      alwaysAvailable: false,
    });

    const response = await within(execute(h, 'nothing', {}), 'Execute');

    assert.equal(response.result, undefined);
    assert.deepEqual(
      toJson(ToolHandlerServiceExecuteResponseSchema, response),
      {},
    );
    await assertFails(execute(h, 'big', {}), 'invalid_output');
  });

  test('A7: Check of a tool with check answers its result', async () => {
    const h = await harness();
    const checked: unknown[] = [];
    const never = async () => assert.fail('execute ran');

    await h.tools.register(
      h.context,
      contractTool('yes', never, (payload) => {
        checked.push(payload);

        return { success: true, data: { normalized: true } };
      }),
      { alwaysAvailable: false },
    );
    await h.tools.register(
      h.context,
      contractTool('no', never, async () => ({
        success: false,
        issues: [{ path: 'q', message: 'bad q' }],
      })),
      { alwaysAvailable: false },
    );

    const yes = await within(
      h.toolClient.check({ name: 'yes', payload: jsonValue({ q: 1 }) }),
      'Check yes',
    );
    const no = await within(
      h.toolClient.check({ name: 'no', payload: jsonValue({ q: 1 }) }),
      'Check no',
    );

    assert.deepEqual(checked, [{ q: 1 }]);
    assert.deepEqual(toJson(ToolHandlerServiceCheckResponseSchema, yes), {
      success: true,
      data: { normalized: true },
    });
    assert.deepEqual(toJson(ToolHandlerServiceCheckResponseSchema, no), {
      issues: [{ path: 'q', message: 'bad q' }],
    });
  });

  test("A8: Check of a tool without check answers tool.input.safeParse: the parsed data, or one {path, message} per issue with the path joined by '.'", async () => {
    const h = await harness();
    const tool = returning('parsed', null);

    await h.tools.register(h.context, tool, { alwaysAvailable: false });

    const valid = await within(
      h.toolClient.check({
        name: 'parsed',
        payload: jsonValue({ a: { b: 'x' } }),
      }),
      'Check valid',
    );

    assert.deepEqual(toJson(ToolHandlerServiceCheckResponseSchema, valid), {
      success: true,
      data: { a: { b: 'x' }, n: 5 },
    });

    const invalidPayload = { a: { b: 1 } };
    const parsed = tool.input.safeParse(invalidPayload);
    assert.equal(parsed.success, false);
    const [issue] = parsed.error.issues;
    assert.ok(issue !== undefined && parsed.error.issues.length === 1);

    const invalid = await within(
      h.toolClient.check({
        name: 'parsed',
        payload: jsonValue(invalidPayload),
      }),
      'Check invalid',
    );

    assert.deepEqual(toJson(ToolHandlerServiceCheckResponseSchema, invalid), {
      issues: [{ path: 'a.b', message: issue.message }],
    });
  });

  test('A9: a Register that fails (duplicate_tool) rejects register with it, and the tool is not served', async () => {
    const h = await harness({
      toolRegisterError: new ContractError('duplicate_tool', 'taken'),
    });
    let ran = false;

    const error = await rejectionOf(
      h.tools.register(
        h.context,
        contractTool('taken', async () => {
          ran = true;
        }),
        { alwaysAvailable: false },
      ),
      'register',
    );

    assert.equal(contractErrorOf(error).code, 'duplicate_tool');
    assert.equal(h.toolRegisters.length, 1);
    await assertFails(execute(h, 'taken', {}), 'not_found');
    assert.equal(ran, false);
  });

  test('A10: unregister sends tools/v1.Unregister and stops serving the tool; a second unregister sends nothing', async () => {
    const h = await harness();
    const registration = await h.tools.register(
      h.context,
      returning('gone', 1),
      { alwaysAvailable: false },
    );

    await within(registration.unregister(), 'unregister');

    assert.deepEqual(h.toolUnregisters, ['tool-1']);
    await assertFails(execute(h, 'gone', {}), 'not_found');

    await within(registration.unregister(), 'second unregister');

    assert.deepEqual(h.toolUnregisters, ['tool-1']);
  });

  test('A11: the same key registered twice is registered twice and serves the second tool; the first handle no longer ends it', async () => {
    const h = await harness();
    const first = await h.tools.register(
      h.context,
      returning('same', 'first'),
      {
        alwaysAvailable: false,
      },
    );

    await h.tools.register(h.context, returning('same', 'second'), {
      alwaysAvailable: false,
    });

    assert.equal(h.toolRegisters.length, 2);
    assert.equal(await resultOf(execute(h, 'same', {})), 'second');

    await within(first.unregister(), 'unregister of the replaced handle');

    assert.deepEqual(h.toolUnregisters, []);
    assert.equal(await resultOf(execute(h, 'same', {})), 'second');
  });

  test('A12: a replay sends the same Register again, and registrationId follows the new current', async () => {
    const h = await harness();
    const replays: (() => Promise<void>)[] = [];
    let tracked = 0;
    const registrations: HostRegistrations = {
      track: async <S extends DescService, R>(
        ref: S,
        register: (client: Client<S>) => Promise<R>,
      ): Promise<TrackedRegistration<R>> => {
        const client = h.context.services.use(ref);
        let current = await register(client);

        tracked += 1;
        replays.push(async () => {
          current = await register(client);
        });

        return {
          get current() {
            return current;
          },
          untrack: () => {},
        };
      },
    };

    const registration: HandlerRegistration = await within(
      h.tools.register({ registrations }, returning('replayed', 1), {
        alwaysAvailable: true,
        order: 3,
      }),
      'register',
    );

    assert.equal(tracked, 1);
    assert.equal(registration.registrationId, 'tool-1');

    const [replay] = replays;
    assert.ok(replay !== undefined);
    await within(replay(), 'replay');

    assert.equal(h.toolRegisters.length, 2);
    assert.deepEqual(h.toolRegisters[1], h.toolRegisters[0]);
    assert.equal(registration.registrationId, 'tool-2');
  });
});

// ---------------------------------------------------------------------------
// Hooks

describe('createHookHandlers', () => {
  test("A13: register sends hooks/v1.Register with the file's contract id, the message's hook name and the order", async () => {
    const h = await harness();

    const step = await within(
      h.hooks.register(h.context, StepInput, () => {}, { order: 3 }),
      'register onStepHook',
    );
    await within(
      h.hooks.register(h.context, OnHostStartHookInputSchema, () => {}),
      'register onHostStartHook',
    );

    assert.equal(step.registrationId, 'hook-1');
    assert.deepEqual(h.hookRegisters, [
      { contract: 'notes.hooks/v1', hook: 'onStepHook', order: 3 },
      { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
    ]);
  });

  test("A14: observe and sequence: Handle runs the handler with the unpacked input under the run's scope and answers {}, ignoring its value", async () => {
    const h = await harness();
    const seen: { text: unknown; scope: unknown }[] = [];
    const record = (input: Message, call: Call) => {
      seen.push({
        text: textOf(input),
        scope: call.scope === undefined ? undefined : { ...call.scope },
      });

      return note(
        input.$typeName === SeenInput.typeName ? SeenInput : StepInput,
        'ignored',
      );
    };

    await h.hooks.register(h.context, SeenInput, record);
    await h.hooks.register(h.context, StepInput, record);

    const observed = await within(
      handle(h, SeenInput, note(SeenInput, 'seen')),
      'Handle observe',
    );
    const stepped = await within(
      handle(h, StepInput, note(StepInput, 'step')),
      'Handle sequence',
    );

    assert.deepEqual(
      toJson(HookHandlerServiceHandleResponseSchema, observed),
      {},
    );
    assert.deepEqual(
      toJson(HookHandlerServiceHandleResponseSchema, stepped),
      {},
    );
    assert.deepEqual(seen, [
      { text: 'seen', scope: relayed },
      { text: 'step', scope: relayed },
    ]);
  });

  test("A15: transform: Handle answers the handler's message as output, the input when it answers nothing, and invalid_output for a message of another type", async () => {
    const h = await harness();
    let answer: 'changed' | 'nothing' | 'other' = 'changed';

    await h.hooks.register(h.context, ShapeInput, (input) => {
      if (answer === 'changed') {
        return note(ShapeInput, `${String(textOf(input))}!`);
      }

      return answer === 'other' ? note(AllowInput, 'wrong') : undefined;
    });

    const changed = await within(
      handle(h, ShapeInput, note(ShapeInput, 'draft')),
      'Handle changed',
    );
    assert.ok(changed.output !== undefined);
    assert.equal(textOf(anyUnpack(changed.output, ShapeInput)), 'draft!');
    assert.equal(changed.decision, undefined);

    answer = 'nothing';
    const unchanged = await within(
      handle(h, ShapeInput, note(ShapeInput, 'draft')),
      'Handle unchanged',
    );
    assert.ok(unchanged.output !== undefined);
    assert.equal(
      unchanged.output.typeUrl,
      'type.googleapis.com/notes.hooks.ShapeInput',
    );
    assert.equal(textOf(anyUnpack(unchanged.output, ShapeInput)), 'draft');

    answer = 'other';
    await assertFails(
      handle(h, ShapeInput, note(ShapeInput, 'draft')),
      'invalid_output',
    );
  });

  test("A16: decide: Handle answers the handler's decision, {allow: true} when it answers nothing, and invalid_output for a decision breaking allow != has(reason)", async () => {
    const h = await harness();
    let answer: { allow: boolean; reason?: string } | undefined = {
      allow: false,
      reason: 'no',
    };

    await h.hooks.register(h.context, AllowInput, () => answer);

    const refused = await within(
      handle(h, AllowInput, note(AllowInput, 'a')),
      'Handle refused',
    );
    assert.deepEqual(toJson(HookHandlerServiceHandleResponseSchema, refused), {
      decision: { reason: 'no' },
    });
    assert.equal(refused.decision?.allow, false);

    answer = undefined;
    const allowed = await within(
      handle(h, AllowInput, note(AllowInput, 'a')),
      'Handle allowed',
    );
    assert.equal(allowed.decision?.allow, true);
    assert.equal(allowed.decision?.reason, undefined);
    assert.equal(allowed.output, undefined);

    answer = { allow: false };
    await assertFails(
      handle(h, AllowInput, note(AllowInput, 'a')),
      'invalid_output',
    );
  });

  test("A17: Handle answers not_found for an unserved hook, invalid_input for an input of another type, and the handler's ContractError unchanged", async () => {
    const h = await harness();

    await h.hooks.register(h.context, StepInput, () => {
      throw new ContractError('unavailable', 'later');
    });
    await h.hooks.register(h.context, SeenInput, () => {});

    await assertFails(
      handle(h, ShapeInput, note(ShapeInput, 'x')),
      'not_found',
    );
    await assertFails(
      h.hookClient.handle({
        contract: 'notes.hooks/v1',
        hook: 'onSeenHook',
        input: anyPack(AllowInput, note(AllowInput, 'x')),
      }),
      'invalid_input',
    );
    await assertFails(
      handle(h, StepInput, note(StepInput, 'x')),
      'unavailable',
      'later',
    );
  });

  test('A18: register with a message without a hook option rejects with a TypeError and calls nothing', async () => {
    const h = await harness();

    const error = await rejectionOf(
      h.hooks.register(h.context, EmptySchema, () => {}),
      'register',
    );

    assert.ok(error instanceof TypeError, `expected a TypeError: ${error}`);
    assert.deepEqual(h.hookRegisters, []);
  });
});

// ---------------------------------------------------------------------------
// Start

describe('onHostStart', () => {
  test("A19: onHostStart registers onHostStartHook; Handle runs the step, whose Stage and Log reach doric.startup/v1 in order under the run's scope, and answers {}", async () => {
    const h = await harness();

    await within(
      onHostStart(h.hooks, h.context, async (startup) => {
        await startup.stage('s');
        await startup.log('info', 'm', { a: 1 } satisfies JsonObject);
      }),
      'onHostStart',
    );

    assert.deepEqual(h.hookRegisters, [
      { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
    ]);

    const response = await within(
      handle(h, OnHostStartHookInputSchema, create(OnHostStartHookInputSchema)),
      'Handle onHostStartHook',
    );

    assert.deepEqual(
      toJson(HookHandlerServiceHandleResponseSchema, response),
      {},
    );
    assert.deepEqual(h.startup, [
      { method: 'stage', request: { name: 's' }, scope: relayed },
      {
        method: 'log',
        request: { level: 'info', message: 'm', fields: { a: 1 } },
        scope: relayed,
      },
    ]);
  });

  test("A20: a failing Stage fails Handle with its error, and the step's later lines do not run", async () => {
    const h = await harness({
      stageError: new ContractError('unavailable', 'no startup record'),
    });
    let after = false;

    await onHostStart(h.hooks, h.context, async (startup) => {
      await startup.stage('s');
      after = true;
      await startup.log('info', 'm');
    });

    await assertFails(
      handle(h, OnHostStartHookInputSchema, create(OnHostStartHookInputSchema)),
      'unavailable',
    );
    assert.equal(after, false);
    assert.deepEqual(
      h.startup.map(({ method }) => method),
      ['stage'],
    );
  });
});
