// The harness of `transport`'s host part through the router (phase 3, S60c):
// the `doric.api.*` services of S60c and the `onHostStartHook` handler served
// by `createTestRouter` as `src/host/main.ts` will serve them
// (`createTransportHost`, its `activate`, its `invalidInput`), with
// `requires` = inventory row D 336 and recording fakes of the generated
// services the routes call. Each fake a test supplies records its request,
// `callOf(context).scope` and `deadlineOf` through `record`.

import { type DescService, type JsonValue, toJson } from '@bufbuild/protobuf';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  type ContractError,
  callOf,
  deadlineOf,
} from 'bundle/contracts';
import {
  HookHandlerService,
  RegisterRequestSchema as HookRegisterRequestSchema,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  LogRequestSchema,
  StageRequestSchema,
  StartupService,
} from 'bundle/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import { FilesService } from 'files/contracts/gen/doric/files/v1/files_pb.js';
import { CommandsService } from 'git/contracts/gen/doric/git/commands/v1/commands_pb.js';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { ResourcesService } from 'resources/contracts/gen/doric/resources/v1/resources_pb.js';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { ThreadsService } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { RuntimeService } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { SandboxService } from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import { TerminalService } from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';
import { UsageService } from 'usage/contracts/gen/doric/usage/v1/usage_pb.js';

import { ConfigService } from '../../src/contracts/gen/doric/api/config/v1/config_pb.js';
import { CredentialsService } from '../../src/contracts/gen/doric/api/credentials/v1/credentials_pb.js';
import { HostService } from '../../src/contracts/gen/doric/api/host/v1/host_pb.js';
import { ProvidersService } from '../../src/contracts/gen/doric/api/providers/v1/providers_pb.js';
import { StatusService } from '../../src/contracts/gen/doric/api/status/v1/status_pb.js';
import { TerminalsService } from '../../src/contracts/gen/doric/api/terminals/v1/terminals_pb.js';
import {
  createTransportHost,
  type TransportHost,
} from '../../src/host/process/service.js';

/** `core`, as the router stamps it on its calls to the handler services. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/**
 * The services `transport` calls (inventory row D 336): `requires` `hooks/v1`,
 * `runtime/v2`, `runtime.threads/v1`, `runtime.lease/v1`, `sandbox/v1`,
 * `tools/v1`, `models/v1`, `secrets/v1`, `host-config/v1`; `optional`
 * `files/v1`, `git.commands/v1`, `usage/v1`, `resources/v1`, `terminal/v1`.
 */
export const REQUIRES: readonly string[] = [
  HooksService.typeName,
  RuntimeService.typeName,
  ThreadsService.typeName,
  LeaseService.typeName,
  SandboxService.typeName,
  ToolsService.typeName,
  ModelsService.typeName,
  SecretsService.typeName,
  HostConfigService.typeName,
  FilesService.typeName,
  CommandsService.typeName,
  UsageService.typeName,
  ResourcesService.typeName,
  TerminalService.typeName,
];

/** The typeNames of the eight `doric.api.*` services (Q5's `apiServices`). */
export const API_SERVICES: readonly string[] = [
  'doric.api.config.v1.ConfigService',
  'doric.api.credentials.v1.CredentialsService',
  'doric.api.providers.v1.ProvidersService',
  'doric.api.host.v1.HostService',
  'doric.api.projects.v1.ProjectsService',
  'doric.api.threads.v1.ThreadsService',
  'doric.api.terminals.v1.TerminalsService',
  'doric.api.status.v1.StatusService',
];

/** One call a fake received. */
export interface FakeCall {
  /** `<fake>.<method>`, e.g. `secrets.create`, `hostConfig.replace`. */
  readonly method: string;
  /** The request as JSON (fields at their default left out). */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
}

/** Records one fake call; the fakes a test writes call it first. */
export type Recorder = (
  method: string,
  request: JsonValue,
  context: HandlerContext,
) => void;

export interface HarnessOptions {
  /** The fakes of the consumed services; `hooks/v1` and `doric.startup/v1` are the harness's. */
  readonly fakes?: (record: Recorder) => readonly ServiceEntry[];
  /** `hooks/v1.Register` fails with this error. */
  readonly hookRegisterError?: ContractError;
}

export interface Harness {
  readonly router: TestRouter;
  readonly host: TransportHost;
  /** Every call of a consumed fake (not hooks or startup), in order. */
  readonly calls: FakeCall[];
  /** `hooks/v1.Register` requests as JSON. */
  readonly hookRegisters: JsonValue[];
  /** `doric.startup/v1` calls: `{method: 'stage'|'log', request}`. */
  readonly startup: { readonly method: string; readonly request: JsonValue }[];
  readonly config: () => Client<typeof ConfigService>;
  readonly credentials: () => Client<typeof CredentialsService>;
  readonly providers: () => Client<typeof ProvidersService>;
  readonly hostApi: () => Client<typeof HostService>;
  readonly terminals: () => Client<typeof TerminalsService>;
  readonly status: () => Client<typeof StatusService>;
  readonly hooks: () => Client<typeof HookHandlerService>;
  /** Activates the part as `main.ts` does (services, `invalidInput`, `activate`, `deactivate`). */
  activate(): Promise<void>;
  /** Serves the part's services and `invalidInput` without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
}

/** `transport`'s host part on a test router, not yet activated. */
export const harness = (options: HarnessOptions = {}): Harness => {
  const host = createTransportHost();
  const calls: FakeCall[] = [];
  const hookRegisters: JsonValue[] = [];
  const startup: { readonly method: string; readonly request: JsonValue }[] =
    [];
  const record: Recorder = (method, request, context) => {
    const call = callOf(context);

    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
    });
  };

  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'transport' },
    fakes: [
      fakeOf(HooksService, {
        register: (request) => {
          hookRegisters.push(toJson(HookRegisterRequestSchema, request));
          if (options.hookRegisterError !== undefined) {
            throw options.hookRegisterError;
          }

          return { registrationId: `hook-${hookRegisters.length}` };
        },
        unregister: () => ({}),
      }),
      fakeOf(StartupService, {
        stage: (request) => {
          startup.push({
            method: 'stage',
            request: toJson(StageRequestSchema, request),
          });

          return {};
        },
        log: (request) => {
          startup.push({
            method: 'log',
            request: toJson(LogRequestSchema, request),
          });

          return {};
        },
      }),
      ...(options.fakes?.(record) ?? []),
    ],
  });

  const services = () =>
    [
      [ConfigService, host.config],
      [CredentialsService, host.credentials],
      [ProvidersService, host.providers],
      [HostService, host.host],
      [TerminalsService, host.terminals],
      [StatusService, host.status],
      [HookHandlerService, host.hooks.implementation],
    ] as const;

  return {
    router,
    host,
    calls,
    hookRegisters,
    startup,
    config: () => router.client(ConfigService),
    credentials: () => router.client(CredentialsService),
    providers: () => router.client(ProvidersService),
    hostApi: () => router.client(HostService),
    terminals: () => router.client(TerminalsService),
    status: () => router.client(StatusService),
    hooks: () => router.client(HookHandlerService, { caller: core }),
    activate: async () => {
      await router.activate({
        services: services(),
        invalidInput: host.invalidInput,
        activate: (context) => host.activate(context),
        deactivate: () => host.deactivate(),
      });
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: services(),
        invalidInput: host.invalidInput,
        activate: () => undefined,
      });
    },
  };
};

/** One fake service from a partial implementation (a method left out fails the call). */
export const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;
