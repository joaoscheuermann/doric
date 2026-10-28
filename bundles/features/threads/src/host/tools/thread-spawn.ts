import {
  type Call,
  isContractError,
  ModelsV1,
  type Services,
} from 'bundle/contracts';
import {
  type AgentDefinition,
  agentNamePattern,
  DefaultAgentsV1,
} from 'default/contracts';
import { ConfigurationV1 } from 'host-config/contracts';
import { reasoningEfforts, type SpawnOptions } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { threadsOf } from '../threads.js';

/** default.agents/v1.resolve; maps the absent contract to the unavailable error, rethrows every other error unchanged. */
const resolveAgent = async (
  services: Services,
  call: Call,
  name: string,
): Promise<AgentDefinition> => {
  try {
    return await services
      .use(DefaultAgentsV1, call.scope)
      .resolve({ name }, call);
  } catch (error) {
    if (
      isContractError(error) &&
      error.code === 'unavailable' &&
      typeof error.details === 'object' &&
      error.details !== null &&
      'contract' in error.details &&
      error.details.contract === DefaultAgentsV1.id
    ) {
      throw new Error('Agent types are unavailable in this runtime.');
    }
    throw error;
  }
};

/** Throws when model/effort are not valid on models.execution.providerId; resolves when accepted. */
const checkModel = async (
  services: Services,
  call: Call,
  requested: Pick<SpawnOptions, 'model' | 'effort'>,
): Promise<void> => {
  const { configuration } = await services.use(ConfigurationV1).current(call);
  const execution = configuration.models.execution;
  const threadId = call.scope?.threadId;
  const parent =
    requested.model === undefined && threadId !== undefined
      ? await threadsOf(services, call).thread(threadId, call)
      : undefined;
  const model = requested.model ?? parent?.model ?? execution.model;
  const listed = configuration.providers.find(
    ({ id }) => id === execution.providerId,
  )?.models;
  const entry = listed?.find(({ name }) => name === model);

  if (requested.model !== undefined && listed !== undefined && !entry) {
    throw new Error(
      `Model "${requested.model}" is not available on provider "${execution.providerId}". Available models: ${listed.map(({ name }) => name).join(', ')}.`,
    );
  }
  if (
    requested.effort !== undefined &&
    entry?.reasonings !== undefined &&
    !entry.reasonings.includes(requested.effort)
  ) {
    throw new Error(
      `Effort "${requested.effort}" is not supported by model "${model}". Supported efforts: ${entry.reasonings.join(', ')}.`,
    );
  }

  await services.use(ModelsV1).resolve(
    {
      providerId: execution.providerId,
      model,
      ...(requested.effort === undefined ? {} : { effort: requested.effort }),
    },
    call,
  );
};

export const tool = defineTool({
  name: 'thread-spawn',
  description:
    "Create an agent thread and delegate a self-contained task. Returns immediately. The child shares this project workspace; its result arrives automatically in this chat. The reader can watch it, pause it, continue it and retry it, but never prompt or delete it, so the task must stand on its own. Give it a short title (up to 80 characters) naming the task, as the user sees it in the thread list; without one, the thread is named after the start of the prompt. Set agent to run the child as one of the agents listed under # Agents, with that agent's instructions; without it, the child is a plain thread. model and effort override the agent's defaults; without them the child uses the agent's, else yours.",
  input: z
    .object({
      prompt: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
      title: z
        .string()
        .refine((value) => value.trim().length > 0)
        .optional(),
      agent: z.string().regex(agentNamePattern).optional(),
      model: z.string().min(1).optional(),
      effort: z.enum(reasoningEfforts).optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (input, call, services) => {
    const agent =
      input.agent === undefined
        ? undefined
        : await resolveAgent(services, call, input.agent);
    const model = input.model ?? agent?.model;
    const effort = input.effort ?? agent?.effort;

    if (model !== undefined || effort !== undefined) {
      await checkModel(services, call, { model, effort });
    }

    const options: SpawnOptions | undefined =
      agent === undefined && model === undefined && effort === undefined
        ? undefined
        : {
            ...(agent && {
              agent: {
                name: agent.name,
                source: agent.source,
                instructions: agent.instructions,
              },
            }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
          };

    return JSON.stringify(
      await threadsOf(services, call).spawn(
        input.prompt,
        input.title,
        options,
        call,
      ),
    );
  },
});
