// `ThreadToolPorts` over the router (phase 3, S52b): `runtime.threads/v1`'s
// `ThreadsService` and `default.agents/v1`'s `AgentsService`.

import {
  type DescMessage,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { isContractError } from 'bundle/contracts';
import { contractErrorOf, type HostServices } from 'bundle/host';
import type { AgentDefinition } from 'default/contracts';
import {
  AgentsService,
  ResolveResponseSchema,
} from 'default/contracts/gen/doric/default/agents/v1/agents_pb.js';
import type {
  InterruptResult,
  PromptResult,
  ThreadView,
} from 'runtime/contracts';
import {
  EventsResponseSchema,
  GetResponseSchema,
  ListResponseSchema,
  RestartResponseSchema,
  SendResponseSchema,
  SpawnResponseSchema,
  TerminateResponseSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import type { ThreadToolPorts } from './threads.js';

/** `message` as the kernel value `T`: its JSON with implicit fields emitted. */
const jsonOf = <T, Desc extends DescMessage = DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): T => toJson(schema, message, { alwaysEmitImplicit: true }) as T;

/** Runs `request`, rejecting with `contractErrorOf` of its failure. */
const routed = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** `routed(request)`, answered as `jsonOf(schema, answer)`. */
const routedJson = <T, Desc extends DescMessage = DescMessage>(
  schema: Desc,
  request: () => Promise<MessageShape<Desc>>,
): Promise<T> => routed(async () => jsonOf<T, Desc>(schema, await request()));

/**
 * `ThreadToolPorts` over the router; makes no call until a method is called.
 * Calls are made inside the tool's `Execute` handler, so they carry the
 * relayed call's scope (the calling prompt), deadline and signal.
 * - `controls(call)`: `ThreadsService` `Spawn{prompt, title?, options?}`,
 *   `List{limit, cursor?}`, `Get{threadId}`, `Events{threadId, afterSequence,
 *   limit}`, `Send{threadId, prompt}`, `Restart{threadId, prompt?}`,
 *   `Interrupt{threadId, promptId}`, `Terminate{threadId}`. Each answers
 *   `toJson(responseSchema, answer, {alwaysEmitImplicit: true})`, unwrapped to
 *   the kernel value: `SendResponse.promptResult`,
 *   `InterruptResponse.interruptResult`, `TerminateResponse.threadView`, the
 *   rest whole.
 * - `resolveAgent`: `AgentsService.Resolve{name}` → `toJson(…,
 *   {alwaysEmitImplicit: true})` of `agentDefinition`; any `unavailable`
 *   rejects with `Error('Agent types are unavailable in this runtime.')`.
 * Every other failure rejects with `contractErrorOf`'s `ContractError`.
 */
export const routedThreadToolPorts = (
  services: Pick<HostServices, 'use'>,
): ThreadToolPorts => {
  let threadsClient: Client<typeof ThreadsService> | undefined;
  let agentsClient: Client<typeof AgentsService> | undefined;
  const threads = () => {
    threadsClient ??= services.use(ThreadsService);
    return threadsClient;
  };
  const agents = () => {
    agentsClient ??= services.use(AgentsService);
    return agentsClient;
  };

  return {
    controls: () => ({
      spawn: (prompt, title, options) =>
        routedJson(SpawnResponseSchema, () =>
          threads().spawn({ prompt, title, options }),
        ),
      list: (limit, cursor) =>
        routedJson(ListResponseSchema, () => threads().list({ limit, cursor })),
      get: (threadId) =>
        routedJson(GetResponseSchema, () => threads().get({ threadId })),
      events: (threadId, afterSequence, limit) =>
        routedJson(EventsResponseSchema, () =>
          threads().events({ threadId, afterSequence, limit }),
        ),
      send: async (threadId, prompt) =>
        (
          await routedJson<{ promptResult: PromptResult }>(
            SendResponseSchema,
            () => threads().send({ threadId, prompt }),
          )
        ).promptResult,
      restart: (threadId, prompt) =>
        routedJson(RestartResponseSchema, () =>
          threads().restart({ threadId, prompt }),
        ),
      interrupt: (threadId, promptId) =>
        routed(
          async () =>
            (await threads().interrupt({ threadId, promptId }))
              .interruptResult as InterruptResult,
        ),
      terminate: async (threadId) =>
        (
          await routedJson<{ threadView: ThreadView }>(
            TerminateResponseSchema,
            () => threads().terminate({ threadId }),
          )
        ).threadView,
    }),
    resolveAgent: async (name) => {
      try {
        return jsonOf<{ agentDefinition: AgentDefinition }>(
          ResolveResponseSchema,
          await agents().resolve({ name }),
        ).agentDefinition;
      } catch (error) {
        const failure = contractErrorOf(error);

        if (isContractError(failure) && failure.code === 'unavailable') {
          throw new Error('Agent types are unavailable in this runtime.');
        }
        throw failure;
      }
    },
  };
};
