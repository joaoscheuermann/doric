// `tools/v1` served by `core` over the router (S40a): tools as data under
// D4's key rule (name + Project), and `Execute` relayed to the registering
// instance's `ToolHandlerService`. A registering "instance" is a router
// client caller (incarnation 1); its handler service is the per-target fake
// of `serveCore` (`handlers`, `handlerCalls`).

import assert from 'node:assert/strict';
import test from 'node:test';

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import {
  type RegisteredTool,
  type ToolHandlerServiceExecuteRequest,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';

import { type RoutedCore, serveCore } from '../support/router.js';

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
  check?: (message: string) => void,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);

    const contract = fromConnectError(error);

    assert.equal(contract.code, code, error.message);
    check?.(contract.message);

    return true;
  });
};

interface ClientOptions {
  readonly generation?: number;
  readonly projectId?: string;
}

const tools = (
  core: RoutedCore,
  bundleId: string,
  { generation, projectId }: ClientOptions = {},
): Client<typeof ToolsService> =>
  core.client(ToolsService, bundleId, {
    ...(generation === undefined ? {} : { generation }),
    ...(projectId === undefined ? {} : { scope: { projectId } }),
  });

interface ToolSpec {
  readonly projectId?: string;
  readonly order?: number;
  readonly description?: string;
  readonly settings?: readonly Record<string, JsonValue>[];
}

const register = async (
  client: Client<typeof ToolsService>,
  name: string,
  spec: ToolSpec = {},
): Promise<string> => {
  const { registrationId } = await client.register({
    tool: {
      name,
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
      definition: {
        name,
        inputSchema: '{"type":"object"}',
        outputSchema: '{"type":"object"}',
      },
      settings: [...(spec.settings ?? [])] as never,
    },
    options: {
      alwaysAvailable: false,
      ...(spec.order === undefined ? {} : { order: spec.order }),
      ...(spec.projectId === undefined ? {} : { projectId: spec.projectId }),
    },
  });

  assert.notEqual(registrationId, '');

  return registrationId;
};

/** What a `List` entry tells: the tool, its Project and its registrant. */
const shapeOf = (entry: RegisteredTool) => ({
  name: entry.tool?.name,
  description: entry.tool?.description,
  projectId: entry.projectId,
  bundleId: entry.bundleId,
});

const listed = async (core: RoutedCore, projectId?: string) =>
  (
    await tools(core, 'runtime', projectId === undefined ? {} : { projectId })
      .list({})
  ).tools.map(shapeOf);

const value = (json: JsonValue) => fromJson(ValueSchema, json);

const withCore = async (run: (core: RoutedCore) => Promise<void>) => {
  const core = await serveCore();

  try {
    await run(core);
  } finally {
    await core.close();
  }
};

void test('T3.10/AC3.13: one name per Project, refused where Projects overlap', () =>
  withCore(async (core) => {
    const mcp = tools(core, 'mcp');
    const p1 = await register(mcp, 'search', { projectId: 'p1' });
    const p2 = await register(mcp, 'search', { projectId: 'p2' });

    assert.notEqual(p1, p2);
    assert.deepEqual(await listed(core, 'p1'), [
      { name: 'search', description: undefined, projectId: 'p1', bundleId: 'mcp' },
    ]);
    assert.deepEqual(await listed(core, 'p2'), [
      { name: 'search', description: undefined, projectId: 'p2', bundleId: 'mcp' },
    ]);
    assert.deepEqual(await listed(core), []);

    await rejectsWith(register(tools(core, 'other'), 'search'), 'duplicate_tool');
    await rejectsWith(register(mcp, 'search'), 'duplicate_tool');
  }));

void test('another bundle may use the name in a Project nobody else holds it in', () =>
  withCore(async (core) => {
    await register(tools(core, 'mcp'), 'search', { projectId: 'p1' });

    const other = tools(core, 'other');

    await register(other, 'search', { projectId: 'p3' });
    await rejectsWith(
      register(other, 'search', { projectId: 'p1' }),
      'duplicate_tool',
      (message) => {
        assert.equal(
          message,
          'Duplicate tool name "search": bundle "mcp" and bundle "other".',
        );
      },
    );
    assert.deepEqual(await listed(core, 'p3'), [
      { name: 'search', description: undefined, projectId: 'p3', bundleId: 'other' },
    ]);
  }));

void test('the same instance and key again replace the tool and keep the id', () =>
  withCore(async (core) => {
    const mcp = tools(core, 'mcp');
    const first = await register(mcp, 'search', {
      projectId: 'p1',
      description: 'old',
    });
    const again = await register(mcp, 'search', {
      projectId: 'p1',
      description: 'new',
    });

    assert.equal(again, first);
    assert.deepEqual(await listed(core, 'p1'), [
      { name: 'search', description: 'new', projectId: 'p1', bundleId: 'mcp' },
    ]);
  }));

void test('List and Catalog order: by order ascending across bundles, then unordered in registration order', () =>
  withCore(async (core) => {
    const mcp = tools(core, 'mcp');
    const other = tools(core, 'other');

    await register(mcp, 'b', { description: 'bee' });
    await register(other, 'z', { order: 2, description: 'zed' });
    await register(mcp, 'a', {
      order: 1,
      description: 'ay',
      settings: [{ key: 'depth', default: 2 }],
    });
    await register(other, 'c', { description: 'see' });

    assert.deepEqual(
      (await listed(core)).map(({ name, bundleId }) => [name, bundleId]),
      [
        ['a', 'mcp'],
        ['z', 'other'],
        ['b', 'mcp'],
        ['c', 'other'],
      ],
    );

    const { entries } = await tools(core, 'runtime').catalog({});

    assert.deepEqual(
      entries.map(({ name, description, settings }) => ({
        name,
        description,
        settings,
      })),
      [
        { name: 'a', description: 'ay', settings: [{ key: 'depth', default: 2 }] },
        { name: 'z', description: 'zed', settings: [] },
        { name: 'b', description: 'bee', settings: [] },
        { name: 'c', description: 'see', settings: [] },
      ],
    );
  }));

void test("a new generation serves the key, and the older one serves again once it is gone", () =>
  withCore(async (core) => {
    const gen1 = await register(tools(core, 'mcp'), 'search', {
      projectId: 'p1',
      description: 'gen 1',
    });
    const gen2 = await register(tools(core, 'mcp', { generation: 2 }), 'search', {
      projectId: 'p1',
      description: 'gen 2',
    });

    assert.notEqual(gen2, gen1);
    assert.deepEqual(await listed(core, 'p1'), [
      { name: 'search', description: 'gen 2', projectId: 'p1', bundleId: 'mcp' },
    ]);

    core.instanceGone({ bundleId: 'mcp', generation: 2 });

    assert.deepEqual(await listed(core, 'p1'), [
      { name: 'search', description: 'gen 1', projectId: 'p1', bundleId: 'mcp' },
    ]);
  }));

void test("an older instance's tool never refuses a newer instance's", () =>
  withCore(async (core) => {
    await register(tools(core, 'mcp'), 'search', { projectId: 'p2' });

    // Unscoped overlaps gen 1's p2 key, which gen 1 still serves.
    await register(tools(core, 'mcp', { generation: 2 }), 'search', {
      description: 'gen 2',
    });

    assert.deepEqual(await listed(core), [
      { name: 'search', description: 'gen 2', projectId: undefined, bundleId: 'mcp' },
    ]);
  }));

void test('Unregister removes from that Project only; unknown and foreign ids are no-ops', () =>
  withCore(async (core) => {
    const mcp = tools(core, 'mcp');
    const p1 = await register(mcp, 'search', { projectId: 'p1' });
    const p2 = await register(mcp, 'search', { projectId: 'p2' });

    await mcp.unregister({ registrationId: p1 });

    assert.deepEqual(await listed(core, 'p1'), []);
    assert.equal((await listed(core, 'p2')).length, 1);

    await mcp.unregister({ registrationId: 'no-such-id' });
    await tools(core, 'other').unregister({ registrationId: p2 });

    assert.deepEqual(await listed(core, 'p2'), [
      { name: 'search', description: undefined, projectId: 'p2', bundleId: 'mcp' },
    ]);
  }));

void test('Execute relays to the registering instance and answers its result', () =>
  withCore(async (core) => {
    const execute = (request: ToolHandlerServiceExecuteRequest) => ({
      result: value({
        from: request.name,
        echo: request.payload === undefined ? null : toJson(ValueSchema, request.payload),
      }),
    });

    core.handlers.set('mcp/1/1', { tools: { execute } });
    core.handlers.set('mcp/2/1', { tools: { execute } });
    await register(tools(core, 'mcp'), 'search', { projectId: 'p1' });

    const caller = tools(core, 'runtime', { projectId: 'p1' });
    const { result } = await caller.execute({
      name: 'search',
      payload: value({ q: 'x' }),
    });

    assert.ok(result !== undefined);
    assert.deepEqual(toJson(ValueSchema, result), {
      from: 'search',
      echo: { q: 'x' },
    });
    assert.deepEqual(
      core.handlerCalls.map(({ target, method, request }) => {
        const sent = request as ToolHandlerServiceExecuteRequest;

        return {
          target,
          method,
          name: sent.name,
          projectId: sent.projectId,
          payload: sent.payload === undefined ? undefined : toJson(ValueSchema, sent.payload),
        };
      }),
      [
        {
          target: 'mcp/1/1',
          method: 'execute',
          name: 'search',
          projectId: 'p1',
          payload: { q: 'x' },
        },
      ],
    );

    await register(tools(core, 'mcp', { generation: 2 }), 'search', {
      projectId: 'p1',
    });
    await caller.execute({ name: 'search', payload: value({ q: 'y' }) });

    assert.deepEqual(
      core.handlerCalls.map(({ target }) => target),
      ['mcp/1/1', 'mcp/2/1'],
    );
  }));

void test('Execute answers not_found for a tool the call does not see, with no handler call', () =>
  withCore(async (core) => {
    core.handlers.set('mcp/1/1', {
      tools: { execute: () => ({ result: value(true) }) },
    });
    await register(tools(core, 'mcp'), 'search', { projectId: 'p1' });

    await rejectsWith(
      tools(core, 'runtime', { projectId: 'p1' }).execute({
        name: 'missing',
        payload: value({}),
      }),
      'not_found',
    );
    await rejectsWith(
      tools(core, 'runtime', { projectId: 'p2' }).execute({
        name: 'search',
        payload: value({}),
      }),
      'not_found',
    );
    assert.deepEqual(core.handlerCalls, []);
  }));

void test("Execute answers the handler's failure with its Doric code", () =>
  withCore(async (core) => {
    core.handlers.set('mcp/1/1', {
      tools: {
        execute: () => {
          throw new ContractError('invalid_input', 'The query is empty.');
        },
      },
    });
    await register(tools(core, 'mcp'), 'search');

    await rejectsWith(
      tools(core, 'runtime').execute({ name: 'search', payload: value({}) }),
      'invalid_input',
    );
  }));

void test('Execute answers unavailable when the registering instance is unreachable', () =>
  withCore(async (core) => {
    // No handler entry for `mcp/1/1`: the instance cannot be reached.
    await register(tools(core, 'mcp'), 'search');

    await rejectsWith(
      tools(core, 'runtime').execute({ name: 'search', payload: value({}) }),
      'unavailable',
    );
  }));

void test("InstanceGone drops every tool of that instance and keeps the others'", () =>
  withCore(async (core) => {
    const mcp = tools(core, 'mcp');

    await register(mcp, 'search', { projectId: 'p1' });
    await register(mcp, 'fetch');
    await register(tools(core, 'other'), 'lookup');

    core.instanceGone({ bundleId: 'mcp', generation: 1 });

    assert.deepEqual(await listed(core, 'p1'), [
      { name: 'lookup', description: undefined, projectId: undefined, bundleId: 'other' },
    ]);
  }));
