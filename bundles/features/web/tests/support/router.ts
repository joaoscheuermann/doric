// The harness of `web`'s host part through the router (phase 3, slice S50a):
// the web tool served from `ToolHandlerService` by `createTestRouter` as
// `src/host/main.ts` serves it (`createToolHandlers`, `registerWebTool` in
// `activate`), with a recording fake of `tools/v1` (`Register`,
// `Unregister`). `core`'s calls to the handler service arrive through
// `router.client` with the caller `core`.

import type { DescService, JsonValue } from '@bufbuild/protobuf';
import { toJson } from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import type { Caller, CallScope, ContractError } from 'bundle/contracts';
import {
  RegisterRequestSchema,
  ToolHandlerService,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  createToolHandlers,
  type ServiceEntry,
  type ToolHandlers,
} from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';

import { registerWebTool } from '../../src/host/part.js';
import type { WebToolOptions } from '../../src/host/tools/web.js';

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The scope of the `tools/v1` call `core` relays. */
export const relayed: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
};

/** The services `web`'s host part declares it calls. */
export const REQUIRES = [ToolsService.typeName];

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

export interface HarnessOptions {
  /** What `registerWebTool` passes to `createTool`: the fetch fake. */
  readonly tool?: WebToolOptions;
  /** `tools/v1.Register` fails with this error. */
  readonly registerError?: ContractError;
}

export interface Harness {
  readonly router: TestRouter;
  readonly tools: ToolHandlers;
  /** `core`'s client of the bundle's `ToolHandlerService`. */
  readonly client: Client<typeof ToolHandlerService>;
  /** `tools/v1.Register` requests, as JSON, in order. */
  readonly registers: JsonValue[];
  /** `tools/v1.Unregister` registration ids, in order. */
  readonly unregisters: string[];
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
}

/**
 * `web`'s host part on a test router, not yet activated: `services` lists
 * `ToolHandlerService` (`tools.implementation`) and `activate` runs
 * `registerWebTool(context, tools, options.tool)`, as `main.ts` does.
 */
export const harness = (options: HarnessOptions = {}): Harness => {
  const tools = createToolHandlers();
  const registers: JsonValue[] = [];
  const unregisters: string[] = [];
  let ids = 0;

  const router = createTestRouter({
    caller: core,
    scope: relayed,
    requires: REQUIRES,
    fakes: [
      fakeOf(ToolsService, {
        register: (request) => {
          registers.push(toJson(RegisterRequestSchema, request));

          if (options.registerError !== undefined) {
            throw options.registerError;
          }

          ids += 1;

          return { registrationId: `tool-${ids}` };
        },
        unregister: (request) => {
          unregisters.push(request.registrationId);

          return {};
        },
      }),
    ],
  });

  return {
    router,
    tools,
    client: router.client(ToolHandlerService),
    registers,
    unregisters,
    activate: async () => {
      await router.activate({
        services: [[ToolHandlerService, tools.implementation]],
        activate: async (context) => {
          await registerWebTool(context, tools, options.tool);
        },
      });
    },
  };
};
