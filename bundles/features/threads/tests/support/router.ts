// The harness of `threads`' host part through the router (phase 3, slice
// S52b): the eight delegation tools served from `ToolHandlerService` by
// `createTestRouter` as `src/host/main.ts` serves them (`createToolHandlers`,
// `registerThreadTools` in `activate`), with recording fakes of section D's
// services: `tools/v1` (`Register`), `runtime.threads/v1` (the eight
// controls, answering a domain `ThreadControl` as runtime encodes it) and
// `default.agents/v1` (`Resolve`). `core`'s calls to the handler service
// arrive through `router.client` with the caller `core` and the relayed
// prompt scope.

import {
  type DescMessage,
  type DescService,
  fromJson,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  type ContractError,
  callOf,
} from 'bundle/contracts';
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
import type { AgentDefinition } from 'default/contracts';
import {
  AgentDefinitionSchema,
  AgentsService,
  ResolveRequestSchema,
} from 'default/contracts/gen/doric/default/agents/v1/agents_pb.js';
import type { ThreadControl } from 'runtime/contracts';
import {
  EventsRequestSchema,
  EventsResponseSchema,
  GetRequestSchema,
  GetResponseSchema,
  InterruptRequestSchema,
  ListRequestSchema,
  ListResponseSchema,
  RestartRequestSchema,
  RestartResponseSchema,
  SendRequestSchema,
  SendResponseSchema,
  SpawnRequestSchema,
  SpawnResponseSchema,
  TerminateRequestSchema,
  TerminateResponseSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import { registerThreadTools } from '../../src/host/part.js';

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The scope of the `tools/v1.Execute` call `core` relays: one prompt. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'parent-1',
  promptId: 'prompt-1',
};

/** The services `threads`' host part declares it calls (section D). */
export const REQUIRES = [
  ToolsService.typeName,
  ThreadsService.typeName,
  AgentsService.typeName,
];

/** One call a fake received. */
export interface FakeCall {
  /** `ThreadsService` or `AgentsService` method, lowerCamel (`spawn`, `resolve`). */
  readonly method: string;
  /** The request as JSON, implicit fields emitted. */
  readonly request: JsonValue;
  /** `callOf(context).scope` of the call. */
  readonly scope: CallScope | undefined;
}

export interface HarnessOptions {
  /**
   * The domain answers of `runtime.threads/v1`'s controls: each fake method
   * calls the matching method with the request's values and answers its
   * result as runtime encodes it. A method left out fails the call.
   */
  readonly control?: Partial<ThreadControl>;
  /**
   * `default.agents/v1.Resolve`'s domain answer (may throw a
   * `ContractError`). Absent: no `AgentsService` fake (declared, unserved).
   */
  readonly agents?: (name: string) => AgentDefinition;
  /** What the part declares it calls; default {@link REQUIRES}. */
  readonly requires?: readonly string[];
  /** `tools/v1.Register` of the tool named so fails with this error. */
  readonly registerError?: {
    readonly name: string;
    readonly error: ContractError;
  };
}

export interface Harness {
  readonly router: TestRouter;
  readonly tools: ToolHandlers;
  /** `core`'s client of the bundle's `ToolHandlerService`, under {@link promptScope}. */
  readonly client: Client<typeof ToolHandlerService>;
  /** `tools/v1.Register` requests, as JSON, in order. */
  readonly registers: JsonValue[];
  /** `ThreadsService` and `AgentsService` calls, in order. */
  readonly calls: FakeCall[];
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
}

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** `json` as a message of `schema`, as a provider answers it. */
const answer = <Desc extends DescMessage>(
  schema: Desc,
  json: unknown,
): MessageShape<Desc> =>
  fromJson(schema, JSON.parse(JSON.stringify(json)) as JsonValue);

/** The control method `name`, or a failure when the test gave none. */
const method = <K extends keyof ThreadControl>(
  control: Partial<ThreadControl>,
  name: K,
): ThreadControl[K] => {
  const found = control[name];

  if (found === undefined) {
    throw new Error(`The test gave no ${name} answer.`);
  }

  return found as ThreadControl[K];
};

/**
 * `threads`' host part on a test router, not yet activated: `services` lists
 * `ToolHandlerService` (`tools.implementation`) and `activate` runs
 * `registerThreadTools(context, tools)`, as `main.ts` does.
 */
export const harness = (options: HarnessOptions = {}): Harness => {
  const tools = createToolHandlers();
  const registers: JsonValue[] = [];
  const calls: FakeCall[] = [];
  const control = options.control ?? {};
  let ids = 0;

  /** Records one call and answers its request's JSON. */
  const enter = <Desc extends DescMessage>(
    name: string,
    schema: Desc,
    request: MessageShape<Desc>,
    context: HandlerContext,
  ): Record<string, unknown> => {
    const json = toJson(schema, request, { alwaysEmitImplicit: true });

    calls.push({ method: name, request: json, scope: callOf(context).scope });

    return json as Record<string, unknown>;
  };

  const threads = fakeOf(ThreadsService, {
    spawn: async (request, context) => {
      const json = enter('spawn', SpawnRequestSchema, request, context);

      return answer(
        SpawnResponseSchema,
        await method(control, 'spawn')(
          request.prompt,
          request.title,
          json.options as Parameters<ThreadControl['spawn']>[2],
        ),
      );
    },
    list: async (request, context) => {
      enter('list', ListRequestSchema, request, context);

      return answer(
        ListResponseSchema,
        await method(control, 'list')(request.limit, request.cursor),
      );
    },
    get: async (request, context) => {
      enter('get', GetRequestSchema, request, context);

      return answer(
        GetResponseSchema,
        await method(control, 'get')(request.threadId),
      );
    },
    events: async (request, context) => {
      enter('events', EventsRequestSchema, request, context);

      return answer(
        EventsResponseSchema,
        await method(control, 'events')(
          request.threadId,
          request.afterSequence,
          request.limit,
        ),
      );
    },
    send: async (request, context) => {
      enter('send', SendRequestSchema, request, context);

      return answer(SendResponseSchema, {
        promptResult: await method(control, 'send')(
          request.threadId,
          request.prompt,
        ),
      });
    },
    restart: async (request, context) => {
      enter('restart', RestartRequestSchema, request, context);

      return answer(
        RestartResponseSchema,
        await method(control, 'restart')(request.threadId, request.prompt),
      );
    },
    interrupt: async (request, context) => {
      enter('interrupt', InterruptRequestSchema, request, context);

      return {
        interruptResult: await method(control, 'interrupt')(
          request.threadId,
          request.promptId,
        ),
      };
    },
    terminate: async (request, context) => {
      enter('terminate', TerminateRequestSchema, request, context);

      return answer(TerminateResponseSchema, {
        threadView: await method(control, 'terminate')(request.threadId),
      });
    },
  });

  const agents = options.agents;
  const agentsFakes: ServiceEntry[] =
    agents === undefined
      ? []
      : [
          fakeOf(AgentsService, {
            resolve: (request, context) => {
              enter('resolve', ResolveRequestSchema, request, context);

              return {
                agentDefinition: answer(
                  AgentDefinitionSchema,
                  agents(request.name),
                ),
              };
            },
          }),
        ];

  const router = createTestRouter({
    caller: core,
    scope: promptScope,
    requires: options.requires ?? REQUIRES,
    instance: { bundleId: 'threads' },
    fakes: [
      fakeOf(ToolsService, {
        register: (request) => {
          registers.push(toJson(RegisterRequestSchema, request));

          if (request.tool?.name === options.registerError?.name) {
            throw options.registerError?.error;
          }

          ids += 1;

          return { registrationId: `tool-${ids}` };
        },
        unregister: () => ({}),
      }),
      threads,
      ...agentsFakes,
    ],
  });

  return {
    router,
    tools,
    client: router.client(ToolHandlerService),
    registers,
    calls,
    activate: async () => {
      await router.activate({
        services: [[ToolHandlerService, tools.implementation]],
        activate: async (context) => {
          await registerThreadTools(context, tools);
        },
      });
    },
  };
};
