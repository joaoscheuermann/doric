import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { create, type DescService, toJson } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { Code, type ServiceImpl } from '@connectrpc/connect';
import { type Caller, ContractError } from 'bundle/contracts';
import {
  HookHandlerService,
  HooksService,
  RegisterRequestSchema,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { OnHostStartHookInputSchema } from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { StartupService } from 'bundle/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import { createHookHandlers, type ServiceEntry } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';

import { registerSandboxPoolStep } from '../src/host/start.js';
import { failsWith } from './support/served.js';

// `docker`'s start step in its process (phase 3, S61b): activation registers
// an `onHostStartHook` handler with `hooks/v1.Register`, and the host's run,
// a `HookHandlerService.Handle` call from `core`, stages `sandbox_pool` and
// logs the pool's settings through `doric.startup/v1`. The bundle runs as
// `main.ts` activates it (without the pool binding), over fake `hooks/v1` and
// `doric.startup/v1` that record what they receive.

/** `core`, as the router stamps it on its calls to the handler service. */
const core: Caller = { bundleId: 'core', version: '1.0.0', generation: 1 };

/** The deployment the pool is configured from. */
const environment = {
  DORIC_SANDBOX_IMAGE: 'doric-sandbox:test',
  DORIC_SANDBOX_SSH: 'true',
  DORIC_SANDBOX_DOCKER_SOCKET: 'true',
  DORIC_SANDBOX_CPUS: '2',
  DORIC_SANDBOX_MEMORY_MIB: '1024',
};

/** A service entry that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

type StartupRecord =
  | readonly ['stage', string]
  | readonly ['log', string, string, unknown];

const open = async (
  t: TestContext,
  options: { readonly stageError?: ContractError } = {},
) => {
  const registers: unknown[] = [];
  const startup: StartupRecord[] = [];
  const hooksFake: Partial<ServiceImpl<typeof HooksService>> = {
    register: (request) => {
      registers.push(toJson(RegisterRequestSchema, request));

      return { registrationId: 'hook-1' };
    },
    unregister: () => ({}),
  };
  const startupFake: Partial<ServiceImpl<typeof StartupService>> = {
    stage: (request) => {
      startup.push(['stage', request.name]);
      if (options.stageError !== undefined) throw options.stageError;

      return {};
    },
    log: (request) => {
      startup.push([
        'log',
        request.level,
        request.message,
        request.fields ?? {},
      ]);

      return {};
    },
  };
  const router = createTestRouter({
    fakes: [
      partial(HooksService, hooksFake),
      partial(StartupService, startupFake),
    ],
    requires: [HooksService.typeName],
  });
  const hooks = createHookHandlers();

  t.after(() => router.control.stop());

  await router.activate({
    services: [[HookHandlerService, hooks.implementation]],
    activate: async (context) => {
      await registerSandboxPoolStep(hooks, context, environment);
    },
  });

  return {
    registers,
    startup,
    handleStart: () =>
      router.client(HookHandlerService, { caller: core }).handle({
        contract: 'doric.app.hooks/v1',
        hook: 'onHostStartHook',
        input: anyPack(
          OnHostStartHookInputSchema,
          create(OnHostStartHookInputSchema),
        ),
      }),
  };
};

void test('the host-start handler stages sandbox_pool and logs Configuring sandbox pool, then Sandbox pool configured with the docker settings', async (t) => {
  const served = await open(t);

  const response = await served.handleStart();

  assert.equal(response.output, undefined);
  assert.equal(response.decision, undefined);
  assert.deepEqual(served.startup, [
    ['stage', 'sandbox_pool'],
    [
      'log',
      'info',
      'Configuring sandbox pool',
      { sandboxProviderName: 'docker' },
    ],
    [
      'log',
      'info',
      'Sandbox pool configured',
      {
        sandboxProviderName: 'docker',
        sandboxImage: 'doric-sandbox:test',
        sandboxResources: { cpuCount: 2, memoryMiB: 1024, diskMiB: 4096 },
        minIdle: 0,
        maxSandboxes: 10,
        maxCreateAttempts: 3,
        networkMode: 'egress',
        sshEnabled: true,
        dockerSocketShared: true,
      },
    ],
  ]);
});

void test('activation registers onHostStartHook with hooks/v1.Register', async (t) => {
  const served = await open(t);

  assert.deepEqual(served.registers, [
    { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
  ]);
  assert.deepEqual(served.startup, []);
});

void test('a failing Stage fails Handle with its code, and nothing is logged', async (t) => {
  const served = await open(t, {
    stageError: new ContractError('unavailable', 'no startup record'),
  });

  await assert.rejects(
    served.handleStart(),
    failsWith(Code.Unavailable, 'unavailable'),
  );
  assert.deepEqual(served.startup, [['stage', 'sandbox_pool']]);
});
