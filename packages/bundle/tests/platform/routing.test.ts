// The pure parts of calls between bundles (spec
// `docs/designs/grpc-processes.md`, section 3, steps 2 to 4, and section 5,
// "Host-to-bundle calls"; T2.3, T2.15): the call scope header, the `Call` a
// handler finds in its context, the routes of a resolution, the route of one
// call, and the instance table's active instance and its changes. No process,
// no listener.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  createContextValues,
  createHandlerContext,
  type HandlerContext,
} from '@connectrpc/connect';

import { type Call, deadlineOf, isCall } from '../../src/contracts/call.js';
import { isContractError } from '../../src/contracts/error.js';
import { file_doric_models_provider_v1_provider } from '../../src/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { file_doric_platform_generation_v1_generation } from '../../src/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import { file_doric_platform_log_v1_log } from '../../src/contracts/gen/doric/platform/log/v1/log_pb.js';
import {
  CallScopeSchema,
  CallStartSchema,
} from '../../src/contracts/gen/doric/platform/v1/control_pb.js';
import {
  file_doric_settings_v1_settings,
  SettingsService,
} from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  callContextKey,
  callOf,
  scopeFromHeader,
  scopeHeaderValue,
} from '../../src/contracts/metadata.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type InstanceRecord,
  InstanceTable,
} from '../../src/platform/router/instances.js';
import {
  callerInstanceKey,
  callerInstanceOf,
} from '../../src/platform/router/platform-services.js';
import {
  type CallRoutes,
  callRoutesOf,
  gatewayCaller,
  type PartDeclarations,
  type RouteEnv,
  routeCall,
} from '../../src/platform/router/route.js';
import { PLATFORM_VERSION } from '../../src/runtime/version.js';
import { callFromStart, currentCall } from '../../src/sdk/host/serve.js';
import { resolveCallHost } from '../support/call-routes.js';

// ---------------------------------------------------------------------------
// Helpers

/** Asserts a thrown value is a `ContractError` of `code`. */
const contractCode =
  (code: string) =>
  (error: unknown): true => {
    assert.ok(isContractError(error), `expected a ContractError: ${error}`);
    assert.equal(error.code, code);

    return true;
  };

/** The base64 of a binary `CallScope` with `entries`, written by hand. */
const encodeScope = (entries: Record<string, string>): string =>
  Buffer.from(
    toBinary(CallScopeSchema, create(CallScopeSchema, { entries })),
  ).toString('base64');

/** The entries of the binary `CallScope` a header value carries. */
const decodeScope = (value: string): Record<string, string> => ({
  ...fromBinary(CallScopeSchema, Buffer.from(value, 'base64')).entries,
});

/** A handler context whose values hold `values`, as a Connect server builds one. */
const handlerContext = (
  fill: (values: ReturnType<typeof createContextValues>) => void = () => {},
): HandlerContext => {
  const values = createContextValues();

  fill(values);

  return createHandlerContext({
    service: SettingsService,
    method: SettingsService.method.register,
    protocolName: 'grpc',
    requestMethod: 'POST',
    url: `http://127.0.0.1/${SettingsService.typeName}/Register`,
    contextValues: values,
  });
};

const index = createCatalogIndex([
  file_doric_settings_v1_settings,
  file_doric_models_provider_v1_provider,
  file_doric_tools_v1_tools,
  file_doric_platform_generation_v1_generation,
  file_doric_platform_log_v1_log,
]);

const path = (service: string, method: string): string =>
  `/${service}/${method}`;
const settingsRegister = path('doric.settings.v1.SettingsService', 'Register');
const providerAdvertised = path(
  'doric.models.provider.v1.ProviderService',
  'Advertised',
);
const handlerCheck = path('doric.tools.v1.ToolHandlerService', 'Check');
const generationDescribe = path(
  'doric.platform.generation.v1.GenerationService',
  'Describe',
);
const logWrite = path('doric.platform.log.v1.LogService', 'Write');

const declarations = (lists: {
  readonly requires?: readonly string[];
  readonly optional?: readonly string[];
  readonly provides?: readonly string[];
}): PartDeclarations => ({
  requires: new Set(lists.requires ?? []),
  optional: new Set(lists.optional ?? []),
  provides: new Set(lists.provides ?? []),
});

/**
 * Hand-written routes: `app`'s host part requires `settings/v1` and lists
 * `models.provider/v1` under `optional`, its client part requires
 * `tools/v1`; `settings` provides `settings/v1`; `core` provides `tools/v1`;
 * `stranger` declares nothing; any other bundle is not scheduled.
 */
const routesWith = (
  providers: Readonly<Record<string, readonly string[]>> = {},
): CallRoutes => {
  const parts: Readonly<Record<string, PartDeclarations>> = {
    'app/host': declarations({
      requires: ['settings/v1'],
      optional: ['models.provider/v1'],
    }),
    'app/client': declarations({ requires: ['tools/v1'] }),
    'settings/host': declarations({ provides: ['settings/v1'] }),
    'settings/client': declarations({ provides: ['settings/v1'] }),
    'core/host': declarations({ provides: ['tools/v1'] }),
    'core/client': declarations({ provides: ['tools/v1'] }),
    'stranger/host': declarations({}),
    'stranger/client': declarations({}),
  };
  const resolved: Readonly<Record<string, readonly string[]>> = {
    'settings/v1': ['settings'],
    'models.provider/v1': ['alpha', 'beta'],
    'tools/v1': ['core'],
    ...providers,
  };

  return {
    declarationsOf: (bundleId, part) => parts[`${bundleId}/${part}`],
    providersOf: (contractId) => resolved[contractId] ?? [],
    consumersOf: () => [],
  };
};

const record = (
  bundleId: string,
  generation = 1,
  incarnation = 1,
): InstanceRecord => ({
  bundleId,
  version: '1.0.0',
  generation,
  incarnation,
  state: 'active',
});

const envOf = (
  overrides: Partial<RouteEnv> & {
    readonly providers?: Readonly<Record<string, readonly string[]>>;
  } = {},
): RouteEnv => ({
  index,
  routes: overrides.routes ?? routesWith(overrides.providers),
  platformServices:
    overrides.platformServices ??
    new Set([
      'doric.platform.generation.v1.GenerationService',
      'doric.platform.log.v1.LogService',
    ]),
});

const route = (
  caller: string,
  requestPath: string,
  header: Record<string, string> = {},
  env: RouteEnv = envOf(),
) =>
  routeCall(
    {
      caller: record(caller),
      part: 'host',
      path: requestPath,
      header: new Headers(header),
    },
    env,
  );

// ---------------------------------------------------------------------------
// The scope header

describe('the doric-scope-bin header', () => {
  test('scopeHeaderValue writes the scope as a base64 binary CallScope', () => {
    const scope = { tenant: 't1', 'project.id': 'p-9', windowKey: 'w_1' };

    assert.deepEqual(decodeScope(scopeHeaderValue(scope)), scope);
  });

  test('scopeFromHeader reads back what scopeHeaderValue wrote, frozen', () => {
    const scope = { tenant: 't1', 'project.id': 'p-9' };
    const read = scopeFromHeader(scopeHeaderValue(scope));

    assert.deepEqual({ ...read }, scope);
    assert.ok(Object.isFrozen(read));
  });

  test('scopeFromHeader reads a CallScope another writer encoded', () => {
    assert.deepEqual(
      { ...scopeFromHeader(encodeScope({ a: '1' })) },
      { a: '1' },
    );
  });

  test('a value that is not base64 of a CallScope is invalid_scope', () => {
    assert.throws(
      () => scopeFromHeader(Buffer.from([0xff, 0xff, 0xff]).toString('base64')),
      contractCode('invalid_scope'),
    );
  });

  test('more than 16 keys is invalid_scope; 16 are accepted', () => {
    const entries = (count: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`k${i}`, 'v']),
      );

    assert.equal(
      Object.keys(scopeFromHeader(encodeScope(entries(16)))).length,
      16,
    );
    assert.throws(
      () => scopeFromHeader(encodeScope(entries(17))),
      contractCode('invalid_scope'),
    );
  });

  test('a key that breaks the key pattern is invalid_scope', () => {
    assert.throws(
      () => scopeFromHeader(encodeScope({ '1bad': 'v' })),
      contractCode('invalid_scope'),
    );
  });

  test('a value over 512 characters is invalid_scope; 512 is accepted', () => {
    assert.equal(
      scopeFromHeader(encodeScope({ k: 'x'.repeat(512) })).k?.length,
      512,
    );
    assert.throws(
      () => scopeFromHeader(encodeScope({ k: 'x'.repeat(513) })),
      contractCode('invalid_scope'),
    );
  });
});

// ---------------------------------------------------------------------------
// The Call of a handler

const sampleCall = (): Call => ({
  caller: { bundleId: 'app', version: '1.0.0', generation: 1 },
  signal: new AbortController().signal,
  trace: {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  },
});

describe('callOf and callerInstanceOf', () => {
  test('callOf answers the Call under callContextKey, the same each time', () => {
    const call = sampleCall();
    const context = handlerContext((values) =>
      values.set(callContextKey, call),
    );

    assert.equal(callOf(context), call);
    assert.equal(callOf(context), callOf(context));
  });

  test('callOf throws a TypeError for a context that holds no Call', () => {
    assert.throws(() => callOf(handlerContext()), TypeError);
  });

  test('callerInstanceOf answers the record the router put in the context', () => {
    const caller = record('app', 2, 3);
    const context = handlerContext((values) =>
      values.set(callerInstanceKey, caller),
    );

    assert.deepEqual(callerInstanceOf(context), caller);
  });

  test('callerInstanceOf throws a TypeError for a context the router did not fill', () => {
    assert.throws(() => callerInstanceOf(handlerContext()), TypeError);
  });
});

describe('callFromStart', () => {
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const start = (scope: Record<string, string>, deadlineUnixMs: number) =>
    create(CallStartSchema, {
      callId: 7n,
      method: settingsRegister,
      kind: 'unary',
      caller: {
        bundleId: 'app',
        version: '2.1.0',
        generation: 4,
        incarnation: 9,
      },
      scope,
      traceparent,
      deadlineUnixMs,
      initialCredit: 16,
      payload: new Uint8Array(),
    });

  test('the Call carries the stamped caller without its incarnation, the scope, the trace, the signal and the deadline', () => {
    const signal = new AbortController().signal;
    const call = callFromStart(
      start({ tenant: 't1' }, 1_900_000_000_000),
      signal,
    );

    assert.ok(isCall(call));
    assert.deepEqual(
      { ...call.caller },
      { bundleId: 'app', version: '2.1.0', generation: 4 },
    );
    assert.deepEqual({ ...call.scope }, { tenant: 't1' });
    assert.ok(Object.isFrozen(call.scope));
    assert.equal(call.trace.traceparent, traceparent);
    assert.equal(call.signal, signal);
    assert.equal(deadlineOf(call), 1_900_000_000_000);
    assert.ok(Object.isFrozen(call));
  });

  test('a start without scope keys has no scope; deadline 0 is none', () => {
    const call = callFromStart(start({}, 0), new AbortController().signal);

    assert.equal(call.scope, undefined);
    assert.equal(deadlineOf(call), 0);
  });

  test('currentCall answers undefined outside every handler', () => {
    assert.equal(currentCall(), undefined);
  });
});

// ---------------------------------------------------------------------------
// The routes of a resolution

describe('callRoutesOf', () => {
  test('a version 2 bundle is checked against the lists of each part', () => {
    const routes = callRoutesOf(resolveCallHost());
    const host = routes.declarationsOf('app', 'host');
    const client = routes.declarationsOf('app', 'client');

    assert.ok(host !== undefined && client !== undefined);
    assert.deepEqual([...host.requires], ['settings/v1']);
    assert.deepEqual(
      [...host.optional].sort(),
      ['events/v1', 'models.provider/v1'].sort(),
    );
    assert.deepEqual([...host.provides], []);
    assert.deepEqual([...client.requires], ['tools/v1']);
    assert.deepEqual([...client.optional], []);
  });

  test('a host part that only its client part requires a contract of does not list it', () => {
    const routes = callRoutesOf(resolveCallHost());

    assert.equal(
      routes.declarationsOf('web', 'host')?.requires.has('settings/v1'),
      false,
    );
    assert.equal(
      routes.declarationsOf('web', 'client')?.requires.has('settings/v1'),
      true,
    );
  });

  test('a version 1 bundle answers its bundle-wide lists for either part, and its provides', () => {
    const routes = callRoutesOf(resolveCallHost());

    for (const part of ['host', 'client'] as const) {
      const lists = routes.declarationsOf('core', part);

      assert.ok(lists !== undefined, part);
      assert.deepEqual([...lists.provides].sort(), [
        'hooks/v1',
        'skills/v1',
        'tools/v1',
      ]);
      assert.deepEqual([...lists.requires], []);
    }

    assert.deepEqual(
      [...(routes.declarationsOf('settings', 'host')?.provides ?? [])],
      ['settings/v1'],
    );
  });

  test('a bundle the resolution does not schedule has no declarations', () => {
    const routes = callRoutesOf(resolveCallHost());

    assert.equal(routes.declarationsOf('nobody', 'host'), undefined);
    assert.equal(routes.declarationsOf('broken', 'host'), undefined);
  });

  test('providersOf answers the resolved providers in order, and none for an unprovided contract', () => {
    const routes = callRoutesOf(resolveCallHost());

    assert.deepEqual(
      [...routes.providersOf('models.provider/v1')],
      ['alpha', 'beta'],
    );
    assert.deepEqual([...routes.providersOf('settings/v1')], ['settings']);
    assert.deepEqual([...routes.providersOf('events/v1')], []);
    assert.deepEqual([...routes.providersOf('missing/v1')], []);
  });

  test('the routes do not follow later changes of the resolution', () => {
    const resolved = resolveCallHost();
    const routes = callRoutesOf(resolved);

    (resolved.contracts as unknown as { id: string; providers: unknown[] }[])
      .find((contract) => contract.id === 'settings/v1')
      ?.providers.splice(0);

    assert.deepEqual([...routes.providersOf('settings/v1')], ['settings']);
  });
});

// ---------------------------------------------------------------------------
// The route of one call

describe('routeCall', () => {
  test('a contract the caller requires goes to the resolved provider', () => {
    const answer = route('app', settingsRegister);

    assert.equal(answer.kind, 'provider');
    assert.equal(answer.method.path, settingsRegister);
    assert.equal(
      answer.kind === 'provider' ? answer.bundleId : undefined,
      'settings',
    );
  });

  test('step 2: a path that is no method of the index is unknown_contract', () => {
    assert.throws(
      () => route('app', path('doric.unknown.v1.UnknownService', 'List')),
      contractCode('unknown_contract'),
    );
    assert.throws(
      () => route('app', path('doric.settings.v1.SettingsService', 'Nope')),
      contractCode('unknown_contract'),
    );
  });

  test('step 2: a doric.* contract the host does not serve is unknown_contract', () => {
    assert.throws(
      () =>
        route(
          'app',
          generationDescribe,
          {},
          envOf({ platformServices: new Set() }),
        ),
      contractCode('unknown_contract'),
    );
  });

  test('a doric.* contract the host serves is platform, for any caller', () => {
    for (const caller of ['app', 'stranger', 'nobody']) {
      const answer = route(caller, generationDescribe);

      assert.equal(answer.kind, 'platform', caller);
      assert.equal(answer.method.path, generationDescribe);
    }

    assert.equal(route('stranger', logWrite).kind, 'platform');
  });

  test('step 3: a contract the caller neither requires, lists nor provides is undeclared_requirement', () => {
    assert.throws(
      () => route('stranger', settingsRegister),
      contractCode('undeclared_requirement'),
    );
  });

  test('step 3: a caller the routes do not know is undeclared_requirement', () => {
    assert.throws(
      () => route('nobody', settingsRegister),
      contractCode('undeclared_requirement'),
    );
  });

  test('step 3: the host part is checked, not the client part', () => {
    assert.throws(
      () =>
        route('app', path('doric.tools.v1.ToolsService', 'List'), {
          'doric-provider': 'core',
        }),
      contractCode('undeclared_requirement'),
    );
  });

  test('step 3: a contract listed under optional, or provided by the caller, passes', () => {
    assert.equal(
      route('app', providerAdvertised, { 'doric-provider': 'beta' }).kind,
      'provider',
    );
    assert.equal(route('settings', settingsRegister).kind, 'provider');
  });

  test('step 3 comes before step 4: an undeclared many contract without doric-provider is undeclared_requirement', () => {
    assert.throws(
      () => route('stranger', providerAdvertised),
      contractCode('undeclared_requirement'),
    );
  });

  test('step 4, one: doric-provider is ignored', () => {
    const answer = route('app', settingsRegister, {
      'doric-provider': 'elsewhere',
    });

    assert.equal(
      answer.kind === 'provider' ? answer.bundleId : undefined,
      'settings',
    );
  });

  test('step 4, one: no provider is unavailable', () => {
    assert.throws(
      () =>
        route(
          'app',
          settingsRegister,
          {},
          envOf({ providers: { 'settings/v1': [] } }),
        ),
      contractCode('unavailable'),
    );
  });

  test('step 4, many: the provider doric-provider names', () => {
    const answer = route('app', providerAdvertised, {
      'doric-provider': 'beta',
    });

    assert.equal(answer.kind, 'provider');
    assert.equal(
      answer.kind === 'provider' ? answer.bundleId : undefined,
      'beta',
    );
  });

  test('step 4, many: without doric-provider is invalid_input', () => {
    assert.throws(
      () => route('app', providerAdvertised),
      contractCode('invalid_input'),
    );
  });

  test('step 4, many: a doric-provider not among the providers is unknown_provider', () => {
    assert.throws(
      () => route('app', providerAdvertised, { 'doric-provider': 'gamma' }),
      contractCode('unknown_provider'),
    );
  });

  test('handler service: the provider of its contract reaches the doric-target instance', () => {
    const answer = route('core', handlerCheck, { 'doric-target': 'app/3/2' });

    assert.equal(answer.kind, 'target');
    assert.equal(answer.method.path, handlerCheck);
    assert.equal(
      answer.kind === 'target' ? answer.target : undefined,
      'app/3/2',
    );
  });

  test('handler service: a caller that does not provide its contract is not_owner', () => {
    assert.throws(
      () => route('app', handlerCheck, { 'doric-target': 'core/1/1' }),
      contractCode('not_owner'),
    );
    assert.throws(
      () => route('stranger', handlerCheck, { 'doric-target': 'core/1/1' }),
      contractCode('not_owner'),
    );
  });

  test('handler service: the provider without doric-target is not_owner', () => {
    assert.throws(() => route('core', handlerCheck), contractCode('not_owner'));
  });

  test('handler service: a malformed doric-target is invalid_input', () => {
    for (const target of ['app', 'app/1', 'app/x/1', 'app/1/2/3']) {
      assert.throws(
        () => route('core', handlerCheck, { 'doric-target': target }),
        contractCode('invalid_input'),
        target,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// routeCall for a gateway call: the declaring bundle (D34, T2.17)

describe('routeCall with declaredBy', () => {
  const toolsList = path('doric.tools.v1.ToolsService', 'List');
  const gatewayRoute = (
    declaredBy: string | null | undefined,
    requestPath: string,
    header: Record<string, string> = {},
  ) =>
    routeCall(
      {
        caller: gatewayCaller,
        part: 'client',
        ...(declaredBy === undefined ? {} : { declaredBy }),
        path: requestPath,
        header: new Headers(header),
      },
      envOf(),
    );

  test('the gateway caller is the platform doric at the platform version, generation 0', () => {
    assert.equal(gatewayCaller.bundleId, 'doric');
    assert.equal(gatewayCaller.version, PLATFORM_VERSION);
    assert.equal(gatewayCaller.generation, 0);
  });

  test('a bundle id: the client part it names is checked, and a contract its lists hold goes to the provider', () => {
    const answer = gatewayRoute('app', toolsList);

    assert.equal(answer.kind, 'provider');
    assert.equal(
      answer.kind === 'provider' ? answer.bundleId : undefined,
      'core',
    );
  });

  test('a bundle id: a contract its client part does not list is undeclared_requirement, whatever its host part lists', () => {
    assert.throws(
      () => gatewayRoute('app', settingsRegister),
      contractCode('undeclared_requirement'),
    );
    assert.throws(
      () => gatewayRoute('stranger', toolsList),
      contractCode('undeclared_requirement'),
    );
  });

  test('a bundle id the routes do not know is undeclared_requirement', () => {
    assert.throws(
      () => gatewayRoute('nobody', toolsList),
      contractCode('undeclared_requirement'),
    );
  });

  test('a bundle id that provides the contract passes', () => {
    assert.equal(gatewayRoute('core', toolsList).kind, 'provider');
  });

  test('null: nothing is checked at step 3', () => {
    const tools = gatewayRoute(null, toolsList);
    const settings = gatewayRoute(null, settingsRegister);

    assert.equal(
      tools.kind === 'provider' ? tools.bundleId : tools.kind,
      'core',
    );
    assert.equal(
      settings.kind === 'provider' ? settings.bundleId : settings.kind,
      'settings',
    );
  });

  test("undefined: the caller's own bundle is checked, as for a call on the router listener", () => {
    assert.throws(
      () => gatewayRoute(undefined, toolsList),
      contractCode('undeclared_requirement'),
    );
    assert.equal(
      routeCall(
        {
          caller: record('app'),
          part: 'client',
          path: toolsList,
          header: new Headers(),
        },
        envOf(),
      ).kind,
      'provider',
    );
  });

  test('a handler service answers not_owner for every declaredBy', () => {
    for (const declaredBy of [null, 'core', 'app']) {
      assert.throws(
        () =>
          gatewayRoute(declaredBy, handlerCheck, { 'doric-target': 'app/1/1' }),
        contractCode('not_owner'),
        String(declaredBy),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The instance table: the active instance and its changes

describe('InstanceTable.activeOf', () => {
  const issue = (table: InstanceTable, generation: number, incarnation = 1) =>
    table.issue({
      bundleId: 'app',
      version: '1.0.0',
      generation,
      incarnation,
    });

  test('answers undefined while no instance of the bundle is active', () => {
    const table = new InstanceTable();

    issue(table, 1);
    assert.equal(table.activeOf('app'), undefined);
    table.setState('app/1/1', 'connected');
    assert.equal(table.activeOf('app'), undefined);
    assert.equal(table.activeOf('nobody'), undefined);
  });

  test('answers the active instance, not a draining or stopped one', () => {
    const table = new InstanceTable();

    issue(table, 1);
    issue(table, 2);
    table.setState('app/1/1', 'active');
    assert.equal(table.activeOf('app')?.generation, 1);

    table.setState('app/1/1', 'draining');
    table.setState('app/2/1', 'active');
    assert.deepEqual(table.activeOf('app'), {
      bundleId: 'app',
      version: '1.0.0',
      generation: 2,
      incarnation: 1,
      state: 'active',
    });

    table.setState('app/2/1', 'stopped');
    assert.equal(table.activeOf('app'), undefined);
  });
});

describe('InstanceTable.subscribe', () => {
  test('calls the listener with the new record, synchronously, for every applied change', () => {
    const table = new InstanceTable();
    const seen: string[] = [];

    table.issue({
      bundleId: 'app',
      version: '1.0.0',
      generation: 1,
      incarnation: 1,
    });
    table.subscribe((changed) =>
      seen.push(`${changed.bundleId}/${changed.generation} ${changed.state}`),
    );

    table.setState('app/1/1', 'connected');
    assert.deepEqual(seen, ['app/1 connected']);
    table.setState('app/1/1', 'active');
    assert.deepEqual(seen, ['app/1 connected', 'app/1 active']);
  });

  test('is not called for an ignored change', () => {
    const table = new InstanceTable();
    const seen: string[] = [];

    table.issue({
      bundleId: 'app',
      version: '1.0.0',
      generation: 1,
      incarnation: 1,
    });
    table.setState('app/1/1', 'lost');
    table.subscribe((changed) => seen.push(changed.state));

    table.setState('nobody/1/1', 'active');
    table.setState('app/1/1', 'active');
    assert.deepEqual(seen, []);
  });

  test('the answered function removes the listener', () => {
    const table = new InstanceTable();
    const seen: string[] = [];

    table.issue({
      bundleId: 'app',
      version: '1.0.0',
      generation: 1,
      incarnation: 1,
    });
    const unsubscribe = table.subscribe((changed) => seen.push(changed.state));

    table.setState('app/1/1', 'connected');
    unsubscribe();
    table.setState('app/1/1', 'active');
    assert.deepEqual(seen, ['connected']);
  });

  test('a listener that throws stops neither the others nor the change', () => {
    const table = new InstanceTable();
    const seen: string[] = [];

    table.issue({
      bundleId: 'app',
      version: '1.0.0',
      generation: 1,
      incarnation: 1,
    });
    table.subscribe(() => {
      throw new Error('listener failed');
    });
    table.subscribe((changed) => seen.push(changed.state));

    assert.doesNotThrow(() => table.setState('app/1/1', 'active'));
    assert.deepEqual(seen, ['active']);
    assert.equal(table.get('app/1/1')?.state, 'active');
  });
});
